/** Preserve the existing per-request timeout and auth-lifecycle cancellation boundary. */
export function createBoundedRequest(request: (request: Request) => Promise<Response>, lifecycle: () => AbortSignal) {
    return async (input: Request) => {
        const controller = new AbortController();
        const signal = lifecycle();
        const cancel = () => controller.abort();
        signal.addEventListener('abort', cancel);
        input.signal.addEventListener('abort', cancel);
        const timer = setTimeout(cancel, 10000);
        try {
            if (signal.aborted || input.signal.aborted) controller.abort();
            return await request(new Request(input, { signal: controller.signal }));
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            input.signal.removeEventListener('abort', cancel);
        }
    };
}
