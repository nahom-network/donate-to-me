import type { Env } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export type DonationStatus = "pending" | "completed" | "expired";

export type DonationRow = {
  id: number;
  sessionId: string;
  amountMinor: number;
  currency: string;
  gateway: string;
  status: DonationStatus;
  orderId: string | null;
  createdAt: number;
  completedAt: number | null;
  userId: number;
  firstName: string | null;
  username: string | null;
};

export type DonorRow = {
  userId: number;
  firstName: string | null;
  username: string | null;
  donationCount: number;
  totalMinor: number;
  avgMinor: number;
  firstAt: number | null;
  lastAt: number | null;
};

export type SeriesPoint = {
  date: string;
  amountMinor: number;
  donations: number;
  checkouts: number;
  expired: number;
};

export type GatewayRow = {
  gateway: string;
  count: number;
  amountMinor: number;
  share: number;
};

export type Overview = {
  generatedAt: number;
  range: { days: number; from: number; to: number };
  totals: {
    completedCount: number;
    completedMinor: number;
    expiredCount: number;
    expiredMinor: number;
    pendingCount: number;
    pendingMinor: number;
    donors: number;
    avgMinor: number;
    settlementRate: number;
    checkouts: number;
  };
  period: {
    completedCount: number;
    completedMinor: number;
    donors: number;
    checkouts: number;
    expired: number;
    settlementRate: number;
    previous: {
      completedCount: number;
      completedMinor: number;
      donors: number;
      revenueChange: number;
      donationChange: number;
    };
  };
  today: { count: number; amountMinor: number };
  last24h: { count: number; amountMinor: number };
  series: SeriesPoint[];
  gateways: GatewayRow[];
  recent: DonationRow[];
  topDonors: DonorRow[];
  pending: { count: number; amountMinor: number; oldestAt: number | null };
};

type CountRow = { status: string; count: number; amountMinor: number };
type AggregateRow = { count: number; amountMinor: number; donors: number };
type PendingRow = {
  count: number;
  amountMinor: number;
  oldestAt: number | null;
};

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rows<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as unknown as T[];
}

function first<T>(result: D1Result | undefined): T | undefined {
  return rows<T>(result)[0];
}

function rate(completed: number, expired: number): number {
  const settled = completed + expired;
  return settled > 0 ? (completed / settled) * 100 : 0;
}

