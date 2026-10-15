// Cron: decide qué bloque toca, envía avisos, cierre con coach y procesa rachas.

import {
  getSchema,
  fetchDay,
  fetchRange,
  coachData,
  enviarTarjetas,
  fallosKey,
  guardarUltimo,
  llmFallaKey,
  loadStats,
  matricesFor,
  saveStatsSnapshot,
  type App,
} from './app';
import { getCachedMatrices } from './matrix';
import { buildHistorial, coachCierre, coachSemana, TIMEOUT_CRON_MS } from './coach';
import { hasStreakProps, isPending, NOMBRE_PREFIX, parseEntry, streakProperties, type Entry, type HabitosSchema, type Stats } from './habits';
import { headerAviso, LEYENDA, renderMapa } from './messages';
import { dueSlots, SLOTS, VENTANA_MIN, type SlotKey } from './schedule';
import { closableUntil, INITIAL_STATE, outcomeFromEstado, processDays, type DayOutcome, type StreakState } from './streak';
import { addDays, formatCorto } from './time';
import { esc } from './telegram';

const sentKey = (date: string, slot: SlotKey) => `sent:${date}:${slot}`;
const notasKey = (date: string) => `notas:${date}`;
const erroresKey = (date: string) => `errores:${date}`;
const avisadosKey = (date: string) => `salud:avisados:${date}`;
const filasKey = (date: string) => `salud:filas:${date}`;

/** Sin filas de hoy en Notion: el bloque se reintenta, pero la alerta la da `revisarSalud`. */
class SinFilasError extends Error {}

export async function runScheduled(app: App): Promise<void> {
  const slots = dueSlots(app.now.minutes, app.schedule);
  let trabajo = false;
  for (const slot of slots) {
    const key = sentKey(app.now.date, slot);
    if (await app.kv.get(key)) continue;
    trabajo = true;
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
      if (!(e instanceof SinFilasError)) await registrarError(app, slot, String(e));
    }
  }
  // En los ciclos sin aviso se revisa la salud del bot y se leen las Matrices que falten
  // (el 💡 de cada tarjeta), así no gastan subrequests de los avisos.
  if (!trabajo) {
    try {
      await revisarSalud(app);
    } catch (e) {
      console.error(JSON.stringify({ evento: 'salud_error', error: String(e) }));
    }
    try {
      await precalentarMatrices(app);
    } catch (e) {
      console.error(JSON.stringify({ evento: 'matrices_error', error: String(e) }));
    }
  }
}

async function registrarError(app: App, slot: SlotKey, error: string): Promise<void> {
  const errores = (await app.kv.get<Record<string, string>>(erroresKey(app.now.date), 'json')) ?? {};
  errores[slot] = error.slice(0, 300);
  await app.kv.put(erroresKey(app.now.date), JSON.stringify(errores), { expirationTtl: 2 * 86400 });
}

// ---------- Alertas de salud ----------
// Fallos que de otro modo pasarían en silencio. Cada alerta se envía una sola vez al día.

/**
 * Las alertas esperan a las 06:00: no despiertan de madrugada, y para entonces Notion ya creó
 * las filas del día aunque la recurrencia no sea a las 00:00. Llegan antes del aviso de las 06:30.
 */
const SALUD_DESDE_MIN = 6 * 60;

