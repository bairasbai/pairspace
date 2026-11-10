import { expect, it } from 'vitest';
import { fixture, id, inviteId, mutations, now, request, row } from './pair-invitation-fixture.ts';

it('rejects malformed authorizing rows and clock without mutation', async () => {
  for (const overrides of [{ initial: [{ user_id: 'bad' }] }, { initial: [{ user_id: id(1) }, { user_id: id(2) }] },
    { mapping: [{ user_id: 'bad' }] }, { membership: [{ couple_id: 'bad' }] }, { currentMembership: [{ couple_id: 'bad' }] },
    { couple: [] }, { couple: [{ status: 'invalid', membership_epoch: 1 }] }, { couple: [{ status: 'waiting_partner', membership_epoch: 0 }] },
    { clock: [] }, { clock: [{ now: 'bad' }] }, { members: [] }]) {
    const f = fixture(overrides); const response = await f.handler(request());
    expect(response.status).toBe(503); expect(mutations(f)).toHaveLength(0);
  }
});

it('rejects malformed invitation rows, ownership, timestamps and impossible states without exposing details', async () => {
  const before = new Date(+now - 1).toISOString(), after = new Date(+now + 1).toISOString();
  const invalid = [row({ id: 'bad' }), row({ command_id: 'bad' }), row({ owned: false }), row({ owned: 1 }),
    row({ created_at: 'bad' }), row({ expires_at: 'bad' }), row({ expires_at: now.toISOString() }),
    row({ created_at: after }), row({ revoked_at: 'bad' }), row({ revoked_at: before }), row({ revoked_at: after }),
    row({ consumed_at: 'bad' }), row({ consumed_at: before }), row({ consumed_at: after }),
    row({ created_at: before, expires_at: now.toISOString(), consumed_at: now.toISOString() }),
    row({ revoked_at: now.toISOString(), consumed_at: now.toISOString() })];
  for (const current of [...invalid.map(value => [value]), [row(), row()], [row({ revoked_at: now.toISOString() })], [row({ consumed_at: now.toISOString() })]]) {
    const f = fixture({ current }); const response = await f.handler(request('GET'));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect(mutations(f)).toHaveLength(0);
  }
});

it('throws on inconsistent replay/revoke/insert returns so a transaction rolls back instead of committing partial rotation', async () => {
  const expired = row({ created_at: new Date(+now - 600000).toISOString(), expires_at: now.toISOString() });
  for (const target of [[row({ command_id: id(99) })]]) {
    const f = fixture({ target }); expect((await f.handler(request())).status).toBe(503); expect(mutations(f)).toHaveLength(0);
  }
  for (const target of [[row({ id: id(99) })], [row()]]) {
    const f = fixture({ target }); expect((await f.handler(request('DELETE', JSON.stringify({ inviteId })))).status).toBe(503);
    expect(mutations(f)).toHaveLength(0);
  }
  for (const revoked of [[], [{ id: 'invalid' }], [{ id: id(99) }]]) {
    const f = fixture({ current: [expired], revoked }); expect((await f.handler(request())).status).toBe(503);
    expect(mutations(f)).toHaveLength(1);
  }
  for (const inserted of [[], [row({ command_id: id(99) })], [row({ revoked_at: now.toISOString() })],
    [row({ created_at: new Date(+now - 1).toISOString() })], [row({ expires_at: new Date(+now + 600001).toISOString() })]]) {
    const f = fixture({ current: [expired], inserted }); expect((await f.handler(request())).status).toBe(503);
    expect(mutations(f)).toHaveLength(2);
  }
});
