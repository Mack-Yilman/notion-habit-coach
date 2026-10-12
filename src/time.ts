// Fechas locales en formato AAAA-MM-DD. Nunca uses toISOString() para la fecha
// del usuario: devuelve UTC y en Lima (UTC−5) después de las 19:00 ya es mañana.

export interface LocalNow {
  date: string; // AAAA-MM-DD local
  hour: number;
  minute: number;
  minutes: number; // minutos desde medianoche local
  weekday: number; // 0 = domingo
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export const DIAS_LARGOS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function localNow(d: Date, timeZone: string): LocalNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute,
    minutes: hour * 60 + minute,
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

function toUtcNoon(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
}

function fromUtc(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date: string, n: number): string {
  const dt = toUtcNoon(date);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtc(dt);
}

export function diffDays(from: string, to: string): number {
  return Math.round((toUtcNoon(to).getTime() - toUtcNoon(from).getTime()) / 86_400_000);
}

export function weekdayOf(date: string): number {
  return toUtcNoon(date).getUTCDay();
}

/** «lun 12/10» */
export function formatCorto(date: string): string {
  const [, m, d] = date.split('-');
  return `${DIAS_CORTOS[weekdayOf(date)]} ${d}/${m}`;
}

/** Lista de fechas desde `from` hasta `to`, ambas incluidas. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
