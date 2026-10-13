import { describe, expect, it, vi } from 'vitest';
import {
  buildContext,
  buildHistorial,
  coachChat,
  coachCierre,
  matchEntry,
  proyeccion,
  SYSTEM_PROMPT,
  type CoachData,
  type Completer,
} from '../src/coach';
import { complete } from '../src/llm';
import type { Entry, Stats } from '../src/habits';
import type { Env } from '../src/env';

const entry = (over: Partial<Entry> = {}): Entry => ({
  pageId: 'p-gym',
  nombre: 'Ir al gimnasio',
  estado: 'sin_iniciar',
  fecha: '2026-10-12',
  rango: 'tarde',
  objetivo: '1 hora',
  identidad: 'Cuerpo Fitness',
  habitId: 'h-gym',
  ...over,
});

const stats = (racha: number, congeladores: number): Stats => ({
  habitId: 'h-gym',
  nombre: 'Ir al gimnasio',
  state: { racha, mejor: racha, congeladores, procesadoHasta: '2026-10-11' },
});

const data = (over: Partial<CoachData> = {}): CoachData => ({
  fecha: '2026-10-12',
  hora: '23:00',
  entries: [entry(), entry({ pageId: 'p-agua', nombre: 'Tomar agua', estado: 'hecho', habitId: 'h-agua', rango: 'dia' })],
  stats: { 'h-gym': stats(5, 1) },
  matrices: { 'h-gym': { senal: 'Alarma 4:30 PM', protocolo: { parcial: '20 min de cardio' } } },
  ...over,
});

describe('proyeccion', () => {
  it('avisa que se gastará un congelador', () => {
    expect(proyeccion(entry(), stats(5, 1))).toContain('gasta 1 🧊 (quedaría 0)');
  });
  it('avisa que se pierde la racha sin congeladores', () => {
    expect(proyeccion(entry(), stats(5, 0))).toContain('pierde la racha de 5 días');
  });
  it('un hecho sube la racha', () => {
    expect(proyeccion(entry({ estado: 'hecho' }), stats(6, 1))).toBe('racha sube a 7 y gana 1 🧊');
  });
});

describe('buildContext', () => {
  const ctx = buildContext(data());
  it('trae la cifra del día y la proyección ya calculadas', () => {
    expect(ctx).toContain('HOY: 1 de 2 hábitos con Parcial o mejor; 1 sin registrar.');
    expect(ctx).toContain('gasta 1 🧊');
    expect(ctx).toContain('lunes 2026-10-12');
  });
  it('incluye la Matriz solo de los pendientes por defecto', () => {
    expect(ctx).toContain('Señal: Alarma 4:30 PM');
    expect(ctx).toContain('Versión mínima (Parcial): 20 min de cardio');
    expect(ctx).not.toContain('# Tomar agua');
  });
  it('señala los pendientes cuya Matriz no tiene Señal', () => {
    const c = buildContext(data({ matrices: { 'h-gym': { protocolo: { parcial: '20 min' } } } }));
    expect(c).toContain('SIN SEÑAL DEFINIDA EN SU MATRIZ: Ir al gimnasio');
  });
});

describe('buildHistorial', () => {
  it('precalcula tasas por hábito, rango y día', () => {
    const h = buildHistorial(
      [
        entry({ fecha: '2026-10-11', estado: 'hecho' }),
        entry({ fecha: '2026-10-12', estado: 'omitido' }),
        entry({ fecha: '2026-10-12', nombre: 'Tomar agua', rango: 'dia', estado: 'parcial' }),
      ],
      '2026-09-29',
      '2026-10-12',
    );
    expect(h).toContain('- Ir al gimnasio: 50 % (1/2) | ⚡💤');
    expect(h).toContain('- Tarde: 50 % (1/2)');
    expect(h).toContain('- domingo: 100 % (1/1)');
    expect(h).toContain('- Ir al gimnasio: 1'); // omitidos
  });
});

describe('matchEntry', () => {
  const es = [entry(), entry({ pageId: 'x', nombre: 'Cepillarme los dientes en la noche' }), entry({ pageId: 'y', nombre: 'Cepillarme los dientes en la mañana' })];
  it('encuentra por nombre exacto o parcial', () => {
    expect(matchEntry(es, 'ir al gimnasio')?.pageId).toBe('p-gym');
    expect(matchEntry(es, 'gimnasio')?.pageId).toBe('p-gym');
  });
  it('devuelve null si es ambiguo', () => {
    expect(matchEntry(es, 'cepillarme')).toBeNull();
  });
});

describe('coachCierre', () => {
  it('usa el prompt de sistema fijo al inicio (caché de DeepSeek)', async () => {
    const llm = vi.fn<Completer>(async () => ({ content: '**Buen día**', toolCalls: [], provider: 'openai-compatible' as const }));
    const t = await coachCierre(llm, data());
    expect(t).toBe('<b>Buen día</b>');
    const msgs = llm.mock.calls[0]![0].messages;
    expect(msgs[0]!.content!.startsWith(SYSTEM_PROMPT)).toBe(true);
  });
  it('si la IA falla, devuelve un resumen fijo', async () => {
    const t = await coachCierre(async () => {
      throw new Error('sin saldo');
    }, data());
    expect(t).toContain('<b>1 de 2</b>');
    expect(t).toContain('Ir al gimnasio');
  });
});