export async function revisarSalud(app: App): Promise<string[]> {
  if (app.now.minutes < SALUD_DESDE_MIN) return [];
  const fecha = app.now.date;
  const avisados = new Set((await app.kv.get<string[]>(avisadosKey(fecha), 'json')) ?? []);
  const alertas: { clave: string; texto: string }[] = [];

  // 1. Bloques que fallaron en todos sus reintentos (su ventana ya pasó y no quedaron enviados).
  //    Los de ayer también: la ventana del cierre de las 23:00 termina a medianoche.
  const ayer = addDays(fecha, -1);
  for (const dia of [ayer, fecha]) {
    const errores = (await app.kv.get<Record<string, string>>(erroresKey(dia), 'json')) ?? {};
    for (const [slot, error] of Object.entries(errores) as [SlotKey, string][]) {
      const clave = dia === fecha ? slot : `${slot}:${dia}`;
      if (avisados.has(clave) || (dia === fecha && app.now.minutes < app.schedule[slot] + VENTANA_MIN)) continue;
      if ((await app.kv.get(sentKey(dia, slot))) === 'hecho') continue;
      // Lo de ayer ya se avisó ayer si su ventana terminó antes de medianoche.
      if (dia === ayer && app.schedule[slot] + VENTANA_MIN < 24 * 60) continue;
      const que = slot === 'procesar' ? 'No pude cerrar las rachas de ayer' : `Falló el aviso «${SLOTS[slot].titulo}»`;
      const extra = slot === 'procesar' ? ' Se reintentará mañana a las 03:00; también puedes usar /recalcular.' : '';
      alertas.push({ clave, texto: `${que}: <code>${esc(error.slice(0, 200))}</code>.${extra}` });
    }
  }

  // 2. Notion no creó las filas de hoy (recurrencias apagadas o plantillas borradas).
  if (!(await app.kv.get(filasKey(fecha)))) {
    const hoy = await fetchDay(app, await getSchema(app), fecha);
    await app.kv.put(filasKey(fecha), hoy.length ? 'ok' : 'vacio', { expirationTtl: 2 * 86400 });
    if (!hoy.length) {
      alertas.push({
        clave: 'filas',
        texto: 'Notion no creó las filas de hoy. Revisa que las plantillas de tus hábitos tengan la <b>recurrencia diaria activada</b>.',
      });
    }
  }

  // 3. El LLM principal falló hoy (sin saldo, clave inválida o caída) y se usó el respaldo.
  const llm = await app.kv.get(llmFallaKey(fecha));
  if (llm && !avisados.has('llm')) {
    const saldo = /\b402\b|insufficient|balance/i.test(llm) ? ' Parece falta de saldo: recarga tu cuenta de DeepSeek.' : '';
    alertas.push({ clave: 'llm', texto: `El coach de IA falló y usé el respaldo: <code>${esc(llm.slice(0, 200))}</code>.${saldo}` });
  }

  const nuevas = alertas.filter((a) => !avisados.has(a.clave));
  if (!nuevas.length) return [];
  await app.tg.send(app.chatId, `🩺 <b>Revisión del bot</b>\n\n${nuevas.map((a) => `⚠️ ${a.texto}`).join('\n\n')}`);
  for (const a of nuevas) avisados.add(a.clave);
  await app.kv.put(avisadosKey(fecha), JSON.stringify([...avisados]), { expirationTtl: 2 * 86400 });
  return nuevas.map((a) => a.clave);
}

const matricesOkKey = (date: string) => `matrices:ok:${date}`;

/**
 * Lee hasta `max` Matrices Atómicas que falten en caché para los hábitos de hoy. Cuando
 * están todas, deja una marca del día y deja de consultar Notion hasta mañana.
 */
export async function precalentarMatrices(app: App, max = 3): Promise<number> {
  if (await app.kv.get(matricesOkKey(app.now.date))) return 0;
  const hoy = await fetchDay(app, await getSchema(app), app.now.date);
  const ids = [...new Set(hoy.map((e) => e.habitId).filter((x): x is string => !!x))];
  const antes = Object.keys(await getCachedMatrices(app.kv, ids)).length;
  const ahora = Object.keys(await matricesFor(app, [...hoy.filter(isPending), ...hoy], max)).length;
  if (ahora >= ids.length && ids.length) await app.kv.put(matricesOkKey(app.now.date), '1', { expirationTtl: 2 * 86400 });
  return ahora - antes;
}

