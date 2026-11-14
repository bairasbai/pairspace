import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { replyFixture } from './mobile-reply-fixture.mjs';
import { mobile } from './mobile-invitations-fixture.mjs';

export const morningsFixture = (options = {}) => replyFixture(0, { enableSyntheticMornings: true, ...options });
export const morningAccount = (f, index = 0, options = {}) => mobile(f, index, {
  email: `reply-${index}@example.test`, signup: false, ...options,
});
export async function morningRequest(f, connection, pair, suffix = '', { method = 'GET', body, query = {}, readId = randomUUID() } = {}) {
  const url = new URL(`/v1/couples/${pair}/mornings${suffix}`, f.baseURL);
  if (method === 'GET') {
    url.searchParams.set('membership_epoch', '1'); url.searchParams.set('read_id', readId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  }
  const headers = { cookie: await connection.getCookie(), origin: f.baseURL };
  if (body) { headers['content-type'] = 'application/json'; headers['idempotency-key'] = body.command_id; }
  const response = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, payload: await response.json() };
}
export function morningValue(result) {
  assert.equal(result.status >= 200 && result.status < 300, true, `unexpected HTTP ${result.status}`);
  assert.equal(result.payload.ok, true); return result.payload.value;
}
export const morningCommand = fields => ({ membership_epoch: 1, command_id: randomUUID(), ...fields });
export async function setMorningPreference(f, connection, pair, timezone = 'UTC', localTime = '09:00', version = 0) {
  return morningValue(await morningRequest(f, connection, pair, '/preference', { method: 'PUT',
    body: morningCommand({ expected_version: version, timezone, local_time: localTime }),
  }));
}
export function futureDate(days = 7) {
  const date = new Date(); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
