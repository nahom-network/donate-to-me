# Deploying the bot

A complete, from-zero deployment guide: Cloudflare login, KV namespace, secrets, deploy, Telegram webhook, and verification. Commands assume you are in the project folder.

The bot runs on Cloudflare Workers. You need one KV namespace (short-lived checkout sessions), one D1 database (users and donations), three Worker secrets, and two plain variables.

## Quick path (TL;DR)

```sh
pnpm install
pnpm exec wrangler login
pnpm exec wrangler kv namespace create SESSIONS   # copy the id into wrangler.toml
pnpm exec wrangler d1 create donate-to-me         # copy the database_id into wrangler.toml
# edit wrangler.toml: KV id + D1 id + JAMI_PRODUCT_ID
pnpm run db:migrate
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put JAMI_TOKEN
pnpm run deploy
# then, with the host from the deploy output:
curl.exe -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" --data-urlencode "url=https://<HOST>/telegram/webhook" --data-urlencode "secret_token=<SECRET>"
# create the endpoint https://<HOST>/webhooks/payments in the provider dashboard, then:
pnpm exec wrangler secret put JAMI_WEBHOOK_SECRET
curl.exe https://<HOST>/health
# optional dashboard: BotFather → Login Widget → OIDC client id/secret + ADMIN_TELEGRAM_IDS, then redeploy
```

The steps below explain each command, its output, and how to check it worked.

## 0. What you need

