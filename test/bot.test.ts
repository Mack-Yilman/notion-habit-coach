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
