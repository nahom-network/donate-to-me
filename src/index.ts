import { Jami } from "jami-sdk";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  JAMI_TOKEN: string;
  JAMI_PRODUCT_ID: string;
  DONATION_AMOUNTS?: string;
  /** Optional public webhook URL, used by the watchdog to verify/re-register the webhook. */
  WEBHOOK_URL?: string;
  SESSIONS: KVNamespace;
}

type TgUser = { id: number; first_name?: string; username?: string };
type TgMessage = { chat: { id: number }; from?: TgUser; text?: string };
type TgCallback = { id: string; data?: string; from: TgUser; message?: { chat: { id: number } } };
type TgUpdate = { update_id?: number; message?: TgMessage; callback_query?: TgCallback };
type Session = { sessionId: string; amountMinor: number; createdAt: number };
type TelegramResult<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};
type WebhookInfo = {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
};

const GATEWAYS = ["telebirr", "mpesa", "cbe"] as const;
const DEFAULT_AMOUNTS = "50,100,250,500";
const WEBHOOK_URL_KEY = "tg:webhook-url";
const UPDATE_DEDUPE_TTL_SECONDS = 600;
const TELEGRAM_TIMEOUT_MS = 8_000;
const JAMI_TIMEOUT_MS = 15_000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return text("Jami Telegram donation bot is running.");
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return health(env);
    }
    if (url.pathname === "/telegram/repair") {
      return manualRepair(request, env);
    }

    // Telegram (and uptime checks) may probe the webhook URL with a GET before
    // registering it. Answer 200 instead of 404 so registration never fails.
    if (request.method === "GET" && url.pathname === "/telegram/webhook") {
      return text("ok");
    }
    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") {
      return text("Not found", 404);
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return text("Unauthorized", 401);
    }
    if (!env.JAMI_TOKEN || !env.JAMI_PRODUCT_ID || env.JAMI_PRODUCT_ID.startsWith("REPLACE_")) {
      return text("Payment setup incomplete", 503);
    }

    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return text("Bad JSON", 400);
    }

    // Acknowledge Telegram immediately. Slow work (Jami, Telegram sends) runs in
    // the background: if the handler took longer than Telegram's timeout, the
    // same update would be retried over and over and the bot would look dead.
    ctx.waitUntil(rememberWebhookUrl(env, url));
    ctx.waitUntil(handleUpdate(update, env));

    return text("ok");
  },

  // Watchdog: every 15 minutes, verify Telegram still has our webhook and
  // re-register it when it was dropped, moved, or rejected our secret.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      checkWebhook(env, { repair: true }).catch(error =>
        console.error("Webhook watchdog failed", errorMessage(error))),
    );
  },
};

async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  try {
    if (update.update_id !== undefined && !(await claimUpdate(env, update.update_id))) return;
    if (update.callback_query) await onCallback(update.callback_query, env);
    else if (update.message) await onMessage(update.message, env);
  } catch (error) {
    console.error(
      "Update processing failed",
      JSON.stringify({ updateId: update.update_id, error: errorMessage(error) }),
    );
    const chatId = update.callback_query?.message?.chat.id ?? update.message?.chat.id;
    if (!chatId) return;
    // Never let a failed notification escape: that would make the Worker return
    // 500 and trigger another Telegram retry for the same update.
    try {
      await sendMessage(env, chatId, "I couldn’t finish that request. Please send /donate and try again.");
    } catch (notifyError) {
      console.error("Could not notify user", errorMessage(notifyError));
    }
  }
}

async function onMessage(message: TgMessage, env: Env) {
  const messageText = message.text?.trim() ?? "";
  const name = message.from?.first_name ? `, ${escapeHtml(message.from.first_name)}` : "";
  const command = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/i.exec(messageText)?.[1]?.toLowerCase();

  if (command === "start" || command === "donate") {
    await sendMessage(env, message.chat.id,
      `Selam${name}! You can support me with a secure Jami checkout. Choose a donation amount in ETB:`,
      amountKeyboard(env));
  } else if (command === "status") {
    await showStatus(message.chat.id, message.from?.id, env);
  } else if (command === "help") {
    await sendMessage(env, message.chat.id, "Use /donate to choose an amount and payment method, or /status to check your latest checkout.");
  } else {
    await sendMessage(env, message.chat.id, "Send /donate to support me, or /status to check your latest checkout.");
  }
}

function amountKeyboard(env: Env) {
  let amounts = (env.DONATION_AMOUNTS || DEFAULT_AMOUNTS).split(",")
    .map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n >= 1 && n <= 100000);
  if (amounts.length === 0) amounts = DEFAULT_AMOUNTS.split(",").map(Number);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < amounts.length; i += 2) {
    rows.push(amounts.slice(i, i + 2).map(amount => ({ text: `${amount} ETB`, callback_data: `amount:${amount}` })));
  }
  return { inline_keyboard: rows };
}

