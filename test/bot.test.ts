import { describe, expect, it } from 'vitest';
import { handleUpdate } from '../src/bot';
import { encodeEstado } from '../src/callback';
import { fakeApp, row } from './fakes';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PAGE = '3f727351c36780aabbbb0123456789ab';
const pulsar = (data: string, mid = 7) => ({ callback_query: { id: 'q1', data, message: { message_id: mid, chat: { id: 1 } } } });
const escribir = (text: string) => ({ message: { text, chat: { id: 1 } } });

describe('botones', () => {
  it('un día ya cerrado no se cambia: avisa y quita los botones', async () => {
    const { app, updates, tgCalls } = fakeApp('2026-10-14T11:30:00Z', [row(PAGE, 'h-gym', 'Gym', '2026-10-13', '⚪ Sin iniciar', { r: 2, c: 1, cerrada: true })]);
    await handleUpdate(app, pulsar(encodeEstado(PAGE, 'hecho')));
    expect(updates).toHaveLength(0);
    expect(tgCalls.find((c) => c.method === 'answerCallback')!.text).toContain('ya se cerró');
    expect(tgCalls.some((c) => c.method === 'clearKeyboard' && c.mid === 7)).toBe(true);
  });

  it('un día abierto se registra y la tarjeta pasa a mostrar el nivel', async () => {
    const { app, updates, tgCalls, kv } = fakeApp('2026-10-14T11:30:00Z', [row(PAGE, 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar')]);
    kv.m.set('msg:7', JSON.stringify({ kind: 'habito', pageId: PAGE }));
    await handleUpdate(app, pulsar(encodeEstado(PAGE, 'hecho')));
    expect(updates).toHaveLength(1);
    expect(tgCalls.find((c) => c.method === 'edit')!.text).toContain('⚡ <b>Gym</b> · <i>Hecho</i>');
  });
});

describe('madrugada (00:00 a 03:00): el día anterior sigue abierto', () => {
  // 01:00 Lima = 06:00 UTC del 14/10
  const MADRUGADA = '2026-10-14T06:00:00Z';

  it('/pendientes muestra también los pendientes de ayer', async () => {
    const { app, sent } = fakeApp(MADRUGADA, [
      row('g13', 'h-gym', 'Gym', '2026-10-13', '⚪ Sin iniciar'),
      row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
    ]);
    await handleUpdate(app, escribir('/pendientes'));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toContain('Pendientes de ayer');
    expect(sent[1]!.text).toContain('⏳ Pendientes');
  });

  it('después de las 03:00 ya no los muestra', async () => {
    const { app, sent } = fakeApp('2026-10-14T08:30:00Z', [
      row('g13', 'h-gym', 'Gym', '2026-10-13', '⚪ Sin iniciar'),
      row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
    ]);
    await handleUpdate(app, escribir('/pendientes'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).not.toContain('ayer');
  });

  it('el chat puede marcar un pendiente de ayer y actualiza su tarjeta', async () => {
    const { app, rows, sent, tgCalls, kv } = fakeApp(MADRUGADA, [
      row('g13', 'h-gym', 'Gym', '2026-10-13', '⚪ Sin iniciar'),
      row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
    ]);
    kv.m.set('cards:activas', JSON.stringify([{ mid: 9, pageId: 'g13', date: '2026-10-14' }]));
    let ronda = 0;
    app.llm = async () =>
      ronda++ === 0
        ? {
            content: '',
            provider: 'openai-compatible' as const,
            toolCalls: [{ id: 't1', type: 'function' as const, function: { name: 'marcar_estado', arguments: JSON.stringify({ habito: 'Gym', estado: 'hecho', dia: 'ayer' }) } }],
          }
        : { content: '¡Bien!', toolCalls: [], provider: 'openai-compatible' as const };
    await handleUpdate(app, escribir('ayer sí fui al gym'));
    expect(rows.find((r) => r.id === 'g13')!.properties.Estado.select.name).toBe('⚡ Hecho');
    expect(rows.find((r) => r.id === 'g14')!.properties.Estado.select.name).toBe('⚪ Sin iniciar');
    expect(sent[0]!.text).toContain('Registrado en Notion: ⚡ Gym (ayer)');
    expect(tgCalls.find((c) => c.method === 'edit' && c.mid === 9)!.text).toContain('<i>Hecho</i>');
  });
});

describe('/resumen de madrugada', () => {
  it('cuenta lo de ayer en la racha, usa la tarea del resumen y recuerda sus últimos mensajes', async () => {
    // 2026-10-15 00:49 en Lima = 05:49 UTC. El snapshot de rachas es el del cierre del 13/10.
    const { app, sent, kv } = fakeApp('2026-10-15T05:49:00Z', [
      row('d13', 'h-d', 'Dientes', '2026-10-13', '⚡ Hecho'),
      row('d14', 'h-d', 'Dientes', '2026-10-14', '⚡ Hecho'),
      row('d15', 'h-d', 'Dientes', '2026-10-15', '⚪ Sin iniciar'),
    ]);
    kv.m.set(
      'stats:snapshot',
      JSON.stringify([{ habitId: 'h-d', nombre: 'Dientes', state: { racha: 1, mejor: 1, congeladores: 1, procesadoHasta: '2026-10-13' } }]),
    );
    const prompts: string[] = [];
    app.llm = async (o) => {
      prompts.push(o.messages.map((m) => m.content).join('\n'));
      return { content: `Mensaje ${prompts.length}`, toolCalls: [], provider: 'openai-compatible' as const };
    };
    await handleUpdate(app, escribir('/resumen'));
    expect(prompts[0]).toContain('TAREA: resumen que el usuario pidió con /resumen');
    expect(prompts[0]).toContain('MOMENTO: madrugada');
    expect(prompts[0]).toContain('AYER (miércoles 2026-10-14): 1 de 1');
    expect(prompts[0]).toContain('aún no toca (desde 06:00)');
    expect(prompts[0]).toContain('racha 2 (mejor 2)');
    expect(prompts[0]).not.toContain('TUS ÚLTIMOS MENSAJES (no repitas');
    expect(sent[0]!.text).toContain('Mensaje 1');

    await handleUpdate(app, escribir('/resumen'));
    expect(prompts[1]).toContain('«Mensaje 1»');
    expect(JSON.parse(kv.m.get('coach:ultimos')!)).toEqual(['Mensaje 1', 'Mensaje 2']);
  });
});

describe('/mes y /semana', () => {
  const filas = () => [
    row('g12', 'h-gym', 'Gym', '2026-10-12', '⚡ Hecho'),
    row('g13', 'h-gym', 'Gym', '2026-10-13', '⚪ Sin iniciar'),
    row('g14', 'h-gym', 'Gym', '2026-10-14', '⚡ Hecho'),
  ];
  const espiar = (app: any) => {
    const prompts: any[] = [];
    app.llm = async (o: any) => {
      prompts.push(o);
      return { content: '<b>🏆 Logro</b>\nTexto', toolCalls: [], provider: 'openai-compatible' as const };
    };
    return prompts;
  };

  it('/mes: cifras del Worker, texto con etiquetas y mapa por semanas, sin snapshot parcial', async () => {
    const { app, sent, kv } = fakeApp('2026-10-14T17:00:00Z', filas());
    const prompts = espiar(app);
    await handleUpdate(app, escribir('/mes'));
    expect(prompts[0].messages[1].content).toContain('TAREA: balance del mes');
    expect(prompts[0].messages[0].content).toContain('CIFRAS (este mes contra el anterior)');
    expect(prompts[0].messages[0].content).toContain('FICHA POR HÁBITO DEL PERIODO');
    expect(prompts[0].messages[0].content).not.toContain('HOY:');
    expect(prompts[0].messages[0].content).not.toContain('HÁBITOS DE HOY');
    expect(prompts[0].thinking).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Balance de octubre 2026');
    expect(sent[0]!.text).toContain('Cumplimiento: <b>67 %</b> (2/3)');
    expect(sent[0]!.text).toContain('Mes por semanas');
    expect(kv.m.has('resumen:mes:2026-10')).toBe(false); // a mitad de mes no hay snapshot
  });

  it('/mes sin filas del mes lo dice sin llamar al modelo', async () => {
    const { app, sent } = fakeApp('2026-10-14T17:00:00Z', []);
    const prompts = espiar(app);
    await handleUpdate(app, escribir('/mes'));
    expect(prompts).toHaveLength(0);
    expect(sent[0]!.text).toContain('Aún no hay filas de este mes');
  });

  it('/semana: cifras, texto y mapa, con las cifras también en el prompt', async () => {
    const { app, sent } = fakeApp('2026-10-14T17:00:00Z', filas());
    const prompts = espiar(app);
    await handleUpdate(app, escribir('/semana'));
    expect(prompts[0].messages[1].content).toContain('<b>🔧 Ajuste</b>');
    expect(prompts[0].messages[0].content).toContain('CIFRAS (semana actual contra la anterior)');
    expect(prompts[0].messages[0].content).toContain('FICHA POR HÁBITO DEL PERIODO');
    expect(prompts[0].messages[0].content).not.toContain('HOY:');
    const t = sent[0]!.text;
    expect(t.indexOf('📈 Cifras')).toBeLessThan(t.indexOf('🏆 Logro'));
    expect(t.indexOf('🏆 Logro')).toBeLessThan(t.indexOf('Últimos 14 días'));
    expect(t).toContain('<b>Gym</b>\n');
  });

  it('si el coach falla, igual llegan las cifras', async () => {
    const { app, sent } = fakeApp('2026-10-14T17:00:00Z', filas());
    app.llm = async () => {
      throw new Error('LLM caído');
    };
    await handleUpdate(app, escribir('/mes'));
    expect(sent[0]!.text).toContain('📈 Cifras');
    expect(sent[0]!.text).toContain('Sin IA');
  });
});
