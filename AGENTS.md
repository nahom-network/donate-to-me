# AGENTS.md

Telegram donation bot on Cloudflare Workers (single Worker `donate-to-me`). Telegram webhooks, a signed payment webhook, KV for sessions, D1 for users/donations, and a 15-minute cron. TypeScript, no framework.

## Commands

Use **pnpm** (a `pnpm-lock.yaml` is committed; `npm install` can resolve the wrong versions).

```sh
pnpm install
pnpm run typecheck                      # Worker + dashboard TS; no lint or test suite
pnpm run build:web                      # vite build → public/dashboard (gitignored)
pnpm run dev                            # build dashboard, then wrangler dev on :8787
pnpm run dev:web                        # Vite HMR on :5173, proxies /admin/* to :8787
pnpm exec wrangler deploy --dry-run --outdir dist   # bundle check (dist/ is gitignored)
pnpm run deploy                         # vite build + real deploy (assets ship together)
pnpm run db:migrate                     # D1 migrations, remote
pnpm run db:migrate:local               # D1 migrations, local dev state
pnpm exec wrangler tail                 # production logs
curl https://donate-to-me.nahom-network.workers.dev/health
```

Verification order: `typecheck` → `build:web` → `deploy --dry-run` → `deploy`. `deploy` builds the dashboard itself, but running `build:web` first catches frontend errors before Wrangler starts. Run the matching migration before deploying schema changes.

## Hard-won setup rules

- **The D1 binding must be named `DB`.** The code reads `env.DB`. A dashboard edit once changed it to `donate_to_me`; the Worker deployed fine, `/health` showed `databaseConfigured: false`, and every donation was silently lost. Do not rename it.
- **The assets binding must be named `ASSETS`.** `/admin` calls `env.ASSETS.fetch("/dashboard/")` to serve the SPA shell. If the binding is removed, the API still works but `/admin` returns the "dashboard bundle missing" page. Keep `directory = "./public"` and `binding = "ASSETS"`.
- Deploy with Wrangler from this directory, not the dashboard Quick Edit — dashboard deploys have dropped the D1 binding.
- **`JAMI_PRODUCT_ID` is a secret, not a `[vars]` entry.** `wrangler deploy` uploads `[vars]` as the complete var set, so a blank `JAMI_PRODUCT_ID = ""` in `wrangler.toml` overwrote the real product id. The webhook then answered `503 Payment setup incomplete` for every update (see `src/index.ts`), so the bot was silent while `/admin` kept working. Secrets are not touched by deploys; keep it out of the file.
- Local D1 storage is keyed by `database_id`. If the database is recreated or the ID changes, rerun `pnpm run db:migrate:local` or the local tables disappear.
- Secrets (set with `pnpm exec wrangler secret put NAME`, value from stdin): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `JAMI_TOKEN`, `JAMI_WEBHOOK_SECRET`, `JAMI_PRODUCT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET`, optional `ADMIN_SESSION_SECRET`, optional legacy `ADMIN_SECRET`. `DONATION_AMOUNTS`, `WEBHOOK_URL`, `START_IMAGE_URL`, `TELEGRAM_OIDC_CLIENT_ID`, `ADMIN_TELEGRAM_IDS`, optional `ADMIN_BASE_URL` are `[vars]` in `wrangler.toml`.
- `ADMIN_TELEGRAM_IDS` is a comma/space-separated allowlist of numeric Telegram user ids. Empty means nobody can use `/admin`; non-listed ids get `?error=not_allowed`. The list is re-read on every request, so removing an id revokes that admin's existing cookie.
- `wrangler.toml` is a deploy-button template: KV/D1 are provisioned by the deploy form (no ids in the file) and vars are blank. Don't hardcode local IDs or secrets; `.dev.vars` is gitignored. The repo is public at `github.com/nahom-network/donate-to-me`.
- Local dev secrets live in `.dev.vars` (gitignored); dashboard secrets are not downloaded.
- `public/dashboard/` is generated and gitignored; never commit it. `public/sticker.webp` and `public/_headers` are real assets.
- D1 data inspection: `pnpm exec wrangler d1 execute donate-to-me --remote --command "..."`. Prefer `--json` and filter.

## Architecture

