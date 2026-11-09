/** Нейтральные функции из tan-ata/lib/time.ts; происхождение в docs/FOUNDATION.md. */
export type IsoDate = string;

export function dateIn(tz: string, at: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function hourIn(tz: string, at: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(at);
  // "24" вместо "00" — известная особенность hourCycle по умолчанию.
  return Number(h) % 24;
}

function toUtcNoon(date: IsoDate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function fromUtcNoon(at: Date): IsoDate {
  return at.toISOString().slice(0, 10);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  const ms = toUtcNoon(b).getTime() - toUtcNoon(a).getTime();
  return Math.round(ms / 86_400_000);
}

export function addDays(date: IsoDate, n: number): IsoDate {
  const at = toUtcNoon(date);
  at.setUTCDate(at.getUTCDate() + n);
  return fromUtcNoon(at);
}
