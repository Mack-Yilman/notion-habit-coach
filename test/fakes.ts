// Fakes de Notion, KV y Telegram para las pruebas de escenario.

import type { App } from '../src/app';
import { DEFAULT_SCHEDULE } from '../src/schedule';
import { localNow } from '../src/time';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const HAB = 'ds-habitos';

export function fakeKv() {
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

export const row = (
  id: string,
  habit: string,
  nombre: string,
  fecha: string,
  estado: string,
  racha?: { r: number; c: number; cerrada: boolean },
) => ({
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
  if (filter.title) return prop.title.map((t: any) => t.plain_text).join('') === filter.title.equals;
  const v = prop?.date?.start;
  const d = filter.date;
  if (d.equals) return v === d.equals;
  if (d.before && !(v < d.before)) return false;
  if (d.on_or_before && !(v <= d.on_or_before)) return false;
  if (d.on_or_after && !(v >= d.on_or_after)) return false;
  return true;
}

export interface TgCall {
  method: string;
  mid?: number;
  text?: string;
  keyboard?: any;
}

export function fakeApp(nowUtc: string, rows: any[]) {
  const updates: { id: string; props: any }[] = [];
  const sent: { text: string; keyboard?: unknown; silent?: boolean }[] = [];
  const deleted: number[] = [];
  const tgCalls: TgCall[] = [];
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
    async getPage(id: string) {
      return rows.find((x) => x.id.replace(/-/g, '') === id.replace(/-/g, ''));
    },
    async updatePage(id: string, props: any) {
      updates.push({ id, props });
      const r = rows.find((x) => x.id.replace(/-/g, '') === id.replace(/-/g, ''));
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
      async send(_chat: string, text: string, keyboard?: unknown, opts: { silent?: boolean } = {}) {
        sent.push({ text, keyboard, silent: opts.silent });
        return { message_id: sent.length };
      },
      async deleteMessage(_chat: string, mid: number) {
        deleted.push(mid);
      },
      async edit(_chat: string, mid: number, text: string, keyboard?: unknown) {
        tgCalls.push({ method: 'edit', mid, text, keyboard });
      },
      async clearKeyboard(_chat: string, mid: number) {
        tgCalls.push({ method: 'clearKeyboard', mid });
      },
      async answerCallback(_id: string, text?: string) {
        tgCalls.push({ method: 'answerCallback', text });
      },
      async typing() {},
    } as any,
    now: localNow(new Date(nowUtc), 'America/Lima'),
    schedule: DEFAULT_SCHEDULE,
    chatId: '1',
    llm: (async () => ({ content: 'ok', toolCalls: [], provider: 'openai-compatible' as const })) as App['llm'],
  } satisfies App;
  return { app, updates, sent, deleted, tgCalls, kv, rows };
}

export const num = (r: any, k: string) => r.properties[k].number;
export const cerrada = (r: any) => r.properties['Racha cerrada'].checkbox;
