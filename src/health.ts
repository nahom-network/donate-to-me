import type { Env, WebhookInfo } from "./types";
import {
  BOT_PROFILE_CACHE_KEY,
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
    const problem = !info.url
      ? "no webhook registered"
      : desired && info.url !== desired
        ? "webhook points at a different URL"
        : info.last_error_message
          ? `last delivery failed: ${info.last_error_message}`
          : undefined;
    const rateLimited =
      (info.pending_update_count ?? 0) > 50
        ? "large backlog of unprocessed updates"
        : undefined;
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
  // URL got out of sync, which re-registering fixes.
  const rejected = /unauthorized|forbidden|not found|40[134]/i.test(
    info.last_error_message ?? "",
  );
  if (!moved && !rejected) return { ...summary, repaired: false };

  await setWebhook(env, desired, options.dropPending ?? false);
  console.log(
    "Re-registered Telegram webhook",
    JSON.stringify({
      from: info.url,
      to: desired,
      lastError: info.last_error_message ?? null,
    }),
  );
  return { ...summary, registeredUrl: desired, repaired: true };
}

async function setWebhook(env: Env, url: string, dropPending: boolean) {
  const body: Record<string, unknown> = {
    url,
    allowed_updates: ["message", "callback_query"],
    max_connections: 40,
    drop_pending_updates: dropPending,
  };
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    body.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
  }
  await telegram(env, "setWebhook", body);
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
