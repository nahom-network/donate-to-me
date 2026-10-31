import { Jami as PaymentClient, type CheckoutResult } from "jami-sdk";

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
type TgChat = { id: number; type?: string };
type TgContact = {
  phone_number: string;
  user_id?: number;
  first_name?: string;
};
type TgMessage = {
  chat: TgChat;
  from?: TgUser;
  text?: string;
  contact?: TgContact;
};
type TgCallback = {
  id: string;
  data?: string;
  from: TgUser;
  message?: { chat: TgChat };
};
type TgUpdate = {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TgCallback;
};
type Gateway = "telebirr" | "mpesa" | "cbe";
type ButtonStyle = "primary" | "success" | "danger";
type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  style?: ButtonStyle;
};
type Session = { sessionId: string; amountMinor: number; createdAt: number };
/** A gateway was chosen; we still need the payer's phone number. */
type PendingCheckout = {
  amount: number;
  gateway: Gateway;
  createdAt: number;
};
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
const PENDING_TTL_SECONDS = 15 * 60;
const BOT_PROFILE_CACHE_KEY = "tg:bot-profile:v1";
const TELEGRAM_TIMEOUT_MS = 8_000;
const JAMI_TIMEOUT_MS = 15_000;

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
    ctx.waitUntil(handleUpdate(update, env));

    return text("ok");
  },

  // Watchdog: every 15 minutes, verify Telegram still has our webhook and
  // re-register it when it was dropped, moved, or rejected our secret.
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
  },
};

async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  try {
    if (
      update.update_id !== undefined &&
      !(await claimUpdate(env, update.update_id))
    )
      return;
    if (update.callback_query) await onCallback(update.callback_query, env);
    else if (update.message) await onMessage(update.message, env);
  } catch (error) {
    console.error(
      "Update processing failed",
      JSON.stringify({
        updateId: update.update_id,
        error: errorMessage(error),
      }),
    );
    const chatId =
      update.callback_query?.message?.chat.id ?? update.message?.chat.id;
    if (!chatId) return;
    // Never let a failed notification escape: that would make the Worker return
    // 500 and trigger another Telegram retry for the same update.
    try {
      await sendMessage(
        env,
        chatId,
        "I couldn’t finish that request. Please send /donate and try again.",
      );
    } catch (notifyError) {
      console.error("Could not notify user", errorMessage(notifyError));
    }
  }
}

async function onMessage(message: TgMessage, env: Env) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const messageText = message.text?.trim() ?? "";
  const name = message.from?.first_name
    ? `, ${escapeHtml(message.from.first_name)}`
    : "";

  // Phone sharing and reply keyboards only work in a direct chat.
  if (message.chat.type && message.chat.type !== "private") {
    return sendMessage(
      env,
      chatId,
      "I can only take donations in a private chat. Open a direct chat with me and send /donate.",
    );
  }

  if (message.contact) return handleContact(message, env);

  const command = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/i
    .exec(messageText)?.[1]
    ?.toLowerCase();

  if (command === "cancel" || messageText.toLowerCase() === "cancel") {
    return cancelDonation(env, chatId, userId);
  }

  if (command === "start" || command === "donate") {
    if (userId) await clearPending(env, userId);
    return sendMessage(
      env,
      chatId,
      `Selam${name}! You can support me with a secure checkout. Choose a donation amount in ETB:`,
      amountKeyboard(env),
    );
  }
  if (command === "status") {
    return showStatus(chatId, userId, env);
  }
  if (command === "help") {
    return sendMessage(
      env,
      chatId,
      "Use /donate to pick an amount and payment method. Next, share the mobile number registered with your Telebirr, M-Pesa, or CBE Birr account so the payment request can be sent. Use /status to check the result, or /cancel to stop.",
    );
  }

  // While a checkout is waiting for a phone number, a plain message is the
  // number (or a typo).
  if (userId) {
    const pending = await getPending(env, userId);
    if (pending) {
      const phone = normalizeEthiopianPhone(messageText, pending.gateway);
      if (phone) return completeCheckout(env, chatId, userId, pending, phone);
      return sendMessage(
        env,
        chatId,
        `That doesn’t look like ${phoneHint(pending.gateway)}. Send it like <code>${phoneExample(pending.gateway)}</code>, or tap the <b>Share my phone number</b> button.`,
        phoneKeyboard(pending.gateway),
      );
    }
  }

  return sendMessage(
    env,
    chatId,
    "Send /donate to support me, or /status to check your latest checkout.",
  );
}

