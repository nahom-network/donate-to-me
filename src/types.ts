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
  SESSIONS: KVNamespace;
  DB: D1Database;
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
  chat: TgChat;
  from?: TgUser;
  text?: string;
  contact?: TgContact;
};

export type TgCallback = {
  id: string;
  data?: string;
  from: TgUser;
  message?: { chat: TgChat };
};

export type TgUpdate = {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TgCallback;
};

export type ButtonStyle = "primary" | "success" | "danger";

export type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  style?: ButtonStyle;
};

export type Session = {
  sessionId: string;
  amountMinor: number;
  createdAt: number;
};

/** A gateway was chosen; the bot still needs the payer's phone number. */
export type PendingCheckout = {
  amount: number;
  gateway: Gateway;
  createdAt: number;
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
};
