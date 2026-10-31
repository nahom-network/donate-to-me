# AGENTS.md

Telegram donation bot on Cloudflare Workers (single Worker `donate-to-me`). Telegram webhooks, a signed payment webhook, KV for sessions, D1 for users/donations, and a 15-minute cron. TypeScript, no framework.

## Commands

Use **pnpm** (a `pnpm-lock.yaml` is committed; `npm install` can resolve the wrong versions).

```sh
pnpm install
pnpm run typecheck                      # only static check; there is no lint or test suite
pnpm run dev                            # wrangler dev on :8787 with local KV/D1
pnpm exec wrangler deploy --dry-run --outdir dist   # bundle check (dist/ is gitignored)
pnpm run deploy                         # real deploy
pnpm run db:migrate                     # D1 migrations, remote
pnpm run db:migrate:local               # D1 migrations, local dev state
pnpm exec wrangler tail                 # production logs
curl https://donate-to-me.nahom-network.workers.dev/health
```

Verification order: `typecheck` → `deploy --dry-run` → `deploy`. Run the matching migration before deploying schema changes.

## Hard-won setup rules

- **The D1 binding must be named `DB`.** The code reads `env.DB`. A dashboard edit once changed it to `donate_to_me`; the Worker deployed fine, `/health` showed `databaseConfigured: false`, and every donation was silently lost. Do not rename it.
- Deploy with Wrangler from this directory, not the dashboard Quick Edit — dashboard deploys have dropped the D1 binding.
- Local D1 storage is keyed by `database_id`. If the database is recreated or the ID changes, rerun `pnpm run db:migrate:local` or the local tables disappear.
- Secrets (set with `pnpm exec wrangler secret put NAME`, value from stdin): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `JAMI_TOKEN`, `JAMI_WEBHOOK_SECRET`, optional `ADMIN_SECRET`. `JAMI_PRODUCT_ID`, `DONATION_AMOUNTS`, `WEBHOOK_URL`, `START_IMAGE_URL` are `[vars]` in `wrangler.toml`.
- `wrangler.toml` is a deploy-button template: KV/D1 are provisioned by the deploy form (no ids in the file) and vars are blank. Don't hardcode local IDs or secrets; `.dev.vars` is gitignored. The repo is public at `github.com/nahom-network/donate-to-me`.
- Local dev secrets live in `.dev.vars` (gitignored); dashboard secrets are not downloaded.
- D1 data inspection: `pnpm exec wrangler d1 execute donate-to-me --remote --command "..."`. Prefer `--json` and filter.

## Architecture

- `src/index.ts` — routes and cron. Telegram updates are acknowledged with `200` immediately and processed in `ctx.waitUntil`; never move slow work back into the response path.
- `src/bot.ts` — Telegram flow: amount → gateway → phone (ForceReply) → checkout; `/status`, `/cancel`, `/halloffame`.
- `src/webhooks.ts` — `POST /webhooks/payments`; verifies the raw body signature, dedupes by event id, returns `503` if D1 is missing so the provider retries.
- `src/db.ts` — D1 `users`/`donations`, reconciliation, leaderboard query.
- `src/session.ts` — KV session/pending keys, update dedupe, checkout-message helpers.
- `src/payment.ts` — `jami-sdk` client with request timeouts.
- `src/telegram.ts` — Bot API client; 8 s timeout, retries 429/5xx, swallows edit/delete failures.
- `src/health.ts` — `/health`, webhook watchdog/repair, command-menu registration.
- `src/constants.ts`, `src/types.ts`, `src/util.ts` — shared values, types, helpers.

Routes: `GET /`, `GET /health`, `POST /telegram/webhook`, `POST /telegram/repair` (Telegram secret), `POST /webhooks/payments` (signed), `POST /admin/reconcile` (`ADMIN_SECRET` or Telegram secret).

Cron (every 15 min, `src/index.ts`): reconcile Telegram webhook, register bot profile/commands, reconcile pending donations, backfill missing donations from KV sessions. Anything added here runs in production every 15 minutes.

## Behavior contracts

- **White-label:** never print the payment provider's name in bot text, buttons, or `/help`. Env vars, `jami-sdk`, and `X-JamiDev-*` headers still use it; those are internal.
- **Settlement messages:** delete the old checkout prompt, then send the result **once**. Editing the prompt *and* sending the same text duplicated "The payment failed." Background reconciliation edits in place (no push) instead.
- **Donation state:** `pending` → `completed` | `expired`. `completed` must never regress; `session_id` is unique. Settlement can arrive via webhook, `/status`, cron, or KV backfill — all paths must stay idempotent.
- **Phone numbers:** M-Pesa only `07…`/`+2517…`; Telebirr and CBE Birr only `09…`/`+2519…`; normalize to `251…`. `jami-sdk` also requires `customer.email` and `customer.phone` for paid checkouts.
- **Telegram constraints:** flows are private-chat only, so `chat_id === user_id` (message edits rely on this). `setWebhook` in `src/health.ts` sets `allowed_updates: ["message", "callback_query"]` — add new update types there or they are never delivered.
- **Identity:** D1 `users.id` is the Telegram user id. `donations.user_id` is a foreign key; insert/upsert the user before a donation.
- **Hall of Fame:** aggregated per user across all `completed` donations (`SUM`), first names only, top 3.
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

## Windows / PowerShell gotchas

- Use `curl.exe`, not `curl` (a PowerShell alias with different flags).
- `wrangler kv key put` mangles inline JSON quotes — write the value to a file and pass `--path file.json`.
- `wrangler d1 migrations apply` auto-confirms in non-interactive contexts.

## Docs

`README.md` covers behavior and commands; `DEPLOY.md` covers from-zero setup (KV, D1, secrets, Telegram and payment webhooks). Keep them in sync with code changes.
