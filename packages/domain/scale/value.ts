export const validScaleValue = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
export function validScaleDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31')
        return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validScaleZone(value: unknown): value is string {
    if (typeof value !== 'string' || value.length < 1 || value.length > 100 || value.trim() !== value || /\p{Cc}/u.test(value) || /^[+-]/.test(value))
        return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return true;
    }
    catch {
        return false;
    }
}
export function scaleDateAt(now: Date, timezone: string): string | null {
    if (!Number.isFinite(now.getTime()) || !validScaleZone(timezone))
        return null;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (type: string) => parts.find(part => part.type === type)!.value;
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    return validScaleDate(date) ? date : null;
}
