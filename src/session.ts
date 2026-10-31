import type { Env, PendingCheckout } from "./types";
import {
  GATEWAYS,
  PENDING_TTL_SECONDS,
  UPDATE_DEDUPE_TTL_SECONDS,
} from "./constants";

export function sessionKey(userId: number): string {
  return `tg:${userId}:latest`;
}

export function pendingKey(userId: number): string {
  return `tg:${userId}:pending`;
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