function change(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function startOfUtcDay(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new Error("D1 binding is not configured");
  return env.DB;
}

/**
 * One batched round trip for the whole overview screen. D1 executes the
 * statements sequentially, so reading them through a single batch keeps the
 * dashboard refresh cheap.
 */
export async function getOverview(env: Env, days: number): Promise<Overview> {
  const db = requireDb(env);
  const now = Date.now();
  const span = Math.min(Math.max(Math.trunc(days), 1), 365);
  const from = startOfUtcDay(now - (span - 1) * DAY_MS);
  const previousFrom = from - span * DAY_MS;

  const results = await db.batch([
    // 0 — all-time totals by status
    db.prepare(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount_minor), 0) AS amountMinor
       FROM donations GROUP BY status`,
    ),
    // 1 — all-time completed aggregate
    db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(amount_minor), 0) AS amountMinor,
              COUNT(DISTINCT user_id) AS donors
       FROM donations WHERE status = 'completed'`,
    ),
    // 2 — completed in the selected window
    db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(amount_minor), 0) AS amountMinor,
              COUNT(DISTINCT user_id) AS donors
       FROM donations
       WHERE status = 'completed' AND completed_at >= ? AND completed_at <= ?`,
    ).bind(from, now),
    // 3 — completed in the preceding window
    db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(amount_minor), 0) AS amountMinor,
              COUNT(DISTINCT user_id) AS donors
       FROM donations
       WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?`,
    ).bind(previousFrom, from),
    // 4 — attempts created in the selected window, by status
    db.prepare(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount_minor), 0) AS amountMinor
       FROM donations WHERE created_at >= ? GROUP BY status`,
    ).bind(from),
    // 5 — completed value per day
    db.prepare(
      `SELECT strftime('%Y-%m-%d', completed_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS count,
              COALESCE(SUM(amount_minor), 0) AS amountMinor
       FROM donations
       WHERE status = 'completed' AND completed_at >= ?
       GROUP BY day`,
    ).bind(from),
    // 6 — checkouts created per day, by status
    db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              status, COUNT(*) AS count
       FROM donations WHERE created_at >= ?
       GROUP BY day, status`,
    ).bind(from),
    // 7 — payment rails in the window
    db.prepare(
      `SELECT gateway, COUNT(*) AS count,
              COALESCE(SUM(amount_minor), 0) AS amountMinor
       FROM donations
       WHERE status = 'completed' AND completed_at >= ?
       GROUP BY gateway ORDER BY amountMinor DESC`,
    ).bind(from),
    // 8 — newest checkouts
    db.prepare(
      `SELECT d.id, d.session_id AS sessionId, d.amount_minor AS amountMinor,
              d.currency, d.gateway, d.status, d.order_id AS orderId,
              d.created_at AS createdAt, d.completed_at AS completedAt,
              d.user_id AS userId, u.first_name AS firstName, u.username
       FROM donations d LEFT JOIN users u ON u.id = d.user_id
       ORDER BY d.created_at DESC LIMIT 8`,
    ),
    // 9 — leading supporters
    db.prepare(
      `SELECT u.id AS userId, u.first_name AS firstName, u.username,
              COUNT(*) AS donationCount,
              COALESCE(SUM(d.amount_minor), 0) AS totalMinor,
              COALESCE(AVG(d.amount_minor), 0) AS avgMinor,
              MIN(d.completed_at) AS firstAt, MAX(d.completed_at) AS lastAt
       FROM donations d JOIN users u ON u.id = d.user_id
       WHERE d.status = 'completed'
       GROUP BY u.id
       ORDER BY totalMinor DESC, donationCount DESC LIMIT 5`,
    ),
    // 10 — money still in flight
    db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(amount_minor), 0) AS amountMinor,
              MIN(created_at) AS oldestAt
       FROM donations WHERE status = 'pending'`,
    ),
    // 11 — last 24 hours
    db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(amount_minor), 0) AS amountMinor
       FROM donations WHERE status = 'completed' AND completed_at >= ?`,
    ).bind(now - DAY_MS),
    // 12 — today (UTC)
    db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(amount_minor), 0) AS amountMinor
       FROM donations WHERE status = 'completed' AND completed_at >= ?`,
    ).bind(startOfUtcDay(now)),
  ]);

  const statuses = rows<CountRow>(results[0]);
  const allTime = first<AggregateRow>(results[1]) ?? {
    count: 0,
    amountMinor: 0,
    donors: 0,
  };
  const current = first<AggregateRow>(results[2]) ?? {
    count: 0,
    amountMinor: 0,
    donors: 0,
  };
  const previous = first<AggregateRow>(results[3]) ?? {
    count: 0,
    amountMinor: 0,
    donors: 0,
  };
  const attempts = rows<CountRow>(results[4]);
  const revenueDays = rows<{ day: string; count: number; amountMinor: number }>(
    results[5],
  );
  const attemptDays = rows<{ day: string; status: string; count: number }>(
    results[6],
  );
  const gatewayRows = rows<{
    gateway: string;
    count: number;
    amountMinor: number;
  }>(results[7]);
  const recent = rows<DonationRow>(results[8]);
  const topDonors = rows<DonorRow>(results[9]);
  const pending = first<PendingRow>(results[10]) ?? {
    count: 0,
    amountMinor: 0,
    oldestAt: null,
  };
  const last24h = first<AggregateRow>(results[11]) ?? {
    count: 0,
    amountMinor: 0,
    donors: 0,
  };
  const today = first<AggregateRow>(results[12]) ?? {
    count: 0,
    amountMinor: 0,
    donors: 0,
  };

  const byStatus = new Map(
    statuses.map((row) => [
      row.status,
      { count: num(row.count), amountMinor: num(row.amountMinor) },
    ]),
  );
  const completedAll = byStatus.get("completed") ?? {
    count: 0,
    amountMinor: 0,
  };
  const expiredAll = byStatus.get("expired") ?? { count: 0, amountMinor: 0 };
  const pendingAll = byStatus.get("pending") ?? { count: 0, amountMinor: 0 };

  const created = new Map(
    attempts.map((row) => [
      row.status,
      { count: num(row.count), amountMinor: num(row.amountMinor) },
    ]),
  );
  const createdCompleted = created.get("completed")?.count ?? 0;
  const createdExpired = created.get("expired")?.count ?? 0;
  const createdPending = created.get("pending")?.count ?? 0;

  const revenueByDay = new Map(
    revenueDays.map((row) => [
      row.day,
      { count: num(row.count), amountMinor: num(row.amountMinor) },
    ]),
  );
  const attemptsByDay = new Map<string, { total: number; expired: number }>();
  for (const row of attemptDays) {
    const bucket = attemptsByDay.get(row.day) ?? { total: 0, expired: 0 };
    bucket.total += num(row.count);
    if (row.status === "expired") bucket.expired += num(row.count);
    attemptsByDay.set(row.day, bucket);
  }

  const series: SeriesPoint[] = [];
  for (let index = 0; index < span; index++) {
    const date = new Date(from + index * DAY_MS).toISOString().slice(0, 10);
    const revenue = revenueByDay.get(date);
    const activity = attemptsByDay.get(date);
    series.push({
      date,
      amountMinor: revenue?.amountMinor ?? 0,
      donations: revenue?.count ?? 0,
      checkouts: activity?.total ?? 0,
      expired: activity?.expired ?? 0,
    });
  }

  const gatewayTotal = gatewayRows.reduce(
    (sum, row) => sum + num(row.amountMinor),
    0,
  );
  const gateways: GatewayRow[] = gatewayRows.map((row) => ({
    gateway: row.gateway,
    count: num(row.count),
    amountMinor: num(row.amountMinor),
    share:
      gatewayTotal > 0 ? (num(row.amountMinor) / gatewayTotal) * 100 : 0,
  }));

  return {
    generatedAt: now,
    range: { days: span, from, to: now },
    totals: {
      completedCount: num(allTime.count),
      completedMinor: num(allTime.amountMinor),
      expiredCount: expiredAll.count,
      expiredMinor: expiredAll.amountMinor,
      pendingCount: pendingAll.count,
      pendingMinor: pendingAll.amountMinor,
      donors: num(allTime.donors),
      avgMinor:
        num(allTime.count) > 0
          ? Math.round(num(allTime.amountMinor) / num(allTime.count))
          : 0,
      settlementRate: rate(completedAll.count, expiredAll.count),
      checkouts:
        completedAll.count + expiredAll.count + pendingAll.count,
    },
    period: {
      completedCount: num(current.count),
      completedMinor: num(current.amountMinor),
      donors: num(current.donors),
      checkouts: createdCompleted + createdExpired + createdPending,
      expired: createdExpired,
      settlementRate: rate(createdCompleted, createdExpired),
      previous: {
        completedCount: num(previous.count),
        completedMinor: num(previous.amountMinor),
        donors: num(previous.donors),
        revenueChange: change(
          num(current.amountMinor),
          num(previous.amountMinor),
        ),
        donationChange: change(num(current.count), num(previous.count)),
      },
    },
    today: { count: num(today.count), amountMinor: num(today.amountMinor) },
    last24h: {
      count: num(last24h.count),
      amountMinor: num(last24h.amountMinor),
    },
    series,
    gateways,
    recent,
    topDonors,
    pending: {
      count: num(pending.count),
      amountMinor: num(pending.amountMinor),
      oldestAt: pending.oldestAt ? num(pending.oldestAt) : null,
    },
  };
}

export type DonationFilters = {
  status?: string;
  gateway?: string;
  query?: string;
  limit?: number;
  offset?: number;
};

export async function getDonations(
  env: Env,
  filters: DonationFilters,
): Promise<{ items: DonationRow[]; total: number; limit: number; offset: number }> {
  const db = requireDb(env);
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 25), 1), 100);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (
    filters.status === "pending" ||
    filters.status === "completed" ||
    filters.status === "expired"
  ) {
    clauses.push("d.status = ?");
    binds.push(filters.status);
  }
  if (
    filters.gateway === "telebirr" ||
    filters.gateway === "mpesa" ||
    filters.gateway === "cbe"
  ) {
    clauses.push("d.gateway = ?");
    binds.push(filters.gateway);
  }
  const search = (filters.query ?? "").trim().slice(0, 80);
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    clauses.push(
      `(u.first_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\'
        OR d.session_id LIKE ? ESCAPE '\\' OR d.order_id LIKE ? ESCAPE '\\')`,
    );
    binds.push(like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const from = `FROM donations d LEFT JOIN users u ON u.id = d.user_id ${where}`;

  const results = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...binds),
    db
      .prepare(
        `SELECT d.id, d.session_id AS sessionId, d.amount_minor AS amountMinor,
                d.currency, d.gateway, d.status, d.order_id AS orderId,
                d.created_at AS createdAt, d.completed_at AS completedAt,
                d.user_id AS userId, u.first_name AS firstName, u.username
         ${from}
         ORDER BY d.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset),
  ]);

  return {
    items: rows<DonationRow>(results[1]),
    total: num(first<{ total: number }>(results[0])?.total),
    limit,
    offset,
  };
}

