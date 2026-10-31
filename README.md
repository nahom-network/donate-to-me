# Donate to me

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nahom-network/donate-to-me)

A small Telegram bot that lets people choose a donation amount, select Telebirr, M-Pesa, or CBE Birr, and pay through a secure hosted checkout. It runs on Cloudflare Workers. It does not use OCR or collect transaction IDs.

**New here?** Follow [DEPLOY.md](DEPLOY.md) for the full from-zero setup: Cloudflare login, KV namespace, secrets, deploy, Telegram webhook, and verification.

## How a donation works

1. `/donate` — pick an amount from the colored inline buttons.
2. Pick Telebirr, M-Pesa, or CBE Birr.
3. Reply to the bot's prompt with the mobile number registered with that account (the prompt uses ForceReply; spaces and dashes are fine).
   - M-Pesa: a Safaricom number starting with `07` or `+2517` (e.g. `0712345678`).
   - Telebirr and CBE Birr: an Ethio Telecom number starting with `09` or `+2519` (e.g. `0912345678`).

   The payment provider requires the number to send the payment request. The bot forwards it for that checkout and does not store it.

4. Open the secure checkout (or approve the prompt on the phone). A signed webhook notifies the bot as soon as the payment completes, so it messages you automatically; you can also tap **I’ve paid — check status** or send `/status`.
5. `/halloffame` shows the top three people by total completed donations, aggregated across all their donations (first names only, no usernames).

Button colors use the `style` field added in Bot API 9.4 (blue = primary, green = success, red = danger). Older Telegram clients simply show their default button color.

## Before running

1. In the payment provider dashboard, create a **pay-what-you-want** donation product and copy its product ID. Configure the receiving account there.
2. Create a Telegram bot with BotFather and copy its bot token.
3. Install Node.js 20 or later and run `pnpm install`.
4. Create a KV namespace and put its ID in `wrangler.toml` under `[[kv_namespaces]]`.
5. Create the D1 database and apply the schema:

   ```sh
   pnpm exec wrangler d1 create donate-to-me
   # copy the database_id into wrangler.toml under [[d1_databases]]
   pnpm run db:migrate
   ```

   The migration creates the `users` and `donations` tables. `db:migrate` targets the remote database; use `pnpm run db:migrate:local` for local development.

6. Set Worker secrets (do not paste these into source files):

   ```sh
   pnpm exec wrangler secret put JAMI_TOKEN
   pnpm exec wrangler secret put JAMI_WEBHOOK_SECRET
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
   ```

   The API token should be a test token while testing. Use a long random string for `JAMI_WEBHOOK_SECRET`.

7. Replace `JAMI_PRODUCT_ID` in `wrangler.toml` with the pay-what-you-want product ID. Adjust `DONATION_AMOUNTS` if desired. Amounts are ETB.
8. Run locally with `pnpm run dev` or deploy with `pnpm run deploy`.
9. Register the Telegram webhook after deployment:

   ```sh
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     --data-urlencode "url=https://<YOUR_WORKER_HOST>/telegram/webhook" \
     --data-urlencode "secret_token=<THE_SAME_TELEGRAM_WEBHOOK_SECRET>"
   ```

   This step changes the Telegram bot's webhook. Do it only for a bot you control and when you're ready to receive updates.

10. In the payment provider dashboard → **Automation → Webhooks**, add a new endpoint:

    ```
    https://<YOUR_WORKER_HOST>/webhooks/payments
    ```

    Subscribe it to `order.completed` and `checkout.session.expired`. Copy the endpoint secret and store it as a Worker secret:

    ```sh
    pnpm exec wrangler secret put JAMI_WEBHOOK_SECRET
    ```

    Secrets take effect immediately; no redeploy is needed.

## Chat commands

- `/start` or `/donate` — choose an amount and payment rail.
- `/status` — ask the payment provider for the latest checkout status. The status endpoint reconciles with the provider.
- `/halloffame` (or `/top`, `/topdonors`) — show the top three donors by completed amount.
- `/help` — show a short help message.
- `/cancel` — cancel a checkout that is waiting for a phone number.

The command menu is registered automatically (from the 15-minute cron job), so the Telegram menu shows `/donate`, `/status`, `/halloffame`, `/help`, and `/cancel`.

### What is stored

- **D1 `users`** — everyone who interacts with the bot: Telegram id, first name, username, language code, first/last seen timestamps, and an interaction counter.
- **D1 `donations`** — one row per checkout, linked to `users.id` by foreign key: amount, currency, gateway, status (`pending` / `completed` / `expired`), order reference, and timestamps. The `session_id` is unique, so retries cannot duplicate a donation.
- **KV `SESSIONS`** — each user's latest checkout session for up to 24 hours, a pending gateway choice for 15 minutes while the bot waits for a phone number, and processed payment-webhook event ids for 7 days.

