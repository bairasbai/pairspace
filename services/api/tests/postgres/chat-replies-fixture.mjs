import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFixture } from "./fixture.mjs";
const origin = "http://localhost:3123";
export async function replyFixture({ skipChatDeletionMigration = false } = {}) {
    const f = await createFixture({ skipChatDeletionMigration });
    try {
        const accounts = [];
        for (let i = 0; i < 4; i++) {
            const response = await f.call("sign-up/email", {
                name: "Synthetic",
                email: `window-${i}@example.test`,
                password: "Synthetic-window-password-42!"
            });
            assert.equal(response.status, 200);
            accounts.push({
                ...await response.json(),
                cookie: response.headers.getSetCookie().map(v => v.split(";")[0]).join("; ")
            });
        }
        const a = randomUUID(), b = randomUUID(), usersA = await f.provision(accounts.slice(0, 2).map(x => x.user.id), a), usersB = await f.provision(accounts.slice(2).map(x => x.user.id), b), db = f.database();
        const principals = await Promise.all(accounts.map(x => db.sessionAuthority.authenticate(new Request(origin, {
            headers: {
                origin,
                cookie: x.cookie
            }
        }))));
        for (const [pair, user] of [[a, usersA[0]], [b, usersB[0]]])
            await f.domainPool.query(`INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body,created_at) SELECT $1,$2,gen_random_uuid(),n*3,'Synthetic '||n,'2026-01-01' FROM generate_series(1,251)n`, [pair, user]);
        return {
            f,
            a,
            b,
            db,
            principals,
            usersA
        };
    }
    catch (error) {
        await f.close();
        throw error;
    }
}
