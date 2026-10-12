// Punto de entrada del Worker: webhook de Telegram, endpoint de administración y cron.

import { makeApp, safeEqual } from './app';
import { handleUpdate } from './bot';
import type { Env } from './env';
import { runScheduled, runSlot } from './scheduler';
import { SLOTS, type SlotKey } from './schedule';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/telegram' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
      if (!(await safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))) return new Response('forbidden', { status: 403 });
      const update = await request.json();
      // Se responde 200 de inmediato; el trabajo sigue en segundo plano (Telegram no reintenta).
      ctx.waitUntil(
        handleUpdate(makeApp(env), update).catch((e) => console.error(JSON.stringify({ evento: 'update_error', error: String(e) }))),
      );
      return new Response('ok');
    }

    if (url.pathname === '/admin/run') {
      const secret = request.headers.get('x-admin-secret') ?? '';
      if (!env.ADMIN_SECRET || !(await safeEqual(secret, env.ADMIN_SECRET))) return new Response('forbidden', { status: 403 });
      const slot = url.searchParams.get('slot') as SlotKey | null;
      if (!slot || !(slot in SLOTS)) {
        return Response.json({ error: `slot inválido; usa uno de: ${Object.keys(SLOTS).join(', ')}` }, { status: 400 });
      }
      try {
        const resultado = await runSlot(makeApp(env), slot);
        return Response.json({ ok: true, slot, resultado });
      } catch (e) {
        return Response.json({ ok: false, slot, error: String(e) }, { status: 500 });
      }
    }

    return new Response('Habit Coach funcionando.');
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduled(makeApp(env, new Date(controller.scheduledTime))));
  },
} satisfies ExportedHandler<Env>;
