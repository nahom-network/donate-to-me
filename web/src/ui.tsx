import {
  createContext,
  useCallback,
  useContext,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  Check,
  CircleAlert,
  CircleHelp,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { initials, statusLabel } from "./format";

/* ------------------------------------------------------------------ brand */

export function Mark({ size = 34 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1"
        y="1"
        width="62"
        height="62"
        rx="17"
        stroke="currentColor"
        strokeOpacity=".28"
        strokeWidth="1.4"
      />
      <circle
        cx="32"
        cy="32"
        r="18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray="2 5"
        opacity=".55"
      />
      <path
        d="M32 43s-9.4-5.6-9.4-12.6a5.4 5.4 0 0 1 9.4-3.4 5.4 5.4 0 0 1 9.4 3.4C41.4 37.4 32 43 32 43Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function TelegramIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M21.9 4.3 18.8 19c-.2 1-.8 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.2.2-.4.4-.9.4l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L7.1 12.7l-4.5-1.4c-1-.3-1-1 .2-1.4l17.7-6.8c.8-.3 1.6.2 1.4 1.2Z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ cards */

export function Card({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLElement>) {
  return (
    <section className={`card ${className}`.trim()} {...rest}>
      {children}
    </section>
  );
}

export function CardHead({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <header className="card-head">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="card-title">{title}</h2>
      </div>
      {action ? <div className="card-action">{action}</div> : null}
    </header>
  );
}

/* ------------------------------------------------------------------- pills */

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {statusLabel(status)}
    </span>
  );
}

export function GatewayChip({ gateway }: { gateway: string }) {
  return (
    <span className="gateway">
      <span className={`gateway-dot gateway-${gateway}`} />
      {gateway === "telebirr"
        ? "Telebirr"
        : gateway === "mpesa"
          ? "M-Pesa"
          : gateway === "cbe"
            ? "CBE Birr"
            : gateway}
    </span>
  );
}

export function Avatar({
  name,
  picture,
  size = 36,
}: {
  name: string | null;
  picture?: string | null;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const label = name?.trim() || "?";
  let hash = 0;
  for (let index = 0; index < label.length; index++) {
    hash = (hash * 31 + label.charCodeAt(index)) % 360;
  }
  const hue = 30 + (hash % 8) * 34;

  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(145deg, hsl(${hue} 34% 24%), hsl(${hue} 26% 14%))`,
        fontSize: Math.max(10, size * 0.32),
      }}
      aria-hidden="true"
    >
      {picture && !broken ? (
        <img
          src={picture}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/* --------------------------------------------------------------- controls */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? "is-active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function RefreshButton({
  onClick,
  loading,
  label = "Refresh",
}: {
  onClick: () => void;
  loading?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="btn btn-icon"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <RefreshCw size={16} className={loading ? "spin" : ""} />
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

export function PrimaryButton({
  children,
  loading,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
}) {
  return (
    <button className="btn btn-primary" {...rest} disabled={rest.disabled || loading}>
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- states */

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`.trim()} />;
}

export function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="error-panel" role="alert">
      <CircleAlert size={18} />
      <div>
        <strong>Could not load this view</strong>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  icon,
}: {
  title: string;
  detail?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon ?? <CircleHelp size={20} />}</span>
      <strong>{title}</strong>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- toasts */

type Tone = "ok" | "error" | "info";
type ToastItem = { id: number; tone: Tone; title: string; detail?: string };

const ToastContext = createContext<
  (tone: Tone, title: string, detail?: string) => void
>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

let toastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((tone: Tone, title: string, detail?: string) => {
    const id = ++toastId;
    setItems((current) => [...current, { id, tone, title, detail }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 4800);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            <span className="toast-icon">
              {item.tone === "ok" ? (
                <Check size={15} />
              ) : item.tone === "error" ? (
                <CircleAlert size={15} />
              ) : (
                <CircleHelp size={15} />
              )}
            </span>
            <div>
              <strong>{item.title}</strong>
              {item.detail ? <p>{item.detail}</p> : null}
            </div>
            <button
              type="button"
              className="toast-close"
              onClick={() =>
                setItems((current) =>
                  current.filter((entry) => entry.id !== item.id),
                )
              }
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* -------------------------------------------------------------- page head */

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function LiveBadge({ label = "Live" }: { label?: string }) {
  return (
    <span className="live-badge">
      <span className="live-dot" />
      {label}
    </span>
  );
}

export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast("ok", "Copied to clipboard");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast("error", "Could not copy", "Your browser blocked clipboard access.");
    }
  };

  return (
    <button
      type="button"
      className="copy-btn"
      onClick={copy}
      aria-label={label}
      title={label}
    >
      {copied ? <Check size={13} /> : <span className="copy-glyph">⧉</span>}
    </button>
  );
}

export function useGradientId(): string {
  return `g${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}
