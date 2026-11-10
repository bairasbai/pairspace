import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function report(count = 0) {
  return {
    auditReportVersion: 2,
    vulnerabilities: count ? { synthetic: { severity: 'moderate' } } : {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: count, high: 0, critical: 0, total: count },
      dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
    },
  };
}
function runAudit(body, exitCode) {
  const directory = mkdtempSync(join(tmpdir(), 'pairspace-audit-'));
  try {
    // Stub only npm in this child; exercise the actual shell + validator.
    writeFileSync(join(directory, 'npm'), '#!/bin/sh\nprintf "%s" "$FAKE_AUDIT_BODY"\nexit "$FAKE_AUDIT_EXIT"\n', { mode: 0o700 });
    return spawnSync('bash', [resolve('scripts/audit.sh'), join(directory, 'audit.json')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAKE_AUDIT_BODY: body, FAKE_AUDIT_EXIT: String(exitCode) },
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('audit accepts valid clean and vulnerability reports', () => {
  for (const [count, exitCode] of [[0, 0], [1, 1]]) {
    const result = runAudit(JSON.stringify(report(count)), exitCode);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Validated npm audit/);
  }
});

test('audit fails closed on network error, invalid JSON, metadata and operational failures', () => {
  const malformedMetadata = report();
  delete malformedMetadata.metadata;
  const wrongCount = report(1);
  wrongCount.metadata.vulnerabilities.total = 2;
  const cases = [
    [JSON.stringify({ error: { code: 'ENETUNREACH', summary: 'Synthetic network failure' } }), 1],
    ['not-json', 1], ['', 0],
    [JSON.stringify(malformedMetadata), 0],
    [JSON.stringify(wrongCount), 1],
    [JSON.stringify(report()), 2],
    [JSON.stringify(report()), 1],
    [JSON.stringify(report(1)), 0],
  ];
  for (const [body, exitCode] of cases) {
    const result = runAudit(body, exitCode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Audit verification failed/);
    assert.doesNotMatch(result.stdout, /Validated npm audit/);
  }
});
