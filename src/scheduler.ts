// Cron: decide qué bloque toca, envía avisos, cierre con coach y procesa rachas.

import { getSchema, fetchDay, fetchRange, coachData, enviarTarjetas, loadStats, saveStatsSnapshot, type App } from './app';
import { buildHistorial, coachCierre, coachSemana } from './coach';
import { hasStreakProps, isPending, NOMBRE_PREFIX, parseEntry, streakProperties, type Entry, type HabitosSchema, type Stats } from './habits';
import { headerAviso, LEYENDA } from './messages';
import { dueSlots, SLOTS, type SlotKey } from './schedule';
import { closableUntil, INITIAL_STATE, outcomeFromEstado, processDays, type DayOutcome, type StreakState } from './streak';
import { addDays, formatCorto } from './time';
import { esc } from './telegram';

const sentKey = (date: string, slot: SlotKey) => `sent:${date}:${slot}`;
const notasKey = (date: string) => `notas:${date}`;

export async function runScheduled(app: App): Promise<void> {
  for (const slot of dueSlots(app.now.minutes, app.schedule)) {
    const key = sentKey(app.now.date, slot);
    if (await app.kv.get(key)) continue;
    // Candado: el cron es «al menos una vez»; evita que dos ejecuciones envíen el mismo aviso.
    // Si el bloque falla, el candado se borra y el siguiente cron lo reintenta.
    await app.kv.put(key, 'en_curso', { expirationTtl: 600 });
    try {
      const r = await runSlot(app, slot);
      console.log(JSON.stringify({ evento: 'slot', slot, fecha: app.now.date, resultado: r }));
      await app.kv.put(key, 'hecho', { expirationTtl: 3 * 86400 });
    } catch (e) {
      console.error(JSON.stringify({ evento: 'slot_error', slot, error: String(e) }));
      await app.kv.delete(key);
    }
  }
}

export async function runSlot(app: App, slot: SlotKey): Promise<string> {
  const def = SLOTS[slot];
  if (def.tipo === 'procesar') {
    const r = await closeDays(app);
    // Si se cortó por el tope de escrituras, el error hace que el siguiente cron lo retome.
    if (r.incompleto) throw new Error(`cierre incompleto (${r.actualizados} hábitos); se retoma en el siguiente cron`);
    return `procesados ${r.actualizados} hábitos hasta ${r.hasta}`;
  }

  const schema = await getSchema(app);
  const hoy = await fetchDay(app, schema, app.now.date);
  if (!hoy.length) return 'no hay filas de hoy en Notion';

  if (def.tipo === 'cierre') return enviarCierre(app, hoy);

  const delBloque = hoy.filter((e) => def.rangos.includes(e.rango ?? 'dia'));
  if (!delBloque.some(isPending)) return 'nada pendiente en este bloque';

  let header = headerAviso(`<b>${def.titulo}</b> · ${formatCorto(app.now.date)}`, def.intro);
  if (slot === 'manana') {
    const notas = await app.kv.get(notasKey(app.now.date));
    if (notas) header = `${notas}\n\n${header}`;
  }

  // Recordatorio inteligente: los últimos llamados solo suenan si hay una racha en riesgo.
  let silencioso = false;
  if (def.ultimo) {
    const riesgo = enRiesgo(delBloque, await loadStats(app, hoy));
    silencioso = riesgo.length === 0;
    if (riesgo.length) header = `${lineaRiesgo(riesgo)}\n\n${header}`;
  }
  // Aprovecha el aviso para leer hasta 2 Matrices que falten en caché.
  const n = await enviarTarjetas(app, hoy, delBloque, header, 2, silencioso);
  return `aviso con ${n} pendientes${def.ultimo ? (silencioso ? ' (silencioso)' : ' (racha en riesgo)') : ''}`;
}

/**
 * Pendientes que perderían su racha si no se hacen hoy: tienen racha y ya no les quedan
 * congeladores. Si fallarlo no cuesta nada (racha 0 o queda un 🧊), no es riesgo.
 */
export function enRiesgo(entries: Entry[], stats: Record<string, Stats>): { nombre: string; racha: number }[] {
  return entries
    .filter(isPending)
    .map((e) => ({ e, st: e.habitId ? stats[e.habitId]?.state : undefined }))
    .filter(({ st }) => !!st && st.racha > 0 && st.congeladores === 0)
    .map(({ e, st }) => ({ nombre: e.nombre, racha: st!.racha }));
}

export function lineaRiesgo(riesgo: { nombre: string; racha: number }[]): string {
  const lista = riesgo.map((r) => `«${esc(r.nombre)}» (${r.racha} ${r.racha === 1 ? 'día' : 'días'})`).join(', ');
  return `⚠️ <b>Racha en riesgo, sin 🧊:</b> ${lista}`;
}

