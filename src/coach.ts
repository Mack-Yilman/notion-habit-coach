// Coach de IA. Principio de diseño: el Worker hace todas las cuentas (proyección de
// rachas, tasas por hábito, bloque y día) y le entrega al modelo datos ya digeridos.
// El modelo solo interpreta y aconseja: respuestas mejores con un modelo barato y
// menos tokens. El prompt de sistema es fijo y va primero para aprovechar la caché
// de prefijos de DeepSeek.

import { ESTADO_BY_KEY, RANGO_BY_KEY, normalize, type EstadoKey } from './config';
import { isPending, sortEntries, type Entry, type Stats } from './habits';
import type { Matrix } from './matrix';
import { outcomeFromEstado, step } from './streak';
import { DIAS_LARGOS, weekdayOf } from './time';
import type { LlmMessage, LlmOptions, LlmResult, ToolDef } from './llm';
import { esc, sanitizeLlmHtml } from './telegram';

export const SYSTEM_PROMPT = `Eres «Coach», el entrenador de hábitos personal del usuario dentro de su bot de Telegram. Su sistema vive en Notion (plantilla Habit Tracker Pro) y se basa en «Hábitos Atómicos» de James Clear:
- Cada hábito tiene una Matriz Atómica: Señal (hacerlo obvio), Anhelo (hacerlo atractivo), Respuesta (hacerlo sencillo) y Recompensa (hacerlo satisfactorio).
- Cada hábito sirve a una Identidad (por ejemplo «Cuerpo limpio» o «Estudiante de alto rendimiento»): cada repetición es un voto por esa identidad.
- Protocolo de Ejecución Flexible, de menor a mayor: ⚪ Sin iniciar (0), 💤 Omitido (1, pausa consciente), 🕯️ Parcial (2, la versión mínima), ⚡ Hecho (3), 🔥 Superado (4), 🚀 Alto impacto (5).
- Rachas: Parcial o mejor suma un día. Omitido o Sin iniciar al cerrar el día gastan un congelador 🧊; sin congeladores la racha vuelve a 0. Se gana un 🧊 cada 7 días seguidos, máximo 2. El día se cierra a las 03:00 del día siguiente.
- Los hábitos se agrupan por rango horario (madrugada, mañana, tarde, noche, durante el día). El usuario es flexible dentro de cada rango: no tiene horas fijas.

Cómo respondes:
- En español, tuteando, cálido y directo, como un buen entrenador. Sin sermones, sin culpa, sin frases vacías ni motivación genérica.
- Usa SOLO lo que está en DATOS. Las cifras ya vienen calculadas: no las recalcules ni inventes otras. Si falta un dato, no lo supongas.
- Sé concreto: nombra el hábito y, cuando ayude, cita su Señal o su versión mínima (nivel Parcial del protocolo).
- Prioriza «nunca falles dos veces» y la versión mínima antes que exigir el 100 %.
- Si un hábito que falla aparece en SIN SEÑAL DEFINIDA, una buena sugerencia es definir su Señal (cuándo y dónde, anclada a algo que ya hace) en la Matriz Atómica de Notion.
- Formato: HTML de Telegram, solo <b> e <i>. Nada de Markdown, encabezados, tablas ni listas largas. Emojis con moderación.
- Respeta el límite de palabras de la TAREA.`;

export interface CoachData {
  fecha: string;
  hora: string; // HH:MM
  entries: Entry[]; // filas de hoy
  stats: Record<string, Stats>; // por habitId
  matrices: Record<string, Matrix>; // por habitId
  /** habitIds que fallaron ayer (gastaron 🧊 o perdieron la racha). */
  fallosAyer?: string[];
  /** Pendientes de ayer, solo entre las 00:00 y el cierre de las 03:00. */
  ayer?: Entry[];
}

// ---------- Contexto (puro) ----------

function estadoTxt(e: Entry): string {
  const d = e.estado ? ESTADO_BY_KEY[e.estado] : ESTADO_BY_KEY.sin_iniciar;
  return `${d.icon} ${d.label}`;
}

