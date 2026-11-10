import { expect, it, vi } from 'vitest';
import { limitRequestBody } from '../src/request-limits.ts';
const limits = { bodyBytes: 8, bodyReadMs: 100 };
function post(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request('https://fixture.invalid', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
}
it('retains empty-body requests and reconstructs bounded multiple chunks', async () => {
  const get = new Request('https://fixture.invalid'); expect(await limitRequestBody(get, limits)).toBe(get);
  const bounded = await limitRequestBody(post(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('abc')); controller.enqueue(new TextEncoder().encode('def')); controller.close();
  } }), { 'content-length': '6' }), limits);
  expect(await bounded.text()).toBe('abcdef');
});
it('rejects malformed/oversized declarations and actual bytes beyond limit', async () => {
  for (const declared of ['-1', 'no', '999999999999999999999999']) {
    await expect(limitRequestBody(post('a', { 'content-length': declared }), limits)).rejects.toMatchObject({ status: 400 });
  }
  await expect(limitRequestBody(post('a', { 'content-length': '9' }), limits)).rejects.toMatchObject({ status: 413 });
  await expect(limitRequestBody(post('123456789', { 'content-length': '1' }), limits)).rejects.toMatchObject({ status: 413 });
});
it('bounds stalled streams and handles read/cancel failure without leaking details', async () => {
  const cancel = vi.fn(() => Promise.reject(new Error('synthetic cancel')));
  await expect(limitRequestBody(post(new ReadableStream({ cancel })), { ...limits, bodyReadMs: 5 })).rejects.toMatchObject({ status: 408 });
  expect(cancel).toHaveBeenCalledOnce();
  await expect(limitRequestBody(post(new ReadableStream({ pull() { throw new Error('private upstream detail'); } })), limits)).rejects.toMatchObject({ status: 400, message: 'invalid_request' });
});
