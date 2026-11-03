import { useMemo, useRef, useState } from "react";
import { dayLabel } from "./format";
import { useGradientId } from "./ui";

export type ChartPoint = {
  date: string;
  value: number;
  donations: number;
  checkouts: number;
};

const WIDTH = 1000;
const HEIGHT = 300;
const TOP = 18;
const BOTTOM = 10;

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function linePath(coords: Array<{ x: number; y: number }>): string {
  if (coords.length === 0) return "";
  if (coords.length === 1) {
    return `M ${coords[0].x} ${coords[0].y} L ${coords[0].x} ${coords[0].y}`;
  }
  let path = `M ${coords[0].x} ${coords[0].y}`;
  for (let index = 0; index < coords.length - 1; index++) {
    const p0 = coords[index - 1] ?? coords[index];
    const p1 = coords[index];
    const p2 = coords[index + 1];
    const p3 = coords[index + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = Math.min(HEIGHT, Math.max(0, p1.y + (p2.y - p0.y) / 6));
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = Math.min(HEIGHT, Math.max(0, p2.y - (p3.y - p1.y) / 6));
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

export function AreaChart({
  points,
  format,
  metricLabel,
}: {
  points: ChartPoint[];
  format: (value: number) => string;
  metricLabel: string;
}) {
  const gradient = useGradientId();
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const max = useMemo(
    () => niceMax(Math.max(...points.map((point) => point.value), 0)),
    [points],
  );

  const coords = useMemo(
    () =>
      points.map((point, index) => ({
        x:
          points.length === 1
            ? WIDTH / 2
            : (index / (points.length - 1)) * WIDTH,
        y: TOP + (1 - point.value / max) * (HEIGHT - TOP - BOTTOM),
      })),
    [points, max],
  );

  const line = linePath(coords);
  const area =
    coords.length > 0
      ? `${line} L ${coords[coords.length - 1].x} ${HEIGHT} L ${coords[0].x} ${HEIGHT} Z`
      : "";

  const active = hover !== null ? points[hover] : null;
  const activeCoord = hover !== null ? coords[hover] : null;
  const ratio =
    hover !== null && points.length > 1
      ? (hover / (points.length - 1)) * 100
      : 50;

  const yTicks = [1, 0.75, 0.5, 0.25, 0];
  const xTicks =
    points.length <= 1
      ? points
      : [0, 0.25, 0.5, 0.75, 1].map(
          (fraction) => points[Math.round((points.length - 1) * fraction)],
        );

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || points.length === 0) return;
    const position = (event.clientX - rect.left) / rect.width;
    const index = Math.round(
      Math.min(Math.max(position, 0), 1) * (points.length - 1),
    );
    setHover(index);
  };

  return (
    <div className="chart">
      <div className="chart-y" aria-hidden="true">
        {yTicks.map((tick) => (
          <span key={tick} style={{ top: `${(1 - tick) * 100}%` }}>
            {format(max * tick)}
          </span>
        ))}
      </div>
      <div
        className="chart-plot"
        ref={plotRef}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${metricLabel} over ${points.length} days`}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--gold)" stopOpacity=".34" />
              <stop offset="70%" stopColor="var(--gold)" stopOpacity=".05" />
              <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map((tick) => (
            <line
              key={tick}
              x1="0"
              x2={WIDTH}
              y1={TOP + (1 - tick) * (HEIGHT - TOP - BOTTOM)}
              y2={TOP + (1 - tick) * (HEIGHT - TOP - BOTTOM)}
              className="chart-grid"
            />
          ))}
          {area ? <path d={area} fill={`url(#${gradient})`} /> : null}
          {line ? (
            <path
              d={line}
              className="chart-line"
              pathLength={1}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {activeCoord ? (
            <circle
              cx={activeCoord.x}
              cy={activeCoord.y}
              r="4"
              className="chart-point"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>

        {active && activeCoord ? (
          <>
            <div
              className="chart-crosshair"
              style={{ left: `${ratio}%` }}
              aria-hidden="true"
            />
            <div
              className={`chart-tip ${
                ratio > 72 ? "align-right" : ratio < 28 ? "align-left" : ""
              }`}
              style={{ left: `${ratio}%` }}
            >
              <span className="chart-tip-date">{dayLabel(active.date)}</span>
              <strong>{format(active.value)}</strong>
              <span className="chart-tip-meta">
                {active.donations} completed · {active.checkouts} checkouts
              </span>
            </div>
          </>
        ) : null}
      </div>
      <div className="chart-x" aria-hidden="true">
        {xTicks.map((point, index) =>
          point ? (
            <span key={`${point.date}-${index}`}>{dayLabel(point.date)}</span>
          ) : null,
        )}
      </div>
    </div>
  );
}

export function Sparkline({
  values,
  tone = "var(--gold)",
}: {
  values: number[];
  tone?: string;
}) {
  const gradient = useGradientId();
  const max = Math.max(...values, 1);
  const coords = values.map((value, index) => ({
    x: values.length === 1 ? 60 : (index / (values.length - 1)) * 120,
    y: 34 - (value / max) * 28,
  }));
  const line = linePath(coords);
  const area =
    coords.length > 0
      ? `${line} L 120 40 L 0 40 Z`
      : "";

  return (
    <svg
      className="sparkline"
      viewBox="0 0 120 40"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity=".3" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area ? <path d={area} fill={`url(#${gradient})`} /> : null}
      {line ? (
        <path
          d={line}
          fill="none"
          stroke={tone}
          strokeWidth="1.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

export function Donut({
  segments,
  centerValue,
  centerLabel,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  centerValue: string;
  centerLabel: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  return (
    <div className="donut-wrap">
      <div className="donut">
        <svg viewBox="0 0 140 140" aria-hidden="true">
          <circle
            cx="70"
            cy="70"
            r={radius}
            className="donut-track"
            fill="none"
          />
          {segments.map((segment) => {
            const fraction = total > 0 ? segment.value / total : 0;
            const length = Math.max(fraction * circumference - 4, 0);
            const offset = -cumulative * circumference;
            cumulative += fraction;
            return (
              <circle
                key={segment.label}
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth="11"
                strokeLinecap="round"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={offset}
                transform="rotate(-90 70 70)"
              />
            );
          })}
        </svg>
        <div className="donut-center">
          <strong>{centerValue}</strong>
          <span>{centerLabel}</span>
        </div>
      </div>
      <div className="donut-legend">
        {segments.map((segment) => (
          <div key={segment.label} className="donut-row">
            <span
              className="donut-swatch"
              style={{ background: segment.color }}
            />
            <span className="donut-label">{segment.label}</span>
            <span className="donut-share">
              {total > 0
                ? `${Math.round((segment.value / total) * 100)}%`
                : "0%"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