The payer's phone number and the payment API key are not stored in D1. The phone is only forwarded to the payment provider to create the checkout. Telegram's webhook secret header is checked before processing updates.

## Payment webhooks

`POST /webhooks/payments` receives signed events from the payment provider:

- `order.completed` — marks the matching donation `completed`, stores the order id, and messages the donor.
- `checkout.session.expired` — marks a pending donation `expired` and tells the payer why (canceled, timed out, rejected, …).

The handler verifies `X-JamiDev-Signature` against the **raw** request body using `JAMI_WEBHOOK_SECRET`, returns `400` on a bad signature, and skips repeated event ids. `/status` polling and the 15-minute cron remain as fallbacks, so a missed delivery still reconciles.

### Recovering missed donations

The 15-minute cron also walks the KV sessions and backfills any checkout that has no `donations` row yet, so a Worker deployed without the D1 binding does not lose donations. To run it immediately:

```sh
pnpm exec wrangler secret put ADMIN_SECRET
curl -X POST "https://<YOUR_WORKER_HOST>/admin/reconcile" \
  -H "X-Admin-Secret: <ADMIN_SECRET>"
```

The response reports how many sessions were checked, completed, expired, or skipped, with any errors. The Telegram webhook secret also works as the admin secret.

## Project structure

| File                                              | Purpose                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| `src/index.ts`                                    | Worker entry: routes, Telegram webhook, cron           |
| `src/bot.ts`                                      | Telegram updates, donation flow, `/halloffame`         |
| `src/webhooks.ts`                                 | Signed payment webhook handler                         |
| `src/db.ts`                                       | D1 users, donations, reconciliation, leaderboard query |
| `src/session.ts`                                  | KV sessions, pending choices, update dedupe            |
| `src/payment.ts`                                  | Payment API client with timeouts                       |
| `src/telegram.ts`                                 | Telegram API client with retries                       |
| `src/health.ts`                                   | `/health`, webhook watchdog, bot profile               |
| `src/constants.ts`, `src/types.ts`, `src/util.ts` | Shared constants, types, helpers                       |

## When the bot stops responding

Telegram retries a webhook delivery when the endpoint is slow or returns an error, and it keeps a backlog of updates. If that backlog gets stuck, the bot looks dead until the webhook is fixed. This Worker is built to recover on its own:

- Updates are acknowledged with `200 ok` immediately; the slow work (payment API, Telegram replies) continues in the background, so Telegram never times out and retries the same message.
- Retried updates are de-duplicated by `update_id`, so a retry cannot create a second checkout.
- Outbound Telegram and payment API calls have timeouts and retry transient `429`/`5xx` failures.
- A cron job runs every 15 minutes and re-registers the webhook if Telegram lost it, it points at a different URL, or Telegram reports `401`/`403`/`404` delivery errors.

Check the bot's view of Telegram at any time:

```sh
curl https://<YOUR_WORKER_HOST>/health
```

The response shows the registered webhook URL, how many updates are waiting, and the last delivery error. If something is wrong, repair it immediately instead of waiting for the cron job:

```sh
curl -X POST "https://<YOUR_WORKER_HOST>/telegram/repair" \
  -H "X-Telegram-Bot-Api-Secret-Token: <THE_SAME_TELEGRAM_WEBHOOK_SECRET>"
```

Add `?drop=1` to discard the stale backlog (use this if old messages keep arriving after a repair). For the watchdog to repair a webhook that was deleted before this Worker ever received an update, set `WEBHOOK_URL` in `wrangler.toml` to the same URL you registered with `setWebhook`; otherwise the Worker learns and remembers its URL from the first update it receives.

If `/health` reports `no webhook registered` and you are redeploying to a new hostname, run the `setWebhook` call from step 9 again.

One more thing to rule out: a bot started with `pnpm run dev` only answers while that local process (and any tunnel in front of it) is running. Once it is stopped, Telegram has nothing to deliver updates to. Deploy the Worker for a bot that must stay online.

## Test flow

Use a test API key and a test-mode pay-what-you-want product. Send `/start` to the bot, choose an amount, select a gateway, then reply with a phone number that matches it (`07…` for M-Pesa, `09…` for Telebirr/CBE). Open the checkout link and complete the sandbox flow. The bot should message you automatically when the webhook arrives, without sending `/status`. Confirm both a pending state and a completed state, and that `/halloffame` lists the donor with their aggregated total. Also confirm that a mismatched prefix is rejected, check `/status` after an expired checkout, and try `/cancel` while the bot is waiting for the phone number.

If the test key shared in chat is used outside this private test, rotate it in the provider dashboard and set the replacement as the Worker secret.
