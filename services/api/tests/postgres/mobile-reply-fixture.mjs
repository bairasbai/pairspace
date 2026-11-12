import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { password } from './mobile-invitations-fixture.mjs';

export async function replyFixture(count = 251, options = {}) {
  const f = await createComposedFixture({ enableSyntheticChatHistoryWindow: true, enableSyntheticChatReplies: true, ...options });
  try {
    const connections = [], identities = [];
    for (let i = 0; i < 4; i++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({ email: `reply-${i}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true);
      connections.push(connection); identities.push(result.data.user.id);
    }
    const pairA = randomUUID(), pairB = randomUUID();
    const usersA = await f.provision(identities.slice(0, 2), pairA);
    const usersB = await f.provision(identities.slice(2), pairB);
    for (const [pair, users] of [[pairA, usersA], [pairB, usersB]]) {
      await f.domainPool.query(`INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body)
        SELECT $1,CASE WHEN n%2=0 THEN $2::uuid ELSE $3::uuid END,gen_random_uuid(),n*3,'Synthetic source '||n
        FROM generate_series(1,$4::integer) n`, [pair, users[0], users[1], count]);
      await f.domainPool.query('UPDATE couples SET next_chat_seq=$2 WHERE id=$1', [pair, count * 3 + 1]);
    }
    const rows = (await f.domainPool.query('SELECT id,seq::int,body,sender_id FROM chat_messages WHERE couple_id=$1 ORDER BY seq', [pairA])).rows;
    return { f, pairA, pairB, usersA, usersB, connections, rows };
  } catch (error) { await f.close(); throw error; }
}
export function latch() {
  let arrive, release;
  const reached = new Promise(resolve => { arrive = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  return { reached, gate, arrive, release };
}
export async function tombstone(f, id) {
  // Internal synthetic state transition only: no product deletion API is claimed.
  const tx = await f.domainPool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT c.id FROM couples c JOIN chat_messages m ON m.couple_id=c.id WHERE m.id=$1 FOR UPDATE OF c', [id]);
    await tx.query("UPDATE chat_messages SET body=NULL,deleted_at=date_trunc('milliseconds',clock_timestamp()),version=version+1 WHERE id=$1", [id]);
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
