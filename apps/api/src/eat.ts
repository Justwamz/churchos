/** Nairobi time (UTC+3, no daylight saving) and calendar-date helpers, shared by the schedules that run on Nairobi clock times. */

export const EAT = 3 * 3600_000;
export const DAY = 86_400_000;

export const pad = (n: number) => String(n).padStart(2, '0');
export const dateStr = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => dateStr(new Date(parseDate(s).getTime() + n * DAY));
/** Today's date in Nairobi. */
export const eatToday = (now: Date) => dateStr(new Date(now.getTime() + EAT));
/** The Nairobi date of an instant. */
export const eatDateOf = (iso: string) => dateStr(new Date(Date.parse(iso) + EAT));
/** The instant (ISO) of a Nairobi date and clock time. */
export const dueAt = (date: string, time: string) => new Date(Date.parse(`${date}T${time}:00Z`) - EAT).toISOString();
/** 1 = Monday to 7 = Sunday. */
export const isoWeekday = (s: string) => ((parseDate(s).getUTCDay() + 6) % 7) + 1;
/** The Monday of the week a date falls in. */
export const weekStartOf = (s: string) => addDays(s, -(isoWeekday(s) - 1));
export const lastDayOfYear = (s: string) => `${s.slice(0, 4)}-12-31`;
export const lastDayOfMonth = (s: string) => {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return dateStr(new Date(Date.UTC(y, m, 0)));
};
