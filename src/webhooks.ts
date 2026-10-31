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
import { errorMessage, formatEtb, json } from "./util";

type Notification = { userId: number; amountMinor: number };

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
        ? { userId: existing.userId, amountMinor: existing.amountMinor }
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
    return { userId, amountMinor: amount };
  }

  if (event.type === "checkout.session.expired") {
    await markDonationExpired(env, event.data.sessionId);
    return null;
  }

  return null;
}

async function notifyDonor(env: Env, info: Notification): Promise<void> {
  try {
    await sendMessage(
      env,
      info.userId,
      `✅ Payment received — thank you for donating ${formatEtb(info.amountMinor / 100)}!`,
    );
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