describe('coachChat', () => {
  it('ejecuta marcar_estado y luego responde', async () => {
    const marcar = vi.fn(async () => {});
    let n = 0;
    const llm: Completer = async (opts) => {
      n++;
      if (n === 1) {
        expect(opts.tools?.[0]?.function.name).toBe('marcar_estado');
        return {
          content: '',
          provider: 'openai-compatible',
          toolCalls: [{ id: 't1', type: 'function', function: { name: 'marcar_estado', arguments: '{"habito":"gimnasio","estado":"parcial"}' } }],
        };
      }
      const toolMsg = opts.messages.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toContain('OK');
      return { content: '¡Bien! Registré tu versión mínima.', toolCalls: [], provider: 'openai-compatible' };
    };
    const d = data();
    const r = await coachChat(llm, d, [], 'hice 20 min de cardio', marcar);
    expect(marcar).toHaveBeenCalledWith(expect.objectContaining({ pageId: 'p-gym' }), 'parcial');
    expect(r.marcados).toEqual(['🕯️ Ir al gimnasio']);
    expect(r.text).toContain('Registré');
  });
  it('si el hábito es ambiguo devuelve el error a la IA y no marca nada', async () => {
    const marcar = vi.fn(async () => {});
    let toolResult = '';
    let n = 0;
    const llm: Completer = async (opts) => {
      n++;
      if (n === 1)
        return {
          content: '',
          provider: 'openai-compatible',
          toolCalls: [{ id: 't1', type: 'function', function: { name: 'marcar_estado', arguments: '{"habito":"leer","estado":"hecho"}' } }],
        };
      toolResult = opts.messages.find((m) => m.role === 'tool')?.content ?? '';
      return { content: '¿Cuál hábito?', toolCalls: [], provider: 'openai-compatible' };
    };
    await coachChat(llm, data(), [], 'ya leí', marcar);
    expect(marcar).not.toHaveBeenCalled();
    expect(toolResult).toContain('Error: no encontré');
  });
});

describe('complete (proveedor)', () => {
  const baseEnv = {
    LLM_API_KEY: 'k',
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_MODEL: 'deepseek-flash',
    WORKERS_AI_MODEL: '@cf/google/gemma-4-26b-a4b-it',
  } as unknown as Env;

  const okFetch = (capture: { body?: Record<string, unknown> }) =>
    (async (_url: string, init: RequestInit) => {
      capture.body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hola' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

  it('con tools desactiva thinking (evita el 400 por reasoning_content)', async () => {
    const cap: { body?: Record<string, unknown> } = {};
    await complete(baseEnv, { messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f', description: '', parameters: {} } }], thinking: true }, okFetch(cap));
    expect(cap.body?.thinking).toEqual({ type: 'disabled' });
    expect(cap.body?.tool_choice).toBe('auto');
  });
  it('con thinking no manda temperature', async () => {
    const cap: { body?: Record<string, unknown> } = {};
    await complete(baseEnv, { messages: [{ role: 'user', content: 'x' }], thinking: true }, okFetch(cap));
    expect(cap.body?.thinking).toEqual({ type: 'enabled' });
    expect(cap.body).not.toHaveProperty('temperature');
  });
  it('a otro proveedor no le manda el campo thinking', async () => {
    const cap: { body?: Record<string, unknown> } = {};
    await complete({ ...baseEnv, LLM_BASE_URL: 'https://openrouter.ai/api/v1' } as Env, { messages: [{ role: 'user', content: 'x' }] }, okFetch(cap));
    expect(cap.body).not.toHaveProperty('thinking');
  });
  it('si DeepSeek falla usa Workers AI', async () => {
    const failFetch = (async () => new Response('sin saldo', { status: 402 })) as unknown as typeof fetch;
    const AI = { run: vi.fn(async () => ({ response: 'respaldo' })) };
    const r = await complete({ ...baseEnv, AI } as unknown as Env, { messages: [{ role: 'user', content: 'x' }] }, failFetch);
    expect(r.provider).toBe('workers-ai');
    expect(r.content).toBe('respaldo');
  });
  it('sin clave ni AI lanza error (el llamador usa texto fijo)', async () => {
    await expect(complete({ ...baseEnv, LLM_API_KEY: '' } as Env, { messages: [] })).rejects.toThrow(/Sin proveedor/);
  });
});

describe('contexto: nunca falles dos veces y pendientes de ayer', () => {
  it('marca el hábito que falló ayer y lista los pendientes de ayer de madrugada', () => {
    const ctx = buildContext(data({ fallosAyer: ['h-gym'], ayer: [entry({ pageId: 'p-ayer', fecha: '2026-10-11' })] }));
    expect(ctx).toMatch(/- Ir al gimnasio \|.*\| AYER FALLÓ: no debe fallar dos veces/);
    expect(ctx).toContain('PENDIENTES DE AYER');
  });
  it('sin datos de ayer no agrega nada', () => {
    const ctx = buildContext(data());
    expect(ctx).not.toContain('AYER');
  });
});
