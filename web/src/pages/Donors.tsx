import { useMemo, useState } from "react";
import { Search, Users, X } from "lucide-react";
import {
  birr,
  count,
  relativeTime,
} from "../format";
import { useDebounced, usePolling } from "../hooks";
import type { Donor, DonorsResponse } from "../types";
import {
  Avatar,
  Card,
  CardHead,
  EmptyState,
  ErrorPanel,
  PageHeader,
  RefreshButton,
  Skeleton,
} from "../ui";

export function DonorsPage() {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 350);
  const path = useMemo(
    () =>
      `/admin/api/donors?${new URLSearchParams({
        q: debounced,
        limit: "100",
      }).toString()}`,
    [debounced],
  );
  const { data, error, loading, refresh } =
    usePolling<DonorsResponse>(path, 45_000);

  const items = data?.items ?? [];
  const top = items[0]?.totalMinor || 1;
  const podium = items.slice(0, 3);
  const rest = items.slice(3);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Supporters"
        title="The people behind the number."
        subtitle="Lifetime giving, aggregated across every completed donation. First names only in the bot; identity stays here."
        actions={<RefreshButton onClick={refresh} loading={loading} />}
      />

      {error ? <ErrorPanel message={error} onRetry={refresh} /> : null}

      <div className="toolbar donors-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            type="search"
            value={query}
            placeholder="Search supporters"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search supporters"
          />
          {query ? (
            <button
              type="button"
              className="search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          ) : null}
        </label>
        <span className="muted-note">
          {data ? `${count(data.total)} supporters with completed gifts` : " "}
        </span>
      </div>

      {!data && loading ? (
        <div className="donors-skeleton" aria-busy="true">
          <div className="podium">
            {[0, 1, 2].map((item) => (
              <Card key={item} className="podium-card">
                <Skeleton className="sk-avatar sk-avatar-lg" />
                <Skeleton className="sk-line sk-w-50" />
                <Skeleton className="sk-line sk-w-30" />
              </Card>
            ))}
          </div>
          <Card>
            <Skeleton className="sk-line sk-w-30" />
            <Skeleton className="sk-block" />
          </Card>
        </div>
      ) : items.length ? (
        <>
          <div className="podium">
            {podium.map((donor, index) => (
              <Card
                key={donor.userId}
                className={`podium-card podium-${index + 1}`}
              >
                <span className="podium-medal">{index + 1}</span>
                <Avatar name={donor.firstName} size={54} />
                <div className="podium-who">
                  <strong>{donor.firstName ?? "Anonymous"}</strong>
                  <span>
                    {donor.username
                      ? `@${donor.username}`
                      : `Telegram id ${donor.userId}`}
                  </span>
                </div>
                <div className="podium-amount">
                  {birr(donor.totalMinor)}
                  <small>ETB</small>
                </div>
                <div className="podium-meta">
                  <span>{count(donor.donationCount)} gifts</span>
                  <span className="dot-sep" />
                  <span>avg {birr(donor.avgMinor)}</span>
                </div>
                <div className="podium-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.max((donor.totalMinor / top) * 100, 4)}%`,
                    }}
                  />
                </div>
              </Card>
            ))}
          </div>

          <Card className="board-card">
            <CardHead
              eyebrow="Leaderboard"
              title="Lifetime giving"
              action={
                <span className="muted-note">
                  top {Math.min(items.length, 100)} of {count(data?.total ?? 0)}
                </span>
              }
            />
            {rest.length ? (
              <div className="board">
                {rest.map((donor, index) => (
                  <BoardRow
                    key={donor.userId}
                    donor={donor}
                    rank={index + 4}
                    top={top}
                  />
                ))}
              </div>
            ) : null}
          </Card>
        </>
      ) : (
        <Card>
          <EmptyState
            title={
              query ? "No supporter matches that search" : "No supporters yet"
            }
            detail={
              query
                ? "Try a shorter name or username."
                : "The leaderboard fills up as donations settle."
            }
            icon={<Users size={20} />}
          />
        </Card>
      )}
    </div>
  );
}

function BoardRow({
  donor,
  rank,
  top,
}: {
  donor: Donor;
  rank: number;
  top: number;
}) {
  return (
    <div className="board-row">
      <span className="board-rank">{String(rank).padStart(2, "0")}</span>
      <Avatar name={donor.firstName} size={34} />
      <div className="board-who">
        <strong>{donor.firstName ?? "Anonymous"}</strong>
        <span>
          {donor.username ? `@${donor.username}` : `id ${donor.userId}`}
        </span>
      </div>
      <div className="board-stat">
        <strong>{count(donor.donationCount)}</strong>
        <span>gifts</span>
      </div>
      <div className="board-stat board-avg">
        <strong>{birr(donor.avgMinor)}</strong>
        <span>avg ETB</span>
      </div>
      <div className="board-stat board-last">
        <strong>{relativeTime(donor.lastAt)}</strong>
        <span>last gift</span>
      </div>
      <div className="board-total">
        <strong>{birr(donor.totalMinor)}</strong>
        <span>ETB</span>
      </div>
      <div className="board-track" aria-hidden="true">
        <span
          style={{
            width: `${Math.max((donor.totalMinor / top) * 100, 2)}%`,
          }}
        />
      </div>
    </div>
  );
}