function amountKeyboard(env: Env) {
  let amounts = (env.DONATION_AMOUNTS || DEFAULT_AMOUNTS)
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 100000);
  if (amounts.length === 0) amounts = DEFAULT_AMOUNTS.split(",").map(Number);
  const rows: InlineButton[][] = [];
  for (let i = 0; i < amounts.length; i += 2) {
    rows.push(
      amounts.slice(i, i + 2).map((amount) => ({
        text: `${amount} ETB`,
        callback_data: `amount:${amount}`,
        style: "primary",
      })),
    );
  }
  rows.push([{ text: "Cancel", callback_data: "cancel", style: "danger" }]);
  return { inline_keyboard: rows };
}

async function onCallback(query: TgCallback, env: Env) {
  const chatId = query.message?.chat.id;
  // Answering an old button can fail ("query is too old"); that must not stop
  // the rest of the checkout flow.
  await answerCallback(env, query.id);
  if (!chatId || !query.data) return;

  // Inline keyboards exist in groups, but the phone step needs a private chat.
  const chatType = query.message?.chat.type;
  if (chatType && chatType !== "private") {
    return sendMessage(
      env,
      chatId,
      "I can only take donations in a private chat. Open a direct chat with me and send /donate.",
    );
  }

  const userId = query.from.id;

  if (query.data === "cancel") {
    await clearPending(env, userId);
    return sendMessage(
      env,
      chatId,
      "Cancelled. Send /donate whenever you want to donate.",
      removeKeyboard(),
    );
  }

  if (query.data === "back") {
    return sendMessage(
      env,
      chatId,
      "Choose a donation amount in ETB:",
      amountKeyboard(env),
    );
  }

  if (query.data === "status") {
    return showStatus(chatId, userId, env);
  }

  const amountMatch = /^amount:(\d{1,6})$/.exec(query.data);
  if (amountMatch) {
    const amount = Number(amountMatch[1]);
    if (amount < 1 || amount > 100000)
      return sendMessage(env, chatId, "That amount isn’t available.");
    const rows: InlineButton[][] = GATEWAYS.map((gateway) => [
      {
        text: gatewayLabel(gateway),
        callback_data: `gateway:${amount}:${gateway}`,
        style: gateway === "telebirr" ? "success" : "primary",
      },
    ]);
    rows.push([
      { text: "← Back", callback_data: "back", style: "primary" },
      { text: "Cancel", callback_data: "cancel", style: "danger" },
    ]);
    return sendMessage(
      env,
      chatId,
      `You chose <b>${formatEtb(amount)}</b>. Select how you’d like to pay:`,
      { inline_keyboard: rows },
    );
  }

  const checkoutMatch = /^gateway:(\d{1,6}):(telebirr|mpesa|cbe)$/.exec(
    query.data,
  );
  if (!checkoutMatch) {
    return sendMessage(
      env,
      chatId,
      "That button is out of date. Send /donate to start a fresh checkout.",
    );
  }

  const amount = Number(checkoutMatch[1]);
  const gateway = checkoutMatch[2] as Gateway;
  if (amount < 1 || amount > 100000) {
    return sendMessage(env, chatId, "That amount isn’t available.");
  }

  // The payment API needs the payer's phone number to send the payment
  // request. Remember the choice briefly and ask for it; the number itself is
  // never persisted.
  const pending: PendingCheckout = {
    amount,
    gateway,
    createdAt: Date.now(),
  };
  await env.SESSIONS.put(pendingKey(userId), JSON.stringify(pending), {
    expirationTtl: PENDING_TTL_SECONDS,
  });

  try {
    return await sendMessage(
      env,
      chatId,
      `You chose <b>${gatewayLabel(gateway)}</b> for <b>${formatEtb(amount)}</b>.\n\n` +
        `Send ${phoneHint(gateway)} so the payment request can be sent. Tap the button below or type it, e.g. <code>${phoneExample(gateway)}</code>.\n\n` +
        `<i>Your number is used only to start this payment and isn’t stored by this bot.</i>`,
      phoneKeyboard(gateway),
    );
  } catch (error) {
    // If the prompt never reached the user, don't leave a pending state that
    // would swallow their next message.
    await clearPending(env, userId);
    throw error;
  }
}

