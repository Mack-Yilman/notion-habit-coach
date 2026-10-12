import { describe, expect, it } from 'vitest';
import { Telegram } from '../src/telegram';

/* eslint-disable @typescript-eslint/no-explicit-any */

const respuesta = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('Telegram', () => {
  it('ante un 429 con espera corta, reintenta una vez', async () => {
    const llamadas: any[] = [];
    const tg = new Telegram('t', async (_u, init) => {
      llamadas.push(JSON.parse(String(init!.body)));
      return llamadas.length === 1
        ? respuesta(429, { ok: false, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } })
        : respuesta(200, { ok: true, result: { message_id: 5 } });
    });
    expect(await tg.send('1', 'hola')).toEqual({ message_id: 5 });
    expect(llamadas).toHaveLength(2);
  });

  it('un 429 con espera larga no se reintenta', async () => {
    let n = 0;
    const tg = new Telegram('t', async () => {
      n++;
      return respuesta(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } });
    });
    await expect(tg.send('1', 'hola')).rejects.toThrow('Too Many Requests');
    expect(n).toBe(1);
  });

  it('edit con HTML inválido reintenta como texto plano', async () => {
    const llamadas: any[] = [];
    const tg = new Telegram('t', async (_u, init) => {
      llamadas.push(JSON.parse(String(init!.body)));
      return llamadas.length === 1
        ? respuesta(400, { ok: false, description: "Bad Request: can't parse entities" })
        : respuesta(200, { ok: true, result: true });
    });
    await tg.edit('1', 3, '<b>Gym</b> &amp; más');
    expect(llamadas[1]).toMatchObject({ text: 'Gym & más', message_id: 3 });
    expect(llamadas[1].parse_mode).toBeUndefined();
  });
});
