import { handleTelegramCallback, handleTelegramMessage } from "./modules/glance";
import { verifyWebhookAuth } from "./security";
import type { RuntimeEnv, TelegramUpdate } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const runtimeEnv = env as RuntimeEnv;
    const url = new URL(request.url);

    // Health check endpoint
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({
        ok: true,
        service: "vector-bot",
        module: "glance-cms",
        firebaseProjectId: runtimeEnv.FIREBASE_PROJECT_ID,
        configured: Boolean(
          runtimeEnv.TELEGRAM_BOT_TOKEN &&
            runtimeEnv.TELEGRAM_WEBHOOK_SECRET &&
            runtimeEnv.ALLOWED_TELEGRAM_USER_ID &&
            runtimeEnv.GEMINI_API_KEY &&
            runtimeEnv.FIREBASE_CLIENT_EMAIL &&
            runtimeEnv.FIREBASE_PRIVATE_KEY,
        ),
      });
    }

    // Telegram Webhook endpoint
    if (request.method === "POST" && url.pathname === "/webhook") {
      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON payload" }, { status: 400 });
      }

      const auth = await verifyWebhookAuth(request, update, runtimeEnv);
      if (!auth.authorized) {
        console.error(
          JSON.stringify({
            message: "webhook_auth_rejected",
            reason: auth.reason,
            userId: auth.userId ?? null,
          }),
        );
        if (auth.reason === "invalid_webhook_secret_header") {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }
        return Response.json({ ok: true, ignored: true });
      }

      console.log(
        JSON.stringify({
          message: "webhook_update_accepted",
          updateId: update.update_id,
          type: update.message ? "message" : update.callback_query ? "callback_query" : "other",
        }),
      );

      if (update.message) {
        ctx.waitUntil(handleTelegramMessage(runtimeEnv, update.message, auth.userId!));
      } else if (update.callback_query) {
        ctx.waitUntil(handleTelegramCallback(runtimeEnv, update.callback_query, auth.userId!));
      }

      return Response.json({ ok: true });
    }

    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
