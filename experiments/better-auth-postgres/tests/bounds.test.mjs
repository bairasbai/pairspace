import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { observeTask, barrierOrCompletion, withDeadline, settleBounded } from '../src/async-bounds.mjs';

const never = () => new Promise(() => {});
test('barrier fails promptly when write rejects or finishes before reaching barrier', async () => {
  const failure = new Error('synthetic pre-lock SQL failure');
  await assert.rejects(barrierOrCompletion(never(), observeTask(Promise.reject(failure)), 100), error => error === failure);
  await assert.rejects(barrierOrCompletion(never(), observeTask(Promise.resolve(401)), 100), /completed before reaching barrier/);
  await barrierOrCompletion(Promise.resolve(), never(), 100);
});
test('readiness, operation and cleanup deadlines reject stuck work', async () => {
  await assert.rejects(barrierOrCompletion(never(), never(), 10), /deadline exceeded/);
  await assert.rejects(withDeadline(never(), 10, 'Query'), /Query deadline exceeded/);
  await assert.rejects(settleBounded([never()], 10), /cleanup deadline exceeded/);
});
test('shell sanitation removes all inherited PG settings before utility execution', () => {
  const result = spawnSync('bash', ['-c', 'source scripts/sanitize-pg-env.sh; node --input-type=module -e "if(Object.keys(process.env).some(k=>k.startsWith(\'PG\')))process.exit(1)"'], {
    encoding: 'utf8', env: { ...process.env, PGHOSTADDR: '198.51.100.1', PGSERVICE: 'synthetic-service', PGOPTIONS: '-c search_path=public', PGPASSWORD: 'synthetic-test-password', PGSERVICEFILE: '/nonexistent', PGCUSTOM_FUTURE: 'synthetic' },
  });
  assert.equal(result.status, 0, result.stderr);
});


test('outer GNU timeout terminates stuck subprocess with nonzero status', () => {
  const result = spawnSync('timeout', ['--signal=TERM', '--kill-after=1s', '0.05s', 'bash', '-c', 'sleep 30'], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 124);
});
