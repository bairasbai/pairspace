import { fixture, slot, id, prefs, envelope, deferred, scope } from './mornings.fixture';
test('preference CAS, explicit assignment snapshot and one-time fill never write on reads or selection', async () => {
    const h = fixture();
    await h.actions.list();
    h.actions.selectSlot(id(10));
    h.actions.setDraft('Утро\nGood morning');
    expect(h.write).not.toHaveBeenCalled();
    h.actions.setPreference({ timezone: 'utc', localTime: '08:30' });
    await h.actions.savePreference();
    expect(await h.write.mock.calls[0][0].clone().json()).toMatchObject({ expected_version: 1, timezone: 'UTC', local_time: '08:30' });
    h.actions.setLocalDate('2030-01-04');
    h.actions.requestAssignment();
    expect(h.actions.getSnapshot().confirmation).toMatchObject({ kind: 'assign', localDate: '2030-01-04', offset: '+00:00', releaseAt: '2030-01-04T09:00:00.000Z' });
    expect(h.write).toHaveBeenCalledTimes(1);
    await h.actions.confirm('obsolete');
    expect(h.write).toHaveBeenCalledTimes(1);
    await h.actions.confirm(h.actions.getSnapshot().confirmation!.token);
    expect(h.write).toHaveBeenCalledTimes(2);
    h.actions.selectSlot(id(10));
    h.actions.requestFill();
    const token = h.actions.getSnapshot().confirmation!.token;
    h.actions.cancelConfirmation();
    await h.actions.confirm(token);
    expect(h.write).toHaveBeenCalledTimes(2);
    h.actions.requestFill();
    await h.actions.confirm(h.actions.getSnapshot().confirmation!.token);
    expect(h.actions.getSnapshot()).toMatchObject({ draft: '', selected: { prepared: true } });
    expect(JSON.stringify(h.actions.getSnapshot().slots)).not.toContain('Good morning');
});
test('unknown fill retry pins original body/slot, preserves a newer draft and another selection', async () => {
    const h = fixture();
    await h.actions.list();
    h.actions.selectSlot(id(10));
    h.actions.setDraft('first');
    h.actions.requestFill();
    h.write.mockRejectedValueOnce(Error('lost ACK'));
    await h.actions.confirm(h.actions.getSnapshot().confirmation!.token);
    const original = await h.write.mock.calls[0][0].clone().json();
    expect(h.actions.getSnapshot().status).toBe('unknown');
    h.actions.selectSlot(id(11));
    h.actions.setDraft('other slot draft');
    await h.actions.retry();
    expect(await h.write.mock.calls[1][0].clone().json()).toEqual(original);
    expect(h.actions.getSnapshot()).toMatchObject({ selected: { id: id(11) }, draft: 'other slot draft' });
    h.actions.selectSlot(id(10));
    expect(h.actions.getSnapshot().draft).toBe('');
});
test('held fill ACK does not clear a new revision after clear-and-retype', async () => {
    const h = fixture();
    await h.actions.list();
    h.actions.selectSlot(id(10));
    h.actions.setDraft('submitted');
    h.actions.requestFill();
    const held = deferred();
    h.write.mockReturnValueOnce(held.promise);
    const saving = h.actions.confirm(h.actions.getSnapshot().confirmation!.token);
    while (!h.write.mock.calls.length)
        await Promise.resolve();
    h.actions.clearDraft();
    h.actions.setDraft('new revision');
    const input = await h.write.mock.calls[0][0].clone().json();
    held.resolve(envelope({ commandId: input.command_id, replay: false, slot: { ...slot(10), prepared: true } }));
    await saving;
    expect(h.actions.getSnapshot().draft).toBe('new revision');
});
test('recipient reads reveal no body or readiness before explicit open, latch survives clock rollback', async () => {
    const h = fixture(), ready = { ...slot(10, true), state: 'available' as const };
    h.read.mockImplementation(async (request) => {
        const readId = new URL(request.url).searchParams.get('read_id');
        return request.url.includes('/slots/') ? envelope({ readId, serverNow: '2030-01-02T10:00:00.000Z', slot: ready })
            : envelope({ readId, serverNow: '2030-01-02T10:00:00.000Z', preferences: prefs, slots: [ready], hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null, lastAvailableId: ready.id });
    });
    await h.actions.list();
    await h.actions.openLastAvailable();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.actions.getSnapshot().opened).toBeNull();
    const opened = { ...ready, openedAt: '2030-01-02T10:00:00.000Z' };
    h.write.mockImplementation(async (request) => envelope({ commandId: (await request.clone().json()).command_id, replay: false, slot: opened, body: 'For you' }));
    await h.actions.open(ready.id);
    expect(h.actions.getSnapshot().opened?.body).toBe('For you');
    expect(h.actions.getSnapshot().selected?.openedAt).toBe(opened.openedAt);
    expect(h.write.mock.calls[0][0].url).toContain('/open');
    h.read.mockImplementation(async (request) => envelope({ readId: new URL(request.url).searchParams.get('read_id'), serverNow: '2030-01-01T00:00:00.000Z', slot: opened, body: 'For you' }));
    await h.actions.open(ready.id);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.actions.getSnapshot().opened?.body).toBe('For you');
});
test('late old account ACK and read never populate the new user', async () => {
    const h = fixture();
    await h.actions.list();
    h.actions.selectSlot(id(10));
    h.actions.setDraft('old account');
    h.actions.requestFill();
    const held = deferred();
    h.write.mockReturnValueOnce(held.promise);
    const saving = h.actions.confirm(h.actions.getSnapshot().confirmation!.token);
    while (!h.write.mock.calls.length)
        await Promise.resolve();
    const command = await h.write.mock.calls[0][0].clone().json();
    h.setCapture({ generation: 2, identity: { userId: 'new', sessionId: 'new' }, context: { ...scope, sessionId: 'new', userId: id(5), coupleId: id(6) } });
    held.resolve(envelope({ commandId: command.command_id, replay: false, slot: { ...slot(10), prepared: true } }));
    await saving;
    expect(h.actions.getSnapshot()).toMatchObject({ available: true, draft: '', slots: [], selected: null });
    expect(h.actions.getSnapshot().pendingId).toBeUndefined();
});

