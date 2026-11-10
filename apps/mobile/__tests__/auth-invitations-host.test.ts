import { createInvitationController, type InvitationHostSnapshot } from '../src/auth/invitations-controller';
import { config, identity, owner, recipient, cookie, envelope, uuid, deferred, settle } from './invitation-fixtures';
it('sync with null or unchanged unmapped context is idempotent and never exposes invitation controls', () => {
  let current: InvitationHostSnapshot | null = null;
  const controller = createInvitationController(config, { capture: () => current, getCookie: async () => cookie,
    block: () => {}, refresh: async () => {} }, async () => envelope({}), () => uuid(4));
  controller.sync(); expect(controller.actions.getSnapshot().mode).toBe('unavailable');
  current = { generation: 1, identity, context: { state: 'unmapped', sessionId: 'session' } };
  controller.sync(); const listener = jest.fn(); controller.actions.subscribe(listener); controller.sync();
  expect(listener).not.toHaveBeenCalled();
});
it('host generation or identity replacement invalidates pending completion before the next await boundary', async () => {
  const hold = deferred<string>(); const request = jest.fn(async () => envelope(owner));
  let current: InvitationHostSnapshot | null = { generation: 1, identity, context: owner };
  const controller = createInvitationController(config, { capture: () => current, getCookie: () => hold.promise,
    block: () => {}, refresh: async () => {} }, request, () => uuid(4));
  controller.sync(); const pending = controller.actions.issue(); await settle();
  current = { generation: 2, identity: { ...identity }, context: recipient };
  controller.sync(); hold.resolve(cookie); await pending; expect(request).not.toHaveBeenCalled();
  expect(controller.actions.getSnapshot()).toMatchObject({ mode: 'recipient', issuedToken: null, busy: null });
  current = null; controller.sync(); expect(controller.actions.getSnapshot().mode).toBe('unavailable');
});
