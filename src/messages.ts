// Textos fijos de los avisos (sin IA) y teclados de Telegram. Funciones puras.

import { ESTADO_BY_KEY, RANGO_BY_KEY, type EstadoKey } from './config';
import { encodeEstado } from './callback';
import { isPending, sortEntries, type Entry, type Stats } from './habits';
import type { Keyboard } from './telegram';
import { esc } from './telegram';

const BOTONES: EstadoKey[] = ['hecho', 'parcial', 'superado', 'alto', 'omitido'];
const MAX_SENAL = 160;

function corto(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function lineaEntry(e: Entry, senal?: string): string {
  const def = e.estado ? ESTADO_BY_KEY[e.estado] : ESTADO_BY_KEY.sin_iniciar;
  const obj = e.objetivo ? ` · ${esc(e.objetivo)}` : '';
  if (!isPending(e)) {
    return `${def.icon} <s>${esc(e.nombre)}</s> · <i>${def.label}</i>`;
  }
  const racha = e.streak && e.streak.racha > 0 ? ` · 🔥${e.streak.racha}` : '';
  const s = senal ? `\n    💡 <i>${esc(corto(senal, MAX_SENAL))}</i>` : '';
  return `${def.icon} <b>${esc(e.nombre)}</b>${obj}${racha}${s}`;
}

/** Una fila de botones por hábito: [⚡ Nombre] [🕯️] [🔥] [🚀] [💤]. */
export function keyboardFor(entries: Entry[]): Keyboard {
  return entries.map((e) =>
    BOTONES.map((key, i) => {
      const def = ESTADO_BY_KEY[key];
      const marcado = e.estado === key ? '✅' : def.icon;
      const text = i === 0 ? `${marcado} ${corto(e.nombre, 18)}` : marcado;
      return { text, callback_data: encodeEstado(e.pageId, key) };
    }),
  );
}

export interface Rendered {
  text: string;
  keyboard: Keyboard;
}

/** Cabecera + lista de hábitos con botones. Se usa para avisos, /hoy y al editar tras un botón. */
export function renderLista(header: string, entries: Entry[], senales: Record<string, string> = {}): Rendered {
  const ordenadas = sortEntries(entries);
  const lineas = ordenadas.map((e) => lineaEntry(e, e.habitId ? senales[e.habitId] : undefined));
  const pendientes = ordenadas.filter(isPending).length;
  const pie =
    pendientes === 0
      ? '\n\n🎉 <b>¡Todo registrado en este bloque!</b>'
      : '\n\n<i>Toca un botón para registrar. El primero marca ⚡ Hecho.</i>';
  return { text: `${header}\n\n${lineas.join('\n')}${pie}`, keyboard: keyboardFor(ordenadas) };
}

/** /hoy: todos los hábitos del día agrupados por rango horario. */
export function renderHoy(header: string, entries: Entry[]): Rendered {
  const ordenadas = sortEntries(entries);
  const bloques: string[] = [];
  let actual: string | null = null;
  for (const e of ordenadas) {
    const r = e.rango ?? 'dia';
    if (r !== actual) {
      actual = r;
      bloques.push(`\n${RANGO_BY_KEY[r].icon} <b>${RANGO_BY_KEY[r].label}</b>`);
    }
    bloques.push(lineaEntry(e));
  }
  const hechos = ordenadas.filter((e) => !isPending(e)).length;
  return {
    text: `${header} · ${hechos}/${ordenadas.length} registrados\n${bloques.join('\n')}`,
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