async function handleContact(message: TgMessage, env: Env) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const contact = message.contact!;
  if (!userId) {
    return sendMessage(
      env,
      chatId,
      "I couldn’t identify this Telegram account. Send /donate to start again.",
    );
  }
  if (contact.user_id !== undefined && contact.user_id !== userId) {
    return sendMessage(
      env,
      chatId,
      "Please share your own phone number, not someone else’s.",
      phoneKeyboard(),
    );
  }

  const pending = await getPending(env, userId);
  if (!pending) {
    return sendMessage(
      env,
      chatId,
      "Thanks! There’s no donation in progress right now. Send /donate to start one.",
      removeKeyboard(),
    );
  }

  const phone = normalizeEthiopianPhone(contact.phone_number, pending.gateway);
  if (!phone) {
    return sendMessage(
      env,
      chatId,
      `That number doesn’t match ${phoneHint(pending.gateway)}. Type it instead, e.g. <code>${phoneExample(pending.gateway)}</code>.`,
      phoneKeyboard(pending.gateway),
    );
  }

  return completeCheckout(env, chatId, userId, pending, phone);
}

async function completeCheckout(
  env: Env,
  chatId: number,
  userId: number,
  pending: PendingCheckout,
  phone: string,
) {
  if (Date.now() - pending.createdAt > PENDING_TTL_SECONDS * 1000) {
    await clearPending(env, userId);
    return sendMessage(
      env,
      chatId,
      "That donation session expired. Send /donate to start again.",
      removeKeyboard(),
    );
  }

  await clearPending(env, userId);
  // Don't let a failed status message block the actual checkout.
  void sendMessage(
    env,
    chatId,
    "Creating your secure checkout…",
    removeKeyboard(),
  ).catch((error) => console.warn("Could not send progress message", errorMessage(error)));

  const payment = paymentClient(env);
  let checkout: CheckoutResult;
  try {
    checkout = await payment.createCheckout({
      productId: env.JAMI_PRODUCT_ID,
      amount: pending.amount * 100,
      // The payment API requires an email on the customer record. Telegram
      // users don't have one here, so use a stable per-user placeholder
      // (example.com is reserved). The phone is the real payment number.
      customer: {
        email: `tg${userId}@example.com`,
        phone,
        externalId: String(userId),
      },
      gateway: pending.gateway,
    });
  } catch (error) {
    console.error(
      "Checkout creation failed",
      JSON.stringify({
        userId,
        gateway: pending.gateway,
        error: errorMessage(error),
      }),
    );
    return sendMessage(
      env,
      chatId,
      "We couldn’t start that checkout. Check the number and try again, or send /donate to restart.",
      removeKeyboard(),
    );
  }

  if ("orderId" in checkout) {
    return sendMessage(
      env,
      chatId,
      `Thank you! Your ${formatEtb(pending.amount)} donation was completed. Reference: ${checkout.orderId}`,
      removeKeyboard(),
    );
  }

  await env.SESSIONS.put(
    sessionKey(userId),
    JSON.stringify({
      sessionId: checkout.sessionId,
      amountMinor: pending.amount * 100,
      createdAt: Date.now(),
    } satisfies Session),
    { expirationTtl: 86400 },
  );

  if (checkout.mode === "redirect" && checkout.checkoutUrl) {
    return sendMessage(
      env,
      chatId,
      `Your ${formatEtb(pending.amount)} donation checkout is ready.\n\nPay with <b>${gatewayLabel(pending.gateway)}</b> on the secure payment page, then check the result here.`,
      {
        inline_keyboard: [
          [
            {
              text: "Open secure checkout",
              url: checkout.checkoutUrl,
              style: "success",
            },
          ],
          [
            {
              text: "I’ve paid — check status",
              callback_data: "status",
              style: "primary",
            },
          ],
        ] satisfies InlineButton[][],
      },
    );
  }

  return sendMessage(
    env,
    chatId,
    `Approve the ${formatEtb(pending.amount)} request on your phone, then check the result here.`,
    {
      inline_keyboard: [
        [
          {
            text: "I’ve paid — check status",
            callback_data: "status",
            style: "primary",
          },
        ],
      ] satisfies InlineButton[][],
    },
  );
}

