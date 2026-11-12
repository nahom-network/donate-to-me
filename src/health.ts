import type { Env, WebhookInfo } from "./types";
import {
  BOT_PROFILE_CACHE_KEY,
  WEBHOOK_ERROR_GRACE_SECONDS,
  WEBHOOK_URL_KEY,
} from "./constants";
import { telegram } from "./telegram";
import { errorMessage, json, normalizeUrl, text } from "./util";

/** Register the command menu and profile text, at most once a day. */
export async function ensureBotProfile(env: Env): Promise<void> {
  try {
    if (await env.SESSIONS.get(BOT_PROFILE_CACHE_KEY)) return;
  } catch {
    /* fall through and update anyway */
  }

  await telegram(env, "setMyCommands", {
    commands: [
      { command: "donate", description: "Choose a donation amount" },
      { command: "status", description: "Check your latest checkout" },
      { command: "halloffame", description: "Top 3 donors" },
      { command: "help", description: "How donations work" },
      { command: "cancel", description: "Cancel the current donation" },
    ],
  });
  await telegram(env, "setMyDescription", {
    description:
      "Support me with a secure donation. Choose an amount and pay with Telebirr, M-Pesa, or CBE Birr.",
  });
  await telegram(env, "setMyShortDescription", {
    short_description: "Donate securely with Telebirr, M-Pesa, or CBE Birr.",
  });

  try {
    await env.SESSIONS.put(BOT_PROFILE_CACHE_KEY, "1", {
      expirationTtl: 86400,
    });
  } catch {
    /* not fatal: it just retries on the next run */
  }
}

/** Update types the bot needs. Widget taps arrive as `widget_query`. */
const REQUIRED_UPDATE_TYPES = [
  "message",
  "callback_query",
  "widget_query",
] as const;

/**
 * Update types the registered webhook is missing. Telegram returns an empty
 * (or absent) list when it delivers everything, which is fine.
 */
function missingUpdateTypes(allowed: string[] | undefined): string[] {
  if (!allowed || allowed.length === 0) return [];
  return REQUIRED_UPDATE_TYPES.filter((type) => !allowed.includes(type));
}

export async function health(env: Env): Promise<Response> {
  const required = {
    webhookSecretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
    paymentTokenConfigured: Boolean(env.JAMI_TOKEN),
    productConfigured:
      Boolean(env.JAMI_PRODUCT_ID) &&
      !env.JAMI_PRODUCT_ID.startsWith("REPLACE_"),
    databaseConfigured: Boolean(env.DB),
  };
  const config = {
    ...required,
    paymentWebhookSecretConfigured: Boolean(env.JAMI_WEBHOOK_SECRET),
  };
  const missing = Object.entries(required)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  try {
    const info = await telegram<WebhookInfo>(env, "getWebhookInfo", {});
    const desired = await desiredWebhookUrl(env);
    const pending = info.pending_update_count ?? 0;
    const staleUpdates = missingUpdateTypes(info.allowed_updates);
    // Telegram keeps last_error_message after deliveries recover, so only call
    // it a problem while updates are actually stuck in the queue. If they were
    // piling up, the message is current even when its timestamp is older.
    const problem = !info.url
      ? "no webhook registered"
      : desired && info.url !== desired
        ? "webhook points at a different URL"
        : staleUpdates.length
          ? `webhook is missing update types: ${staleUpdates.join(", ")}`
          : pending > 0 && info.last_error_message
            ? `last delivery failed: ${info.last_error_message}`
            : undefined;
    const rateLimited =
      pending > 50 ? "large backlog of unprocessed updates" : undefined;
    const status = missing.length
      ? "misconfigured"
      : problem || rateLimited
        ? "degraded"
        : "ok";

    return json({
      status,
      problem: problem ?? rateLimited ?? null,
      missingConfig: missing,
      config,
      webhook: {
        url: info.url,
        expectedUrl: desired || null,
        pendingUpdateCount: info.pending_update_count,
        allowedUpdates: info.allowed_updates ?? null,
        lastErrorDate: info.last_error_date ?? null,
        lastErrorMessage: info.last_error_message ?? null,
      },
    });
  } catch (error) {
    return json(
      {
        status: missing.length ? "misconfigured" : "error",
        error: errorMessage(error),
        missingConfig: missing,
        config,
      },
      503,
    );
  }
}

