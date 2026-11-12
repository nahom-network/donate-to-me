import {
  JamiSignatureError,
  verifyWebhookSignature,
  type JamiWebhookEvent,
} from "jami-sdk";
import type { Env } from "./types";
import { WEBHOOK_EVENT_TTL_SECONDS } from "./constants";
import {
  ensureUser,
  getDonationBySession,
  markDonationCompleted,
  markDonationExpired,
  upsertDonation,
} from "./db";
import { deleteCheckoutMessage } from "./session";
import { sendCelebration, sendFailure, tryAgainKeyboard } from "./cards";
import { errorMessage, escapeHtml, formatEtb, json } from "./util";

type Notification =
  | {
      kind: "completed";
      userId: number;
      sessionId: string;
      /** Charge amount in ETB, not minor units. */
      amount: number;
      gateway?: string | null;
      reference?: string | null;
      /** Plain-text result, used when the celebration widget is unavailable. */
      text: string;
    }
  | {
      kind: "expired";
      userId: number;
      sessionId: string;
      reason: string;
      detail?: string | null;
      amount?: number | null;
      variant: "failed" | "expired";
      text: string;
    };

/**
 * POST /webhooks/payments
 *
 * Signed payment events. Verification uses the raw body, so never parse it
 * before this handler. Events are processed before the 2xx reply (D1 only,
 * a few milliseconds); the donor notification runs in the background.
 */
export async function handlePaymentWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.JAMI_WEBHOOK_SECRET) {
    console.error("Payment webhook received but JAMI_WEBHOOK_SECRET is not set");
    return json({ ok: false, error: "Webhook secret is not configured" }, 503);
  }

  const raw = await request.text();
  const signature = request.headers.get("x-jamidev-signature") ?? "";

  let event: JamiWebhookEvent;
  try {
    event = await verifyWebhookSignature({
      payload: raw,
      signature,
      secret: env.JAMI_WEBHOOK_SECRET,
    });
  } catch (error) {
    if (error instanceof JamiSignatureError) {
      console.warn("Rejected payment webhook with an invalid signature");
      return json({ ok: false, error: "Invalid signature" }, 400);
    }
    console.error("Payment webhook verification failed", errorMessage(error));
    return json({ ok: false, error: "Invalid payload" }, 400);
  }

  // Never acknowledge an event we cannot persist: without this guard a Worker
  // deployed without the D1 binding would silently drop every donation.
  if (!env.DB) {
    console.error("Payment webhook received but the DB binding is missing");
    return json({ ok: false, error: "Database is not configured" }, 503);
  }

  // Deliveries are retried and may be resent, so the event id is the
  // idempotency key.
  if (await wasProcessed(env, event.id)) {
    return json({ ok: true, duplicate: true });
  }

  let notification: Notification | null = null;
  try {
    notification = await applyEvent(env, event);
    await rememberEvent(env, event.id);
  } catch (error) {
    console.error(
      "Payment webhook processing failed",
      JSON.stringify({
        type: event.type,
        id: event.id,
        error: errorMessage(error),
      }),
    );
    // No 2xx on failure: the provider retries with backoff.
    return json({ ok: false, error: "Processing failed" }, 500);
  }

  if (notification) {
    ctx.waitUntil(notifyDonor(env, notification));
  }

  return json({ ok: true });
}

async function applyEvent(
  env: Env,
  event: JamiWebhookEvent,
): Promise<Notification | null> {
  if (event.type === "order.completed") {
    const { sessionId, orderId, amount, customerExternalId } = event.data;

    const existing = await getDonationBySession(env, sessionId);
    const changed = await markDonationCompleted(env, sessionId, orderId);

    if (existing) {
      return changed
        ? {
            kind: "completed",
            userId: existing.userId,
            sessionId,
            amount: existing.amountMinor / 100,
            gateway: existing.gateway,
            reference: orderId,
            text: `✅ Payment received — thank you for donating ${formatEtb(existing.amountMinor / 100)}!`,
          }
        : null;
    }

    // The checkout row is normally created before the buyer can pay. If it is
    // missing (old data or a partial failure), recreate it from the event.
    const userId = customerExternalId ? Number(customerExternalId) : NaN;
    if (!Number.isInteger(userId) || userId <= 0) {
      console.warn(
        "order.completed without a usable customerExternalId",
        sessionId,
      );
      return null;
    }

    await ensureUser(env, userId);
    await upsertDonation(
      env,
      {
        userId,
        sessionId,
        amountMinor: amount,
        gateway: "unknown",
        status: "completed",
        orderId,
        completedAt: Date.now(),
      },
      true,
    );
    return {
      kind: "completed",
      userId,
      sessionId,
      amount: amount / 100,
      reference: orderId,
      text: `✅ Payment received — thank you for donating ${formatEtb(amount / 100)}!`,
    };
  }

  if (event.type === "checkout.session.expired") {
    const existing = await getDonationBySession(env, event.data.sessionId);
    const changed = await markDonationExpired(env, event.data.sessionId);
    // Only tell the payer once, and only if this was a pending donation.
    if (!changed || !existing) return null;
    const code = event.data.failure?.code;
    const reason = failureReason(code);
    const detail = event.data.failure?.message ?? null;
    return {
      kind: "expired",
      userId: existing.userId,
      sessionId: event.data.sessionId,
      reason,
      detail,
      amount: existing.amountMinor / 100,
      variant: code === "session_expired" ? "expired" : "failed",
      text: failureText(reason, detail),
    };
  }

  return null;
}

/** User-facing headline for a payment failure code. */
function failureReason(code?: string): string {
  switch (code) {
    case "payment_rejected":
      return "The payment was rejected by the provider.";
    case "payment_failed":
      return "The payment failed.";
    case "payment_canceled":
      return "You canceled the payment.";
    case "payment_timed_out":
      return "The payment request timed out.";
    case "initiate_failed":
      return "The payment couldn’t be started.";
    case "session_expired":
      return "That checkout expired.";
    default:
      return "The payment didn’t complete.";
  }
}

/** Plain-text result, used when the failure widget is unavailable. */
function failureText(reason: string, detail?: string | null): string {
  const extra = detail ? `\n\n${escapeHtml(detail)}` : "";
  return `⌛ ${reason}${extra}\n\nSend /donate to try again.`;
}

async function notifyDonor(env: Env, info: Notification): Promise<void> {
  // Delete the "approve / open checkout" prompt and the amount-picker card,
  // then send the result once, so the same text never appears twice in the
  // chat and no stale card is left behind.
  await deleteCheckoutMessage(env, info.userId, info.sessionId);

  if (info.kind === "completed") {
    await sendCelebration(
      env,
      info.userId,
      {
        amount: info.amount,
        gateway: info.gateway,
        reference: info.reference,
      },
      info.text,
    );
    return;
  }

  await sendFailure(
    env,
    info.userId,
    {
      reason: info.reason,
      detail: info.detail,
      amount: info.amount,
      variant: info.variant,
    },
    info.text,
    tryAgainKeyboard(),
  );
}

async function wasProcessed(env: Env, eventId: string): Promise<boolean> {
  try {
    return Boolean(await env.SESSIONS.get(`wh:${eventId}`));
  } catch {
    return false;
  }
}

async function rememberEvent(env: Env, eventId: string): Promise<void> {
  try {
    await env.SESSIONS.put(`wh:${eventId}`, "1", {
      expirationTtl: WEBHOOK_EVENT_TTL_SECONDS,
    });
  } catch (error) {
    console.warn("Could not store webhook event id", errorMessage(error));
  }
}