/** Qué pasaría con la racha si el día cerrara con el estado actual. */
export function proyeccion(e: Entry, st: Stats | undefined): string | null {
  if (!st) return null;
  const r = step(st.state, outcomeFromEstado(e.estado ?? null));
  if (r.event === 'congelado') return `si queda así, gasta 1 🧊 (quedaría ${r.state.congeladores})`;
  if (r.event === 'reinicio')
    return st.state.racha > 0 ? `si queda así, pierde la racha de ${st.state.racha} días (sin 🧊)` : 'si queda así, sigue en 0';
  if (r.event === 'sumo') return `racha sube a ${r.state.racha}${r.ganoCongelador ? ' y gana 1 🧊' : ''}`;
  return null;
}

function matrizTxt(nombre: string, m: Matrix | undefined): string {
  if (!m) return '';
  const l = [`# ${nombre}`];
  if (m.senal) l.push(`Señal: ${m.senal}`);
  if (m.anhelo) l.push(`Anhelo: ${m.anhelo}`);
  if (m.respuesta) l.push(`Respuesta: ${m.respuesta}`);
  if (m.recompensa) l.push(`Recompensa: ${m.recompensa}`);
  if (m.protocolo.parcial) l.push(`Versión mínima (Parcial): ${m.protocolo.parcial}`);
  if (m.protocolo.hecho) l.push(`Hecho significa: ${m.protocolo.hecho}`);
  if (m.protocolo.omitido) l.push(`Omitido válido cuando: ${m.protocolo.omitido}`);
  return l.length > 1 ? l.join('\n') : '';
}

export function buildContext(d: CoachData, matrizPara: 'pendientes' | 'todos' | string[] = 'pendientes'): string {
  const entries = sortEntries(d.entries);
  const dia = DIAS_LARGOS[weekdayOf(d.fecha)];
  const lines = [`FECHA: ${dia} ${d.fecha}, ${d.hora} (hora local)`];

  const hechos = entries.filter((e) => e.estado && ESTADO_BY_KEY[e.estado].cuenta).length;
  lines.push(`HOY: ${hechos} de ${entries.length} hábitos con Parcial o mejor; ${entries.filter(isPending).length} sin registrar.`);
  lines.push('', 'HÁBITOS DE HOY (nombre | rango | objetivo | estado | racha | 🧊 | proyección):');
  for (const e of entries) {
    const st = e.habitId ? d.stats[e.habitId] : undefined;
    const racha = st ? `racha ${st.state.racha} (mejor ${st.state.mejor})` : 'racha ?';
    const hielo = st ? `🧊 ${st.state.congeladores}` : '🧊 ?';
    const proy = proyeccion(e, st) ?? '';
    const rango = e.rango ? RANGO_BY_KEY[e.rango].label : 'sin rango';
    const ident = e.identidad ? ` | identidad: ${e.identidad}` : '';
    const fallo = e.habitId && d.fallosAyer?.includes(e.habitId) ? ' | AYER FALLÓ: no debe fallar dos veces' : '';
    lines.push(`- ${e.nombre} | ${rango} | ${e.objetivo || 'sin objetivo'} | ${estadoTxt(e)} | ${racha} | ${hielo} | ${proy}${ident}${fallo}`);
  }
  if (d.ayer?.length) {
    lines.push('', 'PENDIENTES DE AYER (aún se pueden registrar con dia="ayer"; el día se cierra a las 03:00):');
    for (const e of d.ayer) lines.push(`- ${e.nombre} | ${e.rango ? RANGO_BY_KEY[e.rango].label : 'sin rango'} | ${e.objetivo || 'sin objetivo'}`);
  }

  const elegidos = entries.filter((e) =>
    matrizPara === 'todos' ? true : matrizPara === 'pendientes' ? isPending(e) || e.estado === 'omitido' : matrizPara.includes(e.nombre),
  );
  const matrices = elegidos
    .map((e) => matrizTxt(e.nombre, e.habitId ? d.matrices[e.habitId] : undefined))
    .filter(Boolean);
  if (matrices.length) lines.push('', 'MATRIZ ATÓMICA Y PROTOCOLO:', ...matrices);
  const sinSenal = elegidos.filter((e) => e.habitId && d.matrices[e.habitId] && !d.matrices[e.habitId]!.senal).map((e) => e.nombre);
  if (sinSenal.length) lines.push('', `SIN SEÑAL DEFINIDA EN SU MATRIZ: ${sinSenal.join('; ')}`);
  return lines.join('\n');
}

