import { describe, expect, it, vi } from 'vitest';
import {
  buildContext,
  buildContextPeriodo,
  buildHistorial,
  buildTendencia,
  coachChat,
  coachCierre,
  coachMes,
  coachSemana,
  cuandoToca,
  fallbackCierre,
  matchEntry,
  momentoDe,
  proyeccion,
  SYSTEM_PROMPT,
  TAREA_MES,
  TAREA_RESUMEN,
  TAREA_SEMANA,
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
    expect(proyeccion(entry(), stats(5, 1))).toBe('si queda así, gasta 1 🧊 y conserva la racha de 5 (le quedarían 0 🧊)');
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
    // Gemma 4 razona por defecto y, sin esto, gasta max_tokens y devuelve content vacío.
    expect(AI.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ chat_template_kwargs: { enable_thinking: false } }),
    );
  });
  it('Workers AI: lee el formato OpenAI y falla si solo hubo razonamiento', async () => {
    const failFetch = (async () => new Response('timeout', { status: 504 })) as unknown as typeof fetch;
    const ok = { run: vi.fn(async () => ({ choices: [{ message: { content: 'gemma', reasoning_content: null } }] })) };
    const r = await complete({ ...baseEnv, AI: ok } as unknown as Env, { messages: [{ role: 'user', content: 'x' }] }, failFetch);
    expect(r.content).toBe('gemma');
    const vacio = { run: vi.fn(async () => ({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'pienso…' } }] })) };
    await expect(
      complete({ ...baseEnv, AI: vacio } as unknown as Env, { messages: [{ role: 'user', content: 'x' }] }, failFetch),
    ).rejects.toThrow(/respuesta vacía/);
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

describe('contexto según la hora, ayer y la semana', () => {
  const dientes = (fecha: string, estado: Entry['estado']) =>
    entry({ pageId: `d-${fecha}`, nombre: 'Cepillarme los dientes en la noche', rango: 'noche', habitId: 'h-dientes', fecha, estado });
  const agua = (fecha: string, estado: Entry['estado']) => entry({ pageId: `a-${fecha}`, nombre: 'Tomar agua', rango: 'dia', habitId: 'h-agua', fecha, estado });
  const semana = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'].flatMap((f) => [
    dientes(f, f === '2026-10-12' ? 'sin_iniciar' : 'hecho'),
    agua(f, 'hecho'),
  ]);
  const madrugada = (): CoachData => ({
    fecha: '2026-10-15',
    hora: '00:49',
    entries: [dientes('2026-10-15', 'sin_iniciar'), agua('2026-10-15', 'sin_iniciar')],
    stats: { 'h-dientes': { habitId: 'h-dientes', nombre: 'Cepillarme los dientes en la noche', state: { racha: 2, mejor: 4, congeladores: 1, procesadoHasta: '2026-10-14' } } },
    matrices: {},
    ayerAbierto: true,
    semana,
  });

  it('momentoDe y cuandoToca', () => {
    expect(momentoDe(49)).toBe('madrugada');
    expect(momentoDe(23 * 60)).toBe('noche');
    expect(cuandoToca(dientes('x', null), 49)).toBe('aún no toca (desde 18:00)');
    expect(cuandoToca(dientes('x', null), 19 * 60)).toBe('en su rango ahora');
    expect(cuandoToca(entry({ rango: 'manana' }), 23 * 60)).toBe('su rango ya pasó');
    expect(cuandoToca(agua('x', null), 49)).toBe('cualquier momento del día');
  });

  it('de madrugada marca lo de hoy como «aún no toca» y trae el balance de ayer', () => {
    const ctx = buildContext(madrugada());
    expect(ctx).toContain('MOMENTO: madrugada');
    expect(ctx).toContain('Ayer sigue abierto hasta las 03:00');
    expect(ctx).toContain('AYER (miércoles 2026-10-14): 2 de 2 hábitos con Parcial o mejor.');
    expect(ctx).toMatch(/Cepillarme los dientes en la noche \| Noche \| aún no toca \(desde 18:00\)/);
  });

  it('la tendencia trae días completos seguidos, recuperación y récords', () => {
    const t = buildTendencia(semana, '2026-10-15', {
      'h-agua': { habitId: 'h-agua', nombre: 'Tomar agua', state: { racha: 9, mejor: 9, congeladores: 2, procesadoHasta: '2026-10-14' } },
    });
    expect(t).toContain('Días seguidos con todo cumplido, hasta ayer: 2');
    expect(t).toContain('Cumplimiento: 93 % (13/14)');
    expect(t).toContain('Más constante: Tomar agua 100 % (7/7)');
    expect(t).toContain('Más flojo: Cepillarme los dientes en la noche 86 % (6/7)');
    expect(t).toContain('Se recuperó tras fallar: Cepillarme los dientes en la noche');
    expect(t).toContain('Tomar agua está en su mejor racha (9)');
    expect(buildTendencia([], '2026-10-15')).toBe('');
  });

  it('incluye los últimos mensajes para no repetirse', () => {
    const ctx = buildContext({ ...madrugada(), ultimos: ['Cada repetición es un voto por tu Cuerpo limpio'] });
    expect(ctx).toContain('TUS ÚLTIMOS MENSAJES');
    expect(ctx).toContain('«Cada repetición es un voto por tu Cuerpo limpio»');
  });

  it('/resumen usa su propia tarea y el resumen sin IA no alarma por lo que aún no toca', async () => {
    const llm = vi.fn<Completer>(async () => ({ content: 'ok', toolCalls: [], provider: 'openai-compatible' as const }));
    await coachCierre(llm, madrugada(), undefined, TAREA_RESUMEN);
    expect(llm.mock.calls[0]![0].messages[1]!.content).toBe(TAREA_RESUMEN);
    const sinIa = fallbackCierre(madrugada());
    expect(sinIa).not.toContain('Cepillarme');
    expect(sinIa).toContain('Tomar agua');
  });
});

