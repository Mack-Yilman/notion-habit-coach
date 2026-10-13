// callback_data de los botones de Telegram (máximo 64 bytes).
//   e:<pageId sin guiones>:<código de estado>  → registra ese nivel
//   u:<pageId sin guiones>                     → ↩️ deshacer: vuelve a ⚪ Sin iniciar

import { ESTADO_BY_CODE, ESTADO_BY_KEY, type EstadoKey } from './config';

export type Callback = { kind: 'estado'; pageId: string; estado: EstadoKey };

export function compactId(id: string): string {
  return id.replace(/-/g, '');
}

export function encodeEstado(pageId: string, estado: EstadoKey): string {
  return `e:${compactId(pageId)}:${ESTADO_BY_KEY[estado].code}`;
}

export function encodeDeshacer(pageId: string): string {
  return `u:${compactId(pageId)}`;
}

/** Deshacer es registrar «Sin iniciar»; por eso ambos se decodifican como `estado`. */
export function decodeCallback(data: string | undefined): Callback | null {
  const undo = (data ?? '').match(/^u:([0-9a-f]{32})$/);
  if (undo) return { kind: 'estado', pageId: undo[1]!, estado: 'sin_iniciar' };
  const m = (data ?? '').match(/^e:([0-9a-f]{32}):([a-z])$/);
  if (!m) return null;
  const def = ESTADO_BY_CODE[m[2]!];
  if (!def) return null;
  return { kind: 'estado', pageId: m[1]!, estado: def.key };
}