test('a repeated local time requires explicit offset and confirms the exact zone/instant', async () => {
    const h = fixture();
    h.read.mockImplementation(async request => envelope({ readId: new URL(request.url).searchParams.get('read_id'), serverNow: '2030-01-01T00:00:00.000Z',
        preferences: [prefs[0], { ...prefs[1], timezone: 'America/New_York', localTime: '01:30' }], slots: [],
        hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null, lastAvailableId: null }));
    await h.actions.list(); h.actions.setLocalDate('2030-11-03');
    expect(h.actions.getSnapshot().choices).toHaveLength(2); expect(h.actions.getSnapshot().offset).toBe('');
    h.actions.requestAssignment(); expect(h.actions.getSnapshot().confirmation).toBeUndefined();
    h.actions.chooseOffset('invalid'); expect(h.actions.getSnapshot().offset).toBe('');
    h.actions.chooseOffset('-05:00'); h.actions.requestAssignment();
    expect(h.actions.getSnapshot().confirmation).toMatchObject({ localDate: '2030-11-03', offset: '-05:00', releaseAt: '2030-11-03T06:30:00.000Z', preference: { timezone: 'America/New_York', localTime: '01:30' } });
    expect(h.write).not.toHaveBeenCalled();
});
test('unknown recipient-open retry pins its slot but never displays old body under a newly selected morning', async () => {
    const h = fixture(), a = { ...slot(10, true), state: 'available' as const }, b = { ...slot(11), state: 'available' as const, prepared: true };
    h.read.mockImplementation(async request => envelope({ readId: new URL(request.url).searchParams.get('read_id'), serverNow: '2030-01-02T10:00:00.000Z', preferences: prefs,
        slots: [b, a], hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null, lastAvailableId: a.id }));
    await h.actions.list(); h.actions.selectSlot(a.id); h.write.mockRejectedValueOnce(Error('lost open ACK'));
    await h.actions.open(a.id); const original = await h.write.mock.calls[0][0].clone().json();
    h.actions.selectSlot(b.id); h.actions.setDraft('new selected text');
    h.write.mockImplementation(async request => envelope({ commandId: (await request.clone().json()).command_id, replay: true,
        slot: { ...a, openedAt: '2030-01-02T10:00:00.000Z' }, body: 'old selected body' }));
    await h.actions.retry(); expect(await h.write.mock.calls[1][0].clone().json()).toEqual(original);
    expect(h.actions.getSnapshot()).toMatchObject({ selected: { id: b.id }, draft: 'new selected text', opened: null });
    expect(JSON.stringify(h.actions.getSnapshot())).not.toContain('old selected body');
});
