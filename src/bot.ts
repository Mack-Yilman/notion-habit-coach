// Webhook de Telegram: botones de estado, comandos y chat con el coach.

import {
  coachData,
  fetchDay,
  enviarTarjetas,
  fetchRange,
  getMsgContext,
  getSchema,
  loadStats,
  matricesFor,
  type App,
} from './app';
import { decodeCallback } from './callback';
import { buildHistorial, coachChat, coachCierre, coachSemana, type ChatTurn } from './coach';
import { ESTADO_BY_KEY } from './config';
import { estadoProperty, isPending, parseEntry, type Entry } from './habits';
import { clearMatrices, senalesDe } from './matrix';
import { AYUDA, LEYENDA, renderCard, renderRachas, renderResumenHoy } from './messages';
import { recalcular } from './scheduler';
import { addDays, formatCorto } from './time';
import { esc } from './telegram';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Update = any;

export async function handleUpdate(app: App, update: Update): Promise<void> {
  if (update.callback_query) return onCallback(app, update.callback_query);
  const msg = update.message;
  if (!msg?.text || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const text: string = msg.text.trim();

  if (chatId !== app.chatId) {
    // Solo /start responde a desconocidos, para que el dueño pueda ver su chat id.
    if (text.startsWith('/start')) {
      await app.tg.send(chatId, `Hola. Tu chat ID es <code>${esc(chatId)}</code>.\nConfigúralo como <code>TELEGRAM_CHAT_ID</code> para usar este bot.`);
    }
    return;
  }

  const cmd = text.match(/^\/([a-z_]+)(?:@\w+)?/i)?.[1]?.toLowerCase();
  try {
    switch (cmd) {
      case 'start':
      case 'ayuda':
      case 'help':
        await app.tg.send(app.chatId, AYUDA);
        return;
      case 'hoy':
        return enviarHoy(app, false);
      case 'pendientes':
        return enviarHoy(app, true);
      case 'rachas':
        return enviarRachas(app);
      case 'resumen':
        return enviarResumen(app, false);
      case 'semana':
        return enviarResumen(app, true);
      case 'recalcular': {
        const r = await recalcular(app);
        await app.tg.send(app.chatId, `✅ Rachas recalculadas para ${r.habitos} hábitos, hasta el ${r.hasta}.`);
        return enviarRachas(app);
      }
      case 'actualizar':
        return actualizar(app);
      case undefined:
        return chat(app, text);
      default:
        await app.tg.send(app.chatId, 'No conozco ese comando. /ayuda muestra la lista.');
    }
  } catch (e) {
    console.error(JSON.stringify({ evento: 'comando_error', cmd, error: String(e) }));
    await app.tg.send(app.chatId, `⚠️ Algo falló: <code>${esc(String(e).slice(0, 300))}</code>`);
  }
}

async function onCallback(app: App, q: Update): Promise<void> {
  if (String(q.message?.chat?.id ?? q.from?.id) !== app.chatId) {
    await app.tg.answerCallback(q.id);
    return;
  }
  const messageId: number | undefined = q.message?.message_id;
  const cb = decodeCallback(q.data);
  if (!cb) {
    // Botones de una versión anterior del bot: se quitan para que no confundan.
    await app.tg.answerCallback(q.id, 'Este mensaje es de una versión anterior. Usa /pendientes.');
    if (messageId) await app.tg.clearKeyboard(app.chatId, messageId);
    return;
  }
  const schema = await getSchema(app);
  let marcado: Entry;
  try {
    marcado = parseEntry(await app.notion.updatePage(cb.pageId, estadoProperty(schema, cb.estado)), schema);
  } catch (e) {
    console.error('callback', e);
    await app.tg.answerCallback(q.id, '⚠️ No pude guardar en Notion');
    return;
  }
  const def = ESTADO_BY_KEY[cb.estado];
  await app.tg.answerCallback(q.id, cb.estado === 'sin_iniciar' ? `↩️ ${marcado.nombre}: sin registrar` : `${def.icon} ${def.label}`);
  if (!messageId) return;

  const ctx = await getMsgContext(app, messageId);
  if (!ctx || ctx.pageId.replace(/-/g, '') !== cb.pageId) {
    // Mensaje con lista de una versión anterior: solo se quitan sus botones.
    await app.tg.clearKeyboard(app.chatId, messageId);
    return;
  }
  // La respuesta del PATCH ya trae la página actualizada: no hace falta consultar de nuevo.
  const senal = isPending(marcado) && marcado.habitId ? senalesDe(await matricesFor(app, [marcado]))[marcado.habitId] : undefined;
  const r = renderCard(marcado, senal, ctx.header);
  await app.tg.edit(app.chatId, messageId, r.text, r.keyboard);
}

async function enviarHoy(app: App, soloPendientes: boolean): Promise<void> {
  const schema = await getSchema(app);
  const hoy = await fetchDay(app, schema, app.now.date);
  if (!hoy.length) {
    await app.tg.send(app.chatId, 'No hay hábitos para hoy en Notion. ¿Están activas las plantillas recurrentes?');
    return;
  }
  const pendientes = hoy.filter(isPending);
  if (!pendientes.length) {
    await app.tg.send(app.chatId, soloPendientes ? '🎉 No te queda nada pendiente hoy.' : renderResumenHoy(`<b>📋 Hoy</b> · ${formatCorto(app.now.date)}`, hoy));
    return;
  }
  const leyenda = `<i>${LEYENDA}</i>`;
  if (soloPendientes) {
    await enviarTarjetas(app, hoy, pendientes, `<b>⏳ Pendientes</b> · ${formatCorto(app.now.date)}\n${leyenda}`);
    return;
  }
  await app.tg.send(app.chatId, renderResumenHoy(`<b>📋 Hoy</b> · ${formatCorto(app.now.date)}`, hoy));
  await enviarTarjetas(app, hoy, pendientes, leyenda);
}

async function enviarRachas(app: App): Promise<void> {
  const schema = await getSchema(app);
  const hoy = await fetchDay(app, schema, app.now.date);
  const stats = await loadStats(app, hoy);
  await app.tg.send(app.chatId, renderRachas(Object.values(stats)));
}

async function enviarResumen(app: App, semanal: boolean): Promise<void> {
  await app.tg.typing(app.chatId);
  const schema = await getSchema(app);
  const hoy = await fetchDay(app, schema, app.now.date);
  const data = await coachData(app, hoy);
  let texto: string;
  if (semanal) {
    const desde = addDays(app.now.date, -13);
    texto = await coachSemana(app.llm, data, buildHistorial(await fetchRange(app, schema, desde, app.now.date, 3), desde, app.now.date));
  } else {
    texto = await coachCierre(app.llm, data);
  }
  await app.tg.send(app.chatId, `<b>${semanal ? '📊 Revisión' : '🧭 Resumen'}</b> · ${formatCorto(app.now.date)}\n\n${texto}`);
}

async function actualizar(app: App): Promise<void> {
  const schema = await getSchema(app, true);
  const hoy = await fetchDay(app, schema, app.now.date);
  await clearMatrices(app.kv, hoy.map((e) => e.habitId).filter((x): x is string => !!x));
  const m = await matricesFor(app, hoy, 5);
  const total = new Set(hoy.map((e) => e.habitId).filter(Boolean)).size;
  await app.tg.send(
    app.chatId,
    `🔄 Esquema actualizado. Leí ${Object.keys(m).length} de ${total} Matrices Atómicas.` +
      (Object.keys(m).length < total ? ' Las demás se leen en los próximos avisos (o repite /actualizar).' : ''),
  );
}

// ---------- Chat con el coach ----------

const HIST_KEY = 'chat:hist';
const countKey = (date: string) => `chat:count:${date}`;

async function chat(app: App, text: string): Promise<void> {
  const limite = Number(app.env.CHAT_DAILY_LIMIT || '30');
  const usados = Number((await app.kv.get(countKey(app.now.date))) ?? '0');
  if (usados >= limite) {
    await app.tg.send(app.chatId, `Llegaste al límite de ${limite} mensajes con el coach por hoy. Los botones y comandos siguen funcionando.`);
    return;
  }
  await app.tg.typing(app.chatId);
  const schema = await getSchema(app);
  const hoy = await fetchDay(app, schema, app.now.date);
  const data = await coachData(app, hoy);
  const history = (await app.kv.get<ChatTurn[]>(HIST_KEY, 'json')) ?? [];

  const r = await coachChat(app.llm, data, history, text.slice(0, 1500), async (entry, estado) => {
    await app.notion.updatePage(entry.pageId, estadoProperty(schema, estado));
  });
  const extra = r.marcados.length ? `\n\n<i>Registrado en Notion: ${r.marcados.map(esc).join(', ')}</i>` : '';
  await app.tg.send(app.chatId, (r.text || '…') + extra);

  const nuevo = [...history, { role: 'user' as const, content: text.slice(0, 1500) }, { role: 'assistant' as const, content: r.text }].slice(-12);
  await Promise.all([
    app.kv.put(HIST_KEY, JSON.stringify(nuevo), { expirationTtl: 86400 }),
    app.kv.put(countKey(app.now.date), String(usados + 1), { expirationTtl: 2 * 86400 }),
  ]);
}
