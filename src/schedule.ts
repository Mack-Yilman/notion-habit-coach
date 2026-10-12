// Bloques de aviso. El usuario no quiere horas fijas por hábito: cada aviso lista
// lo pendiente del bloque horario y él decide cuándo hacerlo dentro del rango.

import type { RangoKey } from './config';

export type SlotKey =
  | 'manana'
  | 'manana_ultimo'
  | 'tarde'
  | 'tarde_ultimo'
  | 'noche'
  | 'noche_ultimo'
  | 'cierre'
  | 'procesar';

export interface SlotDef {
  tipo: 'aviso' | 'cierre' | 'procesar';
  titulo: string;
  intro: string;
  rangos: RangoKey[];
  /** Último llamado del bloque: solo suena si hay una racha en riesgo. */
  ultimo?: boolean;
}

const TODOS: RangoKey[] = ['madrugada', 'manana', 'tarde', 'noche', 'dia'];

export const SLOTS: Record<SlotKey, SlotDef> = {
  manana: {
    tipo: 'aviso',
    titulo: '☀️ Buenos días',
    intro: 'Esto toca en la mañana (y lo que puedes hacer en cualquier momento del día):',
    rangos: ['madrugada', 'manana', 'dia'],
  },
  manana_ultimo: {
    tipo: 'aviso',
    ultimo: true,
    titulo: '⏳ Último llamado de la mañana',
    intro: 'Queda poco del bloque de la mañana. Aún pendiente:',
    rangos: ['madrugada', 'manana'],
  },
  tarde: {
    tipo: 'aviso',
    titulo: '🌆 Bloque de la tarde',
    intro: 'Lo que toca esta tarde (y lo que aún falta de «durante el día»):',
    // «Durante el día» se recuerda 3 veces: 06:30, 12:30 y 21:30.
    rangos: ['tarde', 'dia'],
  },
  tarde_ultimo: {
    tipo: 'aviso',
    ultimo: true,
    titulo: '⏳ Último llamado de la tarde',
    intro: 'Se acaba la tarde. Aún pendiente:',
    rangos: ['tarde'],
  },
  noche: {
    tipo: 'aviso',
    titulo: '🌙 Bloque de la noche',
    intro: 'Lo que toca esta noche:',
    rangos: ['noche'],
  },
  noche_ultimo: {
    tipo: 'aviso',
    ultimo: true,
    titulo: '⏳ Último llamado del día',
    intro: 'Antes de cerrar el día, aún pendiente:',
    rangos: ['noche', 'dia'],
  },
  cierre: { tipo: 'cierre', titulo: '🌒 Cierre del día', intro: '', rangos: TODOS },
  procesar: { tipo: 'procesar', titulo: 'Procesar rachas', intro: '', rangos: [] },
};

export const SLOT_KEYS = Object.keys(SLOTS) as SlotKey[];

const hm = (h: number, m: number) => h * 60 + m;

export const DEFAULT_SCHEDULE: Record<SlotKey, number> = {
  manana: hm(6, 30),
  manana_ultimo: hm(10, 30),
  tarde: hm(12, 30),
  tarde_ultimo: hm(16, 30),
  noche: hm(18, 30),
  noche_ultimo: hm(21, 30),
  cierre: hm(23, 0),
  procesar: hm(3, 0),
};

/** «manana=06:30,cierre=23:00» → minutos por bloque; lo que falta usa el valor por defecto. */
export function parseSchedule(raw: string | undefined): Record<SlotKey, number> {
  const out = { ...DEFAULT_SCHEDULE };
  for (const pair of (raw ?? '').split(',')) {
    const m = pair.trim().match(/^([a-z_]+)=(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const key = m[1] as SlotKey;
    const h = Number(m[2]);
    const min = Number(m[3]);
    if (!(key in SLOTS) || h > 23 || min > 59) continue;
    out[key] = hm(h, min);
  }
  return out;
}

/**
 * Bloques cuya hora ya pasó hace menos de `windowMin` minutos. La ventana permite
 * recuperar un cron perdido; la deduplicación (no enviar dos veces) va aparte, en KV.
 */
export function dueSlots(nowMinutes: number, schedule: Record<SlotKey, number>, windowMin = 60): SlotKey[] {
  return SLOT_KEYS.filter((k) => {
    const t = schedule[k];
    return nowMinutes >= t && nowMinutes < t + windowMin;
  });
}
