import type { Env, Session, TgUser } from "./types";
import { DONATION_SESSION_TTL_MS } from "./constants";
import { paymentClient } from "./payment";
import { updateCheckoutMessage } from "./session";
import { errorMessage, formatEtb } from "./util";

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
  if (!env.DB) throw new Error("D1 binding is not configured");
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
  if (!env.DB) {
    if (strict) throw new Error("D1 binding is not configured");
    return false;
  }
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
    `SELECT session_id AS sessionId,
            user_id AS userId,
            amount_minor AS amountMinor
     FROM donations
     WHERE status = 'pending' AND created_at >= ?
     ORDER BY created_at ASC LIMIT 10`,
  )
    .bind(cutoff)
    .all<{ sessionId: string; userId: number; amountMinor: number }>();

  const payment = paymentClient(env);
  for (const row of results ?? []) {
    try {
      const status = await payment.getCheckoutStatus(row.sessionId);
      if (status.status === "completed") {
        const changed = await markDonationCompleted(
          env,
          row.sessionId,
          status.orderId,
        );
        if (changed) {
          await updateCheckoutMessage(
            env,
            row.userId,
            row.sessionId,
            `✅ Payment received — thank you for donating ${formatEtb(row.amountMinor / 100)}!`,
          );
        }
      } else if (status.status === "expired") {
        const changed = await markDonationExpired(env, row.sessionId);
        if (changed) {
          await updateCheckoutMessage(
            env,
            row.userId,
            row.sessionId,
            "⌛ That checkout expired. Send /donate to try again.",
          );
        }
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

/**
 * Recover donations whose row was never written (for example a Worker deployed
 * without the D1 binding). Walks the KV sessions and backfills D1 from the
 * payment API. Sessions that already have a row are skipped.
 */
export type ReconcileSummary = {
  keys: number;
  checked: number;
  completed: number;
  expired: number;
  skipped: number;
  errors: string[];
};

export async function reconcileSessions(
  env: Env,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    keys: 0,
    checked: 0,
    completed: 0,
    expired: 0,
    skipped: 0,
    errors: [],
  };
  if (!env.DB) {
    summary.errors.push("D1 binding is not configured");
    return summary;
  }

  const listed = await env.SESSIONS.list({ prefix: "tg:", limit: 100 });
  summary.keys = listed.keys.length;
  const payment = paymentClient(env);

  for (const key of listed.keys) {
    if (!key.name.endsWith(":latest")) continue;
    const userId = Number(key.name.split(":")[1]);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    summary.checked++;

    let session: Session;
    try {
      const raw = await env.SESSIONS.get(key.name);
      if (!raw) {
        summary.skipped++;
        continue;
      }
      session = JSON.parse(raw) as Session;
    } catch (error) {
      summary.skipped++;
      summary.errors.push(`${key.name}: ${errorMessage(error)}`);
      continue;
    }
    if (!session.sessionId) {
      summary.skipped++;
      continue;
    }

    if (await getDonationBySession(env, session.sessionId)) {
      summary.skipped++;
      continue;
    }

    try {
      const status = await payment.getCheckoutStatus(session.sessionId);
      if (status.status === "completed") {
        await ensureUser(env, userId);
        await upsertDonation(
          env,
          {
            userId,
            sessionId: session.sessionId,
            amountMinor: session.amountMinor,
            gateway: "unknown",
            status: "completed",
            orderId: status.orderId,
            completedAt: Date.now(),
          },
          true,
        );
        await updateCheckoutMessage(
          env,
          userId,
          session.sessionId,
          `✅ Payment received — thank you for donating ${formatEtb(session.amountMinor / 100)}!`,
        );
        summary.completed++;
      } else if (status.status === "expired") {
        await ensureUser(env, userId);
        await upsertDonation(
          env,
          {
            userId,
            sessionId: session.sessionId,
            amountMinor: session.amountMinor,
            gateway: "unknown",
            status: "expired",
          },
          true,
        );
        await updateCheckoutMessage(
          env,
          userId,
          session.sessionId,
          "⌛ That checkout expired. Send /donate to try again.",
        );
        summary.expired++;
      } else {
        summary.skipped++;
        summary.errors.push(`${session.sessionId}: status=${status.status}`);
      }
    } catch (error) {
      summary.errors.push(`${session.sessionId}: ${errorMessage(error)}`);
    }
  }

  return summary;
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
