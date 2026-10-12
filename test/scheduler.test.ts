import { describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { closeDays, recalcular, runScheduled } from '../src/scheduler';
import { DEFAULT_SCHEDULE } from '../src/schedule';
import { localNow } from '../src/time';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HAB = 'ds-habitos';

function fakeKv() {
  const m = new Map<string, string>();
  return {
    m,
    async get(k: string, type?: string) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k: string, v: string) {
      m.set(k, v);
    },
    async delete(k: string) {
      m.delete(k);
    },
  };
}

const row = (id: string, habit: string, nombre: string, fecha: string, estado: string, racha?: { r: number; c: number; cerrada: boolean }) => ({
  id,
  properties: {
    'Nombre del habito ': { type: 'title', title: [{ plain_text: nombre }] },
    Estado: { type: 'select', select: { name: estado } },
    Fecha: { type: 'date', date: { start: fecha } },
    'Rango horario': { type: 'select', select: { name: '☀️ 06:00 a 11:59' } },
    Objetivo: { type: 'rich_text', rich_text: [] },
    'Estadística ': { type: 'relation', relation: [{ id: habit }] },
    Racha: { type: 'number', number: racha ? racha.r : null },
    'Mejor racha': { type: 'number', number: racha ? racha.r : null },
    Congeladores: { type: 'number', number: racha ? racha.c : null },
    'Racha cerrada': { type: 'checkbox', checkbox: racha?.cerrada ?? false },
  },
});

function matches(filter: any, p: any): boolean {
  if (!filter) return true;
  if (filter.and) return filter.and.every((f: any) => matches(f, p));
  const prop = p.properties[filter.property];
  if (filter.relation) return prop.relation.some((r: any) => r.id === filter.relation.contains);
  if (filter.checkbox) return prop.checkbox === filter.checkbox.equals;
  const v = prop?.date?.start;
  const d = filter.date;
  if (d.equals) return v === d.equals;
  if (d.before && !(v < d.before)) return false;
  if (d.on_or_before && !(v <= d.on_or_before)) return false;
  if (d.on_or_after && !(v >= d.on_or_after)) return false;
  return true;
}

function fakeApp(nowUtc: string, rows: any[]) {
  const updates: { id: string; props: any }[] = [];
  const sent: { text: string; keyboard?: unknown }[] = [];
  const notion = {
    async getDataSource() {
      return {
        id: HAB,
        properties: {
          'Nombre del habito ': { type: 'title' },
          Estado: { type: 'select', select: { options: [{ name: '⚪ Sin iniciar' }, { name: '⚡ Hecho' }, { name: '🕯️ Parcial' }, { name: '💤 Omitido' }] } },
          Fecha: { type: 'date' },
          Objetivo: { type: 'rich_text' },
          'Rango horario': { type: 'select', select: { options: [] } },
          'Estadística ': { type: 'relation', relation: { data_source_id: 'ds-est' } },
          Racha: { type: 'number' },
          'Mejor racha': { type: 'number' },
          Congeladores: { type: 'number' },
          'Racha cerrada': { type: 'checkbox' },
        },
      };
    },
    async queryAll(_ds: string, body: any) {
      const out = rows.filter((r) => matches(body.filter, r));
      const dir = body.sorts?.[0]?.direction === 'descending' ? -1 : 1;
      return out.sort((a, b) => (a.properties.Fecha.date.start < b.properties.Fecha.date.start ? -dir : dir));
    },
    async updatePage(id: string, props: any) {
      updates.push({ id, props });
      const r = rows.find((x) => x.id === id);
      for (const [k, v] of Object.entries(props)) r.properties[k] = { ...r.properties[k], ...(v as object) };
      return r;
    },
    async children() {
      return [];
    },
  };
  const kv = fakeKv();
  const app = {
    env: { HABITOS_DATA_SOURCE_ID: HAB } as any,
    kv: kv as any,
    notion: notion as any,
    tg: {
      async send(_chat: string, text: string, keyboard?: unknown) {
        sent.push({ text, keyboard });
        return { message_id: sent.length };
      },
    } as any,
    now: localNow(new Date(nowUtc), 'America/Lima'),
    schedule: DEFAULT_SCHEDULE,
    chatId: '1',
    llm: async () => ({ content: 'ok', toolCalls: [], provider: 'openai-compatible' as const }),
  } satisfies App;
  return { app, updates, sent, kv, rows };
}

const num = (r: any, k: string) => r.properties[k].number;
const cerrada = (r: any) => r.properties['Racha cerrada'].checkbox;

// 2026-10-14 03:05 en Lima = 08:05 UTC
const NOW = '2026-10-14T08:05:00Z';

