#!/usr/bin/env node
// Asistente de configuración de Habit Coach. Lee los secretos de .dev.vars.
//
//   node scripts/setup.mjs notion [--aplicar]   revisa Notion y agrega las propiedades de racha
//   node scripts/setup.mjs chat-id              muestra tu chat ID (escríbele /start al bot)
//   node scripts/setup.mjs webhook --url URL    registra el webhook y los comandos del bot
//   node scripts/setup.mjs estado               resumen de todo

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTION_VERSION = '2025-09-03';
// Columnas de racha en cada fila diaria (igual que STREAK_SCHEMA_ADDITIONS en src/habits.ts).
const STREAK_PROPS = {
  Racha: { number: { format: 'number' } },
  'Mejor racha': { number: { format: 'number' } },
  Congeladores: { number: { format: 'number' } },
  'Racha cerrada': { checkbox: {} },
};
const COMANDOS = [
  ['hoy', 'Todos los hábitos de hoy con botones'],
  ['pendientes', 'Solo lo que falta hoy'],
  ['rachas', 'Rachas y congeladores'],
  ['resumen', 'El coach analiza tu día'],
  ['semana', 'Revisión de los últimos 14 días'],
  ['recalcular', 'Rehace las rachas desde el historial'],
  ['actualizar', 'Vuelve a leer tus Matrices Atómicas'],
  ['ayuda', 'Cómo funciona el bot'],
];

const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const info = (m) => console.log(`   ${m}`);
const fail = (m) => {
  console.error(`❌ ${m}`);
  process.exit(1);
};

function loadVars() {
  const file = join(ROOT, '.dev.vars');
  if (!existsSync(file)) fail('No existe .dev.vars. Copia .dev.vars.example a .dev.vars y llénalo.');
  const vars = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return vars;
}

// Si existe wrangler.local.jsonc (configuración personal, ignorada por git), se usa ese.
const wranglerPath = existsSync(join(ROOT, 'wrangler.local.jsonc')) ? join(ROOT, 'wrangler.local.jsonc') : join(ROOT, 'wrangler.jsonc');
const readWrangler = () => readFileSync(wranglerPath, 'utf8');
function wranglerVar(name) {
  return readWrangler().match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`))?.[1];
}
function setWranglerVar(name, value) {
  writeFileSync(wranglerPath, readWrangler().replace(new RegExp(`("${name}"\\s*:\\s*")[^"]*(")`), `$1${value}$2`));
}

async function notion(token, method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.code}: ${data.message}`);
  return data;
}

async function telegram(token, method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const norm = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9: ]+/g, ' ').replace(/\s+/g, ' ').trim();
const findProp = (props, wanted) => Object.keys(props).find((k) => norm(k) === norm(wanted));
const pareceHabitos = (ds) => ['estado', 'fecha', 'rango horario'].every((p) => findProp(ds.properties ?? {}, p));

// ---------- notion ----------

async function cmdNotion(vars, aplicar) {
  const token = vars.NOTION_TOKEN;
  if (!token) fail('Falta NOTION_TOKEN en .dev.vars.');
  const me = await notion(token, 'GET', '/users/me').catch((e) => fail(`El token de Notion no funciona: ${e.message}`));
  ok(`Conectado a Notion como «${me.name ?? me.bot?.workspace_name ?? 'integración'}».`);

  let dsId = wranglerVar('HABITOS_DATA_SOURCE_ID');
  if (!dsId || dsId === 'REEMPLAZA') {
    const res = await notion(token, 'POST', '/search', { query: 'Hábitos', filter: { property: 'object', value: 'data_source' } });
    const candidatos = res.results.filter(pareceHabitos);
    if (!candidatos.length) {
      fail('No encontré la base «Hábitos». Comparte la página «Habit Tracker Pro» con tu integración (••• → Conexiones).');
    }
    if (candidatos.length > 1) {
      warn('Encontré varias fuentes de datos que parecen la de hábitos:');
      for (const c of candidatos) info(`${c.id}  ${c.title?.map((t) => t.plain_text).join('') ?? ''}`);
      fail('Pon el ID correcto en HABITOS_DATA_SOURCE_ID de wrangler.jsonc y repite.');
    }
    dsId = candidatos[0].id;
    setWranglerVar('HABITOS_DATA_SOURCE_ID', dsId);
    ok(`Detecté la fuente «Hábitos» (${dsId}) y la guardé en wrangler.jsonc.`);
  }

  const ds = await notion(token, 'GET', `/data_sources/${dsId}`).catch((e) =>
    fail(`No pude leer la fuente de hábitos ${dsId}: ${e.message}`),
  );
  if (!pareceHabitos(ds)) fail('Esa fuente de datos no tiene Estado, Fecha y Rango horario.');
  ok('La fuente «Hábitos» tiene Estado, Fecha y Rango horario.');

  const fecha = findProp(ds.properties, 'fecha');
  const q = await notion(token, 'POST', `/data_sources/${dsId}/query`, { page_size: 100, sorts: [{ property: fecha, direction: 'descending' }] });
  ok(`Puedo consultar los hábitos (${q.results.length}${q.has_more ? '+' : ''} filas recientes).`);

  if (!findProp(ds.properties, 'estadistica')) {
    warn('No encontré la relación «Estadística»: sin ella el bot no puede agrupar las filas de cada hábito.');
  }

  // Las rachas se guardan en las filas diarias de «Hábitos». («Estadísticas» no sirve: es una
  // segunda fuente de datos de la base y la API de Notion no deja consultarla ni modificarla.)
  const faltan = Object.keys(STREAK_PROPS).filter((p) => !findProp(ds.properties, p));
  if (!faltan.length) {
    ok('«Hábitos» ya tiene las columnas de racha.');
    return;
  }
  if (!aplicar) {
    warn(`A «Hábitos» le faltan las columnas de racha: ${faltan.join(', ')}.`);
    info('Ejecuta de nuevo con --aplicar para agregarlas (solo agrega columnas; no borra nada).');
    return;
  }
  const properties = Object.fromEntries(faltan.map((p) => [p, STREAK_PROPS[p]]));
  await notion(token, 'PATCH', `/data_sources/${dsId}`, { properties }).catch((e) =>
    fail(`No pude agregar las columnas: ${e.message}`),
  );
  ok(`Agregué a «Hábitos»: ${faltan.join(', ')}.`);
}

// ---------- chat-id ----------

async function cmdChatId(vars) {
  const token = vars.TELEGRAM_BOT_TOKEN;
  if (!token) fail('Falta TELEGRAM_BOT_TOKEN en .dev.vars.');
  const bot = await telegram(token, 'getMe').catch((e) => fail(`El token del bot no funciona: ${e.message}`));
  ok(`Bot: @${bot.username}`);
  const wh = await telegram(token, 'getWebhookInfo');
  if (wh.url) {
    info('El webhook ya está activo: escríbele /start al bot y él mismo te responderá con tu chat ID.');
    return;
  }
  console.log(`\n👉 Abre https://t.me/${bot.username} y envíale /start. Espero hasta 2 minutos…\n`);
  let offset = 0;
  const fin = Date.now() + 120_000;
  while (Date.now() < fin) {
    const updates = await telegram(token, 'getUpdates', { offset, timeout: 20, allowed_updates: ['message'] });
    for (const u of updates) {
      offset = u.update_id + 1;
      const chat = u.message?.chat;
      if (chat) {
        ok(`Tu chat ID es: ${chat.id}  (${chat.first_name ?? chat.title ?? ''})`);
        info('Cópialo en .dev.vars como TELEGRAM_CHAT_ID.');
        await telegram(token, 'getUpdates', { offset }); // marca los mensajes como leídos
        return;
      }
    }
  }
  fail('No llegó ningún mensaje. ¿Le escribiste /start al bot correcto?');
}

