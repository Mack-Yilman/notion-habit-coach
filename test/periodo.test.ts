import { describe, expect, it } from 'vitest';
import { renderCifras, renderMapaMes, resumir, semanaYPrevia } from '../src/periodo';
import { esUltimoDiaDelMes, inicioMes, mesAnterior, nombreMes } from '../src/time';
import type { Entry } from '../src/habits';

const e = (nombre: string, fecha: string, estado: Entry['estado'], rango: Entry['rango'] = 'manana'): Entry => ({
  pageId: `${nombre}-${fecha}`,
  habitId: `h-${nombre}`,
  nombre,
  fecha,
  estado,
  rango,
  objetivo: '',
  identidad: '',
});

/** Un hábito con `ok` de `tot` días cumplidos a partir de `desde`. */
const serie = (nombre: string, desde: string, ok: number, tot: number, rango: Entry['rango'] = 'manana') =>
  Array.from({ length: tot }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, Number(desde.slice(8)) + i, 12)).toISOString().slice(0, 10);
    return e(nombre, d, i < ok ? 'hecho' : 'sin_iniciar', rango);
  });

describe('fechas del mes', () => {
  it('esUltimoDiaDelMes', () => {
    expect(esUltimoDiaDelMes('2026-10-31')).toBe(true);
    expect(esUltimoDiaDelMes('2026-10-30')).toBe(false);
    expect(esUltimoDiaDelMes('2026-02-28')).toBe(true);
    expect(esUltimoDiaDelMes('2028-02-28')).toBe(false); // bisiesto
    expect(esUltimoDiaDelMes('2028-02-29')).toBe(true);
    expect(esUltimoDiaDelMes('2026-04-30')).toBe(true);
  });
  it('inicio, mes anterior y nombre', () => {
    expect(inicioMes('2026-10-26')).toBe('2026-10-01');
    expect(mesAnterior('2026-01-15')).toBe('2025-12');
    expect(mesAnterior('2026-10-26')).toBe('2026-09');
    expect(nombreMes('2026-10-26')).toBe('octubre 2026');
  });
});

describe('resumir y cifras', () => {
  it('cuenta Parcial o mejor como cumplido y solo dentro del rango de fechas', () => {
    const r = resumir([e('Gym', '2026-10-01', 'parcial'), e('Gym', '2026-10-02', 'omitido'), e('Gym', '2026-09-30', 'hecho')], '2026-10-01', '2026-10-31');
    expect(r.total).toEqual({ ok: 1, tot: 2 });
  });

  it('semana contra semana anterior: cumplimiento, mejor y peor hábito, y cambios', () => {
    const hist = [
      ...serie('Dormir', '2026-10-12', 7, 7), // previa 100 %
      ...serie('Dormir', '2026-10-19', 7, 7), // actual 100 %
      ...serie('Gym', '2026-10-12', 6, 7), // previa 86 %
      ...serie('Gym', '2026-10-19', 2, 7), // actual 29 %
    ];
    const { actual, previo } = semanaYPrevia(hist, '2026-10-25');
    expect(actual.desde).toBe('2026-10-19');
    expect(previo.desde).toBe('2026-10-12');
    const c = renderCifras(actual, previo, 'los 7 días anteriores');
    expect(c).toContain('Cumplimiento: <b>64 %</b> (9/14)');
    expect(c).toContain('🔽 -29 pts vs. los 7 días anteriores (93 %)');
    expect(c).toContain('💪 Más constante: Dormir 100 %');
    expect(c).toContain('🌧️ Más flojo: Gym 29 %');
    expect(c).toContain('⚠️ Más cayó: Gym 🔽 -57 pts');
  });

  it('sin periodo anterior no compara; sin filas no devuelve nada', () => {
    const r = resumir(serie('Gym', '2026-10-01', 3, 5), '2026-10-01', '2026-10-31');
    const c = renderCifras(r, null, 'el mes anterior');
    expect(c).toContain('Cumplimiento: <b>60 %</b> (3/5)');
    expect(c).not.toContain('vs.');
    expect(renderCifras(resumir([], '2026-10-01', '2026-10-31'), null, 'x')).toBe('');
  });

  it('un hábito con menos de 3 filas no entra en mejor/peor', () => {
    const r = resumir([...serie('Gym', '2026-10-01', 5, 5), e('Nuevo', '2026-10-05', 'sin_iniciar')], '2026-10-01', '2026-10-31');
    expect(renderCifras(r, null, 'x')).not.toContain('Nuevo');
  });
});

describe('renderMapaMes', () => {
  it('nombre en su línea y un cuadro por semana', () => {
    const hist = [...serie('Gym', '2026-10-01', 7, 7), ...serie('Gym', '2026-10-08', 2, 7), ...serie('Gym', '2026-10-15', 5, 5)];
    const m = renderMapaMes(hist, '2026-10-01', '2026-10-19');
    expect(m).toContain('<b>Gym</b> · 74 %\n🟩🟥🟩'); // 14/19
    expect(m).toContain('Semanas:');
    expect(renderMapaMes([], '2026-10-01', '2026-10-19')).toBe('');
  });
});
