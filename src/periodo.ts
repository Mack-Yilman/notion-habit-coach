// Cifras de un periodo (semana o mes), calculadas por el Worker: el coach las interpreta,
// no las calcula. Lógica pura, sin red.

import { RANGO_BY_KEY } from './config';
import { sortEntries, type Entry } from './habits';
import { outcomeFromEstado } from './streak';
import { addDays, dateRange, formatCorto } from './time';
import { esc } from './telegram';

export interface Tasa {
  ok: number;
  tot: number;
}

export interface ResumenPeriodo {
  desde: string;
  hasta: string;
  total: Tasa;
  porHabito: Record<string, Tasa>;
  porRango: Record<string, Tasa>;
}

const MIN_FILAS = 3; // menos filas no dan una tasa que valga la pena comparar

const pct = (t: Tasa) => (t.tot ? Math.round((t.ok / t.tot) * 100) : 0);
const suma = (m: Record<string, Tasa>, k: string, ok: number) => {
  const t = (m[k] ??= { ok: 0, tot: 0 });
  t.ok += ok;
  t.tot += 1;
};

export function resumir(entries: Entry[], desde: string, hasta: string): ResumenPeriodo {
  const r: ResumenPeriodo = { desde, hasta, total: { ok: 0, tot: 0 }, porHabito: {}, porRango: {} };
  for (const e of entries) {
    if (!e.fecha || e.fecha < desde || e.fecha > hasta) continue;
    const ok = outcomeFromEstado(e.estado ?? null) === 'done' ? 1 : 0;
    r.total.ok += ok;
    r.total.tot += 1;
    suma(r.porHabito, e.nombre, ok);
    suma(r.porRango, e.rango ? RANGO_BY_KEY[e.rango].label : 'Sin rango', ok);
  }
  return r;
}

/** Semana actual (últimos 7 días hasta `hasta`) y la anterior, de una ventana de 14 días. */
export function semanaYPrevia(entries: Entry[], hasta: string): { actual: ResumenPeriodo; previo: ResumenPeriodo } {
  const inicio = addDays(hasta, -6);
  return { actual: resumir(entries, inicio, hasta), previo: resumir(entries, addDays(inicio, -7), addDays(inicio, -1)) };
}

const ordenar = (r: ResumenPeriodo) =>
  Object.entries(r.porHabito)
    .filter(([, t]) => t.tot >= MIN_FILAS)
    .map(([nombre, t]) => ({ nombre, t, p: pct(t) }))
    .sort((a, b) => b.p - a.p || a.nombre.localeCompare(b.nombre, 'es'));

const flecha = (d: number) => (d > 0 ? `🔼 +${d}` : d < 0 ? `🔽 ${d}` : '➖ 0');

/**
 * Bloque de cifras que se muestra tal cual en el mensaje (y que el modelo recibe sin
 * etiquetas): cumplimiento, comparación con el periodo anterior, mejor y peor hábito y rango.
 */
export function renderCifras(actual: ResumenPeriodo, previo: ResumenPeriodo | null, etiquetaPrevio: string): string {
  if (!actual.total.tot) return '';
  const lineas = ['<b>📈 Cifras</b>'];
  const hay = previo && previo.total.tot > 0;
  const cmp = hay ? ` · ${flecha(pct(actual.total) - pct(previo!.total))} pts vs. ${etiquetaPrevio} (${pct(previo!.total)} %)` : '';
  lineas.push(`Cumplimiento: <b>${pct(actual.total)} %</b> (${actual.total.ok}/${actual.total.tot})${cmp}`);

  const hab = ordenar(actual);
  const mejor = hab[0];
  const peor = hab[hab.length - 1];
  if (mejor) lineas.push(`💪 Más constante: ${esc(mejor.nombre)} ${mejor.p} %`);
  if (peor && peor !== mejor && peor.p < 100) lineas.push(`🌧️ Más flojo: ${esc(peor.nombre)} ${peor.p} %`);

  const rangos = Object.entries(actual.porRango)
    .filter(([, t]) => t.tot >= MIN_FILAS)
    .map(([k, t]) => ({ k, p: pct(t) }))
    .sort((a, b) => b.p - a.p);
  if (rangos.length > 1 && rangos[0]!.p !== rangos[rangos.length - 1]!.p) {
    lineas.push(`🕒 Rango más flojo: ${esc(rangos[rangos.length - 1]!.k)} ${rangos[rangos.length - 1]!.p} %`);
  }

  if (hay) {
    const cambios = hab
      .filter(({ nombre }) => (previo!.porHabito[nombre]?.tot ?? 0) >= MIN_FILAS)
      .map(({ nombre, p }) => ({ nombre, d: p - pct(previo!.porHabito[nombre]!) }))
      .sort((a, b) => b.d - a.d);
    const sube = cambios[0];
    const baja = cambios[cambios.length - 1];
    if (sube && sube.d >= 10) lineas.push(`🚀 Más mejoró: ${esc(sube.nombre)} ${flecha(sube.d)} pts`);
    if (baja && baja.d <= -10) lineas.push(`⚠️ Más cayó: ${esc(baja.nombre)} ${flecha(baja.d)} pts`);
  }
  return lineas.join('\n');
}

/** En KV se guarda el ResumenPeriodo del mes para compararlo el mes siguiente (sin leer más Notion). */
export const snapshotMesKey = (mes: string) => `resumen:mes:${mes}`;

const ICONO_SEMANA = (t: Tasa | undefined) => (!t || !t.tot ? '⬜' : pct(t) >= 85 ? '🟩' : pct(t) >= 60 ? '🟨' : pct(t) >= 40 ? '🟧' : '🟥');

/**
 * Mapa del mes: por hábito, su nombre en una línea y debajo un cuadro por semana
 * (🟩 ≥85 %, 🟨 ≥60 %, 🟧 ≥40 %, 🟥 menos, ⬜ sin filas). Un cuadro por semana cabe siempre en una línea.
 */
export function renderMapaMes(entries: Entry[], desde: string, hasta: string): string {
  const dias = dateRange(desde, hasta);
  const semanas: [string, string][] = [];
  for (let i = 0; i < dias.length; i += 7) semanas.push([dias[i]!, dias[Math.min(i + 6, dias.length - 1)]!]);
  const porHabito = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!e.fecha || e.fecha < desde || e.fecha > hasta) continue;
    const k = e.habitId ?? e.nombre;
    porHabito.set(k, [...(porHabito.get(k) ?? []), e]);
  }
  if (!porHabito.size) return '';
  const ultimas = [...porHabito.values()].map((fs) => fs.reduce((a, b) => (b.fecha! >= a.fecha! ? b : a)));
  const lineas = sortEntries(ultimas).map((u) => {
    const fs = porHabito.get(u.habitId ?? u.nombre)!;
    const total = resumir(fs, desde, hasta).total;
    const cuadros = semanas.map(([a, b]) => ICONO_SEMANA(resumir(fs, a, b).total)).join('');
    return `<b>${esc(u.nombre)}</b> · ${pct(total)} %\n${cuadros}`;
  });
  const leyenda = semanas.map(([a, b]) => `${formatCorto(a).slice(4)}–${formatCorto(b).slice(4)}`).join(' · ');
  return `<b>🗓️ Mes por semanas</b>\n${lineas.join('\n')}\n<i>🟩 ≥85 % · 🟨 ≥60 % · 🟧 ≥40 % · 🟥 menos · ⬜ sin filas\nSemanas: ${leyenda}</i>`;
}