async function enviarCierre(app: App, hoy: Entry[]): Promise<string> {
  const data = await coachData(app, hoy);
  const domingo = app.now.weekday === 0;
  let texto: string;
  if (domingo) {
    const schema = await getSchema(app);
    const desde = addDays(app.now.date, -13);
    const hist = await fetchRange(app, schema, desde, app.now.date, 3);
    texto = await coachSemana(app.llm, data, buildHistorial(hist, desde, app.now.date));
  } else {
    texto = await coachCierre(app.llm, data);
  }
  const titulo = domingo ? '📊 Revisión semanal' : SLOTS.cierre.titulo;
  const pendientes = hoy.filter(isPending);
  const pie = pendientes.length ? `\n\n<b>Aún puedes registrar (hasta las 03:00):</b>` : '';
  await app.tg.send(app.chatId, `<b>${titulo}</b> · ${formatCorto(app.now.date)}\n\n${texto}${pie}`);
  // Tarjetas silenciosas para salvar lo que falta antes del cierre de las 03:00.
  const n = await enviarTarjetas(app, hoy, pendientes, `<i>${LEYENDA}</i>`);
  return `cierre con ${n} pendientes`;
}

// ---------- Rachas ----------
// Las rachas se guardan en las filas diarias de «Hábitos» (ver habits.ts). Cada día
// cerrado queda escrito en su fila, así que el cierre es reanudable: si se corta por el
// tope de escrituras, la siguiente ejecución sigue desde la última fila cerrada.

function agrupar(entries: Entry[]): Map<string, Map<string, Entry>> {
  const porHabito = new Map<string, Map<string, Entry>>();
  for (const e of entries) {
    if (!e.habitId || !e.fecha) continue;
    const m = porHabito.get(e.habitId) ?? new Map<string, Entry>();
    m.set(e.fecha, e);
    porHabito.set(e.habitId, m);
  }
  return porHabito;
}

const VENTANA = 14;
/** Escrituras a Notion por ejecución (el plan gratuito permite 50 subrequests). */
const MAX_ESCRITURAS = 36;

function estadoDeFila(e: Entry): StreakState {
  const s = e.streak!;
  return { racha: s.racha, mejor: s.mejor, congeladores: s.congeladores, procesadoHasta: e.fecha };
}

function mismoEstado(a: Entry['streak'], b: StreakState): boolean {
  return !!a && a.racha === b.racha && a.mejor === b.mejor && a.congeladores === b.congeladores;
}

/** Última fila cerrada de un hábito antes de `desde` (solo si la ventana no tiene ninguna). */
async function ultimaCerradaAntes(
  app: App,
  schema: HabitosSchema,
  habitId: string,
  nombre: string,
  desde: string,
): Promise<StreakState | null> {
  if (!schema.cerrada) return null;
  // Hábitos sin relación «Estadística» se agrupan por nombre (ver parseEntry).
  const delHabito = habitId.startsWith(NOMBRE_PREFIX)
    ? { property: schema.titulo, title: { equals: nombre } }
    : schema.relacion
      ? { property: schema.relacion, relation: { contains: habitId } }
      : null;
  if (!delHabito) return null;
  const pages = await app.notion.queryAll(
    schema.dataSourceId,
    {
      filter: {
        and: [
          delHabito,
          { property: schema.cerrada, checkbox: { equals: true } },
          { property: schema.fecha, date: { before: desde } },
        ],
      },
      sorts: [{ property: schema.fecha, direction: 'descending' }],
    },
    1,
  );
  const e = pages.map((p) => parseEntry(p, schema)).find((x) => x.streak && x.fecha);
  return e ? estadoDeFila(e) : null;
}

export interface CloseResult {
  actualizados: number;
  hasta: string;
  incompleto: boolean;
}

