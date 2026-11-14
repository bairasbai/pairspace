export const VISIBILITY_HEADER = 'X-Chat-Visibility-Revision';
export function visibilityRevision(response: Response): number | null {
    const raw = response.headers.get(VISIBILITY_HEADER);
    if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
}
/** Internal transport metadata, never inserted into the server's JSON schema. */
export function visibilityMetadata(response: Response): { visibilityRevision?: number } {
    const revision = visibilityRevision(response);
    return revision === null ? {} : { visibilityRevision: revision };
}