async function onCallback(query: TgCallback, env: Env) {
  const chatId = query.message?.chat.id;
  // Answering an old button can fail ("query is too old"); that must not stop
  // the rest of the checkout flow.
  await answerCallback(env, query.id);
  if (!chatId || !query.data) return;

  const amountMatch = /^amount:(\d{1,6})$/.exec(query.data);
  if (amountMatch) {
    const amount = Number(amountMatch[1]);
    if (amount < 1 || amount > 100000) return sendMessage(env, chatId, "That amount isn’t available.");
    const rows = GATEWAYS.map(gateway => [{ text: gatewayLabel(gateway), callback_data: `gateway:${amount}:${gateway}` }]);
    return sendMessage(env, chatId, `You chose ${formatEtb(amount)}. Select how you’d like to pay:`, { inline_keyboard: rows });
  }

  const checkoutMatch = /^gateway:(\d{1,6}):(telebirr|mpesa|cbe)$/.exec(query.data);
  if (!checkoutMatch) {
    return sendMessage(env, chatId, "That button is out of date. Send /donate to start a fresh checkout.");
  }

  const amount = Number(checkoutMatch[1]);
  const gateway = checkoutMatch[2] as typeof GATEWAYS[number];
  const jami = jamiClient(env);
  const checkout = await jami.createCheckout({
    productId: env.JAMI_PRODUCT_ID,
    amount: amount * 100,
    // Jami requires an email on the customer record. Telegram users don't have
    // one here, so use a stable per-user placeholder (example.com is reserved).
    customer: { email: `tg${query.from.id}@example.com`, externalId: String(query.from.id) },
    gateway,
  });

  if ("orderId" in checkout) {
    await sendMessage(env, chatId, `Thank you! Your ${formatEtb(amount)} donation was completed. Reference: ${checkout.orderId}`);
    return;
  }
  const key = sessionKey(query.from.id);
  await env.SESSIONS.put(key, JSON.stringify({ sessionId: checkout.sessionId, amountMinor: amount * 100, createdAt: Date.now() } satisfies Session), { expirationTtl: 86400 });
  if (checkout.mode === "redirect" && checkout.checkoutUrl) {
    await sendMessage(env, chatId, `Your ${formatEtb(amount)} donation checkout is ready. Complete payment on the secure Jami page, then use /status here.`, {
      inline_keyboard: [[{ text: "Open secure checkout", url: checkout.checkoutUrl }]],
    });
  } else {
    await sendMessage(env, chatId, `Approve the ${formatEtb(amount)} request on your phone. Use /status here when you’re done.`);
  }
}

async function showStatus(chatId: number, userId: number | undefined, env: Env) {
  if (!userId) return sendMessage(env, chatId, "I couldn’t identify this Telegram account. Start a new checkout with /donate.");
  const raw = await env.SESSIONS.get(sessionKey(userId));
  if (!raw) return sendMessage(env, chatId, "You don’t have a recent checkout to check. Send /donate to start one.");

  let session: Session;
  try {
    session = JSON.parse(raw) as Session;
  } catch {
    return sendMessage(env, chatId, "I couldn’t read your last checkout. Send /donate to start a new one.");
  }
  if (Date.now() - session.createdAt > 86400000) return sendMessage(env, chatId, "That checkout has expired. Send /donate to start a new one.");

  const jami = jamiClient(env);
  const status = await jami.getCheckoutStatus(session.sessionId);
  if (status.status === "completed") {
    await sendMessage(env, chatId, `Payment received — thank you for donating ${formatEtb(session.amountMinor / 100)}!`);
  } else if (status.status === "expired") {
    const reason = status.failure?.message ? ` (${escapeHtml(status.failure.message)})` : "";
    await sendMessage(env, chatId, `That checkout expired${reason}. Send /donate to create a new one.`);
  } else {
    await sendMessage(env, chatId, `Your ${formatEtb(session.amountMinor / 100)} checkout is still ${status.status}. Finish payment, then check again with /status.`);
  }
}

// --- Telegram webhook health ------------------------------------------------

async function health(env: Env): Promise<Response> {
  const config = {
    webhookSecretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
    jamiTokenConfigured: Boolean(env.JAMI_TOKEN),
    productConfigured: Boolean(env.JAMI_PRODUCT_ID) && !env.JAMI_PRODUCT_ID.startsWith("REPLACE_"),
  };
  const missing = Object.entries(config).filter(([, ok]) => !ok).map(([name]) => name);

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
    const rateLimited = (info.pending_update_count ?? 0) > 50 ? "large backlog of unprocessed updates" : undefined;
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
    return json({
      status: missing.length ? "misconfigured" : "error",
      error: errorMessage(error),
      missingConfig: missing,
      config,
    }, 503);
  }
}