/** Cierra los días pendientes (hasta ayer, o anteayer si aún no son las 03:00) y sella hoy. */
export async function closeDays(app: App): Promise<CloseResult> {
  const hasta = closableUntil(app.now.date, app.now.minutes, app.schedule.procesar);
  const desde = addDays(hasta, -(VENTANA - 1));
  const schema = await getSchema(app);
  if (!hasStreakProps(schema)) {
    await app.kv.put(notasKey(app.now.date), '⚠️ Faltan las columnas de racha en «Hábitos»: ejecuta <code>node scripts/setup.mjs notion --aplicar</code>.', { expirationTtl: 2 * 86400 });
    return { actualizados: 0, hasta, incompleto: false };
  }
  const porHabito = agrupar(await fetchRange(app, schema, desde, app.now.date, 5));

  const notas: string[] = [];
  const snapshot: Stats[] = [];
  let escrituras = 0;
  let actualizados = 0;
  let incompleto = false;

  for (const [habitId, filas] of porHabito) {
    const fechas = [...filas.keys()].sort();
    const nombre = esc(filas.get(fechas[fechas.length - 1]!)!.nombre);
    const cerrada = fechas.filter((f) => f <= hasta && filas.get(f)!.streak?.cerrada).pop();
    let prev: StreakState = cerrada ? estadoDeFila(filas.get(cerrada)!) : { ...INITIAL_STATE };
    if (!cerrada && fechas[0]! === desde) {
      // La ventana no tiene filas cerradas pero el hábito es más antiguo: busca la última.
      prev = (await ultimaCerradaAntes(app, schema, habitId, filas.get(fechas[0]!)!.nombre, desde)) ?? prev;
      if (prev.procesadoHasta && prev.procesadoHasta < addDays(desde, -1)) prev.procesadoHasta = addDays(desde, -1);
    }
    const outcomeOf = (d: string): DayOutcome => {
      const e = filas.get(d);
      return e ? outcomeFromEstado(e.estado ?? null) : 'none';
    };
    const r = processDays(prev, hasta, outcomeOf, fechas[0]!);

    let tocado = false;
    for (const ev of r.eventos) {
      const fila = filas.get(ev.date);
      if (!fila) continue; // día neutro: no hay fila que escribir
      if (escrituras >= MAX_ESCRITURAS) {
        incompleto = true;
        break;
      }
      await app.notion.updatePage(fila.pageId, streakProperties(schema, ev.state, true));
      escrituras++;
      tocado = true;
      if (ev.event === 'congelado') notas.push(`🧊 «${nombre}» usó un congelador (${formatCorto(ev.date)}).`);
      if (ev.event === 'reinicio' && ev.antes > 0) notas.push(`💔 «${nombre}» perdió su racha de ${ev.antes} días.`);
      if (ev.ganoCongelador) notas.push(`🎁 «${nombre}» ganó un congelador por 7 días seguidos.`);
    }
    if (incompleto) break;
    if (r.state.racha >= 3 && r.state.racha === r.state.mejor && r.state.mejor > prev.mejor) {
      notas.push(`🏅 Récord en «${nombre}»: ${r.state.racha} días.`);
    }

    // Sella la fila de hoy con la racha con la que empieza el día (para verla en Notion).
    const hoy = filas.get(app.now.date);
    if (hoy && !hoy.streak?.cerrada && !mismoEstado(hoy.streak, r.state) && escrituras < MAX_ESCRITURAS) {
      await app.notion.updatePage(hoy.pageId, streakProperties(schema, r.state, false));
      escrituras++;
      tocado = true;
    }
    if (tocado) actualizados++;
    snapshot.push({ habitId, nombre: filas.get(fechas[fechas.length - 1]!)!.nombre, state: r.state });
  }

  if (!incompleto && snapshot.length) await saveStatsSnapshot(app, snapshot);
  if (notas.length) {
    const previas = (await app.kv.get(notasKey(app.now.date))) ?? '';
    await app.kv.put(notasKey(app.now.date), [previas, ...notas].filter(Boolean).join('\n'), { expirationTtl: 2 * 86400 });
  }
  return { actualizados, hasta, incompleto };
}

/** Rehace las rachas desde todo el historial y deja el resultado en la última fila de cada hábito. */
export async function recalcular(app: App): Promise<{ habitos: number; hasta: string }> {
  const hasta = closableUntil(app.now.date, app.now.minutes, app.schedule.procesar);
  const schema = await getSchema(app);
  if (!hasStreakProps(schema)) throw new Error('Faltan las columnas de racha en «Hábitos»: ejecuta node scripts/setup.mjs notion --aplicar');
  // Hasta 15 páginas de 100 filas (~5 meses con 10 hábitos) sin pasar el límite de subrequests.
  const porHabito = agrupar(await fetchRange(app, schema, null, app.now.date, 15));
  const snapshot: Stats[] = [];
  for (const [habitId, filas] of porHabito) {
    const fechas = [...filas.keys()].sort();
    const outcomeOf = (d: string): DayOutcome => {
      const e = filas.get(d);
      return e ? outcomeFromEstado(e.estado ?? null) : 'none';
    };
    const r = processDays({ ...INITIAL_STATE }, hasta, outcomeOf, fechas[0]!);
    const ultimaFila = [...r.eventos].reverse().find((ev) => filas.has(ev.date));
    if (ultimaFila) await app.notion.updatePage(filas.get(ultimaFila.date)!.pageId, streakProperties(schema, ultimaFila.state, true));
    const hoy = filas.get(app.now.date);
    if (hoy) await app.notion.updatePage(hoy.pageId, streakProperties(schema, r.state, false));
    snapshot.push({ habitId, nombre: filas.get(fechas[fechas.length - 1]!)!.nombre, state: r.state });
  }
  await saveStatsSnapshot(app, snapshot);
  return { habitos: snapshot.length, hasta };
}
