import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { replyFixture } from './mobile-reply-fixture.mjs';

export const visibilityFixture = (count = 251) => replyFixture(count, { enableSyntheticChatVisibility: true,
  enableSyntheticChatEditing: true, enableSyntheticChatDeletion: true });
export async function visibilityRequest(f, connection, pair, path, { method = 'GET', body, query = {}, opted = true, readId = randomUUID() } = {}) {
  const url = new URL(`/v1/couples/${pair}/chat/${path}`, f.baseURL);
  if (method === 'GET') {
    url.searchParams.set('membership_epoch', '1'); url.searchParams.set('read_id', readId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  }
  const headers = { cookie: await connection.getCookie(), origin: f.baseURL, ...(opted ? { 'X-Chat-Visibility': '1' } : {}) };
  if (body) { headers['content-type'] = 'application/json'; headers['idempotency-key'] = body.command_id ?? body.client_message_id; }
  const response = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json();
  const raw = response.headers.get('X-Chat-Visibility-Revision');
  const revision = raw === null ? null : Number(raw);
  if (revision !== null) assert.equal(Number.isSafeInteger(revision) && revision >= 0, true);
  return { status: response.status, payload, revision };
}
export async function setVisibility(f, connection, pair, id, hidden, expected = 0, command = randomUUID()) {
  return visibilityRequest(f, connection, pair, `messages/${id}/hidden`, { method: 'PUT', body: {
    membership_epoch: 1, command_id: command, expected_visibility_version: expected, hidden,
  } });
}
export const requireSuccess = result => { assert.equal(result.status, 200); assert.equal(result.payload.ok, true); return result.payload.value; };
