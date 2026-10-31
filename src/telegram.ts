import type { Env, TelegramResult } from "./types";
import { TELEGRAM_TIMEOUT_MS } from "./constants";
import { errorMessage, fetchWithTimeout, sleep } from "./util";

/** Call a Telegram Bot API method with timeouts and retries for 429/5xx. */
export async function telegram<T = unknown>(
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  let lastError = new Error(`Telegram ${method} failed`);

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    let data: TelegramResult<T> | null;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        TELEGRAM_TIMEOUT_MS,
      );
      data = (await response
        .json()
        .catch(() => null)) as TelegramResult<T> | null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(300 * (attempt + 1));
      continue;
    }

    if (response.ok && data?.ok) return data.result as T;

    const code = data?.error_code ?? response.status;
    lastError = new Error(
      `Telegram ${method} failed: ${code} ${data?.description ?? response.statusText}`,
    );
    if (code === 429) {
      await sleep(Math.min(data?.parameters?.retry_after ?? 1, 5) * 1000);
      continue;
    }
    if (code >= 500) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    throw lastError;
  }

  throw lastError;
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function sendMessageGetId(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: unknown,
): Promise<number | undefined> {
  const result = await telegram<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return result?.message_id;
}

export async function editMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  try {
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
    });
  } catch (error) {
    console.warn("Could not edit message", errorMessage(error));
  }
}

export async function deleteMessage(
  env: Env,
  chatId: number,
  messageId: number,
): Promise<boolean> {
  try {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
    return true;
  } catch (error) {
    console.warn("Could not delete message", errorMessage(error));
    return false;
  }
}

export async function sendChatAction(
  env: Env,
  chatId: number,
  action = "typing",
): Promise<void> {
  try {
    await telegram(env, "sendChatAction", { chat_id: chatId, action });
  } catch (error) {
    console.warn("Could not send chat action", errorMessage(error));
  }
}

export async function answerCallback(
  env: Env,
  callbackQueryId: string,
  toast?: string,
): Promise<void> {
  try {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(toast ? { text: toast } : {}),
    });
  } catch (error) {
    console.warn("Could not answer callback query", errorMessage(error));
  }
}
