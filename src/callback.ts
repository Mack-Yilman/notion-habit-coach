// callback_data de los botones de Telegram (máximo 64 bytes).
//   e:<pageId sin guiones>:<código de estado>  → registra ese estado
//   i:<pageId sin guiones>                     → botón de número: muestra el nombre del hábito

import { ESTADO_BY_CODE, ESTADO_BY_KEY, type EstadoKey } from './config';

export type Callback = { kind: 'estado'; pageId: string; estado: EstadoKey } | { kind: 'info'; pageId: string };

export function compactId(id: string): string {
  return id.replace(/-/g, '');
}

export function encodeEstado(pageId: string, estado: EstadoKey): string {
  return `e:${compactId(pageId)}:${ESTADO_BY_KEY[estado].code}`;
}

export function encodeInfo(pageId: string): string {
  return `i:${compactId(pageId)}`;
}

export function decodeCallback(data: string | undefined): Callback | null {
  const info = (data ?? '').match(/^i:([0-9a-f]{32})$/);
  if (info) return { kind: 'info', pageId: info[1]! };
  const m = (data ?? '').match(/^e:([0-9a-f]{32}):([a-z])$/);
  if (!m) return null;
  const def = ESTADO_BY_CODE[m[2]!];
  if (!def) return null;
  return { kind: 'estado', pageId: m[1]!, estado: def.key };
}