async function manualRepair(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return text("Method not allowed", 405);
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return text("Unauthorized", 401);
  }
  try {
    const dropPending = new URL(request.url).searchParams.get("drop") === "1";
    return json(await checkWebhook(env, { repair: true, dropPending }));
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
}

async function checkWebhook(env: Env, options: { repair: boolean; dropPending?: boolean }) {
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
    return { ...summary, repaired: false, reason: "webhook URL unknown; set WEBHOOK_URL or receive one update first" };
  }

  const moved = normalizeUrl(info.url) !== normalizeUrl(desired);
  // A previously failed delivery with 401/403/404 usually means the secret or
  // URL got out of sync, which re-registering fixes.
  const rejected = /unauthorized|forbidden|not found|40[134]/i.test(info.last_error_message ?? "");
  if (!moved && !rejected) return { ...summary, repaired: false };

  await setWebhook(env, desired, options.dropPending ?? false);
  console.log("Re-registered Telegram webhook", JSON.stringify({
    from: info.url, to: desired, lastError: info.last_error_message ?? null,
  }));
  return { ...summary, registeredUrl: desired, repaired: true };
}

async function setWebhook(env: Env, url: string, dropPending: boolean) {
  const body: Record<string, unknown> = {
    url,
    allowed_updates: ["message", "callback_query"],
    max_connections: 40,
    drop_pending_updates: dropPending,
  };
  if (env.TELEGRAM_WEBHOOK_SECRET) body.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
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
  } catch { /* fall through to the warning */ }
  console.warn("Ignoring WEBHOOK_URL: expected an absolute URL ending in /telegram/webhook");
  return "";
}

function normalizeUrl(value: string) { return value.replace(/\/+$/, ""); }

// Remember the URL Telegram actually calls, so the watchdog can restore it
// without any extra configuration.
async function rememberWebhookUrl(env: Env, url: URL): Promise<void> {
  if (configuredWebhookUrl(env)) return;
  try {
    const href = `${url.origin}${url.pathname}`;
    if ((await env.SESSIONS.get(WEBHOOK_URL_KEY)) === href) return;
    await env.SESSIONS.put(WEBHOOK_URL_KEY, href);
  } catch (error) {
    console.warn("Could not remember webhook URL", errorMessage(error));
  }
}

// Best-effort duplicate suppression: Telegram retries an update when it does
// not receive a fast 200, and a retry must not create a second checkout.
async function claimUpdate(env: Env, updateId: number): Promise<boolean> {
  const key = `tg:update:${updateId}`;
  try {
    if (await env.SESSIONS.get(key)) return false;
    await env.SESSIONS.put(key, "1", { expirationTtl: UPDATE_DEDUPE_TTL_SECONDS });
    return true;
  } catch {
    return true;
  }
}

// --- Clients -----------------------------------------------------------------

function jamiClient(env: Env): Jami {
  const timedFetch: typeof fetch = (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetchWithTimeout(href, init ?? {}, JAMI_TIMEOUT_MS);
  };
  return new Jami({ token: env.JAMI_TOKEN, fetch: timedFetch });
}

async function telegram<T = unknown>(env: Env, method: string, body: Record<string, unknown>): Promise<T> {
  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  let lastError = new Error(`Telegram ${method} failed`);

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    let data: TelegramResult<T> | null;
    try {
      response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, TELEGRAM_TIMEOUT_MS);
      data = (await response.json().catch(() => null)) as TelegramResult<T> | null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(300 * (attempt + 1));
      continue;
    }

    if (response.ok && data?.ok) return data.result as T;

    const code = data?.error_code ?? response.status;
    lastError = new Error(`Telegram ${method} failed: ${code} ${data?.description ?? response.statusText}`);
    if (code === 429) {
      await sleep(Math.min(data?.parameters?.retry_after ?? 1, 5) * 1000);
      continue;
    }
    if (code >= 500) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    throw lastError;
  }

  throw lastError;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Helpers -----------------------------------------------------------------

function sessionKey(userId: number) { return `tg:${userId}:latest`; }
function gatewayLabel(gateway: string) { return ({ telebirr: "Telebirr", mpesa: "M-Pesa", cbe: "CBE Birr" } as Record<string, string>)[gateway] ?? gateway; }
function formatEtb(amount: number) { return `${amount.toLocaleString("en-US")} ETB`; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function text(body: string, status = 200) { return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } }); }
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }

async function sendMessage(env: Env, chatId: number, text: string, replyMarkup?: unknown) {
  await telegram(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}
async function answerCallback(env: Env, callbackQueryId: string) {
  try {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  } catch (error) {
    console.warn("Could not answer callback query", errorMessage(error));
  }
}
