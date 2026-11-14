// Request correlation only, not authentication. Independent from mutation command IDs.
let sequence = 0;
export function historyReadId() {
    if (++sequence > 999999999999) throw Error('read_identity_exhausted');
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}
