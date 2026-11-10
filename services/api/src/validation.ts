import { normalizeMessageText } from '../../../packages/domain/chat/text.ts';
import type { HistoryCommand, Result, SendCommand } from './contracts.ts';

export const isUuid = (input: unknown): input is string => typeof input === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input);
export const isEpoch = (input: unknown): input is number => typeof input === 'number'
  && Number.isSafeInteger(input) && input > 0 && input < 2147483647;
function record(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
export function parseSend(input: unknown): Result<SendCommand> {
  if (!record(input) || !isUuid(input.coupleId) || !isUuid(input.clientId) || !isEpoch(input.membershipEpoch)) {
    return { ok: false, error: 'invalid_request' };
  }
  const body = normalizeMessageText(input.body);
  if (!body.ok) return body;
  return { ok: true, value: { coupleId: input.coupleId, clientId: input.clientId,
    membershipEpoch: input.membershipEpoch, body: body.text } };
}
export function parseHistory(input: unknown): Result<HistoryCommand> {
  if (!record(input) || !isUuid(input.coupleId) || !isEpoch(input.membershipEpoch)
    || typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || (input.beforeSeq !== undefined && (typeof input.beforeSeq !== 'number' || !Number.isSafeInteger(input.beforeSeq) || input.beforeSeq < 1))) {
    return { ok: false, error: 'invalid_request' };
  }
  return { ok: true, value: { coupleId: input.coupleId, membershipEpoch: input.membershipEpoch,
    limit: input.limit, beforeSeq: input.beforeSeq as number | undefined } };
}
