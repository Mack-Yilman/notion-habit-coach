// callback_data de los botones de Telegram (máximo 64 bytes).
// Formato: e:<pageId sin guiones>:<código de estado>

import { ESTADO_BY_CODE, ESTADO_BY_KEY, type EstadoKey } from './config';

export type Callback = { kind: 'estado'; pageId: string; estado: EstadoKey };

export function compactId(id: string): string {
  return id.replace(/-/g, '');
}

export function encodeEstado(pageId: string, estado: EstadoKey): string {
  return `e:${compactId(pageId)}:${ESTADO_BY_KEY[estado].code}`;
}

export function decodeCallback(data: string | undefined): Callback | null {
  const m = (data ?? '').match(/^e:([0-9a-f]{32}):([a-z])$/);
  if (!m) return null;
  const def = ESTADO_BY_CODE[m[2]!];
  if (!def) return null;
  return { kind: 'estado', pageId: m[1]!, estado: def.key };
}
