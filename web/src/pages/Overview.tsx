import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDownRight,
  ArrowUpRight,
  Percent,
  ReceiptText,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { AreaChart, Donut, Sparkline } from "../charts";
import {
  birr,
  birrCompact,
  count,
  gatewayColor,
  gatewayLabel,
  percent,
  relativeTime,
  signedPercent,
} from "../format";
import { useAnimatedNumber, usePolling } from "../hooks";
import type { Overview } from "../types";
import {
  Avatar,
  Card,
  CardHead,
  EmptyState,
  ErrorPanel,
  GatewayChip,
  LiveBadge,
  PageHeader,
  RefreshButton,
  Segmented,
  Skeleton,
  StatusPill,
} from "../ui";

const RANGES = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
];

export function OverviewPage() {
  const [range, setRange] = useState("30");
  const [metric, setMetric] = useState<"value" | "volume">("value");
  const { data, error, loading, updatedAt, refresh } = usePolling<Overview>(
    `/admin/api/overview?days=${range}`,
    20_000,
  );
  const heroValue = useAnimatedNumber(
    data ? data.period.completedMinor / 100 : 0,
  );

  return (
    <div className="page">
      <PageHeader
        eyebrow="Overview"
        title="The money, at a glance."
        subtitle="Settled donations, live checkouts, and the rails people use."
        actions={
          <div className="head-tools">
            <Segmented
              value={range}
              options={RANGES}
              onChange={setRange}
              label="Date range"
            />
            <RefreshButton onClick={refresh} loading={loading} />
          </div>
        }
      />

      {error ? <ErrorPanel message={error} onRetry={refresh} /> : null}

      {!data ? (
        loading ? (
          <OverviewSkeleton />
        ) : (
          <EmptyState
            title="No dashboard data yet"
            detail="Once D1 is reachable, the overview appears here."
          />
        )
      ) : (
        <>
          <div className="hero-grid">
            <Card className="hero">
              <div className="hero-head">
                <span className="eyebrow">
                  Raised · last {data.range.days} days
                </span>
                <Delta
                  value={data.period.previous.revenueChange}
                  isNew={
                    data.period.previous.completedMinor === 0 &&
                    data.period.completedMinor > 0
                  }
                />
              </div>
              <div className="hero-value">
                <span className="hero-currency">ETB</span>
                <span>{count(Math.round(heroValue))}</span>
              </div>
              <div className="hero-sub">
                <span>
                  <strong>{count(data.period.completedCount)}</strong> settled
                </span>
                <span>
                  <strong>{count(data.period.donors)}</strong> donors
                </span>
                <span>
                  <strong>{percent(data.period.settlementRate)}</strong>{" "}
                  settlement
                </span>
              </div>
              <div className="hero-spark" aria-hidden="true">
                <Sparkline
                  values={data.series.map((point) => point.amountMinor)}
                />
              </div>
            </Card>

            <Card className="pulse-card">
              <CardHead
                eyebrow="Right now"
                title="Live pulse"
                action={<LiveBadge label="Open" />}
              />
              <div className="pulse-main">
                <span className="pulse-orb" aria-hidden="true">
                  <span />
                </span>
                <div className="pulse-figure">
                  <strong>{count(data.pending.count)}</strong>
                  <span>checkouts in flight</span>
                </div>
                <div className="pulse-money">
                  <strong>{birr(data.pending.amountMinor)}</strong>
                  <span>ETB waiting</span>
                </div>
              </div>
              <div className="pulse-rows">
                <PulseRow
                  label="Today"
                  value={`${birr(data.today.amountMinor)} ETB`}
                  meta={`${count(data.today.count)} donations`}
                />
                <PulseRow
                  label="Last 24 hours"
                  value={`${birr(data.last24h.amountMinor)} ETB`}
                  meta={`${count(data.last24h.count)} donations`}
                />
                <PulseRow
                  label="Oldest pending"
                  value={relativeTime(data.pending.oldestAt)}
                  meta={
                    data.pending.oldestAt
                      ? "will expire automatically"
                      : "nothing waiting"
                  }
                />
              </div>
            </Card>
          </div>

          <div className="kpi-grid">
            <Stat
              icon={<Wallet size={17} />}
              label="Total raised"
              value={`${birr(data.totals.completedMinor)} ETB`}
              meta={`${count(data.totals.completedCount)} completed payments`}
              tone="gold"
            />
            <Stat
              icon={<Users size={17} />}
              label="Supporters"
              value={count(data.totals.donors)}
              meta={`${count(data.totals.checkouts)} checkouts all time`}
              tone="mint"
            />
            <Stat
              icon={<TrendingUp size={17} />}
              label="Average gift"
              value={`${birr(data.totals.avgMinor)} ETB`}
              meta="per completed payment"
              tone="violet"
            />
            <Stat
              icon={<Percent size={17} />}
              label="Settlement rate"
              value={percent(data.totals.settlementRate)}
              meta={`${count(data.totals.expiredCount)} expired checkouts`}
              tone="blue"
            />
          </div>

          <div className="split-grid">
            <Card className="chart-card">
              <CardHead
                eyebrow={`${data.range.days} days · UTC`}
                title="Flow of funds"
                action={
                  <Segmented
                    value={metric}
                    options={[
                      { value: "value", label: "Value" },
                      { value: "volume", label: "Volume" },
                    ]}
                    onChange={setMetric}
                    label="Chart metric"
                  />
                }
              />
              <div className="chart-summary">
                <div>
                  <strong>{birr(data.period.completedMinor)}</strong>
                  <span>ETB completed</span>
                </div>
                <div className="chart-legend">
                  <span>
                    <i className="legend-line" />{" "}
                    {metric === "value" ? "Daily value" : "Daily donations"}
                  </span>
                </div>
              </div>
              <AreaChart
                points={data.series.map((point) => ({
                  date: point.date,
                  value:
                    metric === "value" ? point.amountMinor : point.donations,
                  donations: point.donations,
                  checkouts: point.checkouts,
                }))}
                format={
                  metric === "value"
                    ? (value) => `ETB ${birrCompact(value)}`
                    : (value) =>
                        Number.isInteger(value)
                          ? `${value}`
                          : value.toFixed(1)
                }
                metricLabel={metric === "value" ? "Revenue" : "Donations"}
              />
            </Card>

            <Card className="rails-card">
              <CardHead
                eyebrow="Payment rails"
                title="Where money lands"
                action={
                  <span className="muted-note">
                    {data.gateways.length} active
                  </span>
                }
              />
              {data.gateways.length ? (
                <>
                  <Donut
                    segments={data.gateways.map((gateway) => ({
                      label: gatewayLabel(gateway.gateway),
                      value: gateway.amountMinor,
                      color: gatewayColor(gateway.gateway),
                    }))}
                    centerValue={`${birrCompact(data.period.completedMinor)}`}
                    centerLabel="ETB"
                  />
                  <div className="rail-list">
                    {data.gateways.map((gateway) => (
                      <div key={gateway.gateway} className="rail-row">
                        <span
                          className="donut-swatch"
                          style={{ background: gatewayColor(gateway.gateway) }}
                        />
                        <span>{gatewayLabel(gateway.gateway)}</span>
                        <span className="rail-count">
                          {count(gateway.count)} gifts
                        </span>
                        <strong>{birr(gateway.amountMinor)}</strong>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <EmptyState
                  title="No settled payments in this range"
                  detail="Completed checkouts will be split by rail here."
                />
              )}
            </Card>
          </div>

          <div className="split-grid split-bottom">
            <Card className="ledger-card">
              <CardHead
                eyebrow="Newest first"
                title="Live ledger"
                action={
                  <Link className="link" to="/donations">
                    View all <ArrowUpRight size={13} />
                  </Link>
                }
              />
              {data.recent.length ? (
                <div className="ledger">
                  {data.recent.map((donation) => (
                    <Link
                      key={donation.id}
                      className="ledger-row"
                      to={`/donations?q=${encodeURIComponent(donation.sessionId)}`}
                    >
                      <Avatar name={donation.firstName} size={32} />
                      <div className="ledger-who">
                        <strong>{donation.firstName ?? "Anonymous"}</strong>
                        <span>{relativeTime(donation.createdAt)}</span>
                      </div>
                      <GatewayChip gateway={donation.gateway} />
                      <span className="ledger-amount">
                        {birr(donation.amountMinor)}
                        <small>ETB</small>
                      </span>
                      <StatusPill status={donation.status} />
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="No checkouts yet"
                  detail="Send /donate to the bot to see the first row."
                  icon={<ReceiptText size={20} />}
                />
              )}
            </Card>

            <Card className="leaders-card">
              <CardHead
                eyebrow="All time"
                title="Top supporters"
                action={
                  <Link className="link" to="/donors">
                    All supporters <ArrowUpRight size={13} />
                  </Link>
                }
              />
              {data.topDonors.length ? (
                <div className="leaders">
                  {data.topDonors.map((donor, index) => {
                    const top = data.topDonors[0]?.totalMinor || 1;
                    return (
                      <div className="leader" key={donor.userId}>
                        <div className="leader-row">
                          <span className={`rank rank-${index + 1}`}>
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <Avatar name={donor.firstName} size={32} />
                          <div className="leader-who">
                            <strong>{donor.firstName ?? "Anonymous"}</strong>
                            <span>
                              {donor.username
                                ? `@${donor.username}`
                                : `${donor.donationCount} gifts`}
                            </span>
                          </div>
                          <div className="leader-amount">
                            <strong>{birr(donor.totalMinor)}</strong>
                            <span>ETB</span>
                          </div>
                        </div>
                        <div className="leader-track" aria-hidden="true">
                          <span
                            style={{
                              width: `${Math.max(
                                (donor.totalMinor / top) * 100,
                                3,
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  title="No supporters yet"
                  detail="Completed donations build this leaderboard."
                  icon={<Users size={20} />}
                />
              )}
            </Card>
          </div>

          <div className="sync-note">
            <span className={`sync-dot ${loading ? "is-loading" : ""}`} />
            <span>
              Updated {relativeTime(updatedAt)} · refreshes every 20 seconds ·
              chart buckets use UTC days
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Delta({ value, isNew }: { value: number; isNew?: boolean }) {
  const flat = Math.abs(value) < 0.05;
  const up = value > 0;
  return (
    <span
      className={`delta ${flat ? "is-flat" : up ? "is-up" : "is-down"}`}
      title={
        isNew
          ? "No settled revenue in the previous period"
          : "Compared with the previous period"
      }
    >
      {flat ? null : up ? (
        <ArrowUpRight size={13} />
      ) : (
        <ArrowDownRight size={13} />
      )}
      {isNew ? "New" : flat ? "No change" : signedPercent(value)}
    </span>
  );
}

function PulseRow({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <div className="pulse-row">
      <span className="pulse-label">{label}</span>
      <span className="pulse-value">{value}</span>
      <span className="pulse-meta">{meta}</span>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  meta,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  meta: string;
  tone: "gold" | "mint" | "violet" | "blue";
}) {
  return (
    <Card className={`stat stat-${tone}`}>
      <div className="stat-top">
        <span className="stat-icon">{icon}</span>
        <span className="stat-label">{label}</span>
      </div>
      <strong className="stat-value">{value}</strong>
      <span className="stat-meta">{meta}</span>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="overview-skeleton" aria-busy="true" aria-label="Loading">
      <div className="hero-grid">
        <Card className="hero">
          <Skeleton className="sk-line sk-w-30" />
          <Skeleton className="sk-line sk-hero" />
          <Skeleton className="sk-line sk-w-50" />
        </Card>
        <Card>
          <Skeleton className="sk-line sk-w-40" />
          <Skeleton className="sk-block" />
        </Card>
      </div>
      <div className="kpi-grid">
        {[0, 1, 2, 3].map((item) => (
          <Card key={item}>
            <Skeleton className="sk-line sk-w-40" />
            <Skeleton className="sk-line sk-w-60" />
          </Card>
        ))}
      </div>
      <div className="split-grid">
        <Card>
          <Skeleton className="sk-line sk-w-30" />
          <Skeleton className="sk-chart" />
        </Card>
        <Card>
          <Skeleton className="sk-line sk-w-40" />
          <Skeleton className="sk-chart sk-chart-round" />
        </Card>
      </div>
    </div>
  );
}