async function cancelDonation(
  env: Env,
  chatId: number,
  userId: number | undefined,
) {
  if (userId) await clearPending(env, userId);
  return sendMessage(
    env,
    chatId,
    "Cancelled. Send /donate whenever you want to donate.",
    removeKeyboard(),
  );
}

function pendingKey(userId: number) {
  return `tg:${userId}:pending`;
}

async function getPending(
  env: Env,
  userId: number,
): Promise<PendingCheckout | null> {
  try {
    const raw = await env.SESSIONS.get(pendingKey(userId));
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingCheckout;
    if (
      !pending ||
      typeof pending.amount !== "number" ||
      typeof pending.createdAt !== "number" ||
      !GATEWAYS.includes(pending.gateway)
    ) {
      return null;
    }
    if (Date.now() - pending.createdAt > PENDING_TTL_SECONDS * 1000) return null;
    return pending;
  } catch {
    return null;
  }
}

async function clearPending(env: Env, userId: number) {
  try {
    await env.SESSIONS.delete(pendingKey(userId));
  } catch {
    /* a missing pending checkout is fine */
  }
}

/**
 * M-Pesa uses Safaricom numbers (07… / +2517…), while Telebirr and CBE Birr
 * use Ethio Telecom numbers (09… / +2519…). Also accepts the bare 9-digit
 * form and separators. Returns the `2517…` / `2519…` form the payment API
 * expects, or null when the number does not match the chosen gateway.
 */
function normalizeEthiopianPhone(
  input: string,
  gateway: Gateway,
): string | null {
  let digits = input.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("251")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);

  const prefix = gateway === "mpesa" ? "7" : "9";
  if (!/^\d{9}$/.test(digits) || !digits.startsWith(prefix)) return null;
  return `251${digits}`;
}

function phoneHint(gateway: Gateway) {
  return gateway === "mpesa"
    ? "an M-Pesa number starting with <code>07</code> or <code>+2517</code>"
    : `a ${gatewayLabel(gateway)} number starting with <code>09</code> or <code>+2519</code>`;
}

function phoneExample(gateway: Gateway) {
  return gateway === "mpesa" ? "0712345678" : "0912345678";
}

