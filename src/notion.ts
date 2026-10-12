// Cliente mínimo de la API pública de Notion (con fuentes de datos, 2025-09-03).

export const NOTION_VERSION = '2025-09-03';
const BASE = 'https://api.notion.com/v1';

export class NotionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Notion ${status} ${code}: ${message}`);
  }
}

type FetchFn = typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export class Notion {
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly token: string,
    fetchFn?: FetchFn,
  ) {
    // En Workers, guardar `fetch` sin envolver da «Illegal invocation».
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  async req(method: string, path: string, body?: unknown, attempt = 0): Promise<Json> {
    const res = await this.fetchFn(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? '1'), 3);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.req(method, path, body, attempt + 1);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new NotionError(res.status, data.code ?? 'error', data.message ?? text.slice(0, 200));
    return data;
  }

  getDataSource(id: string) {
    return this.req('GET', `/data_sources/${id}`);
  }

  updateDataSource(id: string, body: unknown) {
    return this.req('PATCH', `/data_sources/${id}`, body);
  }

  /** Consulta paginada; `maxPages` limita las subrequests (el plan gratuito permite 50). */
  async queryAll(id: string, body: Record<string, unknown> = {}, maxPages = 5): Promise<Json[]> {
    const out: Json[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const data = await this.req('POST', `/data_sources/${id}/query`, {
        ...body,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      out.push(...data.results);
      if (!data.has_more) break;
      cursor = data.next_cursor;
    }
    return out;
  }

  getPage(id: string) {
    return this.req('GET', `/pages/${id}`);
  }

  updatePage(id: string, properties: Record<string, unknown>) {
    return this.req('PATCH', `/pages/${id}`, { properties });
  }

  async children(blockId: string, maxPages = 2): Promise<Json[]> {
    const out: Json[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const q = `?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
      const data = await this.req('GET', `/blocks/${blockId}/children${q}`);
      out.push(...data.results);
      if (!data.has_more) break;
      cursor = data.next_cursor;
    }
    return out;
  }
}

export function plain(rich: Json[] | undefined): string {
  return (rich ?? []).map((t: Json) => t.plain_text ?? '').join('').trim();
}