export async function manualRepair(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return text("Method not allowed", 405);
  if (
    !env.TELEGRAM_WEBHOOK_SECRET ||
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return text("Unauthorized", 401);
  }
  try {
    const dropPending = new URL(request.url).searchParams.get("drop") === "1";
    return json(await checkWebhook(env, { repair: true, dropPending }));
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
}

export async function checkWebhook(
  env: Env,
  options: { repair: boolean; dropPending?: boolean },
) {
  const info = await telegram<WebhookInfo>(env, "getWebhookInfo", {});
  const desired = await desiredWebhookUrl(env);
  const summary = {
    registeredUrl: info.url,
    expectedUrl: desired || null,
    pendingUpdateCount: info.pending_update_count,
    allowedUpdates: info.allowed_updates ?? null,
    lastErrorDate: info.last_error_date ?? null,
    lastErrorMessage: info.last_error_message ?? null,
  };

  if (!desired) {
    return {
      ...summary,
      repaired: false,
      reason:
        "webhook URL unknown; set WEBHOOK_URL or receive one update first",
    };
  }

  const moved = normalizeUrl(info.url) !== normalizeUrl(desired);
  // A previously failed delivery with 401/403/404 usually means the secret or
  // URL got out of sync, which re-registering fixes. Only recent failures
  // count: Telegram keeps the last error after deliveries recover, and
  // repairing on that stale text would re-register the webhook on every run.
  const rejected = /unauthorized|forbidden|not found|40[134]/i.test(
    recentWebhookError(info) ?? "",
  );
  // A webhook registered before a newer update type existed keeps delivering
  // only the old types, so widget taps would never reach the Worker. Repair it
  // like a moved webhook instead of waiting for a delivery error that never
  // comes.
  const staleUpdates = missingUpdateTypes(info.allowed_updates);
  if (!moved && !rejected && staleUpdates.length === 0) {
    return { ...summary, repaired: false };
  }

  await setWebhook(env, desired, options.dropPending ?? false);
  console.log(
    "Re-registered Telegram webhook",
    JSON.stringify({
      from: info.url,
      to: desired,
      lastError: info.last_error_message ?? null,
      missingUpdates: staleUpdates,
    }),
  );
  return { ...summary, registeredUrl: desired, repaired: true };
}

async function setWebhook(env: Env, url: string, dropPending: boolean) {
  const body: Record<string, unknown> = {
    url,
    max_connections: 40,
    drop_pending_updates: dropPending,
  };
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    body.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
  }
  try {
    await telegram(env, "setWebhook", {
      ...body,
      // widget_query (Bot API 10.4) carries every tap inside the amount
      // picker; without it in allowed_updates those taps are never delivered.
      allowed_updates: ["message", "callback_query", "widget_query"],
    });
  } catch (error) {
    // An API deployment that predates widgets rejects the unknown update type.
    // Losing every update is worse than losing widget taps, so retry without
    // it and let the inline-keyboard flow carry the donation.
    console.warn(
      "setWebhook rejected widget_query; registering the legacy update types",
      errorMessage(error),
    );
    await telegram(env, "setWebhook", {
      ...body,
      allowed_updates: ["message", "callback_query"],
    });
  }
}

async function desiredWebhookUrl(env: Env): Promise<string> {
  const configured = configuredWebhookUrl(env);
  if (configured) return configured;
  try {
    return ((await env.SESSIONS.get(WEBHOOK_URL_KEY)) ?? "").trim();
  } catch {
    return "";
  }
}

// A wrong WEBHOOK_URL would let the watchdog overwrite a working webhook with a
// broken one, so only accept an absolute URL that reaches this Worker's route.
function configuredWebhookUrl(env: Env): string {
  const configured = env.WEBHOOK_URL?.trim();
  if (!configured) return "";
  try {
    if (new URL(configured).pathname === "/telegram/webhook") return configured;
  } catch {
    /* fall through to the warning */
  }
  console.warn(
    "Ignoring WEBHOOK_URL: expected an absolute URL ending in /telegram/webhook",
  );
  return "";
}

// Remember the URL Telegram actually calls, so the watchdog can restore it
// without any extra configuration.
export async function rememberWebhookUrl(
  env: Env,
  url: URL,
): Promise<void> {
  if (configuredWebhookUrl(env)) return;
  try {
    const href = `${url.origin}${url.pathname}`;
    if ((await env.SESSIONS.get(WEBHOOK_URL_KEY)) === href) return;
    await env.SESSIONS.put(WEBHOOK_URL_KEY, href);
  } catch (error) {
    console.warn("Could not remember webhook URL", errorMessage(error));
  }
}

/**
 * The last delivery error, but only while it is recent. Telegram does not clear
 * `last_error_message` after deliveries start working again, so an unaged error
 * would make the watchdog re-register the webhook on every cron run.
 */
function recentWebhookError(info: WebhookInfo): string | null {
  const message = info.last_error_message;
  if (!message) return null;
  const at = info.last_error_date ?? 0;
  if (at > 0 && Date.now() / 1000 - at > WEBHOOK_ERROR_GRACE_SECONDS) {
    return null;
  }
  return message;
}