- `src/index.ts` — routes and cron. Telegram updates are acknowledged with `200` immediately and processed in `ctx.waitUntil`; never move slow work back into the response path.
- `src/bot.ts` — Telegram flow: amount → gateway → phone (ForceReply) → checkout; `/status`, `/cancel`, `/halloffame`.
- `src/webhooks.ts` — `POST /webhooks/payments`; verifies the raw body signature, dedupes by event id, returns `503` if D1 is missing so the provider retries.
- `src/db.ts` — D1 `users`/`donations`, reconciliation, leaderboard query.
- `src/session.ts` — KV session/pending keys, update dedupe, checkout-message helpers.
- `src/payment.ts` — `jami-sdk` client with request timeouts.
- `src/telegram.ts` — Bot API client; 8 s timeout, retries 429/5xx, swallows edit/delete failures.
- `src/widgets.ts` — the amount-picker HTML widget (`sendWidget`): fixed HTML, amounts baked in at send time, every screen drawn from `chat_data`. Stay inside Telegram's widget profile 1: no `<meta>`/`<link>`/`<input>`, no `opacity`, blurred shadows, filters, `vh`, external fonts or images — clients remove them silently. Ceiling is 32 768 bytes and 4 096 after zlib level 9; the picker is ~3.8 KB, mostly logos, so measure before adding much (Node's `zlib` level 9 over-reports by ~40 bytes here; Python's `zlib.compress(html, 9)` counts as the server does).
- `src/cards.ts` — the two static widgets with no client script: the settlement card (`sendCelebration`, falls back to the old text once) and the Hall of Fame podium (`sendHallOfFame`). Each message has its own 4 KB budget, both are ~1.2 KB.
- `src/widget-images.ts` — generated from `images/` by `node scripts/build-widget-images.mjs [logoSize] [badgeSize]`: PNG-8 data URIs for the three gateway logos and the sticker badge. A widget never loads a URL, so the bytes ship in the message; `sharp` arrives through Wrangler, so this is a manual maintenance step, not part of `deploy`. The generated file is committed.
- `src/health.ts` — `/health`, webhook watchdog/repair, command-menu registration.
- `src/admin.ts` — `/admin` routes: SPA shell, Telegram OIDC + PKCE, signed session cookie, read-only analytics API, background reconcile.
- `src/admin-db.ts` — batched D1 dashboard queries (overview, ledger, donors, system stats).
- `src/constants.ts`, `src/types.ts`, `src/util.ts` — shared values, types, helpers.
- `web/` — Vite + React dashboard source. Built to `public/dashboard/`; `public/sticker.webp` and `public/_headers` are static assets shipped with the Worker.

Routes: `GET /`, `GET /health`, `POST /telegram/webhook`, `POST /telegram/repair` (Telegram secret), `POST /webhooks/payments` (signed), `POST /admin/reconcile` (legacy `ADMIN_SECRET` or Telegram secret), `GET /admin` + `/admin/*` (OIDC session), `GET /admin/auth/login|callback`, `POST /admin/auth/logout`, `GET /admin/api/{session,overview,donations,donors,system}`, `POST /admin/api/reconcile`.

Cron (every 15 min, `src/index.ts`): reconcile Telegram webhook, register bot profile/commands, reconcile pending donations, backfill missing donations from KV sessions. Anything added here runs in production every 15 minutes.

## Behavior contracts