export async function olvidarMatricesOk(app: App): Promise<void> {
  await app.kv.delete(matricesOkKey(app.now.date));
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
  // Se reintenta en el siguiente cron: Notion pudo tardar en crear las filas del día.
  if (!hoy.length) throw new SinFilasError('no hay filas de hoy en Notion');

  if (def.tipo === 'cierre') return enviarCierre(app, hoy);

  const delBloque = hoy.filter((e) => def.rangos.includes(e.rango ?? 'dia'));
  // Las notas del cierre de rachas (🧊, 💔, 🏅, 🎁) van en el aviso de la mañana.
  const notas = slot === 'manana' ? await app.kv.get(notasKey(app.now.date)) : null;
  const titulo = `<b>${def.titulo}</b> · ${formatCorto(app.now.date)}`;
  if (!delBloque.some(isPending)) {
    if (!notas) return 'nada pendiente en este bloque';
    await app.tg.send(app.chatId, `${titulo}\n\n${notas}`);
    return 'solo las notas del cierre de rachas';
  }

  let header = headerAviso(titulo, def.intro);
  if (notas) header = `${notas}\n\n${header}`;

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
  const domingo = app.now.weekday === 0;
  const schema = await getSchema(app);
  // Historia para el contexto del coach: 14 días el domingo (la revisión los usa), 7 los demás.
  const desde = addDays(app.now.date, domingo ? -13 : -7);
  const hist = await fetchRange(app, schema, desde, domingo ? app.now.date : addDays(app.now.date, -1), domingo ? 3 : 2);
  const data = await coachData(app, hoy, { historia: hist.filter((e) => e.fecha !== app.now.date) });
  let texto: string;
  let mapa = '';
  if (domingo) {
    texto = await coachSemana(app.llm, data, buildHistorial(hist, desde, app.now.date));
    mapa = renderMapa(hist, desde, app.now.date);
  } else {
    texto = await coachCierre(app.llm, data, TIMEOUT_CRON_MS);
  }
  await guardarUltimo(app, texto);
  const titulo = domingo ? '📊 Revisión semanal' : SLOTS.cierre.titulo;
  const pendientes = hoy.filter(isPending);
  const pie = pendientes.length ? `\n\n<b>Aún puedes registrar (hasta las 03:00):</b>` : '';
  await app.tg.send(app.chatId, `<b>${titulo}</b> · ${formatCorto(app.now.date)}\n\n${texto}${mapa ? `\n\n${mapa}` : ''}${pie}`);
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
/** Llamadas a Notion por ejecución del cierre (el plan gratuito permite 50 subrequests). */
const MAX_LLAMADAS = 36;

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
  const fallos: string[] = [];
  // Subrequests a Notion: escrituras y búsquedas de la última fila cerrada.
  let llamadas = 0;
  let actualizados = 0;
  let incompleto = false;

  for (const [habitId, filas] of porHabito) {
    const fechas = [...filas.keys()].sort();
    const nombre = esc(filas.get(fechas[fechas.length - 1]!)!.nombre);
    const cerrada = fechas.filter((f) => f <= hasta && filas.get(f)!.streak?.cerrada).pop();
    let prev: StreakState = cerrada ? estadoDeFila(filas.get(cerrada)!) : { ...INITIAL_STATE };
    if (!cerrada) {
      // Sin filas cerradas en la ventana: puede ser nuevo, o antiguo y pausado (los días sin
      // fila son neutros, así que conserva su racha). Se busca su última fila cerrada.
      if (llamadas >= MAX_LLAMADAS) {
        incompleto = true;
        break;
      }
      llamadas++;
      prev = (await ultimaCerradaAntes(app, schema, habitId, filas.get(fechas[0]!)!.nombre, desde)) ?? prev;
      // Los días entre esa fila y la ventana no se leen (solo existen si el Worker estuvo
      // caído más de 14 días): se tratan como neutros.
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
      if (llamadas >= MAX_LLAMADAS) {
        incompleto = true;
        break;
      }
      await app.notion.updatePage(fila.pageId, streakProperties(schema, ev.state, true));
      llamadas++;
      tocado = true;
      if (ev.date === hasta && (ev.event === 'congelado' || ev.event === 'reinicio')) fallos.push(habitId);
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
    if (hoy && !hoy.streak?.cerrada && !mismoEstado(hoy.streak, r.state) && llamadas < MAX_LLAMADAS) {
      await app.notion.updatePage(hoy.pageId, streakProperties(schema, r.state, false));
      llamadas++;
      tocado = true;
    }
    if (tocado) actualizados++;
    snapshot.push({ habitId, nombre: filas.get(fechas[fechas.length - 1]!)!.nombre, state: r.state });
  }

  if (!incompleto && snapshot.length) await saveStatsSnapshot(app, snapshot);
  if (fallos.length) {
    // Se acumula: si el cierre se cortó, la siguiente ejecución agrega los que faltaban.
    const key = fallosKey(addDays(hasta, 1));
    const previos = (await app.kv.get<string[]>(key, 'json')) ?? [];
    await app.kv.put(key, JSON.stringify([...new Set([...previos, ...fallos])]), { expirationTtl: 2 * 86400 });
  }
  if (notas.length) {
    const previas = (await app.kv.get(notasKey(app.now.date))) ?? '';
    await app.kv.put(notasKey(app.now.date), [previas, ...notas].filter(Boolean).join('\n'), { expirationTtl: 2 * 86400 });
  }
  return { actualizados, hasta, incompleto };
}

/**
 * Páginas de historial que lee /recalcular: ~800 filas (unos 3 meses con 9 hábitos). Cada
 * fila pesa ~2,5 KB, y leer más arriesga los 10 ms de CPU del plan gratuito.
 */
const PAGINAS_RECALCULO = 8;
/** Llamadas a Notion de /recalcular, sumando las páginas leídas (límite gratuito: 50). */
const MAX_LLAMADAS_RECALCULO = 40;

export interface RecalculoResult {
  habitos: number;
  total: number;
  hasta: string;
  /** Si el historial era más largo que lo leído: primer día recalculado. */
  desde: string | null;
  incompleto: boolean;
}

/**
 * Rehace las rachas desde el historial y deja el resultado en la última fila cerrada y en la
 * de hoy de cada hábito. Solo escribe lo que cambia, así que si se corta por el tope de
 * llamadas, volver a ejecutarlo continúa donde quedó.
 */
export async function recalcular(app: App): Promise<RecalculoResult> {
  const hasta = closableUntil(app.now.date, app.now.minutes, app.schedule.procesar);
  const schema = await getSchema(app);
  if (!hasStreakProps(schema)) throw new Error('Faltan las columnas de racha en «Hábitos»: ejecuta node scripts/setup.mjs notion --aplicar');
  const entries = await fetchRange(app, schema, null, app.now.date, PAGINAS_RECALCULO);
  // Historial cortado: el día más antiguo leído puede estar incompleto. Cada hábito parte
  // entonces de su primera fila cerrada posterior, en lugar de empezar de cero.
  const corte = entries.length >= PAGINAS_RECALCULO * 100 ? entries.reduce((m, e) => (e.fecha! < m ? e.fecha! : m), app.now.date) : null;
  const porHabito = agrupar(entries);
  let llamadas = Math.ceil(entries.length / 100) + 1;
  const snapshot: Stats[] = [];
  let incompleto = false;

  const escribir = async (fila: Entry, st: StreakState, cerrada: boolean): Promise<boolean> => {
    if (fila.streak?.cerrada === cerrada && mismoEstado(fila.streak, st)) return true;
    if (llamadas >= MAX_LLAMADAS_RECALCULO) return false;
    await app.notion.updatePage(fila.pageId, streakProperties(schema, st, cerrada));
    llamadas++;
    return true;
  };

  for (const [habitId, filas] of porHabito) {
    const fechas = [...filas.keys()].sort();
    const outcomeOf = (d: string): DayOutcome => {
      const e = filas.get(d);
      return e ? outcomeFromEstado(e.estado ?? null) : 'none';
    };
    const base = corte ? fechas.find((f) => f > corte && f <= hasta && filas.get(f)!.streak?.cerrada) : undefined;
    const prev = base ? estadoDeFila(filas.get(base)!) : { ...INITIAL_STATE };
    const r = processDays(prev, hasta, outcomeOf, fechas[0]!);
    const ultimaFila = [...r.eventos].reverse().find((ev) => filas.has(ev.date));
    const hoy = filas.get(app.now.date);
    if (
      (ultimaFila && !(await escribir(filas.get(ultimaFila.date)!, ultimaFila.state, true))) ||
      (hoy && !(await escribir(hoy, r.state, false)))
    ) {
      incompleto = true;
      break;
    }
    snapshot.push({ habitId, nombre: filas.get(fechas[fechas.length - 1]!)!.nombre, state: r.state });
  }
  if (!incompleto) await saveStatsSnapshot(app, snapshot);
  return { habitos: snapshot.length, total: porHabito.size, hasta, desde: corte, incompleto };
}
