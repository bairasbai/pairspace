import { expect, it } from 'vitest';
import { parseDisputesJson, readDisputesJson } from '../src/disputes-json.ts';

it.each(['null', 'true', 'false', '0', '-0', '-12.3e+4', '1E-2', '"plain"', '"escaped\\"text"', '"\\u0061"',
  '{}', '[]', '{"a":1,"b":[{},null,false]}', '[{"a":1},{"a":2}]', ' \n\r\t {"a": {"a": 1}} \t', '{"__proto__":1,"constructor":2}'])('accepts valid unique-key JSON %#', raw => {
  expect(parseDisputesJson(raw)).toEqual(JSON.parse(raw));
});
it.each(['', ' ', '{', '[', '"unterminated', '"bad\\q"', '"control\n"', 'undefined', 'NaN', 'Infinity', '+1', '01', '1.',
  '1e', 'truefalse', '{}[]', '{a:1}', '{"a" 1}', '{"a":1;"b":2}', '[1;2]', '[1,]', '{"a":1,}', '\u0000null',
  '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":1}}', '[{"a":1,"\\u0061":2}]',
  '{"outer":{"a":null,"a":null}}', '{"\\u005f_proto__":1,"__proto__":2}', '"dangling\\', '[[]', '{"x":'])('rejects malformed or duplicate-key JSON %#', raw => {
  expect(() => parseDisputesJson(raw)).toThrow();
});
it('bounds recursion without accepting hidden duplicate keys at depth', () => {
  expect(() => parseDisputesJson('['.repeat(66) + '0' + ']'.repeat(66))).toThrow('invalid_body');
  expect(() => parseDisputesJson('{"x":'.repeat(10) + '{"a":1,"a":2}' + '}'.repeat(10))).toThrow('invalid_body');
});
it('reads bounded UTF8 bytes and rejects missing, oversized and malformed byte input', async () => {
  const request = (body?: string | Uint8Array) => new Request('http://localhost/test', { method: 'POST', body });
  expect(await readDisputesJson(request('{"text":"🦉"}'))).toEqual({ text: '🦉' });
  await expect(readDisputesJson(request())).rejects.toThrow();
  await expect(readDisputesJson(request('"' + 'x'.repeat(65536) + '"'))).rejects.toThrow();
  await expect(readDisputesJson(request(new Uint8Array([0xc0, 0xaf])))).rejects.toThrow();
  await expect(readDisputesJson(request('{"x":1,"x":2}'))).rejects.toThrow();
});
