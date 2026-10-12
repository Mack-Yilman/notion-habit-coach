// Textos fijos de los avisos (sin IA) y teclados de Telegram. Funciones puras.
//
// Diseño de botones (decidido por el usuario): un mensaje por hábito pendiente, con
// solo íconos en el orden del Protocolo de la plantilla. Al registrar, la tarjeta
// muestra el nivel alcanzado y un único botón ↩️ para deshacer.

import { ESTADOS, ESTADO_BY_KEY, RANGO_BY_KEY, type EstadoKey } from './config';
import { encodeDeshacer, encodeEstado } from './callback';
import { isPending, sortEntries, type Entry, type Stats } from './habits';
import type { Keyboard } from './telegram';
import { esc } from './telegram';
import { dateRange, formatCorto } from './time';

/** Niveles que se pueden registrar, en el orden del Protocolo (⚪ Sin iniciar se logra con ↩️). */
const BOTONES: EstadoKey[] = ESTADOS.filter((e) => e.key !== 'sin_iniciar').map((e) => e.key);
const MAX_SENAL = 160;

/** Leyenda de los íconos, en el orden de los botones. */
export const LEYENDA = BOTONES.map((k) => `${ESTADO_BY_KEY[k].icon} ${ESTADO_BY_KEY[k].label}`).join(' · ');

function corto(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export interface Rendered {
  text: string;
  keyboard: Keyboard;
}

/** Botones de una tarjeta: los 5 niveles si está pendiente; si no, solo ↩️. */
export function keyboardCard(e: Entry): Keyboard {
  if (!isPending(e)) return [[{ text: '↩️', callback_data: encodeDeshacer(e.pageId) }]];
  return [BOTONES.map((key) => ({ text: ESTADO_BY_KEY[key].icon, callback_data: encodeEstado(e.pageId, key) }))];
}

/**
 * Tarjeta de un hábito. `header` (título del bloque y leyenda) solo va en la primera
 * tarjeta de cada aviso y se conserva al editarla.
 */
/** «🌆 Tarde · 12:00 a 17:59» o «❇️ Durante el día», como en la plantilla. */
export function etiquetaRango(e: Entry): string {
  if (!e.rango) return '';
  const r = RANGO_BY_KEY[e.rango];
  return `${r.icon} ${r.label}${r.horas ? ` · ${r.horas}` : ''}`;
}

/** Datos extra de una tarjeta pendiente. */
export interface ExtrasCard {
  /** El hábito falló ayer: «nunca falles dos veces». */
  falloAyer?: boolean;
  /** Versión mínima (nivel Parcial del Protocolo), para salvar el día. */
  minima?: string;
}

export function renderCard(e: Entry, senal?: string, header?: string, extras: ExtrasCard = {}): Rendered {
  const obj = e.objetivo ? ` · ${esc(e.objetivo)}` : '';
  const rango = etiquetaRango(e);
  let cuerpo: string;
  if (isPending(e)) {
    const racha = e.streak && e.streak.racha > 0 ? ` · 🔥${e.streak.racha}` : '';
    const minima = extras.minima ? `\n🕯️ Mínimo: <i>${esc(corto(extras.minima, MAX_SENAL))}</i>` : '';
    const dosVeces = extras.falloAyer ? `\n⚠️ <i>Ayer no salió: no falles dos veces.</i>${minima}` : '';
    const s = senal ? `\n💡 <i>${esc(corto(senal, MAX_SENAL))}</i>` : '';
    cuerpo = `<b>${esc(e.nombre)}</b>${obj}${racha}${dosVeces}${s}`;
  } else {
    const def = ESTADO_BY_KEY[e.estado!];
    cuerpo = `${def.icon} <b>${esc(e.nombre)}</b> · <i>${def.label}</i>`;
  }
  if (rango) cuerpo = `${rango}\n${cuerpo}`;
  return { text: header ? `${header}\n\n${cuerpo}` : cuerpo, keyboard: keyboardCard(e) };
}

/** Cabecera de un aviso: título, introducción y leyenda de íconos. */
export function headerAviso(titulo: string, intro: string): string {
  return `${titulo}\n${intro}\n<i>${LEYENDA}</i>`;
}

/** /hoy: resumen del día agrupado por rango horario (solo texto; las tarjetas van aparte). */
export function renderResumenHoy(header: string, entries: Entry[]): string {
  const ordenadas = sortEntries(entries);
  const bloques: string[] = [];
  let actual: string | null = null;
  for (const e of ordenadas) {
    const r = e.rango ?? 'dia';
    if (r !== actual) {
      actual = r;
      bloques.push(`\n${RANGO_BY_KEY[r].icon} <b>${RANGO_BY_KEY[r].label}</b>`);
    }
    const def = e.estado ? ESTADO_BY_KEY[e.estado] : ESTADO_BY_KEY.sin_iniciar;
    const racha = e.streak && e.streak.racha > 0 ? ` · 🔥${e.streak.racha}` : '';
    bloques.push(`${def.icon} ${esc(e.nombre)}${racha}`);
  }
  const hechos = ordenadas.filter((e) => !isPending(e)).length;
  const pendientes = ordenadas.length - hechos;
  const pie = pendientes ? `\n\n<i>Abajo tienes los ${pendientes} pendientes para registrar.</i>` : '\n\n🎉 <b>¡Todo registrado hoy!</b>';
  return `${header} · ${hechos}/${ordenadas.length} registrados\n${bloques.join('\n')}${pie}`;
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

/**
 * Mapa de los últimos días para /semana: una fila de íconos por hábito, en semanas de 7.
 * ➖ = ese día el hábito no tenía fila (neutro para la racha).
 */
export function renderMapa(historial: Entry[], desde: string, hasta: string): string {
  const dias = dateRange(desde, hasta);
  const porHabito = new Map<string, { ultima: Entry; serie: Map<string, EstadoKey | null> }>();
  for (const e of historial) {
    if (!e.fecha) continue;
    const k = e.habitId ?? e.nombre;
    const h = porHabito.get(k) ?? { ultima: e, serie: new Map<string, EstadoKey | null>() };
    if (e.fecha >= h.ultima.fecha!) h.ultima = e; // nombre y rango más recientes
    h.serie.set(e.fecha, e.estado);
    porHabito.set(k, h);
  }
  if (!porHabito.size) return '';
  const lineas = sortEntries([...porHabito.values()].map((h) => h.ultima)).map((e) => {
    const serie = porHabito.get(e.habitId ?? e.nombre)!.serie;
    const iconos = dias.map((d) => (serie.has(d) ? ESTADO_BY_KEY[serie.get(d) ?? 'sin_iniciar'].icon : '➖'));
    const semanas: string[] = [];
    for (let i = 0; i < iconos.length; i += 7) semanas.push(iconos.slice(i, i + 7).join(''));
    return `${semanas.join(' ')}  ${esc(e.nombre)}`;
  });
  return `<b>🗓️ Últimos ${dias.length} días</b> · ${formatCorto(desde)} → ${formatCorto(hasta)}\n${lineas.join('\n')}\n<i>➖ = sin fila ese día</i>`;
}

export const AYUDA = [
  '<b>Habit Coach</b> · tus hábitos de Notion en Telegram',
  '',
  'Cada hábito pendiente llega en su propio mensaje. Toca el nivel que alcanzaste:',
  LEYENDA,
  'Se guarda en Notion al instante. Si te equivocas, toca ↩️ y vuelve a elegir.',
  '',
  '/hoy — resumen del día y los pendientes para registrar',
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
