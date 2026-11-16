import { limitRequestBody } from './request-limits.ts';

/** Scan JSON grammar before parsing: JSON.parse alone silently accepts duplicate keys.
 * Decoded keys are compared in each object, including escaped and nested names.
 * A depth cap bounds recursion independently of the byte cap. No keys are assigned.
 */
export function parseDisputesJson(text: string): unknown {
  let cursor = 0;
  const fail = (): never => { throw new Error('invalid_body'); };
  const space = () => { while (cursor < text.length && /[ \t\n\r]/.test(text[cursor])) cursor++; };
  function string(): string {
    const start = cursor;
    if (text[cursor++] !== '"') return fail();
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '"') return JSON.parse(text.slice(start, cursor)) as string;
      if (char === '\\') cursor++;
    }
    return fail();
  }
  function value(depth: number): void {
    if (depth > 64) fail();
    space();
    if (text[cursor] === '"') { string(); return; }
    if (text[cursor] === '{') {
      cursor++; space(); const keys = new Set<string>();
      if (text[cursor] === '}') { cursor++; return; }
      for (;;) {
        space(); const key = string(); if (keys.has(key)) fail(); keys.add(key);
        space(); if (text[cursor++] !== ':') fail(); value(depth + 1); space();
        const separator = text[cursor++]; if (separator === '}') return; if (separator !== ',') fail();
      }
    }
    if (text[cursor] === '[') {
      cursor++; space(); if (text[cursor] === ']') { cursor++; return; }
      for (;;) {
        value(depth + 1); space(); const separator = text[cursor++];
        if (separator === ']') return; if (separator !== ',') fail();
      }
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(cursor));
    if (!primitive) fail(); else cursor += primitive[0].length;
  }
  value(0); space(); if (cursor !== text.length) fail();
  return JSON.parse(text);
}

/** Independent bounds also protect direct handler use outside the application wrapper. */
export async function readDisputesJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('invalid_body');
  const bounded = await limitRequestBody(request, { bodyBytes: 65536, bodyReadMs: 1000 });
  return parseDisputesJson(new TextDecoder('utf-8', { fatal: true }).decode(await bounded.arrayBuffer()));
}
