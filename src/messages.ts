// Textos fijos de los avisos (sin IA) y teclados de Telegram. Funciones puras.

import { ESTADOS, ESTADO_BY_KEY, RANGO_BY_KEY, type EstadoKey } from './config';
import { encodeEstado, encodeInfo } from './callback';
import { isPending, sortEntries, type Entry, type Stats } from './habits';
import type { Keyboard } from './telegram';
import { esc } from './telegram';

// Botones solo con íconos, en el mismo orden que el Protocolo de la plantilla de Notion.
const BOTONES: EstadoKey[] = ESTADOS.map((e) => e.key);
const MAX_SENAL = 160;
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** Número del hábito en el mensaje: 1️⃣…🔟 y luego «11», «12»… */
export function numero(i: number): string {
  return KEYCAPS[i] ?? String(i + 1);
}

/** Leyenda de los botones, en el orden de la plantilla. */
export const LEYENDA = ESTADOS.map((e) => `${e.icon} ${e.label}`).join(' · ');

function corto(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function lineaEntry(e: Entry, n: string, senal?: string): string {
  const def = e.estado ? ESTADO_BY_KEY[e.estado] : ESTADO_BY_KEY.sin_iniciar;
  if (!isPending(e)) {
    return `${n} <s>${esc(e.nombre)}</s> · ${def.icon} <i>${def.label}</i>`;
  }
  const obj = e.objetivo ? ` · ${esc(e.objetivo)}` : '';
  const racha = e.streak && e.streak.racha > 0 ? ` · 🔥${e.streak.racha}` : '';
  const s = senal ? `\n    💡 <i>${esc(corto(senal, MAX_SENAL))}</i>` : '';
  return `${n} <b>${esc(e.nombre)}</b>${obj}${racha}${s}`;
}

/**
 * Una fila por hábito: [1️⃣] [⚪] [💤] [🕯️] [⚡] [🔥] [🚀]. El número identifica el hábito
 * (al tocarlo muestra su nombre) y el estado actual aparece como ✅.
 */
export function keyboardFor(entries: Entry[]): Keyboard {
  return entries.map((e, i) => [
    { text: numero(i), callback_data: encodeInfo(e.pageId) },
    ...BOTONES.map((key) => ({
      text: e.estado === key ? '✅' : ESTADO_BY_KEY[key].icon,
      callback_data: encodeEstado(e.pageId, key),
    })),
  ]);
}

export interface Rendered {
  text: string;
  keyboard: Keyboard;
}

/** Cabecera + lista de hábitos con botones. Se usa para avisos, /hoy y al editar tras un botón. */
export function renderLista(header: string, entries: Entry[], senales: Record<string, string> = {}): Rendered {
  const ordenadas = sortEntries(entries);
  const lineas = ordenadas.map((e, i) => lineaEntry(e, numero(i), e.habitId ? senales[e.habitId] : undefined));
  const pendientes = ordenadas.filter(isPending).length;
  const pie =
    pendientes === 0
      ? '\n\n🎉 <b>¡Todo registrado en este bloque!</b>'
      : `\n\n<i>Toca el nivel alcanzado en la fila de cada número:</i>\n<i>${LEYENDA}</i>`;
  return { text: `${header}\n\n${lineas.join('\n')}${pie}`, keyboard: keyboardFor(ordenadas) };
}

/** /hoy: todos los hábitos del día agrupados por rango horario. */
export function renderHoy(header: string, entries: Entry[]): Rendered {
  const ordenadas = sortEntries(entries);
  const bloques: string[] = [];
  let actual: string | null = null;
  ordenadas.forEach((e, i) => {
    const r = e.rango ?? 'dia';
    if (r !== actual) {
      actual = r;
      bloques.push(`\n${RANGO_BY_KEY[r].icon} <b>${RANGO_BY_KEY[r].label}</b>`);
    }
    bloques.push(lineaEntry(e, numero(i)));
  });
  const hechos = ordenadas.filter((e) => !isPending(e)).length;
  return {
    text: `${header} · ${hechos}/${ordenadas.length} registrados\n${bloques.join('\n')}\n\n<i>${LEYENDA}</i>`,
    keyboard: keyboardFor(ordenadas),
  };
}

export function renderRachas(stats: Stats[]): string {
  const activos = [...stats].sort((a, b) => b.state.racha - a.state.racha || a.nombre.localeCompare(b.nombre, 'es'));
  if (!activos.length) return 'Aún no hay rachas registradas. Se calculan cada madrugada (03:00).';
  const lineas = activos.map((s) => {
    const hielo = '🧊'.repeat(s.state.congeladores) || '—';
    return `🔥 <b>${s.state.racha}</b> · ${esc(s.nombre)}  <i>(mejor ${s.state.mejor})</i>  ${hielo}`;
  });
  const fecha = activos.map((s) => s.state.procesadoHasta).filter(Boolean).sort().pop();
  const pie = fecha ? `\n\n<i>Calculado hasta el ${fecha}. 🧊 = congeladores disponibles.</i>` : '';
  return `<b>🏆 Rachas</b>\n\n${lineas.join('\n')}${pie}`;
}

export const AYUDA = [
  '<b>Habit Coach</b> · tus hábitos de Notion en Telegram',
  '',
  '/hoy — todos los hábitos de hoy con botones',
  '/pendientes — solo lo que falta',
  '/rachas — rachas y congeladores 🧊',
  '/resumen — el coach analiza tu día',
  '/semana — revisión de los últimos 14 días',
  '/recalcular — rehace las rachas desde el historial',
  '/actualizar — vuelve a leer tus Matrices Atómicas',
  '',
  'Escríbeme lo que quieras («hoy no tengo ganas de ir al gym», «ya me bañé») y te respondo como coach; también puedo marcar tus hábitos.',
  '',
  '<i>Reglas: Parcial o mejor suma un día. Omitido o Sin iniciar gasta un 🧊; sin 🧊 la racha vuelve a 0. Ganas un 🧊 cada 7 días (máximo 2).</i>',
].join('\n');
