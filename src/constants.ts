export const GATEWAYS = ["telebirr", "mpesa", "cbe"] as const;
export type Gateway = (typeof GATEWAYS)[number];

export const DEFAULT_AMOUNTS = "50,100,250,500";

export const PENDING_TTL_SECONDS = 15 * 60;
export const DONATION_SESSION_TTL_MS = 3 * 60 * 60 * 1000;
export const UPDATE_DEDUPE_TTL_SECONDS = 600;
export const WEBHOOK_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

export const WEBHOOK_URL_KEY = "tg:webhook-url";
export const BOT_PROFILE_CACHE_KEY = "tg:bot-profile:v2";

export const TELEGRAM_TIMEOUT_MS = 8_000;
export const PAYMENT_TIMEOUT_MS = 15_000;

// Telegram keeps the last delivery error even after deliveries succeed again,
// so only treat an error as current while it is newer than one cron interval.
export const WEBHOOK_ERROR_GRACE_SECONDS = 15 * 60;