describe('contexto de periodo (semana y mes)', () => {
  const d = data({ ultimos: ['Mensaje anterior'], semana: [entry({ fecha: '2026-10-11' })] });
  const ctx = buildContextPeriodo(d, '2026-10-01 a 2026-10-31 (octubre 2026)', 'FICHA POR HÁBITO DEL PERIODO\n- Gym | 50 %');

  it('no trae nada del día: ni hoy, ni ayer, ni la hora, ni la tabla con estado y «cuándo»', () => {
    for (const x of ['HOY', 'AYER', 'MOMENTO', 'HÁBITOS DE HOY', 'cuándo', 'al cerrar el día', '23:00', 'ÚLTIMOS 7 DÍAS']) expect(ctx).not.toContain(x);
  });
  it('trae el periodo, la ficha y la memoria corta', () => {
    expect(ctx).toContain('PERIODO: 2026-10-01 a 2026-10-31 (octubre 2026)');
    expect(ctx).toContain('- Gym | 50 %');
    expect(ctx).toContain('«Mensaje anterior»');
  });
  it('las tareas de semana y mes piden hablar solo del periodo; el cierre sigue con el contexto del día', () => {
    for (const t of [TAREA_SEMANA, TAREA_MES]) expect(t).toContain('no menciones «hoy», «ayer» ni «ahora»');
    expect(buildContext(d)).toContain('HOY:');
  });
  it('coachMes y coachSemana mandan ese contexto y la tarea correcta, con razonamiento', async () => {
    const llamadas: any[] = [];
    const complete: Completer = async (o) => {
      llamadas.push(o);
      return { content: '<b>🏆 Logro</b>\nok', toolCalls: [], provider: 'openai-compatible' };
    };
    await coachMes(complete, ctx, 'CIFRAS x');
    await coachSemana(complete, ctx, 'CIFRAS y');
    expect(llamadas[0].messages[0].content).toContain('PERIODO: 2026-10-01');
    expect(llamadas[0].messages[1].content).toContain('balance del mes');
    expect(llamadas[1].messages[1].content).toContain('revisión semanal');
    expect(llamadas.every((l) => l.thinking === true && !l.messages[0].content.includes('HOY:'))).toBe(true);
  });
});
