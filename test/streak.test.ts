import { describe, expect, it } from 'vitest';
import {
  INITIAL_STATE,
  RULES,
  closableUntil,
  fold,
  outcomeFromEstado,
  processDays,
  step,
  type StreakState,
} from '../src/streak';

const s = (racha: number, congeladores: number, mejor = racha): StreakState => ({
  racha,
  mejor,
  congeladores,
  procesadoHasta: null,
});

describe('outcomeFromEstado', () => {
  it('Parcial o mejor suma', () => {
    for (const e of ['parcial', 'hecho', 'superado', 'alto'] as const) {
      expect(outcomeFromEstado(e)).toBe('done');
    }
  });
  it('Omitido y Sin iniciar fallan', () => {
    expect(outcomeFromEstado('omitido')).toBe('miss');
    expect(outcomeFromEstado('sin_iniciar')).toBe('miss');
  });
  it('sin fila es neutro', () => {
    expect(outcomeFromEstado(undefined)).toBe('none');
  });
  it('un estado desconocido cuenta como fallo (no regala rachas)', () => {
    expect(outcomeFromEstado(null)).toBe('miss');
  });
});

describe('step', () => {
  it('el estado inicial tiene 2 congeladores', () => {
    expect(INITIAL_STATE.congeladores).toBe(2);
    expect(INITIAL_STATE.racha).toBe(0);
  });

  it('un día cumplido suma 1 y actualiza la mejor racha', () => {
    const r = step(s(3, 2, 3), 'done');
    expect(r.state.racha).toBe(4);
    expect(r.state.mejor).toBe(4);
    expect(r.event).toBe('sumo');
  });

  it('un fallo con congelador lo gasta y conserva la racha', () => {
    const r = step(s(5, 2), 'miss');
    expect(r.state.racha).toBe(5);
    expect(r.state.congeladores).toBe(1);
    expect(r.event).toBe('congelado');
  });

  it('un fallo sin congeladores reinicia la racha pero conserva la mejor', () => {
    const r = step(s(5, 0, 9), 'miss');
    expect(r.state.racha).toBe(0);
    expect(r.state.mejor).toBe(9);
    expect(r.state.congeladores).toBe(0);
    expect(r.event).toBe('reinicio');
  });

  it('un día neutro no cambia nada', () => {
    const r = step(s(5, 1), 'none');
    expect(r.state).toEqual(s(5, 1));
    expect(r.event).toBe('neutro');
  });

  it('gana un congelador cada 7 días de racha', () => {
    const r = step(s(6, 1), 'done');
    expect(r.state.racha).toBe(7);
    expect(r.state.congeladores).toBe(2);
    expect(r.ganoCongelador).toBe(true);
  });

  it('no supera el máximo de 2 congeladores', () => {
    const r = step(s(13, 2), 'done');
    expect(r.state.congeladores).toBe(RULES.maxCongeladores);
    expect(r.ganoCongelador).toBe(false);
  });

  it('los días congelados no cuentan para ganar congeladores', () => {
    // 6 días, fallo congelado, 1 día más => racha 7 => gana
    let st = s(6, 2);
    st = step(st, 'miss').state; // racha 6, congeladores 1
    const r = step(st, 'done');
    expect(r.state.racha).toBe(7);
    expect(r.state.congeladores).toBe(2);
  });
});

describe('fold', () => {
  it('reconstruye la racha desde el historial', () => {
    // 3 hechos, 2 fallos (gasta 2), 1 fallo (reinicia), 2 hechos
    const st = fold(['done', 'done', 'done', 'miss', 'miss', 'miss', 'done', 'done']);
    expect(st.racha).toBe(2);
    expect(st.mejor).toBe(3);
    expect(st.congeladores).toBe(0);
  });
  it('14 días seguidos con 2 congeladores se quedan en 2', () => {
    const st = fold(Array(14).fill('done'));
    expect(st.racha).toBe(14);
    expect(st.congeladores).toBe(2);
  });
  it('recupera congeladores tras gastarlos', () => {
    const st = fold(['miss', 'miss', ...Array(7).fill('done')]);
    expect(st.racha).toBe(7);
    expect(st.congeladores).toBe(1);
  });
});

describe('processDays', () => {
  const rows = new Map<string, 'done' | 'miss'>([
    ['2026-10-12', 'done'],
    ['2026-10-13', 'miss'],
    ['2026-10-15', 'done'],
  ]);
  const outcomeOf = (d: string) => rows.get(d) ?? 'none';

  it('procesa desde el día siguiente al último procesado hasta el fin', () => {
    const st = { ...INITIAL_STATE, racha: 1, mejor: 1, procesadoHasta: '2026-10-12' };
    const r = processDays(st, '2026-10-15', outcomeOf, '2026-10-12');
    expect(r.state.procesadoHasta).toBe('2026-10-15');
    expect(r.state.racha).toBe(2); // 13 congelado, 14 neutro, 15 suma
    expect(r.state.congeladores).toBe(1);
    expect(r.dias).toBe(3);
  });

  it('es idempotente: si ya está al día no cambia', () => {
    const st = { ...INITIAL_STATE, racha: 2, mejor: 2, procesadoHasta: '2026-10-15' };
    const r = processDays(st, '2026-10-15', outcomeOf, '2026-10-12');
    expect(r.state).toEqual(st);
    expect(r.dias).toBe(0);
  });

  it('si nunca se procesó, empieza en la fecha de inicio', () => {
    const r = processDays({ ...INITIAL_STATE }, '2026-10-13', outcomeOf, '2026-10-12');
    expect(r.state.racha).toBe(1);
    expect(r.state.congeladores).toBe(1);
    expect(r.state.procesadoHasta).toBe('2026-10-13');
  });

  it('registra los eventos para avisar al usuario', () => {
    const r = processDays({ ...INITIAL_STATE }, '2026-10-13', outcomeOf, '2026-10-12');
    expect(r.eventos.map((e) => e.event)).toEqual(['sumo', 'congelado']);
  });
});

describe('closableUntil', () => {
  it('a las 03:00 o después se puede cerrar ayer', () => {
    expect(closableUntil('2026-10-13', 3 * 60, 3 * 60)).toBe('2026-10-12');
    expect(closableUntil('2026-10-13', 23 * 60, 3 * 60)).toBe('2026-10-12');
  });
  it('antes de las 03:00 solo se puede cerrar anteayer', () => {
    expect(closableUntil('2026-10-13', 2 * 60 + 59, 3 * 60)).toBe('2026-10-11');
  });
});
