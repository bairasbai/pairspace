import { expect, it } from 'vitest';
import { parseHistory, parseSend } from '../src/validation.ts';
import { normalizeMessageText } from '../../../packages/domain/chat/text.ts';
import { command, history } from './fixtures.ts';

it.each([null, [], 2, {}, { ...command, coupleId: 'bad' }, { ...command, clientId: 'bad' },
  { ...command, membershipEpoch: 0 }, { ...command, membershipEpoch: '1' }, { ...command, membershipEpoch: 2147483647 }])('rejects invalid send %p', value => {
  expect(parseSend(value)).toEqual({ ok: false, error: 'invalid_request' });
});
it.each([null, [], {}, { ...history, coupleId: 'bad' }, { ...history, membershipEpoch: 0 },
  { ...history, limit: 0 }, { ...history, limit: 101 }, { ...history, limit: 1.5 }, { ...history, limit: '2' },
  { ...history, beforeSeq: 0 }, { ...history, beforeSeq: '1' }, { ...history, beforeSeq: Infinity }])('rejects invalid history %p', value => {
  expect(parseHistory(value)).toEqual({ ok: false, error: 'invalid_request' });
});
it('uses the one shared normalization implementation', () => {
  expect(parseSend({ ...command, body: 'e\u0301\r\n' })).toMatchObject({ ok: true, value: { body: 'é\n' } });
  expect(normalizeMessageText('\u0000')).toMatchObject({ ok: false, error: 'invalid_text' });
  expect(normalizeMessageText(null)).toMatchObject({ ok: false, error: 'invalid_text' });
  expect(normalizeMessageText('\ud800')).toMatchObject({ ok: false, error: 'invalid_text' });
  expect(normalizeMessageText('\udc00')).toMatchObject({ ok: false, error: 'invalid_text' });
  expect(normalizeMessageText('😀'.repeat(8000))).toMatchObject({ ok: true });
  expect(normalizeMessageText('😀'.repeat(8001))).toMatchObject({ ok: false, error: 'text_too_long' });
  expect(normalizeMessageText(' \t\n')).toMatchObject({ ok: false, error: 'empty_text' });
});
