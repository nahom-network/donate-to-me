import { useState, type ReactNode } from "react";
import {
  Activity,
  CircleCheck,
  CircleDashed,
  CircleAlert,
  Clock,
  Database,
  KeyRound,
  Radio,
  ShieldCheck,
  Users,
} from "lucide-react";
import { api } from "../api";
import { count, dateTime, relativeTime } from "../format";
import { usePolling } from "../hooks";
import type { ReconcileState, SystemInfo } from "../types";
import {
  Card,
  CardHead,
  CopyButton,
  ErrorPanel,
  PageHeader,
  PrimaryButton,
  RefreshButton,
  Skeleton,
  Spinner,
  useToast,
} from "../ui";

const CONFIG_ITEMS = [
  { key: "webhookSecretConfigured", label: "Telegram webhook secret" },
  { key: "paymentTokenConfigured", label: "Payment API token" },
  { key: "productConfigured", label: "Donation product id" },
  { key: "databaseConfigured", label: "D1 database binding" },
  { key: "paymentWebhookSecretConfigured", label: "Payment webhook secret" },
];

const HEADLINES: Record<string, string> = {
  ok: "All systems operational",
  degraded: "Running with a warning",
  misconfigured: "Configuration incomplete",
  error: "Health check failed",
};

export function SystemPage() {
  const { data, error, loading, refresh } =
    usePolling<SystemInfo>("/admin/api/system", 30_000);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const reconcile = async () => {
    setBusy(true);
    try {
      await api("/admin/api/reconcile", { method: "POST" });
      toast(
        "info",
        "Reconciliation started",
        "This runs in the background; the card below updates when it finishes.",
      );
      window.setTimeout(refresh, 1_500);
    } catch (caught) {
      toast(
        "error",
        "Could not start reconciliation",
        caught instanceof Error ? caught.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  const health = data?.health;
  const status = health?.status ?? "error";
  const problem =
    health?.problem ??
    health?.error ??
    "Telegram, the payment rail, and D1 are responding.";
  const webhookState = !health?.webhook
    ? { label: "unavailable", tone: "tone-rose" }
    : !health.webhook.url
      ? { label: "not registered", tone: "is-warn" }
      : health.webhook.lastErrorMessage
        ? { label: "delivery warning", tone: "is-warn" }
        : { label: "healthy", tone: "is-ok" };
  const reconcileRunning =
    data?.reconcile.status === "running" &&
    Boolean(data.reconcile.startedAt) &&
    Date.now() - (data.reconcile.startedAt ?? 0) < 5 * 60 * 1000;

  return (
    <div className="page">
      <PageHeader
        eyebrow="System"
        title="The plumbing, exposed."
        subtitle="Webhook health, configuration, session policy, and the recovery tools — without leaving the console."
        actions={<RefreshButton onClick={refresh} loading={loading} />}
      />

      {error ? <ErrorPanel message={error} onRetry={refresh} /> : null}

      {!data ? (
        loading ? (
          <SystemSkeleton />
        ) : (
          <ErrorPanel message="No system data available." onRetry={refresh} />
        )
      ) : (
        <>
          <Card className={`system-hero hero-${status}`}>
            <div className="system-hero-main">
              <span className="system-orb">
                {status === "ok" ? (
                  <ShieldCheck size={24} />
                ) : status === "error" || status === "misconfigured" ? (
                  <CircleAlert size={24} />
                ) : (
                  <Activity size={24} />
                )}
              </span>
              <div>
                <p className="eyebrow">System status</p>
                <h2>{HEADLINES[status] ?? "Unknown state"}</h2>
                <p>{problem}</p>
              </div>
              <span className={`status-big status-big-${status}`}>
                <span className="status-dot" />
                {status}
              </span>
            </div>
            <div className="system-stats">
              <MiniStat
                icon={<Users size={14} />}
                label="People"
                value={count(data.stats?.users ?? 0)}
              />
              <MiniStat
                icon={<Activity size={14} />}
                label="Checkouts"
                value={count(data.stats?.donations ?? 0)}
              />
              <MiniStat
                icon={<CircleDashed size={14} />}
                label="Pending"
                value={count(data.stats?.pending ?? 0)}
              />
              <MiniStat
                icon={<Clock size={14} />}
                label="Last checkout"
                value={relativeTime(data.stats?.lastDonationAt ?? null)}
              />
            </div>
          </Card>

          <div className="split-grid">
            <Card>
              <CardHead
                eyebrow="Environment"
                title="Configuration"
                action={
                  <span className="muted-note">
                    {CONFIG_ITEMS.filter(
                      (item) => health?.config?.[item.key],
                    ).length}
                    /{CONFIG_ITEMS.length} ready
                  </span>
                }
              />
              <div className="config-list">
                {CONFIG_ITEMS.map((item) => {
                  const ok = Boolean(health?.config?.[item.key]);
                  return (
                    <div
                      key={item.key}
                      className={`config-row ${ok ? "is-ok" : "is-bad"}`}
                    >
                      {ok ? (
                        <CircleCheck size={15} />
                      ) : (
                        <CircleAlert size={15} />
                      )}
                      <span>{item.label}</span>
                      <strong>{ok ? "Configured" : "Missing"}</strong>
                    </div>
                  );
                })}
                <div className="config-sep" />
                <div
                  className={`config-row ${
                    data.dashboard.oidcConfigured ? "is-ok" : "is-bad"
                  }`}
                >
                  <KeyRound size={15} />
                  <span>Telegram OIDC client</span>
                  <strong>
                    {data.dashboard.oidcConfigured ? "Configured" : "Missing"}
                  </strong>
                </div>
                <div
                  className={`config-row ${
                    data.dashboard.sessionSecretConfigured
                      ? "is-ok"
                      : "is-bad"
                  }`}
                >
                  <ShieldCheck size={15} />
                  <span>Session signing secret</span>
                  <strong>
                    {data.dashboard.sessionSecretConfigured
                      ? "Configured"
                      : "Missing"}
                  </strong>
                </div>
              </div>
            </Card>

            <Card>
              <CardHead
                eyebrow="Telegram"
                title="Webhook"
                action={
                  <span className={`small-state ${webhookState.tone}`}>
                    <span className="status-dot" />
                    {webhookState.label}
                  </span>
                }
              />
              <dl className="detail-list">
                <InfoRow
                  label="Registered URL"
                  value={health?.webhook?.url || "not registered"}
                  copy={
                    health?.webhook?.url ? health.webhook.url : undefined
                  }
                />
                <InfoRow
                  label="Expected URL"
                  value={
                    health?.webhook?.expectedUrl ||
                    "learned from the first update"
                  }
                />
                <InfoRow
                  label="Pending updates"
                  value={count(
                    health?.webhook?.pendingUpdateCount ?? 0,
                  )}
                />
                <InfoRow
                  label="Last delivery error"
                  value={health?.webhook?.lastErrorMessage || "none"}
                />
                <InfoRow
                  label="Last error at"
                  value={
                    health?.webhook?.lastErrorDate
                      ? dateTime(health.webhook.lastErrorDate * 1000)
                      : "—"
                  }
                />
              </dl>
              {health?.problem ? (
                <div className="inline-note">
                  <CircleAlert size={14} />
                  <span>{health.problem}</span>
                </div>
              ) : null}
            </Card>
          </div>

          <div className="split-grid">
            <Card>
              <CardHead
                eyebrow="Allowlist"
                title="Who can get in"
                action={
                  <span className="muted-note">
                    {count(data.dashboard.allowlistCount)} admin
                    {data.dashboard.allowlistCount === 1 ? "" : "s"}
                  </span>
                }
              />
              <div className="allowlist">
                {data.dashboard.allowlist.map((id) => (
                  <span
                    key={id}
                    className={`id-chip ${
                      id === data.dashboard.admin.id ? "is-you" : ""
                    }`}
                  >
                    <Users size={12} />
                    {id}
                    {id === data.dashboard.admin.id ? <em>you</em> : null}
                  </span>
                ))}
                {data.dashboard.allowlist.length === 0 ? (
                  <span className="dim">No ids configured.</span>
                ) : null}
              </div>
              <div className="code-block">
                <code>
                  ADMIN_TELEGRAM_IDS = &quot;
                  {data.dashboard.allowlist.join(",")}&quot;
                </code>
                <CopyButton
                  value={`ADMIN_TELEGRAM_IDS = "${data.dashboard.allowlist.join(",")}"`}
                />
              </div>
              <p className="card-note">
                Edit <code>wrangler.toml</code> and redeploy to change this
                list. Access is re-checked on every request, so removing an id
                revokes an existing session immediately.
              </p>
            </Card>

            <Card>
              <CardHead
                eyebrow="OIDC + session"
                title="Sign-in policy"
                action={
                  <span className="small-state is-ok">
                    <span className="status-dot" />
                    {data.dashboard.environment}
                  </span>
                }
              />
              <dl className="detail-list">
                <InfoRow
                  label="Client id"
                  value={data.dashboard.clientId || "missing"}
                />
                <InfoRow
                  label="Issuer"
                  value={data.dashboard.issuer}
                />
                <InfoRow
                  label="Scopes"
                  value={data.dashboard.scopes.join(" ")}
                />
                <InfoRow
                  label="Callback URL"
                  value={data.dashboard.callbackUrl}
                  copy={data.dashboard.callbackUrl}
                />
                <InfoRow
                  label="Session length"
                  value={`${data.dashboard.sessionTtlSeconds / 3600} hours`}
                />
                <InfoRow
                  label="This session expires"
                  value={dateTime(data.dashboard.admin.expiresAt)}
                />
              </dl>
            </Card>
          </div>

          <Card className="reconcile-card">
            <CardHead
              eyebrow="Recovery"
              title="Reconcile checkouts"
              action={
                <PrimaryButton
                  type="button"
                  onClick={reconcile}
                  loading={busy}
                  disabled={reconcileRunning}
                >
                  Run reconciliation
                </PrimaryButton>
              }
            />
            <p className="card-lede">
              Walks every cached KV session and pending row, asks the payment
              rail for the real status, and backfills anything D1 missed. It
              runs in the background so the request returns immediately.
            </p>
            <ReconcilePanel state={data.reconcile} />
          </Card>

          <p className="sync-note">
            <span className="sync-dot" />
            Health is re-read every 30 seconds. Configuration changes require
            a redeploy.
          </p>
        </>
      )}
    </div>
  );
}

function MiniStat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="mini-stat">
      <span className="mini-stat-icon">{icon}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  copy,
}: {
  label: string;
  value: string;
  copy?: string;
}) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd title={value}>
        <span className="detail-value">{value}</span>
        {copy ? <CopyButton value={copy} /> : null}
      </dd>
    </div>
  );
}