- **White-label:** never print the payment provider's name in bot text, buttons, or `/help`. Env vars, `jami-sdk`, and `X-JamiDev-*` headers still use it; those are internal.
- **Settlement messages:** delete the old checkout prompt, then send the result **once**. Editing the prompt *and* sending the same text duplicated "The payment failed." Background reconciliation edits in place (no push) instead. Settlement sends a widget — the celebration on completion, the failure card on a declined, failed or expired payment (`src/cards.ts`) — and falls back to the plain text when `sendWidget` fails, never both.
- **Amount picker:** `/donate` and the Donate button send the widget first (`src/widgets.ts`); if `sendWidget` throws, log it and fall back to the inline keyboard. Widget taps arrive as `widget_query`, get answered with `answerWidgetQuery` (15 s limit), and only then move the screen with `editMessageWidgetData`. `chat_data` is display state only — never the source of truth for `pending`. Widgets have no text input, so the phone number stays a ForceReply message. Every picker transition (back, new amount, cancel) clears the pending checkout, so a stale ForceReply can never pay the previously chosen amount.
- **Cancelling:** `resetPending` owns cleanup. It reads the pending with `readPending` (no TTL filter, so an expired prompt is still removed) and deletes **both** messages the flow created — the ForceReply phone prompt and the picker card — then clears KV. `/cancel`, the inline Cancel button, the widget's Cancel and every re-entry (`/donate`, back, new amount) go through it; pass `keepMessageId` for a card that is being redrawn, or the user's current card would be deleted under their finger. The prompt is sent before the card switches to its "reply below" screen, so Cancel is never shown while there is nothing to cancel.
- **Sharing:** Telegram sends every widget with protected content and only into private chats in production, so a widget message can never be forwarded — `protect_content` cannot be turned off. `/halloffame` therefore shares a `https://t.me/<bot>?start=fame` deep link (the recipient gets their own podium) plus a `copy_text` button; `/start fame` is the payload handler. Keep that payload working if the command parsing changes.
- **Donation state:** `pending` → `completed` | `expired`. `completed` must never regress; `session_id` is unique. Settlement can arrive via webhook, `/status`, cron, or KV backfill — all paths must stay idempotent.
- **Phone numbers:** M-Pesa only `07…`/`+2517…`; Telebirr and CBE Birr only `09…`/`+2519…`; normalize to `251…`. `jami-sdk` also requires `customer.email` and `customer.phone` for paid checkouts.
- **Telegram constraints:** flows are private-chat only, so `chat_id === user_id` (message edits rely on this). `setWebhook` in `src/health.ts` sets `allowed_updates: ["message", "callback_query", "widget_query"]` — add new update types there or they are never delivered. The watchdog also re-registers a healthy webhook whose `allowed_updates` is missing a required type, because a webhook registered before a type existed keeps its old list forever. If Telegram rejects `widget_query`, `setWebhook` retries once with the two legacy types so the webhook still registers.
- **Identity:** D1 `users.id` is the Telegram user id. `donations.user_id` is a foreign key; insert/upsert the user before a donation.
- **Hall of Fame:** aggregated per user across all `completed` donations (`SUM`), first names only, top 3.
- **Dashboard auth:** Telegram OIDC authorization code + PKCE. The Worker verifies the ID token signature (JWKS), `iss`, `aud`, and `exp`, uses the `id` claim as the Telegram id, and requires it in `ADMIN_TELEGRAM_IDS`. Never trust `email`/username for identity. Sessions are HMAC-signed `HttpOnly` cookies (`SameSite=Lax`, 12 h); the allowlist is re-checked on every API call. OAuth state + the PKCE verifier travel in a 10-minute signed cookie (`d2m_oidc`), not KV, because KV is eventually consistent across colos and a callback can miss a just-written state. JWKS is fetched per login for the same freshness reason.
- **Dashboard is read-only:** never add endpoints that mutate `donations` status from the UI. Reconciliation is idempotent and runs in `ctx.waitUntil`; the UI polls the stored summary in KV. All admin API responses are `cache-control: no-store` and same-origin.
- **Admin API surface:** all `/admin/api/*` require a session except `/session` (which returns `authenticated`/`ready`). `/admin` and deep links return the SPA shell; `/dashboard/*` is static output. Keep CSP in `src/admin.ts` in sync with any new asset origin (fonts are `data:`, Telegram avatars are `*.telesco.pe`).
- All bot messages use HTML parse mode; escape dynamic values with `escapeHtml`.

## Testing webhooks locally

There is no test suite. The practical check is a local Worker with a signed request:

```sh
pnpm exec wrangler dev --port 8790 \
  --var TELEGRAM_BOT_TOKEN:fake-token \
  --var TELEGRAM_WEBHOOK_SECRET:test-secret \
  --var JAMI_TOKEN:jamidev_test_0123456789abcdef0123456789abcdef \
  --var JAMI_PRODUCT_ID:p_test \
  --var JAMI_WEBHOOK_SECRET:test-webhook-secret
```

- Fake tokens make every Telegram call return `404`; that is expected and still exercises delete/send paths.
- Signature: HMAC-SHA256 in hex over `` `${t}.${body}` ``, sent as `x-jamidev-signature: t=<unix>,v1=<hex>`. Test with the raw body; never re-serialize it.
- Seed local state with `wrangler d1 execute ... --local` and `wrangler kv key put ... --local`.
- `wrangler dev` does not run the cron; trigger it with `curl http://127.0.0.1:<port>/cdn-cgi/local/scheduled`.
- Dashboard smoke check: add `--var ADMIN_TELEGRAM_IDS:<id> --var TELEGRAM_OIDC_CLIENT_ID:123456 --var TELEGRAM_OIDC_CLIENT_SECRET:test --var ADMIN_SESSION_SECRET:test`; `/admin/api/session` must return `ready: true`, `/admin` must return the built shell (run `pnpm run build:web` first), and every `/admin/api/*` must be `401` without the cookie. Full OIDC sign-in needs a real BotFather client and an HTTPS callback; do not fake token verification.
- The dashboard API can be exercised with a locally minted HMAC cookie: sign `base64url(JSON({id,name,username,picture,iat,exp,v:1}))` with `ADMIN_SESSION_SECRET` (HMAC-SHA256, base64url) and send `d2m_admin=<body>.<sig>`. This is for local testing only, never a deployed secret.

## Windows / PowerShell gotchas

- Use `curl.exe`, not `curl` (a PowerShell alias with different flags).
- `wrangler kv key put` mangles inline JSON quotes — write the value to a file and pass `--path file.json`.
- `wrangler d1 migrations apply` auto-confirms in non-interactive contexts.

## Docs

`README.md` covers behavior and commands; `DEPLOY.md` covers from-zero setup (KV, D1, secrets, Telegram and payment webhooks, BotFather OIDC, admin allowlist). Keep them in sync with code changes.
