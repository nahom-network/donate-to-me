import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ReceiptText,
  Search,
  X,
} from "lucide-react";
import {
  birr,
  count,
  dateTime,
  relativeTime,
  statusLabel,
} from "../format";
import {
  useBodyLock,
  useDebounced,
  useEscape,
  usePolling,
} from "../hooks";
import type { Donation, DonationsResponse } from "../types";
import {
  Avatar,
  Card,
  CardHead,
  EmptyState,
  ErrorPanel,
  GatewayChip,
  PageHeader,
  RefreshButton,
  Segmented,
  Skeleton,
  StatusPill,
  useToast,
} from "../ui";

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "pending", label: "Pending" },
  { value: "expired", label: "Expired" },
];

const PAGE_SIZE = 25;

export function DonationsPage() {
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [status, setStatus] = useState("all");
  const [gateway, setGateway] = useState("all");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Donation | null>(null);
  const debouncedQuery = useDebounced(query, 350);

  const path = useMemo(() => {
    const params = new URLSearchParams({
      status,
      gateway,
      q: debouncedQuery,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    return `/admin/api/donations?${params.toString()}`;
  }, [status, gateway, debouncedQuery, offset]);

  const { data, error, loading, refresh } =
    usePolling<DonationsResponse>(path, 30_000);

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Donations"
        title="Every checkout, accounted for."
        subtitle="Search by supporter, session id, or order reference. Completed rows never regress."
        actions={<RefreshButton onClick={refresh} loading={loading} />}
      />

      {error ? <ErrorPanel message={error} onRetry={refresh} /> : null}

      <Card className="table-card">
        <CardHead
          eyebrow="Ledger"
          title="Checkout history"
          action={
            <span className="muted-note">
              {count(total)} row{total === 1 ? "" : "s"}
            </span>
          }
        />

        <div className="toolbar">
          <label className="search-field">
            <Search size={16} />
            <input
              type="search"
              value={query}
              placeholder="Search name, @username, session or order id"
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
              aria-label="Search donations"
            />
            {query ? (
              <button
                type="button"
                className="search-clear"
                onClick={() => {
                  setQuery("");
                  setOffset(0);
                }}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            ) : null}
          </label>

          <div className="toolbar-right">
            <Segmented
              value={status}
              options={STATUS_OPTIONS}
              onChange={(value) => {
                setStatus(value);
                setOffset(0);
              }}
              label="Filter by status"
            />
            <select
              className="select"
              value={gateway}
              onChange={(event) => {
                setGateway(event.target.value);
                setOffset(0);
              }}
              aria-label="Filter by payment rail"
            >
              <option value="all">All rails</option>
              <option value="telebirr">Telebirr</option>
              <option value="mpesa">M-Pesa</option>
              <option value="cbe">CBE Birr</option>
            </select>
          </div>
        </div>

        {!data && loading ? (
          <div className="table-loading" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((row) => (
              <div className="table-skeleton" key={row}>
                <Skeleton className="sk-avatar" />
                <Skeleton className="sk-line sk-w-50" />
                <Skeleton className="sk-line sk-w-30" />
                <Skeleton className="sk-line sk-w-20" />
              </div>
            ))}
          </div>
        ) : data && data.items.length ? (
          <>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Supporter</th>
                    <th className="num">Amount</th>
                    <th>Rail</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Reference</th>
                    <th aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((donation) => (
                    <tr
                      key={donation.id}
                      tabIndex={0}
                      onClick={() => setSelected(donation)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(donation);
                        }
                      }}
                    >
                      <td>
                        <div className="donor-cell">
                          <Avatar name={donation.firstName} size={32} />
                          <div>
                            <strong>{donation.firstName ?? "Anonymous"}</strong>
                            <span>
                              {donation.username
                                ? `@${donation.username}`
                                : `id ${donation.userId}`}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="num">
                        {birr(donation.amountMinor)}
                        <small>ETB</small>
                      </td>
                      <td>
                        <GatewayChip gateway={donation.gateway} />
                      </td>
                      <td>
                        <StatusPill status={donation.status} />
                      </td>
                      <td>
                        <span className="cell-time">
                          {relativeTime(donation.createdAt)}
                        </span>
                        <span className="cell-sub">
                          {dateTime(donation.createdAt)}
                        </span>
                      </td>
                      <td>
                        <span className="mono-ref" title={reference(donation)}>
                          {reference(donation)}
                        </span>
                      </td>
                      <td>
                        <ChevronRight size={15} className="row-chevron" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <footer className="table-foot">
              <span>
                Showing {from}–{to} of {count(total)}
              </span>
              <div className="pager">
                <button
                  type="button"
                  className="btn btn-icon"
                  disabled={!hasPrev}
                  onClick={() =>
                    setOffset(Math.max(0, offset - PAGE_SIZE))
                  }
                  aria-label="Previous page"
                >
                  <ChevronLeft size={15} />
                </button>
                <span className="pager-page">
                  {Math.floor(offset / PAGE_SIZE) + 1}
                </span>
                <button
                  type="button"
                  className="btn btn-icon"
                  disabled={!hasNext}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  aria-label="Next page"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </footer>
          </>
        ) : (
          <EmptyState
            title={
              query || status !== "all" || gateway !== "all"
                ? "Nothing matches these filters"
                : "No checkouts yet"
            }
            detail={
              query || status !== "all" || gateway !== "all"
                ? "Try a different search, status, or rail."
                : "Checkouts appear here as soon as someone taps Donate."
            }
            icon={<ReceiptText size={20} />}
          />
        )}
      </Card>

      <p className="sync-note page-note">
        Click a row for the full timeline, order reference, and Telegram
        identity. Times are shown in your local timezone.
      </p>

      {selected ? (
        <DonationDrawer
          donation={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function reference(donation: Donation): string {
  const value = donation.orderId ?? donation.sessionId;
  return value.length > 18
    ? `${value.slice(0, 8)}…${value.slice(-6)}`
    : value;
}

function DonationDrawer({
  donation,
  onClose,
}: {
  donation: Donation;
  onClose: () => void;
}) {
  useBodyLock(true);
  useEscape(onClose, true);
  const toast = useToast();

  const settled = donation.status === "completed";
  const expired = donation.status === "expired";

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast("ok", `${label} copied`);
    } catch {
      toast("error", "Could not copy", "Clipboard access was blocked.");
    }
  };

  return (
    <div
      className="drawer-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`Donation ${donation.id}`}
    >
      <button
        type="button"
        className="drawer-scrim"
        onClick={onClose}
        aria-label="Close details"
      />
      <aside className="drawer">
        <header className="drawer-head">
          <div>
            <p className="eyebrow">Donation #{donation.id}</p>
            <h2>
              {birr(donation.amountMinor)}
              <small>ETB</small>
            </h2>
          </div>
          <div className="drawer-actions">
            <StatusPill status={donation.status} />
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label="Close details"
            >
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="drawer-body">
          <section className="drawer-section">
            <p className="drawer-label">Supporter</p>
            <div className="donor-card">
              <Avatar name={donation.firstName} size={44} />
              <div>
                <strong>{donation.firstName ?? "Anonymous"}</strong>
                <span>
                  {donation.username
                    ? `@${donation.username}`
                    : `Telegram id ${donation.userId}`}
                </span>
              </div>
              {donation.username ? (
                <a
                  className="btn btn-sm"
                  href={`https://t.me/${donation.username}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={13} /> Telegram
                </a>
              ) : null}
            </div>
          </section>

          <section className="drawer-section">
            <p className="drawer-label">Timeline</p>
            <ol className="timeline">
              <li className="is-done">
                <span className="tl-dot" />
                <div>
                  <strong>Checkout created</strong>
                  <small>{dateTime(donation.createdAt)}</small>
                </div>
              </li>
              <li
                className={
                  settled ? "is-done" : expired ? "is-warn" : "is-live"
                }
              >
                <span className="tl-dot" />
                <div>
                  <strong>
                    {settled
                      ? "Payment settled"
                      : expired
                        ? "Checkout expired"
                        : "Awaiting confirmation"}
                  </strong>
                  <small>
                    {settled
                      ? dateTime(donation.completedAt)
                      : expired
                        ? "No confirmation was received"
                        : "The payment rail has not confirmed yet"}
                  </small>
                </div>
              </li>
            </ol>
          </section>

          <section className="drawer-section">
            <p className="drawer-label">Payment</p>
            <dl className="detail-list">
              <Detail label="Rail">
                <GatewayChip gateway={donation.gateway} />
              </Detail>
              <Detail label="Amount">
                {birr(donation.amountMinor)} ETB
              </Detail>
              <Detail label="Currency">{donation.currency}</Detail>
              <Detail label="Status">{statusLabel(donation.status)}</Detail>
              <Detail label="Order id">
                {donation.orderId ? (
                  <button
                    type="button"
                    className="mono-button"
                    onClick={() => copy(donation.orderId!, "Order id")}
                    title={donation.orderId}
                  >
                    {donation.orderId}
                  </button>
                ) : (
                  <span className="dim">not assigned yet</span>
                )}
              </Detail>
              <Detail label="Session id">
                <button
                  type="button"
                  className="mono-button"
                  onClick={() => copy(donation.sessionId, "Session id")}
                  title={donation.sessionId}
                >
                  {donation.sessionId}
                </button>
              </Detail>
              <Detail label="Telegram id">
                <button
                  type="button"
                  className="mono-button"
                  onClick={() =>
                    copy(String(donation.userId), "Telegram id")
                  }
                >
                  {donation.userId}
                </button>
              </Detail>
            </dl>
          </section>

          {donation.status === "pending" ? (
            <div className="drawer-note">
              <ReceiptText size={15} />
              <p>
                Pending checkouts are re-checked by the 15-minute cron and can
                also be refreshed from the Reconcile button. A completed row
                never moves backwards.
              </p>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