describe('closeDays', () => {
  const base = () => [
    row('g12', 'h-gym', 'Gym', '2026-10-12', '⚡ Hecho'),
    row('g13', 'h-gym', 'Gym', '2026-10-13', '⚪ Sin iniciar'),
    row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
    row('a12', 'h-agua', 'Agua', '2026-10-12', '🕯️ Parcial', { r: 1, c: 2, cerrada: true }),
    row('a13', 'h-agua', 'Agua', '2026-10-13', '⚡ Hecho'),
  ];

  it('cierra cada día en su fila, sella hoy y deja notas', async () => {
    const { app, rows, kv } = fakeApp(NOW, base());
    const r = await closeDays(app);
    expect(r).toMatchObject({ hasta: '2026-10-13', incompleto: false, actualizados: 2 });
    const get = (id: string) => rows.find((x) => x.id === id);
    // Gym: 12 suma (1), 13 gasta congelador (1, 🧊1); hoy queda sellado sin cerrar
    expect([num(get('g12'), 'Racha'), cerrada(get('g12'))]).toEqual([1, true]);
    expect([num(get('g13'), 'Racha'), num(get('g13'), 'Congeladores'), cerrada(get('g13'))]).toEqual([1, 1, true]);
    expect([num(get('g14'), 'Racha'), num(get('g14'), 'Congeladores'), cerrada(get('g14'))]).toEqual([1, 1, false]);
    // Agua: ya tenía el 12 cerrado con racha 1 → el 13 suma
    expect(num(get('a13'), 'Racha')).toBe(2);
    expect(kv.m.get('notas:2026-10-14')).toContain('«Gym» usó un congelador');
  });

  it('es idempotente: una segunda ejecución no escribe nada', async () => {
    const { app, updates } = fakeApp(NOW, base());
    await closeDays(app);
    const n = updates.length;
    await closeDays(app);
    expect(updates).toHaveLength(n);
  });

  it('antes de las 03:00 no cierra ayer', async () => {
    const { app } = fakeApp('2026-10-14T07:30:00Z', base());
    expect((await closeDays(app)).hasta).toBe('2026-10-12');
  });

  it('se reanuda si se corta por el tope de escrituras', async () => {
    // 3 hábitos × 14 días = 42 escrituras > 36 → la primera pasada queda incompleta.
    const rows: any[] = [];
    for (const h of ['a', 'b', 'c']) for (let d = 1; d <= 14; d++) rows.push(row(`${h}${d}`, `h-${h}`, h, `2026-10-${String(d).padStart(2, '0')}`, '⚡ Hecho'));
    // 2026-10-15 03:05 Lima
    const { app } = fakeApp('2026-10-15T08:05:00Z', rows);
    expect((await closeDays(app)).incompleto).toBe(true);
    expect((await closeDays(app)).incompleto).toBe(false);
    const ultimo = (h: string) => rows.find((x) => x.id === `${h}14`);
    for (const h of ['a', 'b', 'c']) expect([num(ultimo(h), 'Racha'), cerrada(ultimo(h))]).toEqual([14, true]);
  });

  it('sin filas cerradas en la ventana busca la última cerrada antes', async () => {
    const rows: any[] = [row('old', 'h-gym', 'Gym', '2026-09-20', '⚡ Hecho', { r: 30, c: 2, cerrada: true })];
    for (let d = 1; d <= 14; d++) rows.push(row(`g${d}`, 'h-gym', 'Gym', `2026-10-${String(d).padStart(2, '0')}`, '⚡ Hecho'));
    const { app } = fakeApp('2026-10-15T08:05:00Z', rows);
    await closeDays(app);
    // La ventana arranca el 01: hereda 30 y suma los 14 días
    expect(num(rows.find((x) => x.id === 'g14'), 'Racha')).toBe(44);
  });
});

describe('recalcular', () => {
  it('reconstruye desde el historial y lo deja en la última fila', async () => {
    const { app, rows } = fakeApp(NOW, [
      row('g12', 'h-gym', 'Gym', '2026-10-12', '⚡ Hecho', { r: 99, c: 0, cerrada: true }),
      row('g13', 'h-gym', 'Gym', '2026-10-13', '💤 Omitido'),
      row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
    ]);
    const r = await recalcular(app);
    expect(r.habitos).toBe(1);
    const g13 = rows.find((x) => x.id === 'g13');
    expect([num(g13, 'Racha'), num(g13, 'Congeladores'), cerrada(g13)]).toEqual([1, 1, true]);
    expect(cerrada(rows.find((x) => x.id === 'g14'))).toBe(false);
  });
});

describe('runScheduled', () => {
  it('envía el aviso de la mañana una sola vez aunque el cron se repita, con la racha', async () => {
    // 2026-10-14 06:30 en Lima = 11:30 UTC
    const { app, sent, kv } = fakeApp('2026-10-14T11:30:00Z', [
      row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar', { r: 4, c: 2, cerrada: false }),
      row('a14', 'h-agua', 'Agua', '2026-10-14', '⚡ Hecho'),
    ]);
    await runScheduled(app);
    await runScheduled(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Buenos días');
    expect(sent[0]!.text).toContain('Gym');
    expect(sent[0]!.text).toContain('🔥4');
    expect(sent[0]!.text).not.toContain('Agua'); // ya registrado
    expect(kv.m.get('sent:2026-10-14:manana')).toBe('hecho');
  });

  it('no envía nada si no hay pendientes en el bloque', async () => {
    const { app, sent } = fakeApp('2026-10-14T11:30:00Z', [row('a14', 'h-agua', 'Agua', '2026-10-14', '⚡ Hecho')]);
    await runScheduled(app);
    expect(sent).toHaveLength(0);
  });
});