// ---------- webhook ----------

async function cmdWebhook(vars, url) {
  const token = vars.TELEGRAM_BOT_TOKEN;
  const secret = vars.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) fail('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_WEBHOOK_SECRET en .dev.vars.');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) fail('TELEGRAM_WEBHOOK_SECRET debe tener 16+ caracteres: solo letras, números, _ y -.');
  if (!url || !/^https:\/\//.test(url)) fail('Indica la URL de tu Worker: --url https://notion-habit-coach.<subdominio>.workers.dev');
  const hook = `${url.replace(/\/+$/, '')}/telegram`;
  const ping = await fetch(url).then((r) => r.text()).catch(() => '');
  if (!ping.includes('Habit Coach')) warn(`${url} no respondió como Habit Coach. ¿Ya hiciste npx wrangler deploy?`);
  await telegram(token, 'setWebhook', {
    url: hook,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  ok(`Webhook registrado en ${hook}`);
  await telegram(token, 'setMyCommands', { commands: COMANDOS.map(([command, description]) => ({ command, description })) });
  ok('Comandos del bot registrados (aparecen en el menú «/»).');
  info('Prueba ahora: envíale /hoy al bot.');
}

// ---------- estado ----------

async function cmdEstado(vars) {
  for (const k of ['NOTION_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_CHAT_ID', 'LLM_API_KEY', 'ADMIN_SECRET']) {
    (vars[k] ? ok : warn)(`${k} ${vars[k] ? 'definido' : 'vacío'}`);
  }
  const kv = readWrangler().match(/"binding":\s*"STATE",\s*"id":\s*"([^"]*)"/)?.[1];
  (kv && !kv.startsWith('REEMPLAZA') ? ok : warn)(`KV STATE: ${kv ?? 'sin configurar'}`);
  (wranglerVar('HABITOS_DATA_SOURCE_ID') !== 'REEMPLAZA' ? ok : warn)(`HABITOS_DATA_SOURCE_ID: ${wranglerVar('HABITOS_DATA_SOURCE_ID')}`);
  if (vars.TELEGRAM_BOT_TOKEN) {
    const wh = await telegram(vars.TELEGRAM_BOT_TOKEN, 'getWebhookInfo').catch(() => null);
    if (wh) {
      (wh.url ? ok : warn)(`Webhook: ${wh.url || 'no registrado'}`);
      if (wh.last_error_message) warn(`Último error del webhook: ${wh.last_error_message}`);
      if (wh.pending_update_count) info(`Mensajes en cola: ${wh.pending_update_count}`);
    }
  }
}

// ---------- main ----------

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const vars = loadVars();
const run = {
  notion: () => cmdNotion(vars, flag('--aplicar')),
  'chat-id': () => cmdChatId(vars),
  webhook: () => cmdWebhook(vars, opt('--url')),
  estado: () => cmdEstado(vars),
}[cmd];

if (!run) {
  console.log(`Uso:
  node scripts/setup.mjs notion [--aplicar]   revisa Notion y agrega las propiedades de racha
  node scripts/setup.mjs chat-id              muestra tu chat ID (escríbele /start al bot)
  node scripts/setup.mjs webhook --url URL    registra el webhook y los comandos
  node scripts/setup.mjs estado               resumen de la configuración`);
  process.exit(cmd ? 1 : 0);
}
await run();
