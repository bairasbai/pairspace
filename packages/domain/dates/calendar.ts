/** All-day Gregorian calendar labels, not instants. No device/server timezone conversion. */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}
/** Recognized IANA reference name, retained exactly. Alias spelling is part of command identity. */
export function validatedTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return value; }
  catch { return null; }
}
