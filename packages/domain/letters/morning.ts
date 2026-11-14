import { parseLetterSchedule } from './schedule.ts';
export type MorningChoice = {
    offset: string;
    releaseAt: string;
};
export function parseMorningPreference(timezone: unknown, localTime: unknown): {
    timezone: string;
    localTime: string;
} | null {
    if (typeof timezone !== 'string' || timezone.length > 100 || typeof localTime !== 'string'
        || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(localTime))
        return null;
    try {
        const canonical = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
        return { timezone: canonical, localTime };
    }
    catch {
        return null;
    }
}
export function resolveMorningChoice(localDate: unknown, localTime: unknown, timezone: unknown, offset: unknown): MorningChoice | null {
    const preference = parseMorningPreference(timezone, localTime);
    if (!preference || typeof localDate !== 'string' || !/^(20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$/.test(localDate)
        || typeof offset !== 'string' || !/^[+-](?:0[0-9]|1[0-4]):[0-5][0-9]$/.test(offset)
        || offset === '-00:00' || (offset.slice(1, 3) === '14' && offset.slice(4) !== '00'))
        return null;
    const schedule = parseLetterSchedule(`${localDate}T${preference.localTime}:00${offset}`, preference.timezone);
    return schedule ? { offset, releaseAt: schedule.releaseAt } : null;
}
/** Enumerate actual zone offsets around the civil day; never guess a fold or shift a gap. */
export function resolveMorning(localDate: unknown, localTime: unknown, timezone: unknown): MorningChoice[] {
    const preference = parseMorningPreference(timezone, localTime);
    if (!preference || typeof localDate !== 'string' || !/^(20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$/.test(localDate))
        return [];
    const center = Date.parse(localDate + 'T12:00:00Z');
    if (!Number.isFinite(center))
        return [];
    const formatter = new Intl.DateTimeFormat('en', { timeZone: preference.timezone, timeZoneName: 'longOffset' });
    const offsets = new Set<string>();
    for (let hours = -48; hours <= 48; hours += 6) {
        const name = formatter.formatToParts(new Date(center + hours * 3600000)).find(part => part.type === 'timeZoneName')?.value;
        if (name === 'GMT')
            offsets.add('+00:00');
        else if (name?.startsWith('GMT'))
            offsets.add(name.slice(3));
    }
    return [...offsets].flatMap(offset => {
        const choice = resolveMorningChoice(localDate, localTime, preference.timezone, offset);
        return choice ? [choice] : [];
    }).sort((a, b) => a.releaseAt.localeCompare(b.releaseAt));
}