function ReconcilePanel({ state }: { state: ReconcileState }) {
  const summary = state.sessions;
  const labels: Record<string, string> = {
    idle: "Never run from the dashboard",
    running: "Running now",
    done: "Last run finished",
    error: "Last run failed",
  };
  const tone =
    state.status === "running"
      ? "gold"
      : state.status === "done"
        ? "mint"
        : state.status === "error"
          ? "rose"
          : "dim";

  return (
    <div className="reconcile-panel">
      <div className="reconcile-head">
        <span className={`small-state tone-${tone}`}>
          {state.status === "running" ? (
            <Spinner size={13} />
          ) : (
            <span className="status-dot" />
          )}
          {labels[state.status]}
        </span>
        {state.finishedAt ? (
          <span className="muted-note">
            {relativeTime(state.finishedAt)}
          </span>
        ) : state.startedAt ? (
          <span className="muted-note">
            started {relativeTime(state.startedAt)}
          </span>
        ) : null}
      </div>

      {state.status === "done" && summary ? (
        <>
          <div className="reconcile-grid">
            <ReconcileCell label="Sessions scanned" value={summary.keys} />
            <ReconcileCell label="Checked" value={summary.checked} />
            <ReconcileCell label="Recovered" value={summary.completed} tone />
            <ReconcileCell
              label="Expired"
              value={summary.expired}
              warn
            />
            <ReconcileCell label="Skipped" value={summary.skipped} />
          </div>
          {summary.errors.length > 0 ? (
            <details className="reconcile-errors">
              <summary>
                {summary.errors.length} warning
                {summary.errors.length === 1 ? "" : "s"}
              </summary>
              <ul>
                {summary.errors.slice(0, 12).map((entry, index) => (
                  <li key={`${entry}-${index}`}>{entry}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      {state.status === "error" ? (
        <div className="inline-note is-bad">
          <CircleAlert size={14} />
          <span>{state.error ?? "Unknown error"}</span>
        </div>
      ) : null}

      {state.status === "idle" ? (
        <div className="reconcile-idle">
          <Database size={16} />
          <p>
            Safe to run at any time. Completed donations never regress, and
            sessions are de-duplicated by event id.
          </p>
          <Radio size={16} />
        </div>
      ) : null}
    </div>
  );
}

function ReconcileCell({
  label,
  value,
  tone,
  warn,
}: {
  label: string;
  value: number;
  tone?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="reconcile-cell">
      <strong className={tone ? "tone-mint" : warn ? "tone-gold" : ""}>
        {count(value)}
      </strong>
      <span>{label}</span>
    </div>
  );
}

function SystemSkeleton() {
  return (
    <div className="system-skeleton" aria-busy="true">
      <Card>
        <Skeleton className="sk-line sk-w-30" />
        <Skeleton className="sk-line sk-hero" />
      </Card>
      <div className="split-grid">
        <Card>
          <Skeleton className="sk-block" />
        </Card>
        <Card>
          <Skeleton className="sk-block" />
        </Card>
      </div>
    </div>
  );
}
