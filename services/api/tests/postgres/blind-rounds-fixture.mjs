import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { blindFixture, value } from './blind-fixture.mjs';
export { value };
export async function roundsFixture() {
  const x = await blindFixture();
  const path = (pair = x.pairA) => `/v1/couples/${pair}/blind-rounds`;
  const command = (round, question = 'shared-plan', extra = {}) => ({ membership_epoch: 1,
    command_id: randomUUID(), expected_predecessor_round_id: round.id,
    question_id: question, catalog_version: 1, confirm: true, ...extra });
  const next = (index, body, pair = x.pairA) => x.post(index, `${path(pair)}/next`, body);
  const history = (index, pair = x.pairA, epoch = 1) => x.raw(index, `${path(pair)}?membership_epoch=${epoch}`);
  const select = (index, round, pair = x.pairA, epoch = 1) => x.raw(index, `${path(pair)}/${round.id}?membership_epoch=${epoch}`);
  const finish = async round => {
    for (let index = 0; index < 2; index++) {
      const response = await x.submit(index, round.id, `Synthetic round ${index}`, randomUUID(), x.pairA, 1,
        { question_id: round.questionId, catalog_version: round.catalogVersion });
      assert.equal(response.status, 200);
    }
  };
  return { ...x, roundsPath: path, command, next, history, select, finish };
}
