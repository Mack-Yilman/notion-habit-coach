// Proveedor LLM con respaldo: API compatible con OpenAI (DeepSeek por defecto)
// → Workers AI (gratis, sin tools) → error (el llamador usa un texto fijo).
//
// Notas de DeepSeek (api-docs.deepseek.com, 2026-10):
// - `thinking` viene activado por defecto; se controla con {"thinking": {"type": "enabled"|"disabled"}}.
// - Con `tools` y thinking activo hay que devolver `reasoning_content` en cada turno (si no, 400);
//   por eso las llamadas con tools van siempre con thinking desactivado.
// - En thinking, `temperature` se ignora.
// - El prefijo repetido (prompt de sistema) se cobra como «cache hit», ~50 veces más barato.

import type { Env } from './env';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LlmOptions {
  messages: LlmMessage[];
  tools?: ToolDef[];
  thinking?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmResult {
  content: string;
  toolCalls: ToolCall[];
  provider: 'openai-compatible' | 'workers-ai';
  /** Error del proveedor principal cuando respondió el respaldo. */
  errorPrincipal?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
}

type FetchFn = typeof fetch;

export async function complete(env: Env, opts: LlmOptions, fetchFn?: FetchFn): Promise<LlmResult> {
  const errores: string[] = [];
  if (env.LLM_API_KEY) {
    try {
      return await openaiCompatible(env, opts, fetchFn ?? ((i, init) => fetch(i, init)));
    } catch (e) {
      errores.push(String(e));
      console.error('LLM principal falló, uso respaldo', e);
    }
  }
  if (env.AI) {
    try {
      const r = await workersAi(env, opts);
      return errores.length ? { ...r, errorPrincipal: errores[0] } : r;
    } catch (e) {
      errores.push(String(e));
      console.error('Workers AI falló', e);
    }
  }
  throw new Error(`Sin proveedor de IA disponible: ${errores.join(' | ') || 'no hay LLM_API_KEY ni binding AI'}`);
}

async function openaiCompatible(env: Env, opts: LlmOptions, fetchFn: FetchFn): Promise<LlmResult> {
  const base = (env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const isDeepSeek = /deepseek\.com/.test(base);
  const thinking = opts.tools?.length ? false : (opts.thinking ?? false);
  const body: Record<string, unknown> = {
    model: env.LLM_MODEL || 'deepseek-flash',
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 600,
    stream: false,
  };
  if (!thinking) body.temperature = opts.temperature ?? 0.7;
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  // `thinking` es propio de DeepSeek; otros proveedores podrían rechazar el campo.
  if (isDeepSeek) body.thinking = { type: thinking ? 'enabled' : 'disabled' };

  const res = await fetchFn(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    usage?: LlmResult['usage'];
  };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('LLM: respuesta sin choices');
  return { content: msg.content ?? '', toolCalls: msg.tool_calls ?? [], provider: 'openai-compatible', usage: data.usage };
}

async function workersAi(env: Env, opts: LlmOptions): Promise<LlmResult> {
  // Sin tools: los mensajes de herramientas se convierten en texto para no romper el formato.
  const messages = opts.messages
    .filter((m) => m.content)
    .map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content as string }));
  const model = (env.WORKERS_AI_MODEL || '@cf/google/gemma-4-26b-a4b-it') as Parameters<Ai['run']>[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = await env.AI!.run(model, { messages, max_tokens: opts.maxTokens ?? 600 } as never);
  const content: string = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Workers AI: respuesta vacía');
  return { content, toolCalls: [], provider: 'workers-ai' };
}