export async function getDonors(
  env: Env,
  query: string,
  limit = 50,
): Promise<{ items: DonorRow[]; total: number }> {
  const db = requireDb(env);
  const take = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const search = query.trim().slice(0, 80);
  const like = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const where = search
    ? `AND (u.first_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')`
    : "";
  const binds = search ? [like, like] : [];

  const results = await db.batch([
    db
      .prepare(
        `SELECT COUNT(DISTINCT u.id) AS total
         FROM donations d JOIN users u ON u.id = d.user_id
         WHERE d.status = 'completed' ${where}`,
      )
      .bind(...binds),
    db
      .prepare(
        `SELECT u.id AS userId, u.first_name AS firstName, u.username,
                COUNT(*) AS donationCount,
                COALESCE(SUM(d.amount_minor), 0) AS totalMinor,
                COALESCE(AVG(d.amount_minor), 0) AS avgMinor,
                MIN(d.completed_at) AS firstAt, MAX(d.completed_at) AS lastAt
         FROM donations d JOIN users u ON u.id = d.user_id
         WHERE d.status = 'completed' ${where}
         GROUP BY u.id
         ORDER BY totalMinor DESC, donationCount DESC
         LIMIT ?`,
      )
      .bind(...binds, take),
  ]);

  return {
    items: rows<DonorRow>(results[1]),
    total: num(first<{ total: number }>(results[0])?.total),
  };
}

export type SystemStats = {
  users: number;
  donations: number;
  pending: number;
  lastDonationAt: number | null;
  oldestPendingAt: number | null;
};

export async function getSystemStats(env: Env): Promise<SystemStats> {
  const db = requireDb(env);
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM donations) AS donations,
              (SELECT COUNT(*) FROM donations WHERE status = 'pending') AS pending,
              (SELECT MAX(created_at) FROM donations) AS lastDonationAt,
              (SELECT MIN(created_at) FROM donations WHERE status = 'pending') AS oldestPendingAt`,
    )
    .first<SystemStats>();
  return {
    users: num(row?.users),
    donations: num(row?.donations),
    pending: num(row?.pending),
    lastDonationAt: row?.lastDonationAt ? num(row.lastDonationAt) : null,
    oldestPendingAt: row?.oldestPendingAt ? num(row.oldestPendingAt) : null,
  };
}
