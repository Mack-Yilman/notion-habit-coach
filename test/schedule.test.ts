import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, dueSlots, parseSchedule, SLOTS } from '../src/schedule';

describe('parseSchedule', () => {
  it('lee el horario de la variable SCHEDULE', () => {
    const s = parseSchedule('manana=06:30,cierre=23:00');
    expect(s.manana).toBe(6 * 60 + 30);
    expect(s.cierre).toBe(23 * 60);
    // lo que falta toma el valor por defecto
    expect(s.tarde).toBe(DEFAULT_SCHEDULE.tarde);
  });
  it('ignora claves desconocidas y horas inválidas', () => {
    const s = parseSchedule('foo=01:00,manana=25:99');
    expect(s.manana).toBe(DEFAULT_SCHEDULE.manana);
  });
  it('sin variable usa el horario por defecto', () => {
    expect(parseSchedule(undefined)).toEqual(DEFAULT_SCHEDULE);
  });
});

describe('dueSlots', () => {
  it('a las 06:30 toca la mañana', () => {
    expect(dueSlots(6 * 60 + 30, DEFAULT_SCHEDULE)).toEqual(['manana']);
  });
  it('dentro de la ventana de 60 min sigue tocando (recupera un cron perdido)', () => {
    expect(dueSlots(7 * 60 + 15, DEFAULT_SCHEDULE)).toEqual(['manana']);
  });
  it('fuera de la ventana ya no toca', () => {
    expect(dueSlots(7 * 60 + 31, DEFAULT_SCHEDULE)).toEqual([]);
  });
  it('a las 03:00 toca procesar', () => {
    expect(dueSlots(3 * 60, DEFAULT_SCHEDULE)).toEqual(['procesar']);
  });
});

describe('SLOTS', () => {
  it('la mañana incluye madrugada (Dormir) y durante el día', () => {
    expect(SLOTS.manana.rangos).toEqual(['madrugada', 'manana', 'dia']);
  });
  it('«durante el día» se recuerda en la mañana, la tarde y el último llamado de la noche', () => {
    const conDia = Object.entries(SLOTS)
      .filter(([k, s]) => k !== 'cierre' && s.rangos.includes('dia'))
      .map(([k]) => k);
    expect(conDia).toEqual(['manana', 'tarde', 'noche_ultimo']);
  });
  it('el cierre abarca todos los rangos', () => {
    expect(SLOTS.cierre.rangos).toHaveLength(5);
  });
});
