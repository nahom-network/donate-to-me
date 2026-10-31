import type {
  Env,
  InlineButton,
  PendingCheckout,
  Session,
  TgCallback,
  TgMessage,
  TgUpdate,
} from "./types";
import {
  DEFAULT_AMOUNTS,
  GATEWAYS,
  PENDING_TTL_SECONDS,
  type Gateway,
} from "./constants";
import {
  answerCallback,
  deleteMessage,
  editMessageText,
  sendChatAction,
  sendMessage,
  sendMessageGetId,
  sendPhoto,
} from "./telegram";
import { paymentClient, type CheckoutResult } from "./payment";
import {
  claimUpdate,
  clearPending,
  deleteCheckoutMessage,
  getPending,
  pendingKey,
  sessionKey,
} from "./session";
import {
  getDonationBySession,
  getHallOfFame,
  markDonationCompleted,
  markDonationExpired,
  recordUser,
  upsertDonation,
} from "./db";
import { errorMessage, escapeHtml, formatEtb, gatewayLabel } from "./util";

export async function handleUpdate(
  update: TgUpdate,
  env: Env,
  origin?: string,
): Promise<void> {
  try {
    if (
      update.update_id !== undefined &&
      !(await claimUpdate(env, update.update_id))
    ) {
      return;
    }
    if (update.callback_query) {
      await recordUser(env, update.callback_query.from);
      await onCallback(update.callback_query, env);
    } else if (update.message) {
      await recordUser(env, update.message.from);
      await onMessage(update.message, env, origin);
    }
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
    // Never let a failed notification escape: that would make the Worker
    // return 500 and trigger another Telegram retry for the same update.
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

async function onMessage(message: TgMessage, env: Env, origin?: string) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const messageText = message.text?.trim() ?? "";
  const name = message.from?.first_name
    ? `, ${escapeHtml(message.from.first_name)}`
    : "";
  const command = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/i
    .exec(messageText)?.[1]
    ?.toLowerCase();

  // Phone sharing and reply keyboards only work in a direct chat. The public
  // hall of fame is the one command that also works in groups.
  if (message.chat.type && message.chat.type !== "private") {
    if (isHallOfFameCommand(command)) return showHallOfFame(chatId, env);
    return sendMessage(
      env,
      chatId,
      "I can only take donations in a private chat. Open a direct chat with me and send /donate.",
    );
  }

  if (message.contact) return handleContact(message, env);

  if (command === "cancel" || messageText.toLowerCase() === "cancel") {
    return cancelDonation(env, chatId, userId);
  }

  if (isHallOfFameCommand(command)) return showHallOfFame(chatId, env);

  if (command === "start") {
    await resetPending(env, chatId, userId);
    const caption =
      `Selam${name}! 👋\n\n` +
      `This bot lets you support me with a secure donation via Telebirr, M-Pesa, or CBE Birr.\n\n` +
      `Tap <b>Donate</b> to choose an amount.`;
    try {
      return await sendPhoto(
        env,
        chatId,
        startImageUrl(env, origin),
        caption,
        startKeyboard(),
      );
    } catch (error) {
      // Never let a missing/unsupported image block /start.
      console.error("Could not send start photo", errorMessage(error));
      return sendMessage(env, chatId, caption, startKeyboard());
    }
  }
  if (command === "donate") {
    await resetPending(env, chatId, userId);
    return sendMessage(
      env,
      chatId,
      "Choose a donation amount in ETB:",
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
      "Use /donate to pick an amount and payment method. Next, reply to the prompt with the mobile number registered with your Telebirr, M-Pesa, or CBE Birr account so the payment request can be sent. Use /status to check the result, /halloffame to see the top donors, or /cancel to stop.",
    );
  }

  // While a checkout is waiting for a phone number, a plain message is the
  // number (or a typo).
  if (userId) {
    const pending = await getPending(env, userId);
    if (pending) {
      const phone = normalizeEthiopianPhone(messageText, pending.gateway);
      // The phone message has served its purpose; remove it (this also keeps
      // the number out of the chat history).
      if (message.message_id) {
        await deleteMessage(env, chatId, message.message_id);
      }
      if (phone) return completeCheckout(env, chatId, userId, pending, phone);
      return promptForPhone(
        env,
        chatId,
        userId,
        pending,
        `That doesn’t look like ${phoneHint(pending.gateway)}. Reply with ${phoneHint(pending.gateway)}, e.g. <code>${phoneExample(pending.gateway)}</code>.`,
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

function startKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Donate 🫴", callback_data: "donate", style: "success" }],
      [
        {
          text: "⭐ Open source on GitHub",
          url: "https://github.com/nahom-network/donate-to-me",
          style: "primary",
        },
      ],
    ] satisfies InlineButton[][],
  };
}

/** Public origin used for the start image served by Workers Static Assets. */
function publicOrigin(env: Env): string {
  const configured = env.WEBHOOK_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      /* fall through to the default */
    }
  }
  return "https://donate-to-me.nahom-network.workers.dev";
}

