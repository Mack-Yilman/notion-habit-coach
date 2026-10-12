import { describe, expect, it } from 'vitest';
import { addDays, diffDays, formatCorto, localNow, weekdayOf } from '../src/time';

describe('localNow', () => {
  it('convierte UTC a hora de Lima (UTC−5)', () => {
    const n = localNow(new Date('2026-10-13T02:30:00Z'), 'America/Lima');
    expect(n.date).toBe('2026-10-12');
    expect(n.hour).toBe(21);
    expect(n.minute).toBe(30);
    expect(n.minutes).toBe(21 * 60 + 30);
  });
  it('medianoche local es 00, no 24', () => {
    const n = localNow(new Date('2026-10-13T05:00:00Z'), 'America/Lima');
    expect(n.date).toBe('2026-10-13');
    expect(n.hour).toBe(0);
  });
  it('da el día de la semana (0 = domingo)', () => {
    expect(localNow(new Date('2026-10-12T15:00:00Z'), 'America/Lima').weekday).toBe(1);
  });
});

describe('fechas AAAA-MM-DD', () => {
  it('suma y resta días cruzando meses y años', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
  it('calcula la diferencia en días', () => {
    expect(diffDays('2026-10-12', '2026-10-15')).toBe(3);
    expect(diffDays('2026-10-15', '2026-10-12')).toBe(-3);
  });
  it('weekdayOf', () => {
    expect(weekdayOf('2026-10-11')).toBe(0); // domingo
  });
  it('formatCorto', () => {
    expect(formatCorto('2026-10-12')).toBe('lun 12/10');
  });
});
