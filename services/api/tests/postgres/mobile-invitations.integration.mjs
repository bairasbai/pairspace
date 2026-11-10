import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeTask, barrierOrCompletion, withDeadline } from './async-bounds.mjs';
import { gate } from './profile-fixture.mjs';
import { acceptPath, assertCleared, closeMobile, createMobileFixture, digest, invitationPath,
  issueToken, memberState, mobile, password, previewPath, previewToken, profile, waiting,
} from './mobile-invitations-fixture.mjs';

function assertSameBinding(account, path) {
  for (const [index, request] of account.requests.entries()) {
    if (request.path !== path) continue;
    const binding = account.requests.slice(0, index).findLast(r => r.path === '/v1/session/context');
    assert.equal(Boolean(binding) && binding.cookieDigest === request.cookieDigest, true,
      'mutation uses the exact cookie captured for its authoritative context binding');
  }
}

test('actual mobile controllers: explicit profile → own waiting → invitation consent → two contexts at epoch 2 → chat', async () => {
  const f = await createMobileFixture(); const accounts = [];
  try {
    const owner = await mobile(f, 0); accounts.push(owner);
    const recipient = await mobile(f, 1); accounts.push(recipient);
    const outsider = await mobile(f, 2); accounts.push(outsider);
    await waiting(owner); await profile(recipient); await waiting(outsider);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM better_auth_identities')).rows[0].n, 3);
    assert.equal((await memberState(f)).every(row => row.status === 'waiting_partner' && row.members === 1), true);
    const token = await issueToken(owner);
    const first = owner.invitations.getSnapshot().invitation;
    const stored = (await f.domainPool.query('SELECT token_hash FROM pair_invites WHERE id=$1', [first.id])).rows[0];
    assert.equal(stored.token_hash === digest(token), true, 'only the token digest is stored');
    await owner.invitations.readMetadata();
    assert.equal(owner.count(invitationPath), 1);
    assert.equal(owner.invitations.getSnapshot().invitation.id, first.id);
    await outsider.invitations.readMetadata();
    assert.equal(outsider.invitations.getSnapshot().invitation, null, 'other owner cannot discover this invitation');
    outsider.invitations.setToken(token); outsider.invitations.setConsent(true);
    await outsider.invitations.preview(); await outsider.invitations.accept();
    assert.equal(outsider.count(previewPath) + outsider.count(acceptPath), 0, 'own waiting membership blocks recipient UI');
    assert.equal(outsider.invitations.getSnapshot().tokenInput.length, 0);

    await previewToken(recipient, token);
    assert.equal(recipient.invitations.getSnapshot().consent, false);
    await recipient.invitations.accept();
    assert.equal(recipient.count(acceptPath), 0, 'preview without explicit consent cannot accept');
    recipient.invitations.setConsent(true);
    recipient.invitations.setToken('A'.repeat(43));
    assert.equal(recipient.invitations.getSnapshot().preview, null);
    assert.equal(recipient.invitations.getSnapshot().consent, false);
    await recipient.invitations.accept();
    assert.equal(recipient.count(acceptPath), 0, 'edited token cannot reuse a prior preview/consent');
    await previewToken(recipient, token);
    recipient.invitations.setConsent(true);
    await recipient.invitations.accept();
    await owner.controller.refresh();
    for (const account of [owner, recipient]) {
      assert.equal(account.controller.getSnapshot().phase, 'signed_in');
      const context = account.contexts.at(-1);
      assert.equal(context.state, 'ready'); assert.equal(context.membershipEpoch, 2);
      assert.equal(context.coupleId, owner.contexts.at(-1).coupleId);
      assertCleared(account);
    }
    const pairId = owner.contexts.at(-1).coupleId;
    const joined = (await memberState(f)).find(row => row.id === pairId);
    assert.deepEqual({ status: joined.status, members: joined.members, epoch: joined.membership_epoch },
      { status: 'active', members: 2, epoch: 2 });
    owner.controller.setDraft('Synthetic owner invitation chat'); await owner.controller.send();
    recipient.controller.setDraft('Synthetic recipient invitation chat'); await recipient.controller.send();
    await owner.controller.refresh(); await recipient.controller.refresh();
    for (const account of [owner, recipient]) {
      assert.equal(account.controller.getSnapshot().messages.length, 2);
      assert.equal(account.controller.getSnapshot().draft.length, 0);
    }
    const forbidden = await fetch(`${f.baseURL}/v1/couples/${pairId}/chat/messages?membership_epoch=2&limit=50`,
      { headers: { origin: f.baseURL, cookie: await outsider.connection.getCookie() } });
    assert.equal(forbidden.status, 403);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages')).rows[0].n, 2);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 2);
    assertSameBinding(owner, invitationPath); assertSameBinding(recipient, acceptPath);
  } finally { await closeMobile(f, accounts); }
});