/** Optional START_IMAGE_URL override; falls back to the bundled sticker. */
function startImageUrl(env: Env, origin?: string): string {
  const configured = env.START_IMAGE_URL?.trim();
  return configured || `${origin ?? publicOrigin(env)}/sticker.webp`;
}

async function onCallback(query: TgCallback, env: Env) {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
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
    return cancelDonation(env, chatId, userId, messageId);
  }

  if (query.data === "donate" || query.data === "back") {
    await resetPending(env, chatId, userId);
    const text = "Choose a donation amount in ETB:";
    // The start screen is a photo, and editMessageText cannot edit photo
    // messages. Replace it with a fresh text message for the amount list.
    if (query.message?.photo && messageId) {
      await deleteMessage(env, chatId, messageId);
      return sendMessage(env, chatId, text, amountKeyboard(env));
    }
    if (messageId) {
      return editMessageText(env, chatId, messageId, text, amountKeyboard(env));
    }
    return sendMessage(env, chatId, text, amountKeyboard(env));
  }

  if (query.data === "status") {
    return showStatus(chatId, userId, env);
  }

  const amountMatch = /^amount:(\d{1,6})$/.exec(query.data);
  if (amountMatch) {
    const amount = Number(amountMatch[1]);
    if (amount < 1 || amount > 100000) {
      return sendMessage(env, chatId, "That amount isn’t available.");
    }
    const rows: InlineButton[][] = GATEWAYS.map((gateway) => [
      {
        text: gatewayLabel(gateway),
        callback_data: `gateway:${amount}:${gateway}`,
        style: gateway === "telebirr" ? "success" : "primary",
      },
    ]);
    rows.push([
      { text: "← Back", callback_data: "back", style: "success" },
      { text: "Cancel", callback_data: "cancel", style: "danger" },
    ]);
    const text = `You chose <b>${formatEtb(amount)}</b>. Select how you’d like to pay:`;
    // Replace the amount message instead of leaving it in the chat.
    if (messageId) {
      return editMessageText(env, chatId, messageId, text, {
        inline_keyboard: rows,
      });
    }
    return sendMessage(env, chatId, text, { inline_keyboard: rows });
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

  // The amount/gateway message has served its purpose.
  if (messageId) await deleteMessage(env, chatId, messageId);

  return promptForPhone(
    env,
    chatId,
    userId,
    pending,
    `You chose <b>${gatewayLabel(gateway)}</b> for <b>${formatEtb(amount)}</b>.\n\n` +
      `Reply with ${phoneHint(gateway)} so the payment request can be sent, e.g. <code>${phoneExample(gateway)}</code>.\n\n` +
      `<i>Your number is used only to start this payment and isn’t stored by this bot.</i>`,
  );
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

  // Never leave a contact card (or someone else's number) in the chat.
  if (message.message_id) {
    await deleteMessage(env, chatId, message.message_id);
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

  if (contact.user_id !== undefined && contact.user_id !== userId) {
    return promptForPhone(
      env,
      chatId,
      userId,
      pending,
      "Please share your own phone number, not someone else’s. Reply with your number.",
    );
  }

  const phone = normalizeEthiopianPhone(contact.phone_number, pending.gateway);
  if (!phone) {
    return promptForPhone(
      env,
      chatId,
      userId,
      pending,
      `That number doesn’t match ${phoneHint(pending.gateway)}. Reply with it instead, e.g. <code>${phoneExample(pending.gateway)}</code>.`,
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
  // The ForceReply prompt is no longer needed.
  if (pending.promptMessageId) {
    await deleteMessage(env, chatId, pending.promptMessageId);
  }

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
  // A typing indicator beats a "creating..." message that would need deleting.
  void sendChatAction(env, chatId, "typing");

  const payment = paymentClient(env);
  let checkout: CheckoutResult;
  try {
    checkout = await payment.createCheckout({
      productId: env.JAMI_PRODUCT_ID,
      amount: pending.amount * 100,
      // The payment API requires an email on the customer record. Telegram
      // users don't have one here, so use a stable per-user placeholder
      // (donate_to_me_bot.t.me is reserved). The phone is the real payment number.
      customer: {
        email: `tg${userId}@donate_to_me_bot.t.me`,
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
    await upsertDonation(env, {
      userId,
      sessionId: checkout.sessionId,
      amountMinor: pending.amount * 100,
      gateway: pending.gateway,
      status: "completed",
      orderId: checkout.orderId,
      completedAt: Date.now(),
    });
    return sendMessage(
      env,
      chatId,
      `Thank you! Your ${formatEtb(pending.amount)} donation was completed. Reference: ${checkout.orderId}`,
      removeKeyboard(),
    );
  }

  const session: Session = {
    sessionId: checkout.sessionId,
    amountMinor: pending.amount * 100,
    createdAt: Date.now(),
  };
  const saveSession = () =>
    env.SESSIONS.put(sessionKey(userId), JSON.stringify(session), {
      expirationTtl: 86400,
    });

  await saveSession();

  await upsertDonation(env, {
    userId,
    sessionId: checkout.sessionId,
    amountMinor: pending.amount * 100,
    gateway: pending.gateway,
    status: "pending",
  });

  let messageId: number | undefined;
  if (checkout.mode === "redirect" && checkout.checkoutUrl) {
    messageId = await sendMessageGetId(
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
              style: "success",
            },
          ],
        ] satisfies InlineButton[][],
      },
    );
  } else {
    messageId = await sendMessageGetId(
      env,
      chatId,
      `Approve the ${formatEtb(pending.amount)} request on your phone, then check the result here.`,
      {
        inline_keyboard: [
          [
            {
              text: "I’ve paid — check status",
              callback_data: "status",
              style: "success",
            },
          ],
        ] satisfies InlineButton[][],
      },
    );
  }

  // Remember the prompt so a webhook can edit it into the final result.
  if (messageId) {
    session.checkoutMessageId = messageId;
    await saveSession();
  }
}

/** Drop any pending gateway choice and its ForceReply prompt. */
async function resetPending(
  env: Env,
  chatId: number,
  userId: number | undefined,
) {
  if (!userId) return;
  const pending = await getPending(env, userId);
  if (pending?.promptMessageId) {
    await deleteMessage(env, chatId, pending.promptMessageId);
  }
  await clearPending(env, userId);
}

async function cancelDonation(
  env: Env,
  chatId: number,
  userId: number | undefined,
  messageId?: number,
) {
  await resetPending(env, chatId, userId);
  if (messageId) {
    return editMessageText(
      env,
      chatId,
      messageId,
      "Cancelled. Send /donate whenever you want to donate.",
      { inline_keyboard: [] },
    );
  }
  return sendMessage(
    env,
    chatId,
    "Cancelled. Send /donate whenever you want to donate.",
    removeKeyboard(),
  );
}

function normalizeEthiopianPhone(
  input: string,
  gateway: Gateway,
): string | null {
  let digits = input.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("251")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);

  // M-Pesa uses Safaricom numbers (07…), Telebirr and CBE Birr use Ethio
  // Telecom numbers (09…). The normalized form is what the payment API wants.
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

function phonePlaceholder(gateway: Gateway) {
  return gateway === "mpesa" ? "07xx xxx xxx" : "09xx xxx xxx";
}

function forceReply(placeholder: string) {
  return {
    force_reply: true,
    input_field_placeholder: placeholder,
  };
}

/**
 * Send (or replace) the phone prompt as a ForceReply. The message id is stored
 * with the pending checkout so the prompt can be removed once it is used.
 */
async function promptForPhone(
  env: Env,
  chatId: number,
  userId: number,
  pending: PendingCheckout,
  text: string,
): Promise<void> {
  if (pending.promptMessageId) {
    await deleteMessage(env, chatId, pending.promptMessageId);
  }
  const messageId = await sendMessageGetId(
    env,
    chatId,
    text,
    forceReply(phonePlaceholder(pending.gateway)),
  );
  const updated: PendingCheckout = { ...pending, promptMessageId: messageId };
  await env.SESSIONS.put(pendingKey(userId), JSON.stringify(updated), {
    expirationTtl: PENDING_TTL_SECONDS,
  });
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

async function showStatus(
  chatId: number,
  userId: number | undefined,
  env: Env,
) {
  if (!userId) {
    return sendMessage(
      env,
      chatId,
      "I couldn’t identify this Telegram account. Start a new checkout with /donate.",
    );
  }
  const raw = await env.SESSIONS.get(sessionKey(userId));
  if (!raw) {
    return sendMessage(
      env,
      chatId,
      "You don’t have a recent checkout to check. Send /donate to start one.",
    );
  }

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
  if (Date.now() - session.createdAt > 86400000) {
    return sendMessage(
      env,
      chatId,
      "That checkout has expired. Send /donate to start a new one.",
    );
  }

  const payment = paymentClient(env);
  const status = await payment.getCheckoutStatus(session.sessionId);
  if (status.status === "completed") {
    const message = `✅ Payment received — thank you for donating ${formatEtb(session.amountMinor / 100)}!`;
    try {
      const existing = await getDonationBySession(env, session.sessionId);
      if (existing) {
        const changed = await markDonationCompleted(
          env,
          session.sessionId,
          status.orderId,
        );
        if (changed) {
          await deleteCheckoutMessage(env, userId, session.sessionId);
        }
      } else {
        // The row can be missing if this session was created before D1 was
        // available; backfill it so the donor appears in the hall of fame.
        await upsertDonation(env, {
          userId,
          sessionId: session.sessionId,
          amountMinor: session.amountMinor,
          gateway: "unknown",
          status: "completed",
          orderId: status.orderId,
          completedAt: Date.now(),
        });
        await deleteCheckoutMessage(env, userId, session.sessionId);
      }
    } catch (error) {
      console.error("Could not record completed donation", errorMessage(error));
    }
    await sendMessage(env, chatId, message);
  } else if (status.status === "expired") {
    try {
      const changed = await markDonationExpired(env, session.sessionId);
      if (changed) {
        await deleteCheckoutMessage(env, userId, session.sessionId);
      }
    } catch (error) {
      console.error("Could not record expired donation", errorMessage(error));
    }
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

function isHallOfFameCommand(command: string | undefined) {
  return (
    command === "halloffame" || command === "top" || command === "topdonors"
  );
}

async function showHallOfFame(chatId: number, env: Env) {
  const header =
    "🏆 <b>HALL OF FAME</b>\n<i>Top supporters · all-time total</i>";

  try {
    const rows = await getHallOfFame(env, 3);

    if (rows.length === 0) {
      return sendMessage(
        env,
        chatId,
        `${header}\n\nNo completed donations yet.\nSend /donate and take the top spot!`,
      );
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = rows.map((row, index) => {
      const name = row.firstName || "Anonymous";
      const donations = `donation${row.donationCount === 1 ? "" : "s"}`;
      return (
        `${medals[index]} <b>${escapeHtml(name)}</b>\n` +
        `     ${formatEtb(row.totalMinor / 100)} · ${row.donationCount} ${donations}`
      );
    });

    return sendMessage(
      env,
      chatId,
      `${header}\n━━━━━━━━━━━━━━\n${lines.join("\n\n")}\n━━━━━━━━━━━━━━`,
    );
  } catch (error) {
    console.error("Could not load hall of fame", errorMessage(error));
    return sendMessage(
      env,
      chatId,
      "I couldn’t load the hall of fame right now. Try again in a moment.",
    );
  }
}
