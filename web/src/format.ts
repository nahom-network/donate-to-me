const amountFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function birr(minor: number): string {
  return amountFormatter.format(Math.round(minor / 100));
}

export function birrCompact(minor: number): string {
  const value = Math.round(minor / 100);
  return value >= 10_000 ? compactFormatter.format(value) : birr(minor);
}

export function count(value: number): string {
  return amountFormatter.format(value);
}

export function percent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(1)}%`;
}

export function signedPercent(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

export function relativeTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  const diff = Date.now() - timestamp;
  const future = diff < 0;
  const seconds = Math.abs(Math.round(diff / 1000));
  if (seconds < 45) return future ? "soon" : "just now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.34],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  let value = seconds;
  for (const [unit, size] of units) {
    if (value < size) {
      const rounded = Math.round(value);
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
        future ? rounded : -rounded,
        unit,
      );
    }
    value = value / size;
  }
  return "a while ago";
}

export function shortDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
  }).format(timestamp);
}

export function dateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function clockTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

export function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(parsed);
}

export function initials(name: string | null, fallback = "?"): string {
  const value = (name ?? "").trim();
  if (!value) return fallback;
  const parts = value.split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export function gatewayLabel(gateway: string): string {
  return (
    {
      telebirr: "Telebirr",
      mpesa: "M-Pesa",
      cbe: "CBE Birr",
    } as Record<string, string>
  )[gateway] ?? gateway;
}

export function gatewayColor(gateway: string): string {
  return (
    {
      telebirr: "var(--mint)",
      mpesa: "var(--rose)",
      cbe: "var(--violet)",
    } as Record<string, string>
  )[gateway] ?? "var(--blue)";
}

export function statusLabel(status: string): string {
  return (
    {
      completed: "Completed",
      pending: "Pending",
      expired: "Expired",
    } as Record<string, string>
  )[status] ?? status;
}
