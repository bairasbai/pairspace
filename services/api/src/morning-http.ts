import type { AuthorizedDatabase } from './contracts.ts';
import { isUuid } from './validation.ts';
import { readJson } from './http.ts';
import { windowReadId } from './chat-history-window-http.ts';
import { commandMorning } from './morning-commands.ts';
import { listMornings, readMorning } from './morning-read.ts';
import { draftMorningV2 } from './morning-draft-v2.ts';
import { draftMorning } from './morning-draft.ts';
import { preparedMorning } from './morning-prepared.ts';
import { openMorning } from './morning-open.ts';
export function createMorningsHandler(db: AuthorizedDatabase) {
    return async (request: Request): Promise<Response> => {
        const reading = request.method === 'GET';
        const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
        const fail = (status: number, error: string) => json(status, { ok: false, error, ...(reading ? { readId: windowReadId(request) } : {}) });
        try {
            const url = new URL(request.url);
            const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/mornings(?:\/(preference|slots)(?:\/([^/]+)(?:\/(body|open|prepared|draft|draft-v2))?)?)?$/);
            if (!route)
                return fail(404, 'not_found');
            const [, coupleId, kind, slotId, action] = route;
            const draftV2 = action === 'draft-v2', remove = draftV2 && request.method === 'DELETE';
            const draft = action === 'draft' || draftV2;
            const prepared = action === 'prepared' || draft;
            const privateContent = draft ? draftMorning : preparedMorning;
            if (prepared && kind !== 'slots')
                return fail(404, 'not_found');
            const operation = kind === 'preference' && !slotId ? 'preference' : kind === 'slots' && !slotId ? 'schedule' : action === 'body' ? 'fill' : action === 'open' ? 'open' : null;
            const expected = remove ? 'DELETE' : prepared ? (reading ? 'GET' : 'PUT') : operation === 'preference' || operation === 'fill' ? 'PUT' : operation ? 'POST' : 'GET';
            if (request.method !== expected || (!prepared && !operation && kind !== 'slots' && kind !== undefined))
                return fail(405, 'method_not_allowed');
            const p = await db.sessionAuthority.authenticate(request);
            if (!p || p.source !== db.sessionAuthority.source || !isUuid(p.userId))
                return fail(401, 'unauthenticated');
            if (reading) {
                const q = url.searchParams, anchored = q.get('direction') === 'before' || q.get('direction') === 'after';
                const keys = ['membership_epoch', 'read_id', ...(slotId ? [] : ['direction', ...(anchored ? ['anchor_id', 'anchor_release_at'] : [])])];
                if ([...q.keys()].length !== keys.length || keys.some(k => q.getAll(k).length !== 1)
                    || !/^[1-9][0-9]*$/.test(q.get('membership_epoch') ?? '') || !windowReadId(request))
                    return fail(400, 'invalid_request');
                const scope = { coupleId, membershipEpoch: Number(q.get('membership_epoch')), readId: windowReadId(request) };
                const result = draftV2 ? await draftMorningV2(db, p, { ...scope, slotId }, 'read') : prepared ? await privateContent(db, p, { ...scope, slotId }, false) : slotId ? await readMorning(db, p, { ...scope, slotId }) : await listMornings(db, p, { ...scope, direction: q.get('direction'),
                    ...(anchored ? { anchorId: q.get('anchor_id'), anchorReleaseAt: q.get('anchor_release_at') } : {}) });
                if (!result.ok)
                    return fail(result.error === 'unavailable' ? 403 : result.error === 'stale_membership' || result.error === 'slot_closed' || result.error === 'slot_filled' || result.error === 'draft_deleted' ? 409 : 400, result.error);
                return json(200, result);
            }
            if (url.search)
                return fail(400, 'invalid_request');
            if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
                return fail(415, 'unsupported_media_type');
            let raw: unknown;
            try {
                raw = await readJson(request);
            }
            catch {
                return fail(400, 'invalid_request');
            }
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                return fail(400, 'invalid_request');
            const f = raw as Record<string, unknown>;
            const keys = ['membership_epoch', 'command_id', ...(prepared ? ['expected_version', remove ? 'confirm' : 'body'] : operation === 'preference' ? ['expected_version', 'timezone', 'local_time']
                    : operation === 'schedule' ? ['preference_version', 'local_date', 'offset'] : operation === 'fill' ? ['body'] : ['confirm'])];
            if (Object.keys(f).sort().join(',') !== keys.sort().join(',') || !isUuid(f.command_id)
                || request.headers.get('idempotency-key') !== f.command_id)
                return fail(400, 'invalid_request');
            const scope = { coupleId, membershipEpoch: f.membership_epoch, commandId: f.command_id };
            const result = draftV2 ? await draftMorningV2(db, p, { ...scope, slotId, expectedVersion: f.expected_version, ...(remove ? { confirm: f.confirm } : { body: f.body }) }, remove ? 'delete' : 'save') : prepared ? await privateContent(db, p, { ...scope, slotId, expectedVersion: f.expected_version, body: f.body }, true) : operation === 'open' ? await openMorning(db, p, { ...scope, slotId, confirm: f.confirm })
                : await commandMorning(db, p, { ...scope, ...(operation === 'preference' ? { expectedVersion: f.expected_version, timezone: f.timezone, localTime: f.local_time }
                        : operation === 'schedule' ? { preferenceVersion: f.preference_version, localDate: f.local_date, offset: f.offset } : { slotId, body: f.body }) }, operation!);
            if (!result.ok && 'value' in result) return json(409, result);
            if (!result.ok)
                return fail(result.error === 'invalid_request' ? 400 : result.error === 'unavailable' ? 403 : 409, result.error);
            return json(200, result);
        }
        catch {
            return fail(503, 'temporarily_unavailable');
        }
    };
}
