# Jami Telegram Donations

A small Telegram bot that lets people choose a donation amount, select Telebirr, M-Pesa, or CBE Birr, and pay through Jami's hosted checkout. It runs on Cloudflare Workers. It does not use OCR or collect transaction IDs.

**New here?** Follow [DEPLOY.md](DEPLOY.md) for the full from-zero setup: Cloudflare login, KV namespace, secrets, deploy, Telegram webhook, and verification.

## Before running

1. In JamiDev, create a **pay-what-you-want** donation product and copy its product ID. Configure the receiving account in your JamiDev dashboard.
2. Create a Telegram bot with BotFather and copy its bot token.
3. Install Node.js 20 or later and run `pnpm install`.
4. Create a KV namespace and put its ID in `wrangler.toml`.
5. Set Worker secrets (do not paste these into source files):

   ```sh
   pnpm exec wrangler secret put JAMI_TOKEN
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

   The Jami token should be a test token while testing. Use a long random string for `TELEGRAM_WEBHOOK_SECRET`.

6. Replace `JAMI_PRODUCT_ID` in `wrangler.toml` with the pay-what-you-want product ID. Adjust `DONATION_AMOUNTS` if desired. Amounts are ETB.
7. Run locally with `pnpm run dev` or deploy with `pnpm run deploy`.
8. Register the Telegram webhook after deployment:

   ```sh
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     --data-urlencode "url=https://<YOUR_WORKER_HOST>/telegram/webhook" \
     --data-urlencode "secret_token=<THE_SAME_TELEGRAM_WEBHOOK_SECRET>"
   ```

   This step changes the Telegram bot's webhook. Do it only for a bot you control and when you're ready to receive updates.

## Chat commands

- `/start` or `/donate` — choose an amount and payment rail.
- `/status` — ask Jami for the latest checkout status. The status endpoint reconciles with the provider.
- `/help` — show a short help message.

The Worker keeps only each Telegram user's latest checkout session in KV for up to 24 hours. It does not store the Jami key or a payer's phone number. Telegram's webhook secret header is checked before processing updates.

## When the bot stops responding

Telegram retries a webhook delivery when the endpoint is slow or returns an error, and it keeps a backlog of updates. If that backlog gets stuck, the bot looks dead until the webhook is fixed. This Worker is built to recover on its own:

- Updates are acknowledged with `200 ok` immediately; the slow work (Jami checkout, Telegram replies) continues in the background, so Telegram never times out and retries the same message.
- Retried updates are de-duplicated by `update_id`, so a retry cannot create a second checkout.
- Outbound Telegram and Jami calls have timeouts and retry transient `429`/`5xx` failures.
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

If `/health` reports `no webhook registered` and you are redeploying to a new hostname, run the `setWebhook` call from step 8 again.

One more thing to rule out: a bot started with `pnpm run dev` only answers while that local process (and any tunnel in front of it) is running. Once it is stopped, Telegram has nothing to deliver updates to. Deploy the Worker for a bot that must stay online.

## Test flow

Use a Jami test key and a test-mode pay-what-you-want product. Send `/start` to the bot, choose an amount, select a gateway, open the checkout link, complete the sandbox flow, then send `/status`. Confirm both a pending state and a completed state. Check `/status` after an expired checkout too.

If the test key shared in chat is used outside this private test, rotate it in JamiDev and set the replacement as the Worker secret.