function phoneKeyboard(gateway: Gateway = "telebirr") {
  return {
    keyboard: [
      [
        {
          text: "📱 Share my phone number",
          request_contact: true,
          style: "success",
        },
      ],
      [{ text: "Cancel", style: "danger" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder:
      gateway === "mpesa" ? "07xx xxx xxx" : "09xx xxx xxx",
  };
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

async function showStatus(
  chatId: number,
  userId: number | undefined,
  env: Env,
) {
  if (!userId)
    return sendMessage(
      env,
      chatId,
      "I couldn’t identify this Telegram account. Start a new checkout with /donate.",
    );
  const raw = await env.SESSIONS.get(sessionKey(userId));
  if (!raw)
    return sendMessage(
      env,
      chatId,
      "You don’t have a recent checkout to check. Send /donate to start one.",
    );

  let session: Session;
  try {
    session = JSON.parse(raw) as Session;
  } catch {
    return sendMessage(
      env,
      chatId,
      "I couldn’t read your last checkout. Send /donate to start a new one.",
    );
  }
  if (Date.now() - session.createdAt > 86400000)
    return sendMessage(
      env,
      chatId,
      "That checkout has expired. Send /donate to start a new one.",
    );

  const payment = paymentClient(env);
  const status = await payment.getCheckoutStatus(session.sessionId);
  if (status.status === "completed") {
    await sendMessage(
      env,
      chatId,
      `Payment received — thank you for donating ${formatEtb(session.amountMinor / 100)}!`,
    );
  } else if (status.status === "expired") {
    const reason = status.failure?.message
      ? ` (${escapeHtml(status.failure.message)})`
      : "";
    await sendMessage(
      env,
      chatId,
      `That checkout expired${reason}. Send /donate to create a new one.`,
    );
  } else {
    await sendMessage(
      env,
      chatId,
      `Your ${formatEtb(session.amountMinor / 100)} checkout is still ${status.status}. Finish payment, then check again with /status.`,
    );
  }
}

// --- Telegram webhook health ------------------------------------------------

// Register the command menu and profile text. The cron watchdog calls this at
// most once a day, so a fresh deploy configures itself.
async function ensureBotProfile(env: Env): Promise<void> {
  try {
    if (await env.SESSIONS.get(BOT_PROFILE_CACHE_KEY)) return;
  } catch {
    /* fall through and update anyway */
  }

  await telegram(env, "setMyCommands", {
    commands: [
      { command: "donate", description: "Choose a donation amount" },
      { command: "status", description: "Check your latest checkout" },
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

async function health(env: Env): Promise<Response> {
  const config = {
    webhookSecretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
    paymentTokenConfigured: Boolean(env.JAMI_TOKEN),
    productConfigured:
      Boolean(env.JAMI_PRODUCT_ID) &&
      !env.JAMI_PRODUCT_ID.startsWith("REPLACE_"),
  };
  const missing = Object.entries(config)
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

async function manualRepair(request: Request, env: Env): Promise<Response> {
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

async function checkWebhook(
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
  if (env.TELEGRAM_WEBHOOK_SECRET)
    body.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
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

function normalizeUrl(value: string) {
  return value.replace(/\/+$/, "");
}

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
    await env.SESSIONS.put(key, "1", {
      expirationTtl: UPDATE_DEDUPE_TTL_SECONDS,
    });
    return true;
  } catch {
    return true;
  }
}

// --- Clients -----------------------------------------------------------------

function paymentClient(env: Env): PaymentClient {
  const timedFetch: typeof fetch = (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return fetchWithTimeout(href, init ?? {}, JAMI_TIMEOUT_MS);
  };
  return new PaymentClient({ token: env.JAMI_TOKEN, fetch: timedFetch });
}

async function telegram<T = unknown>(
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  let lastError = new Error(`Telegram ${method} failed`);

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    let data: TelegramResult<T> | null;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        TELEGRAM_TIMEOUT_MS,
      );
      data = (await response
        .json()
        .catch(() => null)) as TelegramResult<T> | null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(300 * (attempt + 1));
      continue;
    }

    if (response.ok && data?.ok) return data.result as T;

    const code = data?.error_code ?? response.status;
    lastError = new Error(
      `Telegram ${method} failed: ${code} ${data?.description ?? response.statusText}`,
    );
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

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Helpers -----------------------------------------------------------------

function sessionKey(userId: number) {
  return `tg:${userId}:latest`;
}
function gatewayLabel(gateway: string) {
  return (
    (
      { telebirr: "Telebirr", mpesa: "M-Pesa", cbe: "CBE Birr" } as Record<
        string,
        string
      >
    )[gateway] ?? gateway
  );
}
function formatEtb(amount: number) {
  return `${amount.toLocaleString("en-US")} ETB`;
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function text(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: unknown,
) {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}
async function answerCallback(
  env: Env,
  callbackQueryId: string,
  toast?: string,
) {
  try {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(toast ? { text: toast } : {}),
    });
  } catch (error) {
    console.warn("Could not answer callback query", errorMessage(error));
  }
}
