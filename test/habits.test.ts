import { describe, expect, it } from 'vitest';
import {
  estadoProperty,
  isPending,
  parseEntry,
  resolveHabitosSchema,
  sortEntries,
  statsFromEntries,
  streakProperties,
} from '../src/habits';

// Forma real (recortada) de la fuente de datos «Hábitos» de la plantilla.
const ds = {
  id: 'ds-habitos',
  properties: {
    'Nombre del habito ': { type: 'title', title: {} },
    Estado: {
      type: 'select',
      select: {
        options: [
          { name: '⚪ Sin iniciar' },
          { name: '💤 Omitido' },
          { name: '🕯️ Parcial' },
          { name: '⚡ Hecho' },
          { name: '🔥Superado' },
          { name: '🚀 Alto impacto' },
        ],
      },
    },
    Fecha: { type: 'date', date: {} },
    Identidad: { type: 'select', select: { options: [] } },
    Objetivo: { type: 'rich_text', rich_text: {} },
    'Rango horario': { type: 'select', select: { options: [] } },
    'Estadística ': { type: 'relation', relation: { data_source_id: 'ds-estadisticas' } },
  },
};

const page = (over: Record<string, unknown> = {}) => ({
  id: 'page-1',
  properties: {
    'Nombre del habito ': { type: 'title', title: [{ plain_text: 'Ir al gimnasio' }] },
    Estado: { type: 'select', select: { name: '⚪ Sin iniciar' } },
    Fecha: { type: 'date', date: { start: '2026-10-12' } },
    Identidad: { type: 'select', select: { name: 'Cuerpo Fitness y Saludable 💪🏻' } },
    Objetivo: { type: 'rich_text', rich_text: [{ plain_text: '1 hora' }] },
    'Rango horario': { type: 'select', select: { name: '🌆 12:00 a 17:59' } },
    'Estadística ': { type: 'relation', relation: [{ id: 'habit-gym' }] },
    ...over,
  },
});

describe('resolveHabitosSchema', () => {
  const s = resolveHabitosSchema(ds);
  it('encuentra las propiedades con espacio final', () => {
    expect(s.titulo).toBe('Nombre del habito ');
    expect(s.relacion).toBe('Estadística ');
  });
  it('mapea los nombres exactos de las opciones de Estado', () => {
    expect(s.estadoOptions.superado).toBe('🔥Superado');
    expect(s.estadoOptions.parcial).toBe('🕯️ Parcial');
  });
  it('falla con un mensaje claro si no es la base correcta', () => {
    expect(() => resolveHabitosSchema({ id: 'x', properties: { Name: { type: 'title' } } })).toThrow(/Estado/);
  });
});

describe('parseEntry', () => {
  const s = resolveHabitosSchema(ds);
  it('convierte una fila diaria', () => {
    const e = parseEntry(page(), s);
    expect(e).toMatchObject({
      pageId: 'page-1',
      nombre: 'Ir al gimnasio',
      estado: 'sin_iniciar',
      fecha: '2026-10-12',
      rango: 'tarde',
      objetivo: '1 hora',
      habitId: 'habit-gym',
    });
    expect(isPending(e)).toBe(true);
  });
  it('sin relación Estadística agrupa por nombre', () => {
    const e = parseEntry(page({ 'Estadística ': { type: 'relation', relation: [] } }), s);
    expect(e.habitId).toBe('nombre:ir al gimnasio');
  });
  it('una fila sin estado cuenta como pendiente', () => {
    const e = parseEntry(page({ Estado: { type: 'select', select: null } }), s);
    expect(e.estado).toBeNull();
    expect(isPending(e)).toBe(true);
  });
  it('estadoProperty usa el nombre exacto de la opción', () => {
    expect(estadoProperty(s, 'superado')).toEqual({ Estado: { select: { name: '🔥Superado' } } });
  });
});

describe('sortEntries', () => {
  it('ordena por rango horario y luego por nombre', () => {
    const s = resolveHabitosSchema(ds);
    const mk = (nombre: string, rango: string) =>
      parseEntry(
        page({
          'Nombre del habito ': { type: 'title', title: [{ plain_text: nombre }] },
          'Rango horario': { type: 'select', select: { name: rango } },
        }),
        s,
      );
    const out = sortEntries([mk('B', '❇️ Durante el día'), mk('Z', '🌃 00:00 a 05:59'), mk('A', '❇️ Durante el día')]);
    expect(out.map((e) => e.nombre)).toEqual(['Z', 'A', 'B']);
  });
});

describe('rachas en las filas diarias', () => {
  const dsRacha = {
    ...ds,
    properties: {
      ...ds.properties,
      Racha: { type: 'number', number: {} },
      'Mejor racha': { type: 'number', number: {} },
      Congeladores: { type: 'number', number: {} },
      'Racha cerrada': { type: 'checkbox', checkbox: {} },
    },
  };
  const s = resolveHabitosSchema(dsRacha);
  const conRacha = (fecha: string, racha: number | null, cerrada: boolean) =>
    parseEntry(
      page({
        Fecha: { type: 'date', date: { start: fecha } },
        Racha: { type: 'number', number: racha },
        'Mejor racha': { type: 'number', number: racha },
        Congeladores: { type: 'number', number: 1 },
        'Racha cerrada': { type: 'checkbox', checkbox: cerrada },
      }),
      s,
    );

  it('lee la racha guardada en la fila', () => {
    expect(conRacha('2026-10-12', 4, true).streak).toEqual({ racha: 4, mejor: 4, congeladores: 1, cerrada: true });
    expect(conRacha('2026-10-12', null, false).streak).toBeNull();
  });

  it('streakProperties escribe las 4 columnas', () => {
    expect(streakProperties(s, { racha: 3, mejor: 7, congeladores: 2, procesadoHasta: null }, true)).toEqual({
      Racha: { number: 3 },
      'Mejor racha': { number: 7 },
      Congeladores: { number: 2 },
      'Racha cerrada': { checkbox: true },
    });
  });

  it('streakProperties falla con un mensaje claro si faltan las columnas', () => {
    expect(() => streakProperties(resolveHabitosSchema(ds), { racha: 0, mejor: 0, congeladores: 2, procesadoHasta: null }, true)).toThrow(/setup/);
  });

  it('statsFromEntries toma la fila más reciente y la fecha de la última cerrada', () => {
    const st = statsFromEntries([conRacha('2026-10-13', 5, false), conRacha('2026-10-12', 5, true), conRacha('2026-10-11', 4, true)]);
    expect(st['habit-gym']!.state).toEqual({ racha: 5, mejor: 5, congeladores: 1, procesadoHasta: '2026-10-12' });
  });
});
