import type { Gateway } from "./constants";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  JAMI_TOKEN: string;
  JAMI_PRODUCT_ID: string;
  /** Secret shown once when the payment webhook endpoint is created. */
  JAMI_WEBHOOK_SECRET?: string;
  DONATION_AMOUNTS?: string;
  /** Optional public URL of the Telegram webhook, used by the watchdog. */
  WEBHOOK_URL?: string;
  /** Optional public image URL for /start; defaults to the bundled sticker. */
  START_IMAGE_URL?: string;
  /** Protects the manual /admin/reconcile endpoint. */
  ADMIN_SECRET?: string;
  /** Telegram OIDC client id from BotFather → Login Widget. */
  TELEGRAM_OIDC_CLIENT_ID?: string;
  /** Telegram OIDC client secret. Store with `wrangler secret put`. */
  TELEGRAM_OIDC_CLIENT_SECRET?: string;
  /** Comma/space separated Telegram user ids allowed into /admin. */
  ADMIN_TELEGRAM_IDS?: string;
  /** Optional override for the public dashboard origin (redirect URI base). */
  ADMIN_BASE_URL?: string;
  /** HMAC key for the admin session cookie; falls back to the OIDC secret. */
  ADMIN_SESSION_SECRET?: string;
  SESSIONS: KVNamespace;
  DB: D1Database;
  /** Static assets binding used to serve the built React dashboard. */
  ASSETS: Fetcher;
}

export type TgUser = {
  id: number;
  first_name?: string;
  username?: string;
  language_code?: string;
};

export type TgChat = { id: number; type?: string };

export type TgContact = {
  phone_number: string;
  user_id?: number;
  first_name?: string;
};

export type TgMessage = {
  message_id?: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  contact?: TgContact;
};

export type TgCallback = {
  id: string;
  data?: string;
  from: TgUser;
  message?: { message_id?: number; chat: TgChat; photo?: unknown };
};

/**
 * A tap inside an HTML widget (`TelegramWidget.request`). `from` is
 * authenticated by Telegram, `data` is untrusted input.
 */
export type TgWidgetQuery = {
  id: string;
  from: TgUser;
  data?: string;
  chat?: TgChat;
  message_id?: number;
  chat_instance?: string;
};

export type TgUpdate = {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TgCallback;
  /** Only delivered when `widget_query` is in the webhook's allowed_updates. */
  widget_query?: TgWidgetQuery;
};

export type ButtonStyle = "primary" | "success" | "danger";

export type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  style?: ButtonStyle;
  /** Copies the text to the clipboard when tapped (Bot API 7.11). */
  copy_text?: { text: string };
};

export type Session = {
  sessionId: string;
  amountMinor: number;
  createdAt: number;
  /** The checkout prompt message, edited into a receipt once it settles. */
  checkoutMessageId?: number;
  /** The amount-picker widget, removed once the donation settles. */
  widgetMessageId?: number;
};

/** A gateway was chosen; the bot still needs the payer's phone number. */
export type PendingCheckout = {
  amount: number;
  gateway: Gateway;
  createdAt: number;
  /** Message id of the ForceReply phone prompt, so it can be cleaned up. */
  promptMessageId?: number;
  /** Message id of the amount-picker widget that started this checkout. */
  widgetMessageId?: number;
};

export type TelegramResult<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

export type WebhookInfo = {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  /** Update types Telegram will deliver. Empty or absent means all of them. */
  allowed_updates?: string[];
};
