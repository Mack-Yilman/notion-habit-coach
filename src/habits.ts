// Traducción entre las páginas de Notion y los objetos del bot. Funciones puras.
//
// Las rachas viven en las filas diarias de «Hábitos» (no en «Estadísticas», que la API
// de Notion no deja consultar ni modificar):
// - Fila de un día cerrado: Racha, Mejor racha y Congeladores tal como quedaron ese día,
//   con «Racha cerrada» marcado. El estado de un hábito es el de su última fila cerrada.
// - Fila de hoy: la racha con la que empieza el día (solo para verla en Notion).

import {
  ESTADOS,
  PROPS,
  RANGOS,
  estadoFromName,
  findProp,
  rangoFromName,
  type EstadoKey,
  type RangoKey,
} from './config';
import { plain, type Json } from './notion';
import type { StreakState } from './streak';

export interface HabitosSchema {
  dataSourceId: string;
  titulo: string;
  estado: string;
  fecha: string;
  identidad?: string;
  objetivo?: string;
  rango?: string;
  relacion?: string;
  racha?: string;
  mejor?: string;
  congeladores?: string;
  cerrada?: string;
  /** Nombre exacto de cada opción de Estado en la plantilla del usuario. */
  estadoOptions: Partial<Record<EstadoKey, string>>;
}

export class SchemaError extends Error {}

export function resolveHabitosSchema(ds: Json): HabitosSchema {
  const props: Record<string, Json> = ds.properties ?? {};
  const p = PROPS.habitos;
  const titulo = Object.keys(props).find((k) => props[k].type === 'title') ?? findProp(props, p.titulo);
  const estado = findProp(props, p.estado);
  const fecha = findProp(props, p.fecha);
  if (!titulo || !estado || !fecha) {
    throw new SchemaError(
      `La fuente de datos de hábitos debe tener título, «${p.estado}» y «${p.fecha}». Encontré: ${Object.keys(props).join(', ')}`,
    );
  }
  const estadoOptions: Partial<Record<EstadoKey, string>> = {};
  const estadoProp = props[estado];
  for (const opt of estadoProp?.[estadoProp.type]?.options ?? []) {
    const key = estadoFromName(opt.name);
    if (key && !estadoOptions[key]) estadoOptions[key] = opt.name;
  }
  return {
    dataSourceId: ds.id,
    titulo,
    estado,
    fecha,
    identidad: findProp(props, p.identidad),
    objetivo: findProp(props, p.objetivo),
    rango: findProp(props, p.rango),
    relacion: findProp(props, p.relacion),
    racha: findProp(props, p.racha),
    mejor: findProp(props, p.mejor),
    congeladores: findProp(props, p.congeladores),
    cerrada: findProp(props, p.cerrada),
    estadoOptions,
  };
}

export function hasStreakProps(s: HabitosSchema): boolean {
  return !!(s.racha && s.mejor && s.congeladores && s.cerrada);
}

export interface StreakSnapshot {
  racha: number;
  mejor: number;
  congeladores: number;
  cerrada: boolean;
}

export interface Entry {
  pageId: string;
  nombre: string;
  estado: EstadoKey | null;
  fecha: string | null;
  rango: RangoKey | null;
  objetivo: string;
  identidad: string;
  /** Hábito al que pertenece la fila (su ficha en Estadísticas). Agrupa las filas por hábito. */
  habitId: string | null;
  /** Racha guardada en la fila (null si la fila aún no tiene racha). */
  streak?: StreakSnapshot | null;
}

function text(prop: Json): string {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return plain(prop[prop.type]);
    case 'select':
    case 'status':
      return prop[prop.type]?.name ?? '';
    case 'formula':
      return String(prop.formula?.[prop.formula.type] ?? '');
    default:
      return '';
  }
}

function num(prop: Json): number | null {
  return typeof prop?.number === 'number' ? prop.number : null;
}

