// Contexto por invocación (nunca estado global) y accesos a Notion con caché en KV.

import type { Env } from './env';
import { hasStreakProps, isPending, parseEntry, resolveHabitosSchema, sortEntries, statsFromEntries, type Entry, type HabitosSchema, type Stats } from './habits';
import { complete, type LlmOptions } from './llm';
import { getCachedMatrices, refreshMatrices, senalesDe, type Matrix } from './matrix';
import { renderCard } from './messages';
import { Notion } from './notion';
import { parseSchedule, type SlotKey } from './schedule';
import { Telegram } from './telegram';
import { localNow, type LocalNow } from './time';
import type { CoachData } from './coach';

export interface App {
  env: Env;
  kv: KVNamespace;
  notion: Notion;
  tg: Telegram;
  now: LocalNow;
  schedule: Record<SlotKey, number>;
  chatId: string;
  llm: (opts: LlmOptions) => ReturnType<typeof complete>;
}

export function makeApp(env: Env, when = new Date()): App {
  return {
    env,
    kv: env.STATE,
    notion: new Notion(env.NOTION_TOKEN),
    tg: new Telegram(env.TELEGRAM_BOT_TOKEN),
    now: localNow(when, env.TZ || 'America/Lima'),
    schedule: parseSchedule(env.SCHEDULE),
    chatId: String(env.TELEGRAM_CHAT_ID ?? '').trim(),
    llm: (opts) => complete(env, opts),
  };
}

export function hhmm(app: App): string {
  return `${String(app.now.hour).padStart(2, '0')}:${String(app.now.minute).padStart(2, '0')}`;
}

// ---------- Esquema ----------

const SCHEMA_KEY = 'schema:habitos';

export async function getSchema(app: App, fresh = false): Promise<HabitosSchema> {
  if (!fresh) {
    const cached = await app.kv.get<HabitosSchema>(SCHEMA_KEY, 'json');
    // Sin columnas de racha se relee: pudieron agregarse después de guardar la caché.
    if (cached && cached.dataSourceId === app.env.HABITOS_DATA_SOURCE_ID && hasStreakProps(cached)) return cached;
  }
  const schema = resolveHabitosSchema(await app.notion.getDataSource(app.env.HABITOS_DATA_SOURCE_ID));
  await app.kv.put(SCHEMA_KEY, JSON.stringify(schema), { expirationTtl: 6 * 3600 });
  return schema;
}

// ---------- Filas diarias ----------

export async function fetchDay(app: App, s: HabitosSchema, date: string): Promise<Entry[]> {
  const pages = await app.notion.queryAll(s.dataSourceId, { filter: { property: s.fecha, date: { equals: date } } }, 2);
  return pages.map((p) => parseEntry(p, s));
}

/**
 * Filas entre dos fechas, de la más reciente a la más antigua: si el tope de páginas
 * corta el resultado, se pierden los días viejos (ya procesados), nunca los recientes.
 */
export async function fetchRange(app: App, s: HabitosSchema, from: string | null, to: string, maxPages = 5): Promise<Entry[]> {
  const filtros: unknown[] = [{ property: s.fecha, date: { on_or_before: to } }];
  if (from) filtros.push({ property: s.fecha, date: { on_or_after: from } });
  const pages = await app.notion.queryAll(
    s.dataSourceId,
    { filter: { and: filtros }, sorts: [{ property: s.fecha, direction: 'descending' }] },
    maxPages,
  );
  return pages.map((p) => parseEntry(p, s)).filter((e) => e.fecha);
}

// ---------- Estadísticas (rachas) ----------

const STATS_KEY = 'stats:snapshot';

export async function saveStatsSnapshot(app: App, stats: Stats[]): Promise<void> {
  await app.kv.put(STATS_KEY, JSON.stringify(stats), { expirationTtl: 3 * 86400 });
}

/**
 * Rachas por hábito: el snapshot que deja el cierre de las 03:00 en KV y, para lo que
 * falte, la racha sellada en las filas recibidas (la fila de hoy la trae desde las 03:00).
 */
export async function loadStats(app: App, entries: Entry[]): Promise<Record<string, Stats>> {
  const out = statsFromEntries(entries);
  const snap = (await app.kv.get<Stats[]>(STATS_KEY, 'json')) ?? [];
  for (const s of snap) out[s.habitId] = s;
  return out;
}

// ---------- Matrices ----------

/**
 * Matrices de los hábitos de `entries`: las de caché y hasta `refreshMax` leídas de Notion.
 * Se leen en el orden de `entries`, así que el llamador pone primero las que va a mostrar.
 */
export async function matricesFor(app: App, entries: Entry[], refreshMax = 0): Promise<Record<string, Matrix>> {
  const ids = entries.map((e) => e.habitId).filter((x): x is string => !!x);
  const cached = await getCachedMatrices(app.kv, ids);
  if (!refreshMax) return cached;
  const vistos = new Set<string>();
  const samples = entries
    .filter((e) => e.habitId && !vistos.has(e.habitId) && vistos.add(e.habitId))
    .map((e) => ({ habitId: e.habitId!, pageId: e.pageId }));
  return refreshMatrices(app.kv, app.notion, samples, cached, refreshMax);
}

