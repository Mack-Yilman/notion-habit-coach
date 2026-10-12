// Los bindings y vars vienen de `npx wrangler types` (worker-configuration.d.ts).
// Vuelve a generarlo cada vez que cambies wrangler.jsonc. Aquí solo se declaran
// los secretos, que se suben con `wrangler secret` y no aparecen en la config.

export interface Secrets {
  NOTION_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_CHAT_ID: string;
  /** Clave del proveedor compatible con OpenAI (DeepSeek por defecto). Opcional. */
  LLM_API_KEY?: string;
  /** Protege /admin/run. Opcional: sin él, el endpoint queda desactivado. */
  ADMIN_SECRET?: string;
}

export type Env = Cloudflare.Env & Secrets;
