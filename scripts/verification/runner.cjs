'use strict';
const { mkdirSync, mkdtempSync, writeFileSync, renameSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runProcess } = require('./process.cjs');
const { snapshot, sourceMatches } = require('./source.cjs');
const { plan, requiredIds } = require('./profile.cjs');

function environment(runtime) {
  // Deliberately allowlist, never inherit credentials, NODE_OPTIONS or connection strings.
  return { PATH: process.env.PATH || '/usr/bin:/bin', HOME: runtime, TMPDIR: runtime,
    XDG_CACHE_HOME: path.join(runtime, 'cache'), CI: '1', EXPO_NO_TELEMETRY: '1',
    EXPO_OFFLINE: '1', TZ: 'UTC', LANG: 'C.UTF-8' };
}
function save(report, directory) {
  writeFileSync(path.join(directory, 'report.pending.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  renameSync(path.join(directory, 'report.pending.json'), path.join(directory, 'report.json'));
}
const { coverageResult } = require('./coverage.cjs');

// Dependency injection is for the local test harness only; CLI accepts no external
// manifest, command, environment, executable, root, or output path.
async function verify({ root, profile = 'full', signal, onStep = () => {},
  makePlan = plan, capture = snapshot, execute = runProcess,
  expectedIds = requiredIds[profile], checkCoverage = coverageResult } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'pairspace-verification-'));
  const runtime = path.join(directory, 'runtime');
  mkdirSync(runtime, { mode: 0o700 });
  const logsDirectory = path.join(directory, 'logs');
  const report = { schemaVersion: 2, runId: randomUUID(), profile,
    policy: 'CONTINUE_AFTER_FAILURE; remaining steps NOT_RUN after interruption',
    runtimeVersion: { node: process.version, platform: process.platform, arch: process.arch },
    status: 'RUNNING', acceptance: false, startedAt: new Date().toISOString(),
    scope: 'local API/mobile/domain/PostgreSQL/safety/JS export checkpoint',
    notProven: ['production readiness', 'native iOS/Android build or two-device E2E',
      'E2EE', 'legacy Next build/typecheck', 'independent acceptance'],
    steps: [], artifacts: { report: 'report.json', runtime: 'runtime/', childLogs: 'logs/' } };
  save(report, directory);
  try {
    mkdirSync(logsDirectory, { mode: 0o700 });
    report.before = capture(root);
    const steps = makePlan(root, runtime, profile);
    if (!steps.length || !expectedIds?.length
      || new Set(steps.map(step => step.id)).size !== steps.length
      || expectedIds.some(id => !steps.some(step => step.id === id && step.required === true && !step.skip))) {
      throw new Error('INVALID_REQUIRED_PLAN');
    }
    for (const [stepIndex, step] of steps.entries()) {
      let result;
      if (step.skip || signal?.aborted) result = { status: 'NOT_RUN', reason: step.skip || 'interrupted', childLogs: 'NO_PROCESS_EXECUTED' };
      else if (!step.command || !Array.isArray(step.args) || !Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) {
        result = { status: 'ERROR', error: 'INVALID_REQUIRED_STEP' };
      } else {
        const cwd = path.resolve(root, step.cwd);
        if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error('STEP_PATH_ESCAPE');
        result = await execute(step, { cwd, env: environment(runtime), signal, logsDirectory, stepIndex });
      }
      const coverage = checkCoverage(step.id, runtime);
      if (coverage) {
        result.coverage = coverage;
        if (!coverage.valid && result.status === 'PASS') result.status = 'FAIL';
      }
      report.steps.push({ id: step.id, required: step.required, ...result });
      save(report, directory);
      onStep(step.id, result.status);
    }
    report.after = capture(root);
    report.sourceValid = sourceMatches(report.before, report.after);
    const required = report.steps.filter(step => step.required);
    const passed = required.length > 0 && required.every(step => step.status === 'PASS');
    report.status = signal?.aborted ? 'INTERRUPTED' : passed && report.sourceValid ? 'PASS' : 'FAIL';
    report.acceptance = report.status === 'PASS' && profile === 'full';
  } catch (error) {
    report.status = 'ERROR';
    // Never serialize arbitrary error messages (they can contain environment or payloads).
    report.error = 'VERIFICATION_INTERNAL_ERROR';
  }
  report.finishedAt = new Date().toISOString();
  save(report, directory);
  return { report, directory, exitCode: report.status === 'PASS' ? 0 : 1 };
}
module.exports = { verify, environment };
