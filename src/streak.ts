// Motor de rachas: funciones puras, sin red. Reglas decididas por el usuario:
// - Parcial, Hecho, Superado y Alto impacto suman un día.
// - Omitido o Sin iniciar al cerrar el día gastan un congelador; sin congeladores
//   la racha vuelve a 0.
// - Un día sin fila del hábito es neutro (no suma ni gasta).
// - Cada hábito empieza con 2 congeladores, gana 1 cada 7 días de racha, máximo 2.

import { addDays, dateRange } from './time';
import { ESTADO_BY_KEY, type EstadoKey } from './config';

export type DayOutcome = 'done' | 'miss' | 'none';
export type StreakEvent = 'sumo' | 'congelado' | 'reinicio' | 'neutro';

export interface StreakState {
  racha: number;
  mejor: number;
  congeladores: number;
  procesadoHasta: string | null; // último día ya contado (AAAA-MM-DD)
}

export const RULES = { inicialCongeladores: 2, maxCongeladores: 2, ganarCada: 7 } as const;

export const INITIAL_STATE: StreakState = {
  racha: 0,
  mejor: 0,
  congeladores: RULES.inicialCongeladores,
  procesadoHasta: null,
};

/**
 * `undefined` = no hay fila ese día (neutro). `null` = hay fila pero con un
 * estado que no se reconoce: se trata como fallo para no regalar rachas.
 */
export function outcomeFromEstado(estado: EstadoKey | null | undefined): DayOutcome {
  if (estado === undefined) return 'none';
  if (estado === null) return 'miss';
  return ESTADO_BY_KEY[estado].cuenta ? 'done' : 'miss';
}

export interface StepResult {
  state: StreakState;
  event: StreakEvent;
  ganoCongelador: boolean;
}

export function step(prev: StreakState, outcome: DayOutcome, rules = RULES): StepResult {
  const s = { ...prev };
  if (outcome === 'none') return { state: s, event: 'neutro', ganoCongelador: false };

  if (outcome === 'done') {
    s.racha += 1;
    s.mejor = Math.max(s.mejor, s.racha);
    let gano = false;
    if (s.racha % rules.ganarCada === 0 && s.congeladores < rules.maxCongeladores) {
      s.congeladores += 1;
      gano = true;
    }
    return { state: s, event: 'sumo', ganoCongelador: gano };
  }

  if (s.congeladores > 0) {
    s.congeladores -= 1;
    return { state: s, event: 'congelado', ganoCongelador: false };
  }
  s.racha = 0;
  return { state: s, event: 'reinicio', ganoCongelador: false };
}

export function fold(outcomes: DayOutcome[], initial: StreakState = INITIAL_STATE, rules = RULES): StreakState {
  return outcomes.reduce((st, o) => step(st, o, rules).state, { ...initial });
}

export interface DayEvent {
  date: string;
  event: StreakEvent;
  ganoCongelador: boolean;
  antes: number; // racha antes del día
  state: StreakState; // estado al terminar el día
}

export interface ProcessResult {
  state: StreakState;
  dias: number;
  eventos: DayEvent[];
}

/**
 * Aplica los días pendientes, desde el siguiente a `procesadoHasta` (o desde
 * `inicio` si nunca se procesó) hasta `hasta`, ambos incluidos. Idempotente.
 */
export function processDays(
  prev: StreakState,
  hasta: string,
  outcomeOf: (date: string) => DayOutcome,
  inicio: string,
  rules = RULES,
): ProcessResult {
  const desde = prev.procesadoHasta ? addDays(prev.procesadoHasta, 1) : inicio;
  if (desde > hasta) return { state: { ...prev }, dias: 0, eventos: [] };

  let st: StreakState = { ...prev };
  const eventos: DayEvent[] = [];
  for (const date of dateRange(desde, hasta)) {
    const prevRacha = st.racha;
    const r = step(st, outcomeOf(date), rules);
    st = { ...r.state, procesadoHasta: date };
    eventos.push({ date, event: r.event, ganoCongelador: r.ganoCongelador, antes: prevRacha, state: { ...st } });
  }
  st.procesadoHasta = hasta;
  return { state: st, dias: eventos.length, eventos };
}

/**
 * Último día que ya se puede cerrar. El día D se cierra a la hora de `procesar`
 * (03:00 por defecto) de D+1, para que cuente lo que se marque de madrugada.
 */
export function closableUntil(today: string, nowMinutes: number, procesarMinutes: number): string {
  return addDays(today, nowMinutes >= procesarMinutes ? -1 : -2);
}