test('mobile lost issue/revoke acknowledgements: metadata recovery and stale targeted revoke preserve a replacement', async () => {
  const f = await createMobileFixture(); const accounts = [];
  let loseIssue = true; let loseRevoke = true; let rotateCookie = false; let owner;
  try {
    owner = await mobile(f, 0, { afterResponse: async (request, response) => {
      if (rotateCookie && request.path === '/v1/session/context') {
        rotateCookie = false;
        const login = await owner.connection.auth.signIn.email({ email: owner.email, password });
        assert.equal(login.error === null, true, 'cookie rotation uses another actual provider session');
      }
      if (request.path !== invitationPath) return;
      if (request.method === 'POST' && loseIssue) {
        loseIssue = false; assert.equal(response.status, 201);
        throw new Error('Synthetic issue acknowledgement lost after COMMIT');
      }
      if (request.method === 'DELETE' && loseRevoke) {
        loseRevoke = false; assert.equal(response.status, 200);
        throw new Error('Synthetic revoke acknowledgement lost after COMMIT');
      }
    } }); accounts.push(owner);
    await waiting(owner); await owner.invitations.readMetadata(); await owner.invitations.issue();
    assert.equal(owner.invitations.getSnapshot().recovery, 'issue_uncertain');
    assert.equal(owner.invitations.getSnapshot().issuedToken === null, true);
    await owner.invitations.issue();
    assert.equal(owner.count(invitationPath), 1, 'unknown issue cannot create another command blindly');
    await owner.invitations.readMetadata(); await owner.invitations.readMetadata();
    const original = owner.invitations.getSnapshot().invitation;
    assert.equal(original?.status, 'pending');
    assert.equal(owner.invitations.getSnapshot().recovery, 'revoke_required');
    assert.equal(owner.invitations.getSnapshot().issuedToken === null, true, 'metadata cannot recover a lost raw token');
    await owner.invitations.revoke();
    assert.equal(owner.invitations.getSnapshot().recovery, 'revoke_uncertain');
    const otherSession = await mobile(f, 0, { email: owner.email, signup: false }); accounts.push(otherSession);
    const replacementToken = await issueToken(otherSession);
    const replacement = otherSession.invitations.getSnapshot().invitation;
    assert.equal(original.id !== replacement.id && original.commandId !== replacement.commandId, true);
    await owner.invitations.readMetadata();
    assert.equal(owner.invitations.getSnapshot().invitation.id, replacement.id);
    assert.equal(owner.invitations.getSnapshot().issuedToken === null, true);
    await owner.invitations.revoke();
    const targets = owner.requests.filter(r => r.path === invitationPath && r.method === 'DELETE');
    assert.equal(targets.length, 2);
    assert.equal(targets.every(r => r.inviteId === original.id), true, 'retry remains bound to old invitation ID');
    const rows = (await f.domainPool.query('SELECT id,revoked_at,token_hash FROM pair_invites')).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.id === original.id).revoked_at !== null, true);
    const current = rows.find(row => row.id === replacement.id);
    assert.equal(current.revoked_at, null);
    assert.equal(current.token_hash === digest(replacementToken), true);
    assertSameBinding(owner, invitationPath); assertSameBinding(otherSession, invitationPath);
    // Change the official SDK cookie after context verification but before the next mutation.
    // A valid second session is still not the session captured by this controller.
    const deletesBeforeRotation = owner.count(invitationPath, 'DELETE');
    rotateCookie = true; await owner.invitations.revoke();
    assert.equal(owner.count(invitationPath, 'DELETE'), deletesBeforeRotation);
    assert.equal(owner.controller.getSnapshot().error, 'auth_required');
    assertCleared(owner);
    assert.equal((await f.domainPool.query('SELECT revoked_at FROM pair_invites WHERE id=$1', [replacement.id])).rows[0].revoked_at, null);
  } finally { await closeMobile(f, accounts); }
});

