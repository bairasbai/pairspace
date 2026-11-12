import { createSessionController as createController } from '../src/auth/controller';
/** Legacy suites exercise authentication/send behavior, not navigation. Convert only
 * their explicit latest /messages fixture facts into the coordinated window DTO.
 * Dedicated window suites import the real controller directly and never use this. */
export const createSessionController: typeof createController = (config, client, request, commandId) =>
  createController(config, client, async input => {
    const url = new URL(input.url);
    const response = await request(input);
    if (!url.pathname.endsWith('/chat/reply-window') || url.searchParams.get('direction') !== 'latest') return response;
    let json: unknown;
    try { json = await response.clone().json(); } catch { return response; }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return response;
    const envelope = json as { ok?: boolean; value?: { messages?: unknown[]; nextBeforeSeq?: number | null }; error?: string };
    if (envelope.ok === false && typeof envelope.error === 'string') {
      return new Response(JSON.stringify({ ...envelope, readId: url.searchParams.get('read_id') }), { status: response.status });
    }
    if (envelope.ok !== true || !envelope.value || !Array.isArray(envelope.value.messages)
      || !Object.hasOwn(envelope.value, 'nextBeforeSeq')) return response;
    const { messages, nextBeforeSeq } = envelope.value;
    const first = messages[0] as { id?: string } | undefined;
    return new Response(JSON.stringify({ ok: true, value: { messages: messages.map(message => ({ ...(message as object), replyToId: null, deletedAt: null })),
      readId: url.searchParams.get('read_id'), hasOlder: nextBeforeSeq !== null, hasNewer: false,
      olderCursor: nextBeforeSeq === null ? null : { id: first?.id, seq: nextBeforeSeq }, newerCursor: null } }), { status: response.status });
  }, commandId);
