import type { Env, TgUpdate } from "./types";
import { handleAdmin } from "./admin";
import { handleUpdate } from "./bot";
import { reconcileDonations, reconcileSessions } from "./db";
import {
  checkWebhook,
  ensureBotProfile,
  health,
  manualRepair,
  rememberWebhookUrl,
} from "./health";
import { handlePaymentWebhook } from "./webhooks";
import { errorMessage, json, text } from "./util";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return text("Donate to me bot is running.");
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return health(env);
    }
    if (url.pathname === "/telegram/repair") {
      return manualRepair(request, env);
    }
    if (url.pathname === "/admin/reconcile") {
      return adminReconcile(request, env);
    }

    // Admin dashboard: OIDC login, read-only analytics API, and the built
    // React app. Legacy /admin/reconcile above stays secret-based.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, ctx);
    }

    // Signed payment events from the payment provider.
    if (request.method === "POST" && url.pathname === "/webhooks/payments") {
      return handlePaymentWebhook(request, env, ctx);
    }

    // Telegram (and uptime checks) may probe the webhook URL with a GET before
    // registering it. Answer 200 instead of 404 so registration never fails.
    if (request.method === "GET" && url.pathname === "/telegram/webhook") {
      return text("ok");
    }
    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") {
      return text("Not found", 404);
    }
    if (
      !env.TELEGRAM_WEBHOOK_SECRET ||
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return text("Unauthorized", 401);
    }
    if (
      !env.JAMI_TOKEN ||
      !env.JAMI_PRODUCT_ID ||
      env.JAMI_PRODUCT_ID.startsWith("REPLACE_")
    ) {
      return text("Payment setup incomplete", 503);
    }

    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return text("Bad JSON", 400);
    }

    // Acknowledge Telegram immediately. Slow work (payment API, Telegram
    // sends) runs in the background: if the handler took longer than
    // Telegram's timeout, the same update would be retried over and over and
    // the bot would look dead.
    ctx.waitUntil(rememberWebhookUrl(env, url));
    ctx.waitUntil(handleUpdate(update, env, url.origin));

    return text("ok");
  },

  // Watchdog: every 15 minutes, verify Telegram still has our webhook and
  // re-register it when it was dropped, moved, or rejected our secret. The
  // same run reconciles donations and refreshes the bot profile.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      checkWebhook(env, { repair: true }).catch((error) =>
        console.error("Webhook watchdog failed", errorMessage(error)),
      ),
    );
    ctx.waitUntil(
      ensureBotProfile(env).catch((error) =>
        console.error("Bot profile update failed", errorMessage(error)),
      ),
    );
    ctx.waitUntil(
      reconcileDonations(env).catch((error) =>
        console.error("Donation reconciliation failed", errorMessage(error)),
      ),
    );
    ctx.waitUntil(
      reconcileSessions(env)
        .then((summary) => {
          if (summary.completed || summary.expired || summary.errors.length) {
            console.log("Session reconciliation", JSON.stringify(summary));
          }
        })
        .catch((error) =>
          console.error("Session reconciliation failed", errorMessage(error)),
        ),
    );
  },
};

/**
 * POST /admin/reconcile
 * Backfills donations from KV sessions and pending donation rows. Protected by
 * ADMIN_SECRET (or the Telegram webhook secret).
 */
async function adminReconcile(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return text("Method not allowed", 405);
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  const expected = env.ADMIN_SECRET || env.TELEGRAM_WEBHOOK_SECRET || "";
  if (!expected || provided !== expected) return text("Unauthorized", 401);

  try {
    const sessions = await reconcileSessions(env);
    await reconcileDonations(env);
    return json({ ok: true, sessions });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
}
