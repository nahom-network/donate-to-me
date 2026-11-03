export type Admin = {
  id: number;
  name: string;
  username: string | null;
  picture: string | null;
};

export type SessionInfo = {
  authenticated: boolean;
  ready: boolean;
  config: {
    allowlistCount: number;
    oidcConfigured: boolean;
    sessionSecretConfigured: boolean;
  };
  admin: Admin | null;
};

export type DonationStatus = "pending" | "completed" | "expired";

export type Donation = {
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

export type Donor = {
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

export type Gateway = {
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
  gateways: Gateway[];
  recent: Donation[];
  topDonors: Donor[];
  pending: { count: number; amountMinor: number; oldestAt: number | null };
};

export type DonationsResponse = {
  items: Donation[];
  total: number;
  limit: number;
  offset: number;
};

export type DonorsResponse = {
  items: Donor[];
  total: number;
};

export type ReconcileSummary = {
  keys: number;
  checked: number;
  completed: number;
  expired: number;
  skipped: number;
  errors: string[];
};

export type ReconcileState = {
  status: "idle" | "running" | "done" | "error";
  startedAt?: number;
  finishedAt?: number;
  sessions?: ReconcileSummary;
  error?: string;
};

export type HealthInfo = {
  status: "ok" | "degraded" | "misconfigured" | "error";
  problem?: string | null;
  missingConfig?: string[];
  config?: Record<string, boolean>;
  webhook?: {
    url?: string;
    expectedUrl?: string | null;
    pendingUpdateCount?: number;
    lastErrorDate?: number | null;
    lastErrorMessage?: string | null;
  };
  error?: string;
};

export type SystemInfo = {
  generatedAt: number;
  stats: {
    users: number;
    donations: number;
    pending: number;
    lastDonationAt: number | null;
    oldestPendingAt: number | null;
  } | null;
  health: HealthInfo;
  dashboard: {
    admin: Admin & { expiresAt: number };
    allowlist: number[];
    allowlistCount: number;
    oidcConfigured: boolean;
    sessionSecretConfigured: boolean;
    clientId: string | null;
    issuer: string;
    scopes: string[];
    baseUrl: string;
    callbackUrl: string;
    sessionTtlSeconds: number;
    environment: string;
  };
  reconcile: ReconcileState;
};