test('mobile lost accept acknowledgement retries exact approved token directly and recovers context without another preview', async () => {
  const f = await createMobileFixture(); const accounts = [];
  let loseAccept = true; const replays = [];
  try {
    const owner = await mobile(f, 0); accounts.push(owner);
    const recipient = await mobile(f, 1, { afterResponse: async (request, response) => {
      if (request.path !== acceptPath) return;
      assert.equal(response.status, 200);
      replays.push((await response.clone().json()).value.replayed);
      if (loseAccept) { loseAccept = false; throw new Error('Synthetic accept acknowledgement lost after COMMIT'); }
    } }); accounts.push(recipient);
    await waiting(owner); await profile(recipient);
    const token = await issueToken(owner);
    await previewToken(recipient, token); recipient.invitations.setConsent(true);
    await recipient.invitations.accept();
    assert.equal(recipient.invitations.getSnapshot().recovery, 'accept_uncertain');
    assert.equal(recipient.count(acceptPath), 1);
    assert.equal(recipient.controller.getSnapshot().messages.length, 0);
    assert.equal((await memberState(f))[0].members, 2);
    assert.equal((await memberState(f))[0].membership_epoch, 2);
    await recipient.invitations.accept();
    assert.equal(recipient.count(acceptPath), 2, 'explicit retry directly exercises server acceptance replay');
    assert.equal(recipient.count(previewPath), 1, 'consumed token must not require a new preview');
    assert.deepEqual(replays, [false, true]);
    const posts = recipient.requests.filter(r => r.path === acceptPath);
    assert.equal(posts.every(r => r.tokenDigest === digest(token) && r.accept === true), true);
    assert.equal(posts[0].cookieDigest === posts[1].cookieDigest, true);
    assert.equal(recipient.controller.getSnapshot().phase, 'signed_in');
    assertCleared(recipient);
    await owner.controller.refresh();
    assert.equal(owner.controller.getSnapshot().phase, 'signed_in');
    assert.equal(owner.contexts.at(-1).membershipEpoch, 2);
    assert.equal(recipient.contexts.at(-1).membershipEpoch, 2);
    const rows = await memberState(f);
    assert.equal(rows.length, 1); assert.equal(rows[0].members, 2); assert.equal(rows[0].membership_epoch, 2);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM pair_invites WHERE consumed_at IS NOT NULL')).rows[0].n, 1);
    assertSameBinding(recipient, acceptPath);
  } finally { await closeMobile(f, accounts); }
});

test('mobile logout invalidates pending real issue, preview and accepted responses without claiming committed SQL was undone', async () => {
  const f = await createMobileFixture(); const accounts = []; const tasks = [];
  let activeGate = null; let heldPath = null;
  const afterResponse = async (request, response) => {
    if (request.path === heldPath && request.method === 'POST') {
      assert.equal(response.ok, true);
      // Hold already received real HTTP bytes at the native boundary. Late resolution deliberately
      // ignores cancellation so this proves generation invalidation, not only AbortSignal behavior.
      await activeGate.hook();
    }
  };
  async function logoutWhilePending(account, path, action) {
    heldPath = path; activeGate = gate();
    const task = observeTask(action()); tasks.push(task);
    try {
      await barrierOrCompletion(activeGate.ready, task);
      await account.controller.signOut();
      assert.equal(account.controller.getSnapshot().phase, 'signed_out'); assertCleared(account);
    } finally { heldPath = null; activeGate.release(); }
    await withDeadline(task, 3000, 'Late invitation response');
    assert.equal(account.controller.getSnapshot().phase, 'signed_out'); assertCleared(account);
  }
  try {
    const owner = await mobile(f, 0, { afterResponse }); accounts.push(owner);
    const recipient = await mobile(f, 1, { afterResponse }); accounts.push(recipient);
    await waiting(owner); await profile(recipient); await owner.invitations.readMetadata();
    await logoutWhilePending(owner, invitationPath, () => owner.invitations.issue());
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM pair_invites')).rows[0].n, 1,
      'logout does not undo an already committed issue');
    await owner.controller.signIn(owner.email, password);
    await owner.invitations.readMetadata();
    assert.equal(owner.invitations.getSnapshot().issuedToken === null, true);
    await owner.invitations.revoke(); const token = await issueToken(owner);
    recipient.invitations.setToken(token);
    await logoutWhilePending(recipient, previewPath, () => recipient.invitations.preview());
    await recipient.controller.signIn(recipient.email, password);
    await previewToken(recipient, token); recipient.invitations.setConsent(true);
    await logoutWhilePending(recipient, acceptPath, () => recipient.invitations.accept());
    const rows = await memberState(f);
    assert.equal(rows[0].status, 'active'); assert.equal(rows[0].members, 2); assert.equal(rows[0].membership_epoch, 2);
    await recipient.controller.signIn(recipient.email, password); await owner.controller.refresh();
    assert.equal(recipient.controller.getSnapshot().phase, 'signed_in');
    assert.equal(owner.controller.getSnapshot().phase, 'signed_in');
    assertCleared(recipient);
    assertSameBinding(owner, invitationPath); assertSameBinding(recipient, previewPath); assertSameBinding(recipient, acceptPath);
  } finally { activeGate?.release(); await closeMobile(f, accounts, tasks); }
});