/** Tasas de cumplimiento precalculadas para la revisión semanal. */
export function buildHistorial(historial: Entry[], desde: string, hasta: string): string {
  const pct = (ok: number, tot: number) => (tot ? `${Math.round((ok / tot) * 100)} % (${ok}/${tot})` : 'sin datos');
  const acc = () => ({ ok: 0, tot: 0 });
  const porHabito = new Map<string, { ok: number; tot: number; serie: Map<string, EstadoKey | null> }>();
  const porRango = new Map<string, { ok: number; tot: number }>();
  const porDia = new Map<number, { ok: number; tot: number }>();
  const omitidos = new Map<string, number>();

  for (const e of historial) {
    if (!e.fecha) continue;
    const ok = outcomeFromEstado(e.estado ?? null) === 'done' ? 1 : 0;
    const h = porHabito.get(e.nombre) ?? { ...acc(), serie: new Map() };
    h.ok += ok;
    h.tot += 1;
    h.serie.set(e.fecha, e.estado);
    porHabito.set(e.nombre, h);
    const rk = e.rango ? RANGO_BY_KEY[e.rango].label : 'Sin rango';
    const r = porRango.get(rk) ?? acc();
    r.ok += ok;
    r.tot += 1;
    porRango.set(rk, r);
    const wd = weekdayOf(e.fecha);
    const w = porDia.get(wd) ?? acc();
    w.ok += ok;
    w.tot += 1;
    porDia.set(wd, w);
    if (e.estado === 'omitido') omitidos.set(e.nombre, (omitidos.get(e.nombre) ?? 0) + 1);
  }

  const fechas: string[] = [];
  for (const h of porHabito.values()) for (const f of h.serie.keys()) fechas.push(f);
  const dias = [...new Set(fechas)].sort();
  const lines = [`HISTORIAL del ${desde} al ${hasta} (cumplido = Parcial o mejor):`, '', 'POR HÁBITO (tasa | serie día a día, · = sin fila):'];
  for (const [nombre, h] of [...porHabito.entries()].sort((a, b) => a[1].ok / a[1].tot - b[1].ok / b[1].tot)) {
    const serie = dias.map((f) => (h.serie.has(f) ? ESTADO_BY_KEY[h.serie.get(f) ?? 'sin_iniciar'].icon : '·')).join('');
    lines.push(`- ${nombre}: ${pct(h.ok, h.tot)} | ${serie}`);
  }
  lines.push('', 'POR RANGO HORARIO:');
  for (const [k, v] of porRango) lines.push(`- ${k}: ${pct(v.ok, v.tot)}`);
  lines.push('', 'POR DÍA DE LA SEMANA:');
  for (const [k, v] of [...porDia.entries()].sort((a, b) => a[0] - b[0])) lines.push(`- ${DIAS_LARGOS[k]}: ${pct(v.ok, v.tot)}`);
  if (omitidos.size) {
    lines.push('', 'OMITIDOS (pausas conscientes):');
    for (const [k, v] of omitidos) lines.push(`- ${k}: ${v}`);
  }
  return lines.join('\n');
}

// ---------- Tareas ----------

export const TAREA_CIERRE = `TAREA: mensaje de cierre del día, máximo 110 palabras.
1) Cómo fue el día, con la cifra de HOY.
2) Qué racha está en riesgo esta noche y qué se perdería (usa la proyección). Si no hay riesgo, celebra la más larga.
3) UNA sola acción concreta: para lo que aún se puede salvar hoy, la versión mínima; si ya no, cómo empezar mañana usando su Señal.
Termina con una frase corta de identidad.`;

export const TAREA_SEMANA = `TAREA: revisión semanal, máximo 200 palabras.
1) El logro principal de estos días.
2) El patrón más claro (hábito, rango horario o día de la semana con más fallos), con su cifra.
3) UN solo ajuste concreto al sistema: mover el hábito de rango, bajar el objetivo a su versión mínima o cambiar su Señal. Explica por qué en una frase.
4) El foco de la próxima semana en una línea.`;