export function parseEntry(page: Json, s: HabitosSchema): Entry {
  const pr = page.properties ?? {};
  const rel = s.relacion ? pr[s.relacion]?.relation : undefined;
  const racha = s.racha ? num(pr[s.racha]) : null;
  return {
    pageId: page.id,
    nombre: text(pr[s.titulo]) || 'Sin nombre',
    estado: estadoFromName(text(pr[s.estado])),
    fecha: pr[s.fecha]?.date?.start?.slice(0, 10) ?? null,
    rango: s.rango ? rangoFromName(text(pr[s.rango])) : null,
    objetivo: s.objetivo ? text(pr[s.objetivo]) : '',
    identidad: s.identidad ? text(pr[s.identidad]) : '',
    habitId: rel?.[0]?.id ?? null,
    streak:
      racha === null
        ? null
        : {
            racha,
            mejor: (s.mejor ? num(pr[s.mejor]) : null) ?? racha,
            congeladores: (s.congeladores ? num(pr[s.congeladores]) : null) ?? 0,
            cerrada: s.cerrada ? pr[s.cerrada]?.checkbox === true : false,
          },
  };
}

const RANGO_ORDEN = Object.fromEntries(RANGOS.map((r, i) => [r.key, i]));

export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort(
    (a, b) =>
      (RANGO_ORDEN[a.rango ?? 'dia'] ?? 9) - (RANGO_ORDEN[b.rango ?? 'dia'] ?? 9) || a.nombre.localeCompare(b.nombre, 'es'),
  );
}

export function isPending(e: Entry): boolean {
  return e.estado === null || e.estado === 'sin_iniciar';
}

/** Propiedad `Estado` para un PATCH, con el nombre exacto de la opción del usuario. */
export function estadoProperty(s: HabitosSchema, key: EstadoKey): Record<string, unknown> {
  const name = s.estadoOptions[key] ?? ESTADOS.find((e) => e.key === key)!.label;
  return { [s.estado]: { select: { name } } };
}

/** Propiedades de racha para un PATCH de una fila diaria. */
export function streakProperties(s: HabitosSchema, st: StreakState, cerrada: boolean): Record<string, unknown> {
  if (!hasStreakProps(s)) throw new SchemaError('Faltan las columnas de racha en «Hábitos»: ejecuta node scripts/setup.mjs notion --aplicar');
  return {
    [s.racha!]: { number: st.racha },
    [s.mejor!]: { number: st.mejor },
    [s.congeladores!]: { number: st.congeladores },
    [s.cerrada!]: { checkbox: cerrada },
  };
}

/** Columnas que `setup.mjs` agrega a «Hábitos». */
export const STREAK_SCHEMA_ADDITIONS = {
  [PROPS.habitos.racha]: { number: { format: 'number' } },
  [PROPS.habitos.mejor]: { number: { format: 'number' } },
  [PROPS.habitos.congeladores]: { number: { format: 'number' } },
  [PROPS.habitos.cerrada]: { checkbox: {} },
};

// ---------- Rachas por hábito ----------

export interface Stats {
  habitId: string;
  nombre: string;
  state: StreakState;
}

/**
 * Estado de cada hábito a partir de sus filas: el de la última fila cerrada. Si la fila
 * más reciente (hoy) trae la racha sellada a las 03:00, también sirve.
 */
export function statsFromEntries(entries: Entry[]): Record<string, Stats> {
  const out: Record<string, Stats> = {};
  const ordenadas = [...entries].filter((e) => e.habitId && e.fecha && e.streak).sort((a, b) => (a.fecha! < b.fecha! ? -1 : 1));
  for (const e of ordenadas) {
    const s = e.streak!;
    out[e.habitId!] = {
      habitId: e.habitId!,
      nombre: e.nombre,
      state: { racha: s.racha, mejor: s.mejor, congeladores: s.congeladores, procesadoHasta: s.cerrada ? e.fecha : (out[e.habitId!]?.state.procesadoHasta ?? null) },
    };
  }
  return out;
}
