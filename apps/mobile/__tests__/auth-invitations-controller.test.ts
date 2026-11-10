import { setup, owner, recipient, ready, uuid, token, otherToken, metadata, cookie, envelope, errorResponse,
  accepted, deferred, settle } from './invitation-fixtures';

it('starts unavailable, ignores actions without trusted context, and has a separate subscription', async () => {
  const { api, request, discovery } = setup();
  const listener = jest.fn(); const unsubscribe = api.subscribe(listener);
  expect(api.getSnapshot()).toEqual({ mode: 'unavailable', busy: null, error: null, invitation: null, issuedToken: null,
    tokenInput: '', preview: null, consent: false, recovery: 'none' });
  api.setToken(token); api.setConsent(true); await api.issue(); await api.revoke(); await api.readMetadata(); await api.preview(); await api.accept();
  expect(request).not.toHaveBeenCalled(); expect(discovery).not.toHaveBeenCalled();
  api.cancel(); expect(listener).toHaveBeenCalledTimes(1); unsubscribe(); api.cancel(); expect(listener).toHaveBeenCalledTimes(1);
});
it.each([['waiting_partner', 'owner'], ['no_active_pair', 'recipient'], ['unmapped', 'unavailable'], ['ready', 'unavailable']] as const)('selects %s mode only from server context', async (state, mode) => {
  const context = state === 'unmapped' ? { state, sessionId: 'session' } : state === 'no_active_pair' ? recipient : { ...owner, state };
  const { api, login, request } = setup(context); await login(); expect(api.getSnapshot().mode).toBe(mode);
  expect(request.mock.calls.filter(([r]) => !r.url.includes('/chat/'))).toHaveLength(0);
});
it('explicit owner issue displays one raw token; same metadata read preserves it but never restores cleared token', async () => {
  const { api, login, request, commandId } = setup(); await login(); await api.issue();
  expect(api.getSnapshot()).toMatchObject({ issuedToken: token, invitation: metadata, recovery: 'none', busy: null });
  await api.issue(); expect(commandId).toHaveBeenCalledTimes(1);
  await api.readMetadata(); expect(api.getSnapshot().issuedToken).toBe(token);
  api.cancel(); await api.readMetadata(); expect(api.getSnapshot().issuedToken).toBeNull();
  expect(request).toHaveBeenCalledTimes(3);
});
it.each(['id', 'expired', 'null'])('metadata %s change clears displayed raw token', async change => {
  const { api, login, request } = setup(); await login(); await api.issue();
  request.mockResolvedValue(envelope({ state: 'current', invitation: change === 'null' ? null
    : change === 'id' ? { ...metadata, id: uuid(30) } : { ...metadata, status: 'expired' } }));
  await api.readMetadata(); expect(api.getSnapshot().issuedToken).toBeNull();
});
it('lost issue acknowledgement requires explicit read, exact revoke, then a new command', async () => {
  const { api, login, request, commandId } = setup(); await login();
  request.mockResolvedValueOnce(errorResponse()); await api.issue();
  expect(api.getSnapshot()).toMatchObject({ recovery: 'issue_uncertain', issuedToken: null, error: 'invitation_retry_required' });
  await api.issue(); expect(commandId).toHaveBeenCalledTimes(1);
  api.cancel(); expect(api.getSnapshot().recovery).toBe('issue_uncertain');
  await api.readMetadata(); expect(api.getSnapshot()).toMatchObject({ recovery: 'revoke_required', invitation: metadata });
  await api.issue(); expect(commandId).toHaveBeenCalledTimes(1);
  await api.revoke(); expect(await request.mock.calls[2][0].json()).toEqual({ inviteId: metadata.id });
  commandId.mockReturnValue(uuid(5)); request.mockResolvedValueOnce(envelope({ state: 'issued', invitation: { ...metadata, commandId: uuid(5) }, token }, 201));
  await api.issue(); expect(api.getSnapshot()).toMatchObject({ recovery: 'none', issuedToken: token });
});
it.each(['issue_uncertain', 'revoke_required'])('explicit current-null read resolves %s without claiming the old command never committed', async recovery => {
  const { api, login, request } = setup(); await login();
  request.mockResolvedValueOnce(recovery === 'issue_uncertain' ? errorResponse()
    : envelope({ state: 'replayed', invitation: metadata, token: null }));
  await api.issue(); expect(api.getSnapshot().recovery).toBe(recovery);
  request.mockResolvedValueOnce(envelope({ state: 'current', invitation: null }));
  await api.readMetadata(); expect(api.getSnapshot().recovery).toBe('none');
  await api.issue(); expect(api.getSnapshot().issuedToken).toBe(token);
});
it('replay never displays a token and requires revoke before a fresh issuance', async () => {
  const { api, login, request } = setup(); await login();
  request.mockResolvedValueOnce(envelope({ state: 'replayed', invitation: metadata, token: null }));
  await api.issue(); expect(api.getSnapshot()).toMatchObject({ recovery: 'revoke_required', issuedToken: null });
});
it('an uncertain revoke retries its exact old ID after metadata changes, without revoking the replacement', async () => {
  const { api, login, request } = setup(); await login(); await api.issue();
  request.mockRejectedValueOnce(new Error('lost acknowledgement')); await api.revoke();
  expect(api.getSnapshot()).toMatchObject({ recovery: 'revoke_uncertain', issuedToken: null });
  api.cancel(); request.mockResolvedValueOnce(envelope({ state: 'current', invitation: { ...metadata, id: uuid(30) } }));
  await api.readMetadata(); await api.issue(); await api.revoke();
  expect(await request.mock.calls.at(-1)![0].json()).toEqual({ inviteId: metadata.id });
  expect(api.getSnapshot()).toMatchObject({ recovery: 'none', invitation: { id: uuid(30) } });
});
it('a lost revoke followed by metadata null still retries saved ID', async () => {
  const { api, login, request } = setup(); await login(); await api.readMetadata();
  request.mockResolvedValueOnce(errorResponse()); await api.revoke();
  request.mockResolvedValueOnce(envelope({ state: 'current', invitation: null })); await api.readMetadata(); await api.revoke();
  expect(await request.mock.calls.at(-1)![0].json()).toEqual({ inviteId: metadata.id });
  expect(api.getSnapshot().recovery).toBe('none');
});
it('known issue denial is distinct from uncertainty; known revoke denial never retargets silently', async () => {
  const { api, login, request } = setup(); await login();
  request.mockResolvedValueOnce(errorResponse('invitation_exists', 409)); await api.issue();
  expect(api.getSnapshot()).toMatchObject({ recovery: 'none', error: 'invitation_unavailable' });
  await api.readMetadata(); request.mockResolvedValueOnce(errorResponse('invitation_unavailable', 409)); await api.revoke();
  expect(api.getSnapshot()).toMatchObject({ recovery: 'revoke_uncertain', error: 'invitation_unavailable' });
});
it('recipient requires manual valid token, explicit preview, and separate explicit consent', async () => {
  const { api, login, request } = setup(recipient); await login();
  api.setConsent(true); await api.accept(); expect(api.getSnapshot().error).toBe('invitation_consent_required');
  api.setToken('bad'); await api.preview(); expect(api.getSnapshot().error).toBe('invitation_token_invalid');
  expect(request).not.toHaveBeenCalled();
  api.setToken(token); await api.accept(); expect(request).not.toHaveBeenCalled();
  await api.preview(); expect(api.getSnapshot()).toMatchObject({ preview: { expiresAt: metadata.expiresAt }, consent: false });
  await api.accept(); expect(request).toHaveBeenCalledTimes(1);
  api.setConsent(true); expect(api.getSnapshot().consent).toBe(true);
  api.setToken(otherToken); expect(api.getSnapshot()).toMatchObject({ preview: null, consent: false, recovery: 'none' });
  api.setToken(otherToken); expect(api.getSnapshot().tokenInput).toBe(otherToken);
});
it('acknowledged accept refreshes authoritative context and only then enables chat', async () => {
  const { api, controller, login, request, discovery, consent } = setup(recipient); await login(); await consent();
  request.mockImplementation(async input => {
    if (input.url.endsWith('/accept')) { discovery.mockImplementation(async () => envelope(ready)); return accepted(); }
    return envelope({ messages: [], nextBeforeSeq: null });
  });
  await api.accept(); expect(controller.getSnapshot().phase).toBe('signed_in');
  expect(api.getSnapshot()).toMatchObject({ mode: 'unavailable', tokenInput: '', preview: null, consent: false });
});
it.each(['no_active_pair', 'ready'])('lost accept ACK retries exact approved token directly when context becomes %s', async state => {
  const { api, login, request, discovery, consent } = setup(recipient); await login(); await consent();
  request.mockResolvedValueOnce(errorResponse()); await api.accept();
  expect(api.getSnapshot()).toMatchObject({ recovery: 'accept_uncertain', tokenInput: token, consent: true });
  const count = request.mock.calls.length; await api.preview(); expect(request).toHaveBeenCalledTimes(count);
  api.setConsent(false); expect(api.getSnapshot().consent).toBe(true);
  if (state === 'ready') discovery.mockImplementation(async () => envelope(ready));
  request.mockImplementation(async input => input.url.endsWith('/accept') ? accepted() : envelope({ messages: [], nextBeforeSeq: null }));
  await api.accept(); const accepts = request.mock.calls.filter(([r]) => r.url.endsWith('/accept'));
  expect(accepts).toHaveLength(2);
  for (const [req] of accepts) expect(await req.json()).toEqual({ token, accept: true });
  expect(request.mock.calls.filter(([r]) => r.url.endsWith('/preview'))).toHaveLength(1);
});
it('unavailable accept clears consent/preview and requires a new explicit decision', async () => {
  const { api, login, request, consent } = setup(recipient); await login(); await consent();
  request.mockResolvedValueOnce(errorResponse('invitation_unavailable', 409)); await api.accept();
  expect(api.getSnapshot()).toMatchObject({ recovery: 'none', preview: null, consent: false, error: 'invitation_unavailable' });
  await api.accept(); expect(request).toHaveBeenCalledTimes(2);
});
it.each(['sessionId', 'userId'])('mismatched accept acknowledgement %s terminally clears state', async field => {
  const { api, controller, login, request, consent } = setup(recipient); await login(); await consent();
  request.mockResolvedValueOnce(envelope({ state: 'accepted', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 2, replayed: false,
    [field]: field === 'sessionId' ? 'different-session' : uuid(99) }));
  await api.accept(); expect(controller.getSnapshot()).toMatchObject({ phase: 'blocked', error: 'auth_required' });
  expect(api.getSnapshot()).toMatchObject({ mode: 'unavailable', tokenInput: '', consent: false });
});
it.each(['read', 'issue', 'revoke', 'preview', 'accept'])('auth denial in %s clears all invitation secrets', async operation => {
  const { api, controller, login, request, consent } = setup(operation === 'preview' || operation === 'accept' ? recipient : owner);
  await login();
  if (operation === 'accept') await consent();
  if (operation === 'preview') api.setToken(token);
  if (operation === 'revoke' || operation === 'read') await api.issue();
  request.mockResolvedValueOnce(errorResponse('unauthenticated', 401));
  await ({ read: api.readMetadata, issue: api.issue, revoke: api.revoke, preview: api.preview, accept: api.accept })[operation]!();
  expect(controller.getSnapshot().error).toBe('auth_required'); expect(api.getSnapshot().issuedToken).toBeNull(); expect(api.getSnapshot().tokenInput).toBe('');
});
it('duplicate presses and cross-operation actions do not queue mutation or preview work', async () => {
  const { api, controller, login, request, consent } = setup(recipient); await login(); await consent();
  const hold = deferred<Response>(); request.mockReturnValueOnce(hold.promise);
  const pending = api.accept(); await settle();
  await api.accept(); await api.preview(); await api.readMetadata(); await api.issue(); await controller.createWaitingSpace();
  api.setConsent(false); expect(api.getSnapshot().consent).toBe(true); expect(request).toHaveBeenCalledTimes(2);
  hold.resolve(errorResponse()); await pending;
});
it('metadata read and issue are mutually serialized, including a duplicate read', async () => {
  const { api, login, request } = setup(); await login(); const hold = deferred<Response>(); request.mockReturnValueOnce(hold.promise);
  const pending = api.readMetadata(); await settle(); await api.readMetadata(); await api.issue(); await api.revoke();
  expect(request).toHaveBeenCalledTimes(1); hold.resolve(envelope({ state: 'current', invitation: null })); await pending;
});
it('preflight and mutation always use the same captured official cookie', async () => {
  const { api, login, request, discovery, client } = setup(); await login(); client.getCookie.mockClear();
  await api.issue(); expect(client.getCookie).toHaveBeenCalledTimes(3);
  expect(discovery.mock.calls.at(-1)![0].headers.get('cookie')).toBe(cookie);
  expect(request.mock.calls.at(-1)![0].headers.get('cookie')).toBe(cookie);
});
it('expired metadata can be explicitly replaced, with no automatic issuance', async () => {
  const { api, login, request } = setup(); await login(); request.mockResolvedValueOnce(envelope({ state: 'current', invitation: { ...metadata, status: 'expired' } }));
  await api.readMetadata(); expect(request).toHaveBeenCalledTimes(1); await api.issue(); expect(api.getSnapshot().issuedToken).toBe(token);
});
it('preview errors preserve input but never fabricate consent or a reservation', async () => {
  const { api, login, request } = setup(recipient); await login(); api.setToken(token); request.mockResolvedValueOnce(errorResponse());
  await api.preview(); expect(api.getSnapshot()).toMatchObject({ tokenInput: token, preview: null, consent: false, error: 'invitation_retry_required' });
});
it('cancel clears accepted token retry secrets and preview but never claims rollback', async () => {
  const { api, login, request, consent } = setup(recipient); await login(); await consent(); request.mockResolvedValueOnce(errorResponse()); await api.accept();
  api.cancel(); expect(api.getSnapshot()).toMatchObject({ recovery: 'none', tokenInput: '', preview: null, consent: false });
  await api.accept(); expect(request).toHaveBeenCalledTimes(2);
});