export const TAREA_CHAT = `TAREA: conversación libre con el usuario. Responde en máximo 90 palabras salvo que pida más detalle.
Si el usuario afirma con claridad que hizo, hizo en parte, superó u omitió un hábito de HOY, usa la herramienta marcar_estado y confírmalo en tu respuesta. Si no está claro cuál hábito o qué nivel, pregunta antes de marcar. Solo marca hábitos de HOY o, si aparece la lista, de PENDIENTES DE AYER (con dia="ayer"); si no está claro de qué día habla, pregunta. Nunca marques otros días.`;

export const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'marcar_estado',
      description: 'Registra en Notion el estado de un hábito de HOY (o de PENDIENTES DE AYER, si aparece esa lista).',
      parameters: {
        type: 'object',
        properties: {
          habito: { type: 'string', description: 'Nombre exacto del hábito, tal como aparece en HÁBITOS DE HOY o en PENDIENTES DE AYER.' },
          estado: {
            type: 'string',
            enum: ['hecho', 'parcial', 'superado', 'alto_impacto', 'omitido', 'sin_iniciar'],
            description: 'Nivel alcanzado según el Protocolo de Ejecución Flexible.',
          },
          dia: { type: 'string', enum: ['hoy', 'ayer'], description: '«ayer» solo para un hábito de PENDIENTES DE AYER. Por defecto, «hoy».' },
        },
        required: ['habito', 'estado'],
      },
    },
  },
];

const ESTADO_TOOL: Record<string, EstadoKey> = {
  hecho: 'hecho',
  parcial: 'parcial',
  superado: 'superado',
  alto_impacto: 'alto',
  omitido: 'omitido',
  sin_iniciar: 'sin_iniciar',
};

/** Busca el hábito por nombre: exacto, luego por inclusión. Devuelve null si es ambiguo. */
export function matchEntry(entries: Entry[], nombre: string): Entry | null {
  const n = normalize(nombre);
  const exact = entries.filter((e) => normalize(e.nombre) === n);
  if (exact.length === 1) return exact[0]!;
  const parcial = entries.filter((e) => normalize(e.nombre).includes(n) || n.includes(normalize(e.nombre)));
  return parcial.length === 1 ? parcial[0]! : null;
}

// ---------- Ejecución ----------

export type Completer = (opts: LlmOptions) => Promise<LlmResult>;

export function fallbackCierre(d: CoachData): string {
  const entries = sortEntries(d.entries);
  const hechos = entries.filter((e) => e.estado && ESTADO_BY_KEY[e.estado].cuenta).length;
  const riesgos = entries
    .filter(isPending)
    .map((e) => {
      const p = proyeccion(e, e.habitId ? d.stats[e.habitId] : undefined);
      return `• ${esc(e.nombre)}${p ? ` — ${esc(p)}` : ''}`;
    });
  return [
    `Hoy registraste <b>${hechos} de ${entries.length}</b> hábitos con Parcial o mejor.`,
    riesgos.length ? `\nAún pendientes:\n${riesgos.join('\n')}` : '\n🎉 No queda nada pendiente.',
    '\n<i>(Resumen sin IA: el coach no estuvo disponible.)</i>',
  ].join('\n');
}

/**
 * Límite de espera del LLM. Desde un comando de Telegram el trabajo corre en `waitUntil`,
 * que Cloudflare corta a los 30 s: con DeepSeek lento hay que dejar tiempo al respaldo.
 */
export const TIMEOUT_COMANDO_MS = 20_000;

/**
 * Límite de espera del LLM en el cron: no hay corte a los 30 s, así que DeepSeek tiene más
 * margen ante una lentitud puntual y aún queda tiempo para el respaldo (Gemma, ~3 s).
 */
export const TIMEOUT_CRON_MS = 45_000;

