// Cliente mínimo de la Bot API de Telegram.

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type Keyboard = InlineButton[][];

type FetchFn = typeof fetch;

export class TelegramError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${status}: ${description}`);
  }
}

export class Telegram {
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly token: string,
    fetchFn?: FetchFn,
  ) {
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(method: string, body: Record<string, unknown>, intento = 0): Promise<any> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
    if (!data.ok) {
      // Muchas tarjetas seguidas pueden toparse con el límite de envío del chat: se espera y
      // se reintenta una vez si la espera es corta.
      const espera = data.parameters?.retry_after;
      if (res.status === 429 && espera !== undefined && espera <= 5 && intento === 0) {
        await new Promise((r) => setTimeout(r, espera * 1000));
        return this.call(method, body, 1);
      }
      throw new TelegramError(res.status, data.description ?? 'error');
    }
    return data.result;
  }

  /** Envía en HTML; si Telegram no puede interpretar las etiquetas, reenvía como texto plano. */
  async send(chatId: string, text: string, keyboard?: Keyboard, opts: { silent?: boolean } = {}): Promise<{ message_id: number }> {
    const markup = keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
    const extra = { ...markup, ...(opts.silent ? { disable_notification: true } : {}) };
    try {
      return await this.call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...extra,
      });
    } catch (e) {
      if (e instanceof TelegramError && /parse entities/i.test(e.description)) {
        return this.call('sendMessage', { chat_id: chatId, text: stripTags(text), ...extra });
      }
      throw e;
    }
  }

  /** Borra un mensaje del bot. Si ya no existe o pasaron más de 48 h, no es un error. */
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    try {
      await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch (e) {
      if (e instanceof TelegramError) return;
      throw e;
    }
  }

  /** Quita los botones de un mensaje (p. ej. uno de una versión anterior del bot). */
  async clearKeyboard(chatId: string, messageId: number): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    } catch (e) {
      if (e instanceof TelegramError && /not modified/i.test(e.description)) return;
      throw e;
    }
  }

  async edit(chatId: string, messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    const base = { chat_id: chatId, message_id: messageId, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard ?? [] } };
    try {
      await this.call('editMessageText', { ...base, text, parse_mode: 'HTML' });
    } catch (e) {
      // Pulsar dos veces el mismo botón no es un error.
      if (e instanceof TelegramError && /not modified/i.test(e.description)) return;
      if (e instanceof TelegramError && /parse entities/i.test(e.description)) {
        await this.call('editMessageText', { ...base, text: stripTags(text) });
        return;
      }
      throw e;
    }
  }

  answerCallback(id: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }

  typing(chatId: string): Promise<unknown> {
    return this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Deja pasar solo las etiquetas que Telegram acepta y que el coach puede usar
 * (<b>, <i>, <u>, <s>, <code>), convierte **negritas** de Markdown y escapa el resto.
 */
export function sanitizeLlmHtml(raw: string): string {
  const allowed = /^<\/?(b|i|u|s|code)>$/i;
  const md = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|$|[.,;:!?])/g, '$1<i>$2</i>')
    .replace(/^#{1,6}\s+/gm, '')
    // Listas y párrafos HTML (Gemma los usa): Telegram no los acepta, se pasan a texto.
    .replace(/\s*<li\b[^>]*>\s*/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/?(ul|ol|p)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const parts = md.split(/(<[^>]*>)/g);
  const out = parts.map((p) => (p.startsWith('<') && allowed.test(p) ? p.toLowerCase() : esc(p))).join('');
  return balanceTags(out);
}

/** Cierra etiquetas abiertas y quita cierres huérfanos para que Telegram no rechace el mensaje. */
function balanceTags(html: string): string {
  const stack: string[] = [];
  const out = html.replace(/<(\/?)(b|i|u|s|code)>/g, (m, close: string, tag: string) => {
    if (!close) {
      stack.push(tag);
      return m;
    }
    const idx = stack.lastIndexOf(tag);
    if (idx === -1) return '';
    const toClose = stack.splice(idx);
    return toClose
      .reverse()
      .map((t) => `</${t}>`)
      .join('');
  });
  return out + stack.reverse().map((t) => `</${t}>`).join('');
}
