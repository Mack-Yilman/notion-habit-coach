// Lee la «Matriz Atómica» y el «Protocolo de Ejecución Flexible» de cada hábito.
// Viven en tablas dentro de un bloque sincronizado y de encabezados desplegables,
// así que leerlos cuesta ~6 llamadas a Notion: se cachean en KV por 7 días.

import { estadoFromName, normalize, type EstadoKey } from './config';
import { plain, type Json, type Notion } from './notion';

export interface Matrix {
  senal?: string;
  anhelo?: string;
  respuesta?: string;
  recompensa?: string;
  protocolo: Partial<Record<EstadoKey, string>>;
}

export interface TableData {
  heading: string;
  rows: string[][];
}

const PLACEHOLDER = /^\[.*\]$|^$/;

export function parseMatrix(tables: TableData[]): Matrix {
  const m: Matrix = { protocolo: {} };
  for (const t of tables) {
    for (const row of t.rows) {
      const label = normalize(row[0] ?? '');
      const val = (row[1] ?? '').trim();
      const campo = label.includes('senal')
        ? 'senal'
        : label.includes('anhelo')
          ? 'anhelo'
          : label.includes('respuesta')
            ? 'respuesta'
            : label.includes('recompensa')
              ? 'recompensa'
              : null;
      if (campo) {
        if (!PLACEHOLDER.test(val)) m[campo] = val;
        continue;
      }
      const estado = estadoFromName(row[0]);
      const spec = (row[2] ?? row[1] ?? '').trim();
      if (estado && spec && !PLACEHOLDER.test(spec)) m.protocolo[estado] = spec;
    }
  }
  return m;
}

export function isEmptyMatrix(m: Matrix): boolean {
  return !m.senal && !m.anhelo && !m.respuesta && !m.recompensa && !Object.keys(m.protocolo).length;
}

const CONTAINERS = new Set(['synced_block', 'toggle', 'heading_1', 'heading_2', 'heading_3', 'column_list', 'column', 'callout']);

/** Recorre el árbol de bloques de una página y junta sus tablas, con un tope de llamadas. */
export async function collectTables(notion: Notion, pageId: string, budget = 10): Promise<TableData[]> {
  const tables: TableData[] = [];
  let calls = 0;
  const queue: { id: string; heading: string; depth: number }[] = [{ id: pageId, heading: '', depth: 0 }];
  while (queue.length && calls < budget) {
    const { id, heading, depth } = queue.shift()!;
    calls++;
    const blocks: Json[] = await notion.children(id, 1);
    for (const b of blocks) {
      const type: string = b.type;
      if (type === 'table') {
        if (calls >= budget) break;
        calls++;
        const rows: Json[] = await notion.children(b.id, 1);
        tables.push({
          heading,
          rows: rows.filter((r) => r.type === 'table_row').map((r) => r.table_row.cells.map((c: Json[]) => plain(c))),
        });
        continue;
      }
      if (!CONTAINERS.has(type) || depth >= 4) continue;
      const h = type.startsWith('heading_') ? plain(b[type]?.rich_text) : heading;
      if (type === 'synced_block' && b.synced_block?.synced_from?.block_id) {
        queue.push({ id: b.synced_block.synced_from.block_id, heading: h, depth: depth + 1 });
      } else if (b.has_children) {
        queue.push({ id: b.id, heading: h, depth: depth + 1 });
      }
    }
  }
  return tables;
}

const KEY = (habitId: string) => `matrix:${habitId}`;
const TTL = 7 * 24 * 3600;

export async function getCachedMatrices(kv: KVNamespace, habitIds: string[]): Promise<Record<string, Matrix>> {
  const out: Record<string, Matrix> = {};
  await Promise.all(
    [...new Set(habitIds)].map(async (id) => {
      const m = await kv.get<Matrix>(KEY(id), 'json');
      if (m) out[id] = m;
    }),
  );
  return out;
}

/**
 * Lee de Notion la Matriz de hasta `max` hábitos que aún no estén en caché.
 * `samples` asocia cada hábito con una de sus filas diarias (que contiene el bloque sincronizado).
 */
export async function refreshMatrices(
  kv: KVNamespace,
  notion: Notion,
  samples: { habitId: string; pageId: string }[],
  cached: Record<string, Matrix>,
  max = 2,
): Promise<Record<string, Matrix>> {
  const out = { ...cached };
  const faltan = samples.filter((s) => !out[s.habitId]).slice(0, max);
  for (const s of faltan) {
    try {
      const m = parseMatrix(await collectTables(notion, s.pageId));
      out[s.habitId] = m;
      // Una matriz vacía también se cachea (más corto) para no releerla en cada ejecución.
      await kv.put(KEY(s.habitId), JSON.stringify(m), { expirationTtl: isEmptyMatrix(m) ? 86400 : TTL });
    } catch (e) {
      console.error('matriz', s.habitId, e);
    }
  }
  return out;
}

export async function clearMatrices(kv: KVNamespace, habitIds: string[]): Promise<void> {
  await Promise.all([...new Set(habitIds)].map((id) => kv.delete(KEY(id))));
}

export function senalesDe(matrices: Record<string, Matrix>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, m] of Object.entries(matrices)) if (m.senal) out[id] = m.senal;
  return out;
}