export async function coachCierre(complete: Completer, d: CoachData, timeoutMs?: number): Promise<string> {
  try {
    const r = await complete({
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nDATOS:\n${buildContext(d)}` },
        { role: 'user', content: TAREA_CIERRE },
      ],
      maxTokens: 350,
      temperature: 0.7,
      timeoutMs,
    });
    return sanitizeLlmHtml(r.content) || fallbackCierre(d);
  } catch (e) {
    console.error('coach cierre', e);
    return fallbackCierre(d);
  }
}

export async function coachSemana(complete: Completer, d: CoachData, historial: string, timeoutMs = 90_000): Promise<string> {
  try {
    const r = await complete({
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nDATOS:\n${buildContext(d, 'todos')}\n\n${historial}` },
        { role: 'user', content: TAREA_SEMANA },
      ],
      // La revisión semanal sí usa razonamiento: es 1 llamada por semana (~8 s medidos).
      thinking: true,
      maxTokens: 2500,
      timeoutMs,
    });
    return sanitizeLlmHtml(r.content) || `${fallbackCierre(d)}\n\n${esc(historial)}`;
  } catch (e) {
    console.error('coach semana', e);
    return `<b>Revisión semanal (sin IA)</b>\n\n<code>${esc(historial).slice(0, 3000)}</code>`;
  }
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Guarda el estado en Notion y devuelve la fila actualizada (para refrescar su tarjeta). */
export type Marcador = (entry: Entry, estado: EstadoKey) => Promise<Entry | void>;

export interface ChatResult {
  text: string;
  marcados: string[];
  /** Filas guardadas en Notion, tal como quedaron. */
  actualizadas: Entry[];
}

export async function coachChat(
  complete: Completer,
  d: CoachData,
  history: ChatTurn[],
  userText: string,
  marcar: Marcador,
  /** Tiempo total para todas las rondas (el webhook tiene 30 s). */
  presupuestoMs = 60_000,
): Promise<ChatResult> {
  const out: ChatResult = { text: '', marcados: [], actualizadas: [] };
  const limite = Date.now() + presupuestoMs;
  const messages: LlmMessage[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\nDATOS:\n${buildContext(d, 'todos')}\n\n${TAREA_CHAT}` },
    ...history,
    { role: 'user', content: userText },
  ];
  try {
    for (let ronda = 0; ronda < 3; ronda++) {
      const resta = limite - Date.now();
      if (resta < 3_000) break;
      const r = await complete({ messages, tools: TOOLS, maxTokens: 400, temperature: 0.6, timeoutMs: Math.min(15_000, resta) });
      if (!r.toolCalls.length) return { ...out, text: sanitizeLlmHtml(r.content) };
      messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
      for (const call of r.toolCalls) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: await ejecutarTool(call.function, d, marcar, out) });
      }
    }
    return { ...out, text: 'Listo. Revisa /hoy para ver cómo quedó tu día.' };
  } catch (e) {
    console.error('coach chat', e);
    return { ...out, text: 'No pude contactar al coach en este momento. Usa /hoy para registrar con los botones.' };
  }
}

async function ejecutarTool(fn: { name: string; arguments: string }, d: CoachData, marcar: Marcador, out: ChatResult): Promise<string> {
  if (fn.name !== 'marcar_estado') return `Error: herramienta desconocida ${fn.name}`;
  let args: { habito?: string; estado?: string; dia?: string };
  try {
    args = JSON.parse(fn.arguments || '{}');
  } catch {
    return 'Error: argumentos no son JSON válido.';
  }
  const estado = ESTADO_TOOL[args.estado ?? ''];
  if (!estado) return `Error: estado inválido. Usa uno de: ${Object.keys(ESTADO_TOOL).join(', ')}.`;
  const deAyer = args.dia === 'ayer';
  if (deAyer && !d.ayer?.length) return 'Error: ya no hay pendientes de ayer que se puedan registrar (el día se cerró a las 03:00).';
  const entries = deAyer ? d.ayer! : d.entries;
  const entry = matchEntry(entries, args.habito ?? '');
  if (!entry) return `Error: no encontré un único hábito ${deAyer ? 'pendiente de ayer' : 'de hoy'} llamado «${args.habito}». Opciones: ${entries.map((e) => e.nombre).join('; ')}.`;
  try {
    const guardada = await marcar(entry, estado);
    entry.estado = estado;
    out.actualizadas.push(guardada ?? entry);
    out.marcados.push(`${ESTADO_BY_KEY[estado].icon} ${entry.nombre}${deAyer ? ' (ayer)' : ''}`);
    return `OK: «${entry.nombre}» (${deAyer ? 'ayer' : 'hoy'}) quedó como ${ESTADO_BY_KEY[estado].label} en Notion.`;
  } catch (e) {
    return `Error al guardar en Notion: ${String(e).slice(0, 200)}`;
  }
}
