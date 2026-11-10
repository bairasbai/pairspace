export type BodyLimits = Readonly<{ bodyBytes: number; bodyReadMs: number }>;
export class RequestLimitError extends Error {
  readonly status: 400 | 408 | 413;
  constructor(status: 400 | 408 | 413) { super('invalid_request'); this.status = status; }
}

/** Limits actual bytes even if Content-Length is missing or dishonest. */
export async function limitRequestBody(request: Request, limits: BodyLimits): Promise<Request> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) throw new RequestLimitError(400);
    if (Number(declared) > limits.bodyBytes) throw new RequestLimitError(413);
  }
  if (!request.body) return request;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reading = (async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limits.bodyBytes) throw new RequestLimitError(413);
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    })();
    const bytes = await Promise.race([reading, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RequestLimitError(408)), limits.bodyReadMs);
    })]);
    return new Request(request, { body: bytes });
  } catch (error) {
    // Do not await an untrusted stream's cancellation callback indefinitely.
    void reader.cancel().catch(() => {});
    if (error instanceof RequestLimitError) throw error;
    throw new RequestLimitError(400);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
