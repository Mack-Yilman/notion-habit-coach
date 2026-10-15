// Webhook de Telegram: botones de estado, comandos y chat con el coach.

import {
  coachData,
  extrasCard,
  fetchDay,
  enviarTarjetas,
  MATRICES_POR_COMANDO,
  filasConHistoria,
  getFallosAyer,
  getMsgContext,
  getSchema,
  guardarUltimo,
  loadStats,
  matricesFor,
  pendientesDeAyer,
  refrescarTarjetas,
  type App,
} from './app';
import { decodeCallback } from './callback';
import { buildHistorial, coachChat, coachCierre, coachSemana, TAREA_RESUMEN, TIMEOUT_COMANDO_MS, type ChatTurn } from './coach';
import { ESTADO_BY_KEY } from './config';
import { estadoProperty, isPending, parseEntry, type Entry } from './habits';
import { clearMatrices } from './matrix';
import { AYUDA, LEYENDA, renderCard, renderMapa, renderRachas, renderResumenHoy } from './messages';
import { olvidarMatricesOk, recalcular } from './scheduler';
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
        if (r.incompleto) {
          await app.tg.send(
            app.chatId,
            `⏳ Recalculé ${r.habitos} de ${r.total} hábitos (tope de llamadas del plan gratuito). Envía /recalcular otra vez para terminar.`,
          );
          return;
        }
        const desde = r.desde ? ` Usé el historial desde el ${r.desde}; lo anterior se toma como estaba.` : '';
        await app.tg.send(app.chatId, `✅ Rachas recalculadas para ${r.habitos} hábitos, hasta el ${r.hasta}.${desde}`);
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
    // Un día ya cerrado (a las 03:00) no se cambia desde Telegram: su racha ya quedó escrita.
    const actual = parseEntry(await app.notion.getPage(cb.pageId), schema);
    if (actual.streak?.cerrada) {
      await app.tg.answerCallback(q.id, `📅 El ${actual.fecha ?? 'día'} ya se cerró a las 03:00: la racha no cambia.`);
      if (messageId) await app.tg.clearKeyboard(app.chatId, messageId);
      return;
    }
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
  let r = renderCard(marcado, undefined, ctx.header);
  if (isPending(marcado)) {
    const [matrices, fallosAyer] = await Promise.all([matricesFor(app, [marcado]), getFallosAyer(app)]);
    const x = extrasCard(marcado, app, matrices, fallosAyer);
    r = renderCard(marcado, x.senal, ctx.header, x.extras);
  }
  await app.tg.edit(app.chatId, messageId, r.text, r.keyboard);
}

async function enviarHoy(app: App, soloPendientes: boolean): Promise<void> {
  const schema = await getSchema(app);
  const [hoy, ayer] = await Promise.all([fetchDay(app, schema, app.now.date), pendientesDeAyer(app, schema)]);
  if (!hoy.length && !ayer.length) {
    await app.tg.send(app.chatId, 'No hay hábitos para hoy en Notion. ¿Están activas las plantillas recurrentes?');
    return;
  }
  const fecha = formatCorto(app.now.date);
  const leyenda = `<i>${LEYENDA}</i>`;
  const pendientes = hoy.filter(isPending);
  const todas = [...ayer, ...hoy];
  if (!soloPendientes && hoy.length) await app.tg.send(app.chatId, renderResumenHoy(`<b>📋 Hoy</b> · ${fecha}`, hoy));
  if (ayer.length) {
    // De madrugada el día anterior sigue abierto. Sus Matrices ya están en caché (mismos hábitos).
    await enviarTarjetas(app, todas, ayer, `<b>🌒 Pendientes de ayer</b> · se cierran a las 03:00\n${leyenda}`);
  }
  if (pendientes.length) {
    // Con dos tandas (ayer y hoy) la segunda no lee Matrices (límite de 50 subrequests; suelen
    // estar en caché) ni suena: ya sonó la de ayer.
    const dosTandas = ayer.length > 0;
    const header = soloPendientes ? `<b>⏳ Pendientes</b> · ${fecha}\n${leyenda}` : leyenda;
    await enviarTarjetas(app, todas, pendientes, header, dosTandas ? 0 : MATRICES_POR_COMANDO, dosTandas);
  } else if (soloPendientes && !ayer.length) {
    await app.tg.send(app.chatId, '🎉 No te queda nada pendiente hoy.');
  }
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
  // Una sola consulta trae hoy y la historia (14 días para la revisión, 7 para el resumen).
  const dias = semanal ? 13 : 7;
  const { hoy, historia, todas } = await filasConHistoria(app, schema, dias, semanal ? 3 : 2);
  const ayer = await pendientesDeAyer(app, schema, historia);
  const data = await coachData(app, hoy, { ayer, historia });
  let texto: string;
  if (semanal) {
    const desde = addDays(app.now.date, -dias);
    texto = await coachSemana(app.llm, data, buildHistorial(todas, desde, app.now.date), TIMEOUT_COMANDO_MS);
    await guardarUltimo(app, texto);
    const mapa = renderMapa(todas, desde, app.now.date);
    if (mapa) texto += `\n\n${mapa}`;
  } else {
    texto = await coachCierre(app.llm, data, TIMEOUT_COMANDO_MS, TAREA_RESUMEN);
    await guardarUltimo(app, texto);
  }
  await app.tg.send(app.chatId, `<b>${semanal ? '📊 Revisión' : '🧭 Resumen'}</b> · ${formatCorto(app.now.date)}\n\n${texto}`);
}

