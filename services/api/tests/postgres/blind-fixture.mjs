import { randomUUID } from 'node:crypto';
import { lettersFixture } from './letters-fixture.mjs';
export async function blindFixture() {
  const x = await lettersFixture({ enableSyntheticBlindAnswers: true, enableSyntheticPairLeave: true });
  const path = (pair = x.pairA) => `/v1/couples/${pair}/blind-round`;
  const post = (index, url, body) => x.raw(index, url, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': body.command_id }, body: JSON.stringify(body) });
  const open = (index, command = randomUUID(), pair = x.pairA, epoch = 1) => post(index, path(pair), {
    command_id: command, membership_epoch: epoch, question_id: 'small-joy', catalog_version: 1 });
  const read = (index, pair = x.pairA, epoch = 1) => x.raw(index, path(pair) + '?membership_epoch=' + epoch);
  const submit = (index, round, answer = 'Synthetic small joy', command = randomUUID(), pair = x.pairA, epoch = 1, extra = {}) =>
    post(index, `${path(pair)}/${round}/answer`, { command_id: command, membership_epoch: epoch,
      question_id: 'small-joy', catalog_version: 1, answer, confirm: true, ...extra });
  const leave = index => x.raw(index, '/v1/pair/leave', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: randomUUID(), coupleId: x.pairA, membershipEpoch: 1, confirm: true }) });
  return { ...x, path, post, open, read, submit, leave };
}
export const value = async response => { const body = await response.json(); return body.value; };
