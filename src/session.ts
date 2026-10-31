import type { Env, PendingCheckout, Session } from "./types";
import {
  GATEWAYS,
  PENDING_TTL_SECONDS,
  UPDATE_DEDUPE_TTL_SECONDS,
} from "./constants";
import { deleteMessage, editMessageText } from "./telegram";
import { errorMessage } from "./util";

export function sessionKey(userId: number): string {
  return `tg:${userId}:latest`;
}

export function pendingKey(userId: number): string {
  return `tg:${userId}:pending`;
}

/**
 * Remove the checkout prompt instead of leaving a dead "approve / open
 * checkout" message. Used when a separate result message is about to be sent,
 * so the payer sees the result exactly once.
 */
export async function deleteCheckoutMessage(
  env: Env,
  userId: number,
  sessionId: string,
): Promise<boolean> {
  try {
    const raw = await env.SESSIONS.get(sessionKey(userId));
    if (!raw) return false;
    const session = JSON.parse(raw) as Session;
    if (session.sessionId !== sessionId || !session.checkoutMessageId) {
      return false;
    }
    const deleted = await deleteMessage(
      env,
      userId,
      session.checkoutMessageId,
    );
    if (deleted) {
      delete session.checkoutMessageId;
      await env.SESSIONS.put(sessionKey(userId), JSON.stringify(session), {
        expirationTtl: 86400,
      });
    }
    return deleted;
  } catch (error) {
    console.warn("Could not delete checkout message", errorMessage(error));
    return false;
  }
}

/**
 * Turn the checkout prompt into a result message (payment received / expired)
 * and drop its inline buttons. Does nothing when the session is gone or when
 * the message was never recorded.
 */
export async function updateCheckoutMessage(
  env: Env,
  userId: number,
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    const raw = await env.SESSIONS.get(sessionKey(userId));
    if (!raw) return;
    const session = JSON.parse(raw) as Session;
    if (session.sessionId !== sessionId || !session.checkoutMessageId) return;
    await editMessageText(env, userId, session.checkoutMessageId, text, {
      inline_keyboard: [],
    });
  } catch (error) {
    console.warn("Could not update checkout message", errorMessage(error));
  }
}

export async function getPending(
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

export async function clearPending(env: Env, userId: number): Promise<void> {
  try {
    await env.SESSIONS.delete(pendingKey(userId));
  } catch {
    /* a missing pending checkout is fine */
  }
}

/**
 * Best-effort duplicate suppression: Telegram retries an update when it does
 * not receive a fast 200, and a retry must not create a second checkout.
 */
export async function claimUpdate(
  env: Env,
  updateId: number,
): Promise<boolean> {
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
