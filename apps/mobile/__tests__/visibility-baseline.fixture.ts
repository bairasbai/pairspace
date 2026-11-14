/** Legacy suites model a pair with no visibility changes. New visibility suites use
 * their own revision-aware server and deliberately exercise absent/invalid headers. */
export async function baselineVisibility(input: Request, response: Promise<Response> | Response) {
    const result = await response;
    if (new URL(input.url).pathname.includes('/chat/') && !result.headers.has('X-Chat-Visibility-Revision')) {
        result.headers.set('X-Chat-Visibility-Revision', '0');
    }
    return result;
}
