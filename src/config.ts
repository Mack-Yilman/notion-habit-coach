// Vocabulario de la plantilla Habit Tracker Pro y utilidades para reconocerlo.
// Los nombres de estados, rangos y propiedades se reconocen por palabra clave
// normalizada, así el bot sigue funcionando si el usuario cambia un emoji o
// deja un espacio al final del nombre de una propiedad.

export type EstadoKey = 'sin_iniciar' | 'omitido' | 'parcial' | 'hecho' | 'superado' | 'alto';
export type RangoKey = 'madrugada' | 'manana' | 'tarde' | 'noche' | 'dia';

export interface EstadoDef {
  key: EstadoKey;
  keyword: string;
  code: string; // un carácter, para callback_data
  icon: string;
  label: string;
  nivel: number;
  cuenta: boolean; // ¿suma un día de racha?
}

export const ESTADOS: readonly EstadoDef[] = [
  { key: 'sin_iniciar', keyword: 'sin iniciar', code: 'n', icon: '⚪', label: 'Sin iniciar', nivel: 0, cuenta: false },
  { key: 'omitido', keyword: 'omitido', code: 'o', icon: '💤', label: 'Omitido', nivel: 1, cuenta: false },
  { key: 'parcial', keyword: 'parcial', code: 'p', icon: '🕯️', label: 'Parcial', nivel: 2, cuenta: true },
  { key: 'hecho', keyword: 'hecho', code: 'h', icon: '⚡', label: 'Hecho', nivel: 3, cuenta: true },
  { key: 'superado', keyword: 'superado', code: 's', icon: '🔥', label: 'Superado', nivel: 4, cuenta: true },
  { key: 'alto', keyword: 'alto impacto', code: 'a', icon: '🚀', label: 'Alto impacto', nivel: 5, cuenta: true },
];

export const ESTADO_BY_KEY = Object.fromEntries(ESTADOS.map((e) => [e.key, e])) as Record<EstadoKey, EstadoDef>;
export const ESTADO_BY_CODE = Object.fromEntries(ESTADOS.map((e) => [e.code, e])) as Record<string, EstadoDef>;

export interface RangoDef {
  key: RangoKey;
  keyword: string;
  icon: string;
  label: string;
  /** Horario del rango tal como figura en la plantilla (vacío para «Durante el día»). */
  horas: string;
}

export const RANGOS: readonly RangoDef[] = [
  { key: 'madrugada', keyword: '00:00', icon: '🌃', label: 'Madrugada', horas: '00:00 a 05:59' },
  { key: 'manana', keyword: '06:00', icon: '☀️', label: 'Mañana', horas: '06:00 a 11:59' },
  { key: 'tarde', keyword: '12:00', icon: '🌆', label: 'Tarde', horas: '12:00 a 17:59' },
  { key: 'noche', keyword: '18:00', icon: '🌙', label: 'Noche', horas: '18:00 a 23:59' },
  { key: 'dia', keyword: 'durante', icon: '❇️', label: 'Durante el día', horas: '' },
];

export const RANGO_BY_KEY = Object.fromEntries(RANGOS.map((r) => [r.key, r])) as Record<RangoKey, RangoDef>;

// Nombres de propiedades tal como aparecen en la plantilla (se comparan normalizados).
export const PROPS = {
  habitos: {
    titulo: 'Nombre del hábito',
    estado: 'Estado',
    fecha: 'Fecha',
    identidad: 'Identidad',
    objetivo: 'Objetivo',
    rango: 'Rango horario',
    relacion: 'Estadística',
    // Columnas que agrega setup.mjs para guardar las rachas en cada fila diaria.
    racha: 'Racha',
    mejor: 'Mejor racha',
    congeladores: 'Congeladores',
    cerrada: 'Racha cerrada',
  },
} as const;

/** Minúsculas, sin tildes, sin emojis ni signos (salvo «:»), espacios colapsados. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9: ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function estadoFromName(name: string | null | undefined): EstadoKey | null {
  if (!name) return null;
  const n = normalize(name);
  return ESTADOS.find((e) => n.includes(e.keyword))?.key ?? null;
}

export function rangoFromName(name: string | null | undefined): RangoKey | null {
  if (!name) return null;
  const n = normalize(name);
  return RANGOS.find((r) => n.includes(r.keyword))?.key ?? null;
}

/** Devuelve la clave real de `props` cuyo nombre normalizado coincide con `wanted`. */
export function findProp(props: Record<string, unknown>, wanted: string): string | undefined {
  const w = normalize(wanted);
  return Object.keys(props).find((k) => normalize(k) === w);
}
