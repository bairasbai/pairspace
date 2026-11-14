import type { AuthorizedDatabase, Principal } from '../src/contracts.ts';
import { c1, id, u1, u2, principal } from './fixtures.ts';
type Row = {
    id: string;
    slot_id: string;
    couple_id: string;
    membership_epoch: number;
    author_id: string;
    client_id: string;
    seq: string;
    body: string | null;
    version: number;
    edited_at: string | null;
    deleted_at: string | null;
    created_at: string;
};
/** Query-level unit fake; SQL constraints are tested separately on actual PostgreSQL. */
export function discussionFixture() {
    let rows: Row[] = [], receipts: {
        actor: string;
        command: string;
        fingerprint: string;
        message_id: string;
    }[] = [], seq = 0, checks = 0;
    let mutations: {
        actor: string;
        command: string;
        fingerprint: string;
    }[] = [];
    const queries: string[] = [];
    const flags = { allowed: true, zeroUpdate: false, now: '2026-11-12T12:00:00Z', failReceipt: false, missingReplay: false, denyCheck: 0, failSql: '', principal: principal as Principal | null };
    const db: AuthorizedDatabase = { now: () => new Date(flags.now), sessionAuthority: { source: 'synthetic-jwt', authenticate: async () => flags.principal, recheck: async () => ++checks !== flags.denyCheck },
        async transaction(work) {
            const oldRows = [...rows], oldReceipts = [...receipts], oldMutations = [...mutations];
            try {
                return await work({ async query<T>(sql: string, p: unknown[] = []): Promise<{
                        rows: T[];
                    }> {
                        queries.push(sql);
                        if (flags.failSql && sql.includes(flags.failSql))
                            throw Error('synthetic_query_failure');
                        let result: unknown[] = [];
                        if (sql.startsWith('SELECT status,membership_epoch FROM couples'))
                            result = p[0] === c1 ? [{ status: 'active', membership_epoch: 1 }] : [];
                        else if (sql.startsWith('SELECT user_id FROM couple_members'))
                            result = [{ user_id: u1 }, { user_id: u2 }];
                        else if (sql.startsWith('SELECT s.id FROM morning_slots'))
                            result = flags.allowed && p[0] === id(9000) ? [{ id: id(9000) }] : [];
                        else if (sql.startsWith('SELECT fingerprint,message_id'))
                            result = receipts.filter(r => r.actor === p[0] && r.command === p[1]);
                        else if (sql.startsWith('SELECT fingerprint FROM morning_discussion_mutation_receipts'))
                            result = mutations.filter(r => r.actor === p[0] && r.command === p[1]);
                        else if (sql.startsWith('INSERT INTO morning_discussion_mutation_receipts')) {
                            if (flags.failReceipt)
                                throw Error('synthetic_receipt_failure');
                            mutations.push({ actor: String(p[0]), command: String(p[1]), fingerprint: String(p[10]) });
                        }
                        else if (sql.startsWith('UPDATE morning_discussion_messages')) {
                            const index = rows.findIndex(r => r.id === p[0] && r.slot_id === p[1] && r.couple_id === p[2] && r.version === p[3]);
                            if (index >= 0 && !flags.zeroUpdate) {
                                const old = rows[index];
                                const at = new Date(Math.max(Date.parse(String(p[6])), Date.parse(old.created_at), old.edited_at ? Date.parse(old.edited_at) : 0)).toISOString();
                                const row = { ...old, body: p[4] === null ? null : String(p[4]), version: old.version + 1, edited_at: p[5] === 'edit' ? at : old.edited_at, deleted_at: p[5] === 'delete' ? at : null };
                                rows[index] = row;
                                result = [row];
                            }
                        }
                        else if (sql.startsWith('INSERT INTO morning_discussion_messages')) {
                            const row: Row = { version: 1, edited_at: null, deleted_at: null, id: id(10000 + seq), slot_id: String(p[0]), couple_id: String(p[1]), membership_epoch: Number(p[2]), author_id: String(p[3]), client_id: String(p[4]), body: String(p[5]), created_at: String(p[6]), seq: String(++seq * 3) };
                            rows.push(row);
                            result = [row];
                        }
                        else if (sql.startsWith('INSERT INTO morning_discussion_receipts')) {
                            if (flags.failReceipt)
                                throw Error('synthetic_receipt_failure');
                            receipts.push({ actor: String(p[0]), command: String(p[1]), message_id: String(p[5]), fingerprint: String(p[6]) });
                        }
                        else if (sql.includes('FROM morning_discussion_messages WHERE id=$1'))
                            result = flags.missingReplay ? [] : rows.filter(r => r.id === p[0] && r.slot_id === p[1] && r.couple_id === p[2] && r.membership_epoch === p[3]);
                        else if (sql.startsWith('SELECT id FROM morning_discussion_messages'))
                            result = rows.filter(r => r.slot_id === p[0] && r.couple_id === p[1] && r.membership_epoch === p[2] && r.id === p[3] && Number(r.seq) === p[4]);
                        else if (sql.includes('EXISTS(SELECT 1 FROM morning_discussion_messages'))
                            result = [{ previous: rows.some(r => r.slot_id === p[0] && (!sql.includes("->>'deleted_at' IS NULL") || !r.deleted_at) && Number(r.seq) < Number(p[3])), next: rows.some(r => r.slot_id === p[0] && (!sql.includes("->>'deleted_at' IS NULL") || !r.deleted_at) && Number(r.seq) > Number(p[4])) }];
                        else if (sql.includes('FROM morning_discussion_messages WHERE slot_id=$1')) {
                            let list = rows.filter(r => (!sql.includes("->>'deleted_at' IS NULL") || !r.deleted_at) && r.slot_id === p[0] && r.couple_id === p[1] && r.membership_epoch === p[2]);
                            if (sql.includes('AND seq>$4'))
                                list = list.filter(r => Number(r.seq) > Number(p[3]));
                            if (sql.includes('AND seq<$4'))
                                list = list.filter(r => Number(r.seq) < Number(p[3]));
                            list.sort((a, b) => (Number(a.seq) - Number(b.seq)) * (sql.includes('seq DESC') ? -1 : 1));
                            result = list.slice(0, 30);
                        }
                        return { rows: result as T[] };
                    } });
            }
            catch (error) {
                rows = oldRows;
                receipts = oldReceipts;
                mutations = oldMutations;
                throw error;
            }
        }
    };
    return { db, flags, queries, get rows() { return rows; }, get receipts() { return receipts; }, get mutations() { return mutations; } };
}
