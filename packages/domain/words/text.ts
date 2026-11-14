/** Plain synthetic dictionary text, independent of transport and storage. */
export function normalizeWordText(value: unknown, kind: 'word' | 'optional'): string | null {
    if (value === undefined && kind === 'optional')
        return '';
    if (typeof value !== 'string' || value.length > 4000 || /[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')))
        return null;
    const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n');
    if (/\p{Cc}/u.test(normalized.replace(/[\n\t]/g, '')))
        return null;
    const text = kind === 'word' ? normalized.replace(/\s+/gu, ' ').trim() : normalized.trim();
    if (kind === 'optional' && text.includes('\t'))
        return null;
    const length = [...text].length;
    return length <= (kind === 'word' ? 120 : 1000) && (kind !== 'word' || length > 0) ? text : null;
}
