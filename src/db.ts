import type { Env, TgUser } from "./types";
import { DONATION_SESSION_TTL_MS } from "./constants";
import { paymentClient } from "./payment";
import { errorMessage } from "./util";

export type HallOfFameRow = {
  firstName: string | null;
  totalMinor: number;
  donationCount: number;
};

export type DonationRecord = {
  userId: number;
  amountMinor: number;
};

/** Upsert every person who interacts with the bot and count interactions. */
export async function recordUser(
  env: Env,
  user: TgUser | undefined,
): Promise<void> {
  if (!user || !env.DB) return;
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO users
         (id, first_name, username, language_code, first_seen_at, last_seen_at, interactions)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         first_name = COALESCE(excluded.first_name, users.first_name),
         username = COALESCE(excluded.username, users.username),
         language_code = COALESCE(excluded.language_code, users.language_code),
         last_seen_at = excluded.last_seen_at,
         interactions = users.interactions + 1`,
    )
      .bind(
        user.id,
        user.first_name ?? null,
        user.username ?? null,
        user.language_code ?? null,
        now,
        now,
      )
      .run();
  } catch (error) {
    console.error("Could not record user", errorMessage(error));
  }
}

/** Make sure a donor has a users row before a foreign-key insert. */
export async function ensureUser(env: Env, userId: number): Promise<void> {
  if (!env.DB) return;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(userId, now, now)
    .run();
}

/**
 * Insert or update a checkout attempt. A completed row never goes backwards.
 * Returns true when the row was written.
 */
export async function upsertDonation(
  env: Env,
  donation: {
    userId: number;
    sessionId: string;
    amountMinor: number;
    gateway: string;
    status: "pending" | "completed" | "expired";
    orderId?: string | null;
    createdAt?: number;
    completedAt?: number | null;
  },
  strict = false,
): Promise<boolean> {
  if (!env.DB) return false;
  try {
    await env.DB.prepare(
      `INSERT INTO donations
         (user_id, session_id, amount_minor, gateway, status, order_id, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         status = CASE
           WHEN donations.status = 'completed' THEN 'completed'
           ELSE excluded.status
         END,
         order_id = COALESCE(excluded.order_id, donations.order_id),
         completed_at = COALESCE(excluded.completed_at, donations.completed_at)`,
    )
      .bind(
        donation.userId,
        donation.sessionId,
        donation.amountMinor,
        donation.gateway,
        donation.status,
        donation.orderId ?? null,
        donation.createdAt ?? Date.now(),
        donation.completedAt ?? null,
      )
      .run();
    return true;
  } catch (error) {
    if (strict) throw error;
    console.error("Could not save donation", errorMessage(error));
    return false;
  }
}

/** Returns true when this call actually moved the row to completed. */
export async function markDonationCompleted(
  env: Env,
  sessionId: string,
  orderId: string | null,
): Promise<boolean> {
  if (!env.DB) return false;
  const result = await env.DB.prepare(
    `UPDATE donations
     SET status = 'completed',
         order_id = COALESCE(?, order_id),
         completed_at = COALESCE(completed_at, ?)
     WHERE session_id = ? AND (status <> 'completed' OR order_id IS NULL)`,
  )
    .bind(orderId, Date.now(), sessionId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Returns true when this call actually expired a pending row. */
export async function markDonationExpired(
  env: Env,
  sessionId: string,
): Promise<boolean> {
  if (!env.DB) return false;
  const result = await env.DB.prepare(
    `UPDATE donations SET status = 'expired'
     WHERE session_id = ? AND status = 'pending'`,
  )
    .bind(sessionId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function getDonationBySession(
  env: Env,
  sessionId: string,
): Promise<DonationRecord | null> {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    `SELECT user_id AS userId, amount_minor AS amountMinor
     FROM donations WHERE session_id = ?`,
  )
    .bind(sessionId)
    .first<DonationRecord>();
  return row ?? null;
}

/**
 * /status reconciles the current user's checkout; the cron uses this to
 * reconcile everyone else's, so the hall of fame is accurate even when a
 * donor never sends /status and no webhook arrives.
 */
export async function reconcileDonations(env: Env): Promise<void> {
  if (!env.DB) return;
  const cutoff = Date.now() - DONATION_SESSION_TTL_MS;

  // Checkout sessions expire after 30 minutes, so anything older than the
  // window can no longer complete.
  await env.DB.prepare(
    `UPDATE donations SET status = 'expired'
     WHERE status = 'pending' AND created_at < ?`,
  )
    .bind(cutoff)
    .run();

  const { results } = await env.DB.prepare(
    `SELECT session_id AS sessionId FROM donations
     WHERE status = 'pending' AND created_at >= ?
     ORDER BY created_at ASC LIMIT 10`,
  )
    .bind(cutoff)
    .all<{ sessionId: string }>();

  const payment = paymentClient(env);
  for (const row of results ?? []) {
    try {
      const status = await payment.getCheckoutStatus(row.sessionId);
      if (status.status === "completed") {
        await markDonationCompleted(env, row.sessionId, status.orderId);
      } else if (status.status === "expired") {
        await markDonationExpired(env, row.sessionId);
      }
    } catch (error) {
      console.warn(
        "Could not reconcile donation",
        row.sessionId,
        errorMessage(error),
      );
    }
  }
}

/** Top donors aggregated by user across all completed donations. */
export async function getHallOfFame(
  env: Env,
  limit = 3,
): Promise<HallOfFameRow[]> {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT u.first_name AS firstName,
            SUM(d.amount_minor) AS totalMinor,
            COUNT(*) AS donationCount
     FROM donations d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'completed'
     GROUP BY u.id
     ORDER BY totalMinor DESC, donationCount DESC, MIN(d.completed_at) ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<HallOfFameRow>();
  return results ?? [];
}
