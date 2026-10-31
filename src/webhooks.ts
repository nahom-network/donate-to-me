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
import { sendMessage } from "./telegram";
import { errorMessage, escapeHtml, formatEtb, json } from "./util";

type Notification = { userId: number; text: string };

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
            userId: existing.userId,
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
      userId,
      text: `✅ Payment received — thank you for donating ${formatEtb(amount / 100)}!`,
    };
  }

  if (event.type === "checkout.session.expired") {
    const existing = await getDonationBySession(env, event.data.sessionId);
    const changed = await markDonationExpired(env, event.data.sessionId);
    // Only tell the payer once, and only if this was a pending donation.
    if (!changed || !existing) return null;
    return {
      userId: existing.userId,
      text: expiredText(event.data.failure),
    };
  }

  return null;
}

function expiredText(
  failure: { code?: string; message?: string } | null | undefined,
): string {
  let reason = "The payment didn’t complete.";
  switch (failure?.code) {
    case "payment_rejected":
      reason = "The payment was rejected by the provider.";
      break;
    case "payment_failed":
      reason = "The payment failed.";
      break;
    case "payment_canceled":
      reason = "You canceled the payment.";
      break;
    case "payment_timed_out":
      reason = "The payment request timed out.";
      break;
    case "initiate_failed":
      reason = "The payment couldn’t be started.";
      break;
    case "session_expired":
      reason = "The checkout expired.";
      break;
  }

  const detail = failure?.message ? `\n\n${escapeHtml(failure.message)}` : "";
  return `⌛ ${reason}${detail}\n\nSend /donate to try again.`;
}

async function notifyDonor(env: Env, info: Notification): Promise<void> {
  try {
    await sendMessage(env, info.userId, info.text);
  } catch (error) {
    console.warn("Could not notify donor", errorMessage(error));
  }
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
