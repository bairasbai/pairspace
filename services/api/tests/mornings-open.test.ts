import { it, expect } from 'vitest';
import type { AuthorizedDatabase } from '../src/contracts.ts';
import { openMorning } from '../src/morning-open.ts';
import { readMorning } from '../src/morning-read.ts';
import { id, c1, u1, u2, principal, identityPrincipal } from './fixtures.ts';
/** Query-level unit fake only. Genuine DB deadline/latch proof is a separate real-minute PostgreSQL test. */
function fixture() {
    let opened: string | null = null, receipt: string | null = null;
    let now = new Date('2026-11-01T10:00:00Z'), checks = 0;
    const flags = { emptyInsert: false, missingBody: false, missingAfter: false, failReceipt: false, denyCheck: 0 };
    const db: AuthorizedDatabase = {
        now: () => now,
        sessionAuthority: { source: 'synthetic-jwt', authenticate: async () => identityPrincipal(u2), recheck: async () => ++checks !== flags.denyCheck },
        async transaction(work) {
            const saved = [opened, receipt];
            try {
                return await work({ async query<T>(sql: string, params: unknown[] = []): Promise<{
                        rows: T[];
                    }> {
                        let rows: unknown[] = [];
                        if (sql.includes('FROM couples'))
                            rows = [{ status: 'active', membership_epoch: 1 }];
                        else if (sql.startsWith('SELECT user_id FROM couple_members'))
                            rows = [{ user_id: u1 }, { user_id: u2 }];
                        else if (sql.includes('SELECT fingerprint FROM morning_command_receipts'))
                            rows = receipt ? [{ fingerprint: receipt }] : [];
                        else if (sql.includes('SELECT s.id,s.couple_id'))
                            rows = flags.missingAfter && opened ? [] : [{ id: id(7000), couple_id: c1, membership_epoch: 1, sender_id: u1, recipient_id: u2, local_date: '2026-11-01', local_time: '09:00', timezone: 'UTC', utc_offset: '+00:00', release_at: '2026-11-01T09:00:00Z', created_at: '2026-10-31T09:00:00Z', preference_version: 1, prepared: true, opened_at: opened }];
                        else if (sql.includes('INSERT INTO morning_openings')) {
                            if (!flags.emptyInsert) {
                                opened = String(params[2]);
                                rows = [{ slot_id: id(7000) }];
                            }
                        }
                        else if (sql.includes('INSERT INTO morning_command_receipts')) {
                            if (flags.failReceipt)
                                throw Error('receipt_failure');
                            receipt = String(params[4]);
                        }
                        else if (sql.includes('SELECT c.body'))
                            rows = flags.missingBody ? [] : [{ body: 'Synthetic current body' }];
                        return { rows: rows as T[] };
                    } });
            }
            catch (error) {
                [opened, receipt] = saved;
                throw error;
            }
        }
    };
    return { db, flags, setNow: (value: Date) => { now = value; }, get opened() { return opened; }, get receipt() { return receipt; } };
}
const input = { coupleId: c1, membershipEpoch: 1, slotId: id(7000), commandId: id(7001), confirm: true };
it('explicit latch is durable across rollback, retries return current body, receipts atomic and scoped', async () => {
    const f = fixture(), p = identityPrincipal(u2);
    f.flags.failReceipt = true;
    await expect(openMorning(f.db, p, input)).rejects.toThrow('receipt_failure');
    expect(f.opened).toBeNull();
    expect(f.receipt).toBeNull();
    f.flags.failReceipt = false;
    expect(await openMorning(f.db, p, input)).toMatchObject({ ok: true, value: { replay: false, body: 'Synthetic current body', slot: { openedAt: '2026-11-01T10:00:00.000Z' } } });
    f.setNow(new Date('2026-11-01T08:00:00Z'));
    expect(await openMorning(f.db, p, input)).toMatchObject({ ok: true, value: { replay: true, slot: { state: 'available' } } });
    expect(await readMorning(f.db, p, { coupleId: c1, membershipEpoch: 1, slotId: id(7000), readId: id(7002) })).toMatchObject({ ok: true, value: { body: 'Synthetic current body', slot: { state: 'available' } } });
    expect(await openMorning(f.db, p, { ...input, slotId: id(7003) })).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(await openMorning(f.db, principal, input)).toEqual({ ok: false, error: 'idempotency_conflict' });
});
it('open query failures, row disappearance, physical clock rejection, and post-last-lock denial fail closed', async () => {
    const p = identityPrincipal(u2);
    const empty = fixture();
    empty.flags.emptyInsert = true;
    expect(await openMorning(empty.db, p, input)).toEqual({ ok: false, error: 'slot_closed' });
    const missing = fixture();
    missing.flags.missingAfter = true;
    expect(await openMorning(missing.db, p, input)).toEqual({ ok: false, error: 'unavailable' });
    const body = fixture();
    body.flags.missingBody = true;
    await expect(openMorning(body.db, p, input)).rejects.toThrow('morning_open_invariant');
    const denied = fixture();
    denied.flags.denyCheck = 3;
    expect(await openMorning(denied.db, p, input)).toEqual({ ok: false, error: 'unavailable' });
    expect(denied.opened).toBeNull();
});
