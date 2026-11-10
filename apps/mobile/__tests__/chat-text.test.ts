import { normalizeMessageText } from '../src/chat/text';

it.each([null, 4, {}, [], '\u0000', '\ud800', '\udc00', 'a\ud800x'])('rejects non-text or malformed Unicode %p', input => {
  expect(normalizeMessageText(input)).toEqual({ ok: false, error: 'invalid_text' });
});
it.each(['', ' \n\t ', '\r\n'])('rejects empty/whitespace %p', input => {
  expect(normalizeMessageText(input)).toEqual({ ok: false, error: 'empty_text' });
});
it('normalizes NFC and CRLF without trimming meaningful whitespace', () => {
  expect(normalizeMessageText(' e\u0301\r\nworld\r ')).toEqual({ ok: true, text: ' é\nworld\n ' });
});
it('counts Unicode codepoints after normalization, not UTF16 units', () => {
  expect(normalizeMessageText('😀'.repeat(8000)).ok).toBe(true);
  expect(normalizeMessageText('e\u0301'.repeat(8000)).ok).toBe(true);
  expect(normalizeMessageText('😀'.repeat(8001))).toEqual({ ok: false, error: 'text_too_long' });
});
