import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localConfiguration, verifyDisposable } from '../src/guard.mjs';
const valid = {
  PAIRSPACE_PG_HOST: '127.0.0.1', PAIRSPACE_PG_PORT: '15432', PAIRSPACE_PG_USER: 'pairspace_fixture',
  PAIRSPACE_PG_DATABASE: 'pairspace_spike_0123456789abcdef', PAIRSPACE_PG_NONCE: 'a'.repeat(64), PAIRSPACE_PG_PASSWORD: 'b'.repeat(64),
};
test('explicit synthetic loopback config only; no default PG env or remote fallback', () => {
  assert.equal(localConfiguration(valid).connection.host, '127.0.0.1');
  assert.throws(() => localConfiguration({}));
  for (const name of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGPASSWORD', 'PGDATABASE', 'PGCUSTOM_FUTURE']) {
    assert.throws(() => localConfiguration({ ...valid, [name]: 'synthetic' }), /Inherited PG settings forbidden/);
  }
  for (const patch of [{ PAIRSPACE_PG_HOST: 'example.com' }, { PAIRSPACE_PG_HOST: 'localhost' }, { PAIRSPACE_PG_PORT: '0' }, { PAIRSPACE_PG_PORT: '65536' }, { PAIRSPACE_PG_DATABASE: 'production' }, { PAIRSPACE_PG_USER: 'postgres' }, { PAIRSPACE_PG_PASSWORD: '' }, { PAIRSPACE_PG_NONCE: '' }]) {
    assert.throws(() => localConfiguration({ ...valid, ...patch }));
  }
});
test('disposable database marker rejects missing, mismatched or multiple rows', async () => {
  const expected = localConfiguration(valid);
  await verifyDisposable({ query: async () => ({ rows: [{ database: valid.PAIRSPACE_PG_DATABASE, nonce: valid.PAIRSPACE_PG_NONCE }] }) }, expected);
  for (const rows of [[], [{}], [{ database: 'production', nonce: valid.PAIRSPACE_PG_NONCE }], [{ database: valid.PAIRSPACE_PG_DATABASE, nonce: 'wrong' }], [{}, {}]]) {
    await assert.rejects(verifyDisposable({ query: async () => ({ rows }) }, expected));
  }
});