/** Cuántas Matrices leer de una vez en un comando (~6 llamadas a Notion cada una; límite 50). */
export const MATRICES_POR_COMANDO = 4;

export async function coachData(app: App, entries: Entry[], date = app.now.date): Promise<CoachData> {
  const [stats, matrices] = await Promise.all([loadStats(app, entries), matricesFor(app, entries)]);
  return { fecha: date, hora: hhmm(app), entries, stats, matrices };
}

// ---------- Contexto de mensajes con botones ----------

/** Contexto de una tarjeta de hábito: la cabecera se conserva al editarla tras un botón. */
export interface MsgContext {
  kind: 'habito';
  header?: string;
  pageId: string;
}

const msgKey = (id: number) => `msg:${id}`;

export async function saveMsgContext(app: App, messageId: number, ctx: MsgContext): Promise<void> {
  await app.kv.put(msgKey(messageId), JSON.stringify(ctx), { expirationTtl: 3 * 86400 });
}

/** Devuelve null también para contextos de versiones anteriores (mensajes con lista). */
export async function getMsgContext(app: App, messageId: number): Promise<MsgContext | null> {
  const ctx = await app.kv.get<MsgContext | { kind: string }>(msgKey(messageId), 'json');
  return ctx?.kind === 'habito' ? (ctx as MsgContext) : null;
}

// ---------- Tarjetas vivas en el chat ----------
// Regla (pedida por el usuario): cada hábito tiene una sola tarjeta viva. Al enviar un
// bloque se borran las tarjetas ya registradas, las que se reemplazan y las de días
// anteriores; las pendientes que el bloque no repite se quedan para registrar tarde.

export interface CardRef {
  mid: number;
  pageId: string;
  date: string;
}

const CARDS_KEY = 'cards:activas';
/** Telegram es una subrequest por mensaje borrado: tope por ejecución (lo demás, la próxima vez). */
const MAX_BORRADOS = 15;

/** Qué tarjetas borrar antes de enviar un bloque. Pura, para probarla. */
export function tarjetasABorrar(cards: CardRef[], hoy: Entry[], fecha: string, reemplazar: Set<string>): CardRef[] {
  const filas = new Map(hoy.map((e) => [e.pageId, e]));
  return cards.filter((c) => {
    if (c.date !== fecha) return true;
    const e = filas.get(c.pageId);
    return !e || !isPending(e) || reemplazar.has(c.pageId);
  });
}

/**
 * Envía una tarjeta por cada hábito pendiente de `aEnviar` y ordena el chat. `hoy` son
 * todas las filas del día (para saber qué tarjetas viejas ya se registraron). Solo la
 * primera tarjeta lleva `header` y suena; las demás llegan en silencio.
 */
export async function enviarTarjetas(
  app: App,
  hoy: Entry[],
  aEnviar: Entry[],
  header?: string,
  leerMatrices = 0,
  /** true: ni la primera tarjeta suena (recordatorio inteligente sin racha en riesgo). */
  silencioso = false,
): Promise<number> {
  const pendientes = sortEntries(aEnviar.filter(isPending));
  if (!pendientes.length) return 0;

  const cards = (await app.kv.get<CardRef[]>(CARDS_KEY, 'json')) ?? [];
  const borrar = tarjetasABorrar(cards, hoy, app.now.date, new Set(pendientes.map((e) => e.pageId))).slice(0, MAX_BORRADOS);
  for (const c of borrar) await app.tg.deleteMessage(app.chatId, c.mid);
  const borradas = new Set(borrar.map((c) => c.mid));
  const vivas = cards.filter((c) => !borradas.has(c.mid));

  // Primero las tarjetas que se van a enviar: así su 💡 Señal sale aunque falten otras.
  const senales = senalesDe(await matricesFor(app, [...pendientes, ...hoy], leerMatrices));
  for (const [i, e] of pendientes.entries()) {
    const h = i === 0 ? header : undefined;
    const r = renderCard(e, e.habitId ? senales[e.habitId] : undefined, h);
    const msg = await app.tg.send(app.chatId, r.text, r.keyboard, { silent: silencioso || i > 0 });
    await saveMsgContext(app, msg.message_id, { kind: 'habito', pageId: e.pageId, ...(h ? { header: h } : {}) });
    vivas.push({ mid: msg.message_id, pageId: e.pageId, date: app.now.date });
  }
  await app.kv.put(CARDS_KEY, JSON.stringify(vivas), { expirationTtl: 3 * 86400 });
  return pendientes.length;
}

// ---------- Seguridad ----------

/** Comparación en tiempo constante (se comparan los hashes para igualar longitudes). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