| Thing              | Where to get it                                  | Where it goes                                                 |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------- |
| Cloudflare account | <https://dash.cloudflare.com/sign-up>            | `wrangler login`                                              |
| Telegram bot token | [@BotFather](https://t.me/BotFather) → `/newbot` | Secret `TELEGRAM_BOT_TOKEN`                                   |
| Webhook secret     | You generate a random string                     | Secret `TELEGRAM_WEBHOOK_SECRET` (same value in `setWebhook`) |
| Jami API token     | JamiDev dashboard → Developer → API Tokens       | Secret `JAMI_TOKEN`                                           |
| Jami product ID    | JamiDev → create a **pay-what-you-want** product | Var `JAMI_PRODUCT_ID`                                         |
| Payment webhook secret | Shown once when you create the endpoint (step 7b) | Secret `JAMI_WEBHOOK_SECRET`                              |
| KV namespace       | Created in step 3                                | `wrangler.toml`                                               |
| D1 database        | Created in step 3                                | `wrangler.toml`                                               |
| Telegram OIDC client id + secret | BotFather → your bot → **Login Widget** (step 6b) | Var `TELEGRAM_OIDC_CLIENT_ID`, secret `TELEGRAM_OIDC_CLIENT_SECRET` |
| Admin Telegram ids | Your Telegram account id (step 6b)               | Var `ADMIN_TELEGRAM_IDS`                                      |

Also install Node.js 20+ and pnpm 9+.

## 1. Install dependencies

```sh
pnpm install
```

## 2. Log in to Cloudflare

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
```

`whoami` should print your account name and ID. If you belong to several accounts, note the correct Account ID and pass it when needed, or set it once:

```sh
# PowerShell
$env:CLOUDFLARE_ACCOUNT_ID = "<account-id>"

# bash
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
```

For CI, skip `login` and export a `CLOUDFLARE_API_TOKEN` with the **Edit Cloudflare Workers** template instead.

## 3. Create the storage (KV + D1)

### KV namespace (sessions)

```sh
pnpm exec wrangler kv namespace create SESSIONS
```

It prints something like:

```
🌀 Creating namespace with title "donate-to-me-SESSIONS"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "SESSIONS"
id = "0f2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c"
```

Copy the `id` value. Open `wrangler.toml` and replace the placeholder:

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "0f2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c"
```

Useful related commands:

```sh
pnpm exec wrangler kv namespace list        # find an existing namespace id
pnpm exec wrangler kv key list --binding SESSIONS --remote   # inspect stored keys (optional)
```

You only need **one** namespace. The Worker stores one session key per Telegram user with a 24-hour TTL, plus a short-lived update-id dedupe key.

### D1 database (users + donations)

```sh
pnpm exec wrangler d1 create donate-to-me
```

It prints the `database_id`. Add it to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "donate-to-me"
database_id = "<the database_id from the command>"
```

Then apply the schema:

```sh
pnpm run db:migrate          # remote database
pnpm run db:migrate:local    # for `wrangler dev`
```

The migrations create:

- `users` — one row per person who interacts with the bot (`id`, names, first/last seen, interaction count).
- `donations` — one row per checkout, linked to `users.id` by foreign key, with amount, gateway, status and order reference.
- `0002_dashboard_indexes.sql` — read indexes for the dashboard timeline and donor queries.

Apply both migrations before opening `/admin` on an existing deployment.

Inspect it with:

```sh
pnpm exec wrangler d1 execute donate-to-me --remote --command "SELECT COUNT(*) FROM users"
pnpm exec wrangler d1 execute donate-to-me --remote --command "SELECT * FROM donations ORDER BY created_at DESC LIMIT 10"
```

## 4. Fill in `wrangler.toml`

The file must look like this when you are done (keep your own IDs):

```toml
name = "donate-to-me"
main = "src/index.ts"
compatibility_date = "2026-10-06"

[[kv_namespaces]]
binding = "SESSIONS"
id = "<the id from step 3>"

[[d1_databases]]
binding = "DB"
database_name = "donate-to-me"
database_id = "<the database_id from step 3>"

[assets]
directory = "./public"
binding = "ASSETS"

[vars]
JAMI_PRODUCT_ID = "p_xxxxxxxx"          # your pay-what-you-want product
DONATION_AMOUNTS = "50,100,250,500"     # optional, ETB
START_IMAGE_URL = ""                    # optional, public image URL for /start
TELEGRAM_OIDC_CLIENT_ID = ""            # BotFather → Login Widget → Client ID
ADMIN_TELEGRAM_IDS = ""                 # comma-separated Telegram user ids
# Optional but recommended. The public URL used by the 15-minute watchdog.
# WEBHOOK_URL = "https://donate-to-me.<your-subdomain>.workers.dev/telegram/webhook"

[triggers]
crons = ["*/15 * * * *"]
```

Notes:

- `DONATION_AMOUNTS` is a comma-separated list of whole ETB amounts. Invalid entries are ignored; if none survive, the defaults `50,100,250,500` are used.
- `START_IMAGE_URL` is an optional public image URL used as the `/start` photo. Leave it empty to use the bundled `public/sticker.webp`; Telegram fetches the URL server-side.
- `WEBHOOK_URL` must be the exact URL you register in step 7 and must end in `/telegram/webhook`. Setting it lets the watchdog restore a webhook that was deleted before the Worker ever saw an update. If omitted, the Worker learns its URL from the first update it receives.
- `TELEGRAM_OIDC_CLIENT_ID` and `ADMIN_TELEGRAM_IDS` are filled in step 6b. The dashboard stays disabled while either is empty.
- `[assets]` must keep `binding = "ASSETS"`: the Worker reads the built SPA shell through `env.ASSETS` for `/admin`. The directory also holds `sticker.webp`, so do not point it at the Vite output directly.
- The cron trigger is part of the file, so it is created by the first deploy. No dashboard action is needed.

## 5. Set the Worker secrets

Secrets are encrypted and never appear in `wrangler.toml`. Run each command and paste the value when prompted (input is hidden):

```sh
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put JAMI_TOKEN
```

`JAMI_WEBHOOK_SECRET` is set in step 7b, after the payment endpoint exists.

Generate the Telegram webhook secret (any random 1–256 characters from `A-Z a-z 0-9 _ -`; hex is safest):

```powershell
# PowerShell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
```

```sh
# bash / macOS
openssl rand -hex 32
```

Check which secrets exist (values cannot be read back):

```sh
pnpm exec wrangler secret list
```

To replace a secret later, run `wrangler secret put` again with the new value. If you rotate `TELEGRAM_WEBHOOK_SECRET`, re-register the webhook (step 7) or run the repair endpoint, or the Worker will reject Telegram with `401`.

> Use a Jami **test** token with a test-mode product while testing. Switch the secret to a live token only when you are ready to receive real money.

## 6. Deploy

```sh
pnpm run typecheck
pnpm run deploy
```

`deploy` builds the React dashboard (`vite build` → `public/dashboard/`) and then uploads the Worker plus `public/` assets. The dashboard is not a separate deployment.

`deploy` prints the Worker URL, for example:

```
https://donate-to-me.your-subdomain.workers.dev
```

Use that host in the next step. If you deploy with a custom domain or a route, use that URL instead.

The deploy also creates the 15-minute cron trigger. Any later `pnpm run deploy` replaces the code but keeps the KV data, secrets, and cron.

## 6b. Enable the admin dashboard

The dashboard lives at `https://<YOUR_WORKER_HOST>/admin` and uses Telegram OIDC. Skipping this step leaves `/admin` locked (the login page shows which pieces are missing).

1. Open [@BotFather](https://t.me/BotFather), select your bot, and choose **Login Widget**.
2. Add both allowed URLs, using the exact host from step 6 (no trailing slash on the callback):
   - `https://<YOUR_WORKER_HOST>`
   - `https://<YOUR_WORKER_HOST>/admin/auth/callback`
3. Copy the **Client ID** and **Client Secret** shown in that screen. Keep the default **RS256** signing algorithm under **Advanced**; the Worker verifies RS256 and ES256 tokens.
4. Put the client id and your Telegram user id(s) in `wrangler.toml`:

   ```toml
   TELEGRAM_OIDC_CLIENT_ID = "123456789"
   ADMIN_TELEGRAM_IDS = "111111111,222222222"
   ```

   The ids are numeric Telegram user ids, not usernames. Split multiple ids with commas; empty disables dashboard access. You can get your id from [@userinfobot](https://t.me/userinfobot).
5. Store the client secret as a Worker secret, plus a separate session-signing secret:

   ```sh
   pnpm exec wrangler secret put TELEGRAM_OIDC_CLIENT_SECRET
   pnpm exec wrangler secret put ADMIN_SESSION_SECRET
   ```

   `ADMIN_SESSION_SECRET` is optional; without it the OIDC client secret also signs the admin cookie. Use a long random value (32+ bytes).
6. Redeploy (`pnpm run deploy`) and open `https://<YOUR_WORKER_HOST>/admin`.

If you use a custom domain or a route, set `ADMIN_BASE_URL` in `wrangler.toml` to that origin and register the same origin + `/admin/auth/callback` in BotFather. The callback URL is computed from the request origin by default.

The Worker verifies the OIDC ID token signature against Telegram's JWKS, checks `iss`, `aud`, and `exp`, and re-checks `ADMIN_TELEGRAM_IDS` on every API request. Sessions are HttpOnly cookies with a 12-hour lifetime. The dashboard makes no donation mutations; the only write action is the idempotent reconciliation runner.

## 7. Register the Telegram webhook

Telegram must be told where to send updates. The URL must be HTTPS and end in `/telegram/webhook`, and `secret_token` must exactly match `TELEGRAM_WEBHOOK_SECRET`.

Windows (PowerShell 5.1/7) — use `curl.exe`, not the `curl` alias:

```powershell
curl.exe -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" `
  --data-urlencode "url=https://<YOUR_WORKER_HOST>/telegram/webhook" `
  --data-urlencode "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Linux / macOS:

```sh
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=https://<YOUR_WORKER_HOST>/telegram/webhook" \
  --data-urlencode "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Expected response: `{"ok":true,"result":true,"description":"Webhook was set"}`.

Verify what Telegram now believes:

```sh
curl.exe "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

You want:

- `"url"` equal to your webhook URL,
- `"pending_update_count"` at or near `0`,
- no `last_error_message` (a stale one is fine if it is old and the bot works).

You only need to repeat this step when the Worker hostname changes, or when you rotate the webhook secret.

## 7b. Register the payment webhook

In the payment provider dashboard, open **Automation → Webhooks** and add an endpoint:

```
https://<YOUR_WORKER_HOST>/webhooks/payments
```

Subscribe it to:

- `order.completed` — a payment succeeded.
- `checkout.session.expired` — a checkout ended without an order.

Copy the endpoint secret (it is shown once) and store it:

```sh
pnpm exec wrangler secret put JAMI_WEBHOOK_SECRET
```

The route verifies the `X-JamiDev-Signature` header against the raw body, returns `400` for a bad signature, returns `503` when the secret is missing, and returns `200` for duplicates it has already processed. Deliveries are retried on non-2xx responses, so a temporary failure is safe.

If you use a sandbox organization, create a separate endpoint there. Sandbox and production endpoints do not share events.

## 8. Verify the deployment

Check the Worker's own view of Telegram:

```sh
curl.exe https://<YOUR_WORKER_HOST>/health
```

A healthy response looks like:

```json
{
  "status": "ok",
  "problem": null,
  "missingConfig": [],
  "config": {
    "webhookSecretConfigured": true,
    "paymentTokenConfigured": true,
    "productConfigured": true,
    "databaseConfigured": true,
    "paymentWebhookSecretConfigured": true
  },
  "webhook": {
    "url": "https://<host>/telegram/webhook",
    "expectedUrl": "https://<host>/telegram/webhook",
    "pendingUpdateCount": 0,
    "lastErrorDate": null,
    "lastErrorMessage": null
  }
}
```

Then open the bot in Telegram and send `/start`. You should get the amount keyboard. Pick an amount, pick a gateway, then reply to the prompt with the mobile number registered with that account (for example `0912345678`) — the payment provider needs it to send the payment request. Follow the checkout and pay: the bot should message you automatically when the webhook arrives, without sending `/status`. `/halloffame` (also works in groups) shows the top 3 donors once a payment completes.

If `/health` is not `ok`:

| `status` / field                                           | Meaning                                           | Fix                                     |
| ---------------------------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| `misconfigured` with `missingConfig`                       | A secret or the product ID is missing/placeholder | Rerun step 5 / step 4                   |
| `degraded`, `problem: "no webhook registered"`             | Telegram has no webhook                           | Repeat step 7                           |
| `degraded`, `problem: "webhook points at a different URL"` | Hostname changed or `WEBHOOK_URL` is stale        | Fix `WEBHOOK_URL` or repeat step 7      |
| `degraded`, `lastErrorMessage` includes `401`/`403`/`404`  | Secret or URL out of sync                         | Repair (below)                          |
| `error`                                                    | The Worker could not reach Telegram               | Check the bot token and `wrangler tail` |

Repair without waiting for the cron job:

```powershell
curl.exe -X POST "https://<YOUR_WORKER_HOST>/telegram/repair" `
  -H "X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>"
```

Add `?drop=1` to the URL to discard a stale backlog of updates.

## 9. Watch logs

```sh
pnpm exec wrangler tail
```

Send a message to the bot while it is running. You will see update processing and any Telegram or payment API errors. `wrangler tail --status error` shows only failures.

In the Cloudflare dashboard, the Worker also has **Logs** and **Metrics** tabs.

## Local development

Create `.dev.vars` in the project root (already git-ignored) with local values:

```ini
TELEGRAM_BOT_TOKEN=123456:your-dev-bot-token
TELEGRAM_WEBHOOK_SECRET=some-local-secret
JAMI_TOKEN=jamidev_test_...
JAMI_PRODUCT_ID=p_test_product
JAMI_WEBHOOK_SECRET=some-local-webhook-secret
# Optional local dashboard config; any real Telegram id can be allowlisted.
TELEGRAM_OIDC_CLIENT_ID=123456789
TELEGRAM_OIDC_CLIENT_SECRET=test-oidc-secret
ADMIN_TELEGRAM_IDS=111111111
ADMIN_SESSION_SECRET=test-session-secret
```

`wrangler dev` only reads secrets from `.dev.vars` — dashboard secrets are not downloaded.

```sh
pnpm run dev
```

This builds the dashboard, then starts <http://127.0.0.1:8787> with simulated local KV and D1 storage. Apply the schema once with `pnpm run db:migrate:local`; local data lives in `.wrangler/state`. Use `pnpm run dev:web` for Vite HMR on <http://localhost:5173/dashboard/> (it proxies `/admin/api` and `/admin/auth` to the Worker). Full OIDC sign-in still needs a public HTTPS origin, so test it on a deployed Worker or through a tunnel and register that exact callback in BotFather.

Telegram cannot reach `localhost`. To exercise the real webhook flow you need either a tunnel (e.g. `cloudflared tunnel --url http://127.0.0.1:8787`) registered with `setWebhook`, or a deployed staging Worker. A tunnel URL changes when it restarts, so re-register the webhook each time.

The cron watchdog does not run automatically in local dev. Trigger it manually:

```sh
curl.exe "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

## Updating and redeploying

```sh
pnpm run typecheck
pnpm run deploy
```

- Code changes: redeploy. KV data, secrets, and the webhook stay as they are.
- Variable changes in `wrangler.toml`: redeploy.
- Secret changes: `wrangler secret put <NAME>` (effective immediately).
- New hostname: repeat step 7 and update `WEBHOOK_URL`; also add the new origin + `/admin/auth/callback` to BotFather and optionally set `ADMIN_BASE_URL`.
- Dashboard UI changes: `pnpm run deploy` rebuilds `public/dashboard/`; `pnpm run build:web` alone is enough to check the bundle.
- Allowlist changes: edit `ADMIN_TELEGRAM_IDS` and redeploy. Existing sessions for removed ids stop working on the next request.

## Rotating a leaked token

1. Rotate it in the provider (BotFather `/revoke` for Telegram, JamiDev dashboard for Jami).
2. `pnpm exec wrangler secret put <NAME>` with the new value.
3. For Telegram, either repair (`POST /telegram/repair`) or repeat step 7 so the webhook uses the new secret.

## Tearing it all down (optional, destructive)

Do this only if you really want to remove the bot:

```sh
# Stop Telegram deliveries first
curl.exe -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"

# Delete the Worker (code + cron + secrets)
pnpm exec wrangler delete

# Delete the KV namespace (check the id with `kv namespace list`)
pnpm exec wrangler kv namespace delete --namespace-id <kv-namespace-id>

# Delete the D1 database (users + donations)
pnpm exec wrangler d1 delete donate-to-me
```

## Troubleshooting checklist

- `pnpm install` fails with `ETARGET` → old `@cloudflare/workers-types` pins. This repo uses `^5.x`; run `pnpm install` from the project root, not from inside `node_modules`.
- `wrangler deploy` says the KV namespace id is invalid → step 3 was skipped or the id was pasted with quotes/whitespace.
- `wrangler deploy` complains about the D1 binding → the `database_id` from `wrangler d1 create` is missing or wrong.
- `/halloffame` says it could not load, or `/health` shows `databaseConfigured: false` → the `DB` binding is missing; apply the schema with `pnpm run db:migrate`.
- Payment webhook returns `503` → `JAMI_WEBHOOK_SECRET` is not set (step 7b).
- Payment webhook returns `400` → the signature was calculated over a body that differs from the raw request, or the endpoint secret is wrong.
- A payment succeeds but the bot is not notified → check the provider's Webhooks page for the delivery response; the cron and `/status` still reconcile the donation.
- A completed donation is missing from `/halloffame` → check `/health` for `databaseConfigured: true`, then run the manual reconcile:
  `curl -X POST "https://<HOST>/admin/reconcile" -H "X-Admin-Secret: <ADMIN_SECRET>"`.
  The 15-minute cron also backfills from KV sessions once the binding is correct.
- Deploy succeeds but the bot replies "Payment setup incomplete" → `JAMI_PRODUCT_ID` is still `REPLACE_...` or `JAMI_TOKEN` is unset.
- `/admin` shows "Dashboard bundle missing" — `public/dashboard/` was not built. Run `pnpm run build:web` or deploy with `pnpm run deploy` (which builds first).
- `/admin` shows "Dashboard login is not configured" — `TELEGRAM_OIDC_CLIENT_ID`, `ADMIN_TELEGRAM_IDS`, or the OIDC client secret is missing. Repeat step 6b; the login card lists the missing pieces.
- Telegram says "not an admin" — the signed-in Telegram id is not in `ADMIN_TELEGRAM_IDS`. Use the numeric id (not `@username`), and redeploy after editing.
- "Telegram rejected the sign-in" — the client id/secret do not match BotFather, or the redirect URI is not registered exactly. Register `https://<HOST>/admin/auth/callback` and check `ADMIN_BASE_URL`.
- "That sign-in attempt expired" — the 10-minute OIDC state expired or was already used. Start the login again.
- Dashboard shows 401 after being idle — the 12-hour session cookie expired. Reload `/admin` and sign in again.
- `/admin/api/*` returns 401 in a script — the admin cookie is signed and HttpOnly; call it from the signed-in browser, not with `curl`.
- System page says "unavailable" for the webhook — Telegram `getWebhookInfo` failed; check `TELEGRAM_BOT_TOKEN` and `/health`.
- Bot does not answer at all → `curl /health`, check `wrangler tail`, and confirm the webhook URL is the current hostname.
- Responses stop after a while → run `POST /telegram/repair` and check `/health`; the 15-minute cron will also self-heal a lost webhook. If the Worker is on the free plan, confirm you have not hit the daily request limit in the dashboard.
- Telegram reports `401 Unauthorized` errors → `TELEGRAM_WEBHOOK_SECRET` and the `secret_token` passed to `setWebhook` differ.