async function actualizar(app: App): Promise<void> {
  const schema = await getSchema(app, true);
  const hoy = await fetchDay(app, schema, app.now.date);
  await clearMatrices(app.kv, hoy.map((e) => e.habitId).filter((x): x is string => !!x));
  await olvidarMatricesOk(app);
  // Primero las de los pendientes (son las que se ven en las tarjetas). Hasta ~10 llamadas
  // por Matriz: más de 4 arriesga el límite de 50 subrequests.
  const m = await matricesFor(app, [...hoy.filter(isPending), ...hoy], MATRICES_POR_COMANDO);
  const total = new Set(hoy.map((e) => e.habitId).filter(Boolean)).size;
  await app.tg.send(
    app.chatId,
    `🔄 Esquema actualizado. Leí ${Object.keys(m).length} de ${total} Matrices Atómicas.` +
      (Object.keys(m).length < total ? ' Las demás se leen solas en los próximos minutos.' : ''),
  );
}

// ---------- Chat con el coach ----------

const HIST_KEY = 'chat:hist';
/** Tiempo para todas las rondas del chat: `waitUntil` corta a los 30 s. */
const PRESUPUESTO_CHAT_MS = 24_000;
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
  // Una sola consulta: hoy, los pendientes de ayer y la semana para el contexto.
  const { hoy, historia } = await filasConHistoria(app, schema);
  const ayer = await pendientesDeAyer(app, schema, historia);
  const data = await coachData(app, hoy, { ayer, historia });
  const history = (await app.kv.get<ChatTurn[]>(HIST_KEY, 'json')) ?? [];

  const r = await coachChat(
    app.llm,
    data,
    history,
    text.slice(0, 1500),
    async (entry, estado) => parseEntry(await app.notion.updatePage(entry.pageId, estadoProperty(schema, estado)), schema),
    PRESUPUESTO_CHAT_MS,
  );
  const extra = r.marcados.length ? `\n\n<i>Registrado en Notion: ${r.marcados.map(esc).join(', ')}</i>` : '';
  await app.tg.send(app.chatId, (r.text || '…') + extra);
  // Las tarjetas de lo que se marcó por chat pasan a mostrar el nivel y ↩️.
  await refrescarTarjetas(app, r.actualizadas);

  const nuevo = [...history, { role: 'user' as const, content: text.slice(0, 1500) }, { role: 'assistant' as const, content: r.text }].slice(-12);
  await Promise.all([
    app.kv.put(HIST_KEY, JSON.stringify(nuevo), { expirationTtl: 86400 }),
    app.kv.put(countKey(app.now.date), String(usados + 1), { expirationTtl: 2 * 86400 }),
  ]);
}
