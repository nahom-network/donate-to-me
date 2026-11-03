import type { Env } from "./types";
import { getDonations, getDonors, getOverview, getSystemStats } from "./admin-db";
import { reconcileDonations, reconcileSessions } from "./db";
import { health } from "./health";
import { errorMessage, fetchWithTimeout, json } from "./util";

const OIDC_ISSUER = "https://oauth.telegram.org";
const OIDC_AUTH_URL = `${OIDC_ISSUER}/auth`;
const OIDC_TOKEN_URL = `${OIDC_ISSUER}/token`;
const OIDC_JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks.json`;

const ADMIN_COOKIE = "d2m_admin";
const OIDC_FLOW_COOKIE = "d2m_oidc";
const RECONCILE_KEY = "admin:reconcile:last";

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const OIDC_FLOW_TTL_SECONDS = 10 * 60;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.telesco.pe https://t.me",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

type AdminSession = {
  id: number;
  name: string;
  username: string | null;
  picture: string | null;
  iat: number;
  exp: number;
  v: 1;
};

type OidcConfig = {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  adminIds: Set<number>;
  ready: boolean;
};

/**
 * OAuth state + PKCE verifier travel in a short-lived signed cookie rather
 * than KV: KV is eventually consistent, and a callback that lands in another
 * Cloudflare colo could miss the write and fail the login.
 */
type OidcFlow = {
  state: string;
  verifier: string;
  redirectUri: string;
  exp: number;
};

type ReconcileState = {
  status: "idle" | "running" | "done" | "error";
  startedAt?: number;
  finishedAt?: number;
  sessions?: unknown;
  error?: string;
};

type IdTokenClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  sub?: string;
  id?: number | string;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  picture?: string;
};

type Jwk = {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
};

type JwkSet = { keys?: Jwk[] };

/**
 * Everything under /admin is handled here:
 *  - /admin, /admin/*            → the built React dashboard
 *  - /admin/auth/*               → Telegram OIDC (PKCE) + session cookie
 *  - /admin/api/*                → allowlisted, read-only analytics API
 */
export async function handleAdmin(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === "/admin/auth/login") return await login(request, env);
    if (path === "/admin/auth/callback") return await callback(request, env);
    if (path === "/admin/auth/logout") return await logout(request, env);
    if (path === "/admin/api/session") return await sessionInfo(request, env);
    if (path.startsWith("/admin/api/")) return await api(request, env, ctx);
    if (path === "/admin" || path.startsWith("/admin/")) {
      return await serveDashboard(request, env);
    }
    return json({ ok: false, error: "Not found" }, 404);
  } catch (error) {
    console.error("Admin request failed", path, errorMessage(error));
    return apiJson(
      { ok: false, error: "Something went wrong. Check the Worker logs." },
      500,
    );
  }
}

function apiJson(body: unknown, status = 200): Response {
  const response = json(body, status);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status, headers });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function cookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
  path = "/",
): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function adminBaseUrl(env: Env, url: URL): string {
  const configured = env.ADMIN_BASE_URL?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        // Only the origin matters: the Worker serves /admin at the root.
        if (parsed.pathname !== "/") {
          console.warn("Ignoring the path in ADMIN_BASE_URL");
        }
        return parsed.origin;
      }
    } catch {
      console.warn("Ignoring ADMIN_BASE_URL: not an absolute URL");
    }
  }
  return url.origin;
}

function oidcConfig(env: Env): OidcConfig {
  const clientId = env.TELEGRAM_OIDC_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.TELEGRAM_OIDC_CLIENT_SECRET?.trim() ?? "";
  const sessionSecret =
    env.ADMIN_SESSION_SECRET?.trim() || clientSecret;
  const adminIds = new Set(parseAdminIds(env.ADMIN_TELEGRAM_IDS));
  return {
    clientId,
    clientSecret,
    sessionSecret,
    adminIds,
    ready: Boolean(clientId && clientSecret && sessionSecret && adminIds.size),
  };
}

export function parseAdminIds(value: string | undefined): number[] {
  if (!value) return [];
  const seen = new Set<number>();
  for (const part of value.split(/[\s,;]+/)) {
    const id = Number(part.trim());
    if (Number.isSafeInteger(id) && id > 0) seen.add(id);
  }
  return [...seen];
}

async function login(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const config = oidcConfig(env);
  const base = adminBaseUrl(env, url);
  if (!config.ready) return redirect(`${base}/admin?error=config`);

  // Start the flow on the canonical origin so the signed OIDC cookie is set
  // on the same host that receives the callback.
  if (new URL(base).origin !== url.origin) {
    return redirect(`${base}/admin/auth/login`);
  }

  if (await currentSession(request, env)) return redirect(`${base}/admin`);

  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = await pkceChallenge(verifier);
  const redirectUri = `${base}/admin/auth/callback`;
  const flow: OidcFlow = {
    state,
    verifier,
    redirectUri,
    exp: Date.now() + OIDC_FLOW_TTL_SECONDS * 1000,
  };
  const flowToken = await signValue(flow, config.sessionSecret);

  const auth = new URL(OIDC_AUTH_URL);
  auth.searchParams.set("client_id", config.clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  return redirect(auth.toString().replace(/\+/g, "%20"), [
    cookieHeader(
      OIDC_FLOW_COOKIE,
      flowToken,
      OIDC_FLOW_TTL_SECONDS,
      url.protocol === "https:",
      "/admin",
    ),
  ]);
}

async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const config = oidcConfig(env);
  const base = adminBaseUrl(env, url);
  const secure = url.protocol === "https:";
  const clearFlow = cookieHeader(OIDC_FLOW_COOKIE, "", 0, secure, "/admin");
  const fail = (reason: string) =>
    redirect(`${base}/admin?error=${reason}`, [clearFlow]);

  if (!config.ready) return fail("config");
  if (url.searchParams.get("error")) return fail("denied");

  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code) return fail("state");

  const flowToken = readCookie(request, OIDC_FLOW_COOKIE);
  const flow = flowToken
    ? await verifyValue<OidcFlow>(flowToken, config.sessionSecret)
    : null;
  if (
    !flow ||
    flow.state !== state ||
    !flow.verifier ||
    typeof flow.exp !== "number" ||
    flow.exp < Date.now()
  ) {
    return fail("state");
  }
  const verifier = flow.verifier;
  const redirectUri = flow.redirectUri || `${base}/admin/auth/callback`;

  const basic = base64Encode(
    new TextEncoder().encode(`${config.clientId}:${config.clientSecret}`),
  );
  let tokens: { id_token?: string };
  try {
    const response = await fetchWithTimeout(
      OIDC_TOKEN_URL,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          code_verifier: verifier,
        }).toString(),
      },
      10_000,
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      console.warn("Telegram token exchange failed", response.status, detail);
      return fail("exchange");
    }
    tokens = (await response.json()) as { id_token?: string };
  } catch (error) {
    console.error("Telegram token exchange error", errorMessage(error));
    return fail("exchange");
  }

  if (!tokens.id_token) return fail("exchange");

  let claims: IdTokenClaims;
  try {
    claims = await verifyIdToken(tokens.id_token, config.clientId);
  } catch (error) {
    console.error("ID token verification failed", errorMessage(error));
    return fail("token");
  }

  const telegramId = Number(claims.id ?? claims.sub);
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) return fail("token");
  if (!config.adminIds.has(telegramId)) {
    console.warn("Rejected dashboard login for non-admin", telegramId);
    return fail("not_allowed");
  }

  const now = Date.now();
  const session: AdminSession = {
    id: telegramId,
    name:
      claims.name?.trim() ||
      [claims.given_name, claims.family_name].filter(Boolean).join(" ") ||
      claims.preferred_username ||
      "Administrator",
    username: claims.preferred_username ?? null,
    picture: claims.picture ?? null,
    iat: now,
    exp: now + SESSION_TTL_SECONDS * 1000,
    v: 1,
  };
  const token = await signValue(session, config.sessionSecret);
  console.log("Dashboard login", JSON.stringify({ id: telegramId }));

  return redirect(`${base}/admin`, [
    clearFlow,
    cookieHeader(ADMIN_COOKIE, token, SESSION_TTL_SECONDS, secure),
  ]);
}

async function logout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return apiJson({ ok: false }, 405);
  if (!sameOrigin(request)) return apiJson({ ok: false }, 403);
  const url = new URL(request.url);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": cookieHeader(
        ADMIN_COOKIE,
        "",
        0,
        url.protocol === "https:",
      ),
      "cache-control": "no-store",
    },
  });
}

async function sessionInfo(request: Request, env: Env): Promise<Response> {
  const config = oidcConfig(env);
  const session = await currentSession(request, env);
  return apiJson({
    authenticated: Boolean(session),
    ready: config.ready,
    config: {
      allowlistCount: config.adminIds.size,
      oidcConfigured: Boolean(config.clientId && config.clientSecret),
      sessionSecretConfigured: Boolean(config.sessionSecret),
    },
    admin: session
      ? {
          id: session.id,
          name: session.name,
          username: session.username,
          picture: session.picture,
        }
      : null,
  });
}

async function api(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return apiJson({ ok: false, error: "Unauthorized" }, 401);

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/admin/api/overview") {
    if (request.method !== "GET") return apiJson({ ok: false }, 405);
    if (!env.DB) return apiJson({ ok: false, error: "DB binding missing" }, 503);
    const days = intParam(url.searchParams.get("days"), 30, 7, 365);
    return apiJson(await getOverview(env, days));
  }

  if (path === "/admin/api/donations") {
    if (request.method !== "GET") return apiJson({ ok: false }, 405);
    if (!env.DB) return apiJson({ ok: false, error: "DB binding missing" }, 503);
    return apiJson(
      await getDonations(env, {
        status: url.searchParams.get("status") ?? undefined,
        gateway: url.searchParams.get("gateway") ?? undefined,
        query: url.searchParams.get("q") ?? undefined,
        limit: intParam(url.searchParams.get("limit"), 25, 1, 100),
        offset: intParam(url.searchParams.get("offset"), 0, 0, 100_000),
      }),
    );
  }

  if (path === "/admin/api/donors") {
    if (request.method !== "GET") return apiJson({ ok: false }, 405);
    if (!env.DB) return apiJson({ ok: false, error: "DB binding missing" }, 503);
    return apiJson(
      await getDonors(
        env,
        url.searchParams.get("q") ?? "",
        intParam(url.searchParams.get("limit"), 50, 1, 100),
      ),
    );
  }

  if (path === "/admin/api/system") {
    if (request.method !== "GET") return apiJson({ ok: false }, 405);
    return apiJson(await systemInfo(request, env, session));
  }

  if (path === "/admin/api/reconcile") {
    if (request.method !== "POST") return apiJson({ ok: false }, 405);
    if (!sameOrigin(request)) return apiJson({ ok: false }, 403);
    if (request.headers.get("x-requested-with") !== "dashboard") {
      return apiJson({ ok: false, error: "Missing request header" }, 403);
    }
    if (!env.DB) return apiJson({ ok: false, error: "DB binding missing" }, 503);
    return await triggerReconcile(env, ctx);
  }

  return apiJson({ ok: false, error: "Not found" }, 404);
}

async function systemInfo(
  request: Request,
  env: Env,
  session: AdminSession,
): Promise<Record<string, unknown>> {
  const config = oidcConfig(env);
  const url = new URL(request.url);
  const base = adminBaseUrl(env, url);

  const [healthResponse, stats, reconcile] = await Promise.all([
    health(env).catch((error) => {
      console.error("Health check failed", errorMessage(error));
      return Response.json({ status: "error" });
    }),
    env.DB
      ? getSystemStats(env).catch(() => null)
      : Promise.resolve(null),
    readReconcileState(env),
  ]);

  let healthBody: unknown = null;
  try {
    healthBody = await healthResponse.json();
  } catch {
    healthBody = { status: "error" };
  }

  return {
    generatedAt: Date.now(),
    stats,
    health: healthBody,
    dashboard: {
      admin: {
        id: session.id,
        name: session.name,
        username: session.username,
        picture: session.picture,
        expiresAt: session.exp,
      },
      allowlist: [...config.adminIds].sort((a, b) => a - b),
      allowlistCount: config.adminIds.size,
      oidcConfigured: Boolean(config.clientId && config.clientSecret),
      sessionSecretConfigured: Boolean(config.sessionSecret),
      clientId: config.clientId || null,
      issuer: OIDC_ISSUER,
      scopes: ["openid", "profile"],
      baseUrl: base,
      callbackUrl: `${base}/admin/auth/callback`,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
      environment: base.includes("localhost") || base.includes("127.0.0.1")
        ? "local"
        : "production",
    },
    reconcile,
  };
}

async function triggerReconcile(
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const current = await readReconcileState(env);
  if (
    current.status === "running" &&
    current.startedAt &&
    Date.now() - current.startedAt < 5 * 60 * 1000
  ) {
    return apiJson({ ok: true, state: current }, 202);
  }

  const started = Date.now();
  const running: ReconcileState = { status: "running", startedAt: started };
  await env.SESSIONS.put(RECONCILE_KEY, JSON.stringify(running), {
    expirationTtl: 24 * 60 * 60,
  });

  // Payment lookups can take longer than a browser wants to wait, so the run
  // continues in the background and the dashboard polls the stored state.
  ctx.waitUntil(
    (async () => {
      try {
        const sessions = await reconcileSessions(env);
        await reconcileDonations(env);
        const done: ReconcileState = {
          status: "done",
          startedAt: started,
          finishedAt: Date.now(),
          sessions,
        };
        await env.SESSIONS.put(RECONCILE_KEY, JSON.stringify(done), {
          expirationTtl: 24 * 60 * 60,
        });
        console.log("Dashboard reconciliation finished", JSON.stringify(sessions));
      } catch (error) {
        const failed: ReconcileState = {
          status: "error",
          startedAt: started,
          finishedAt: Date.now(),
          error: errorMessage(error),
        };
        await env.SESSIONS.put(RECONCILE_KEY, JSON.stringify(failed), {
          expirationTtl: 24 * 60 * 60,
        });
        console.error("Dashboard reconciliation failed", errorMessage(error));
      }
    })(),
  );

  return apiJson({ ok: true, state: running }, 202);
}

async function readReconcileState(env: Env): Promise<ReconcileState> {
  try {
    const raw = await env.SESSIONS.get(RECONCILE_KEY);
    if (!raw) return { status: "idle" };
    const parsed = JSON.parse(raw) as ReconcileState;
    if (
      parsed.status === "running" ||
      parsed.status === "done" ||
      parsed.status === "error"
    ) {
      return parsed;
    }
    return { status: "idle" };
  } catch {
    return { status: "idle" };
  }
}

async function serveDashboard(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  let asset: Response;
  try {
    // Workers Assets redirects /dashboard/index.html to /dashboard/, so ask
    // for the directory URL directly.
    asset = await env.ASSETS.fetch(
      new Request(new URL("/dashboard/", url.origin).toString(), {
        headers: { accept: "text/html" },
      }),
    );
  } catch (error) {
    console.error("Could not read dashboard asset", errorMessage(error));
    asset = new Response("", { status: 404 });
  }

  if (!asset.ok) return dashboardNotBuilt();

  const headers = new Headers(asset.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", CSP);
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  return new Response(asset.body, { status: 200, headers });
}

function dashboardNotBuilt(): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dashboard not built</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center;
        background: #08090c; color: #f2f1ec;
        font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }
      main { max-width: 460px; padding: 32px; border: 1px solid #262832;
        border-radius: 18px; background: #0f1117; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { color: #9396a3; margin: 0 0 16px; }
      code { display: block; padding: 12px 14px; border-radius: 10px;
        background: #08090c; color: #f0b45f; font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <main>
      <h1>Dashboard bundle missing</h1>
      <p>The Worker is running, but the React dashboard has not been built yet.</p>
      <code>pnpm run build:web</code>
    </main>
  </body>
</html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function intParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

function readCookie(request: Request, name: string): string {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return "";
}

async function currentSession(
  request: Request,
  env: Env,
): Promise<AdminSession | null> {
  const config = oidcConfig(env);
  if (!config.sessionSecret || config.adminIds.size === 0) return null;
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return null;
  const session = await verifySession(token, config.sessionSecret);
  if (!session) return null;
  // Allowlist is the source of truth: removing an id revokes access immediately,
  // even if that person still holds a valid cookie.
  if (!config.adminIds.has(session.id)) return null;
  return session;
}

function randomToken(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signValue(payload: unknown, secret: string): Promise<string> {
  const body = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await sessionKey(secret),
    new TextEncoder().encode(body),
  );
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyValue<T>(
  token: string,
  secret: string,
): Promise<T | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await sessionKey(secret),
      base64UrlDecode(signature),
      new TextEncoder().encode(body),
    );
    if (!valid) return null;
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as T;
  } catch {
    return null;
  }
}

async function verifySession(
  token: string,
  secret: string,
): Promise<AdminSession | null> {
  const session = await verifyValue<AdminSession>(token, secret);
  if (!session) return null;
  if (session.v !== 1) return null;
  if (!Number.isSafeInteger(session.id) || session.id <= 0) return null;
  if (typeof session.exp !== "number" || session.exp < Date.now()) return null;
  return session;
}

async function verifyIdToken(
  token: string,
  clientId: string,
): Promise<IdTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(headerPart)),
  ) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" && header.alg !== "ES256") {
    throw new Error(`Unsupported ID token algorithm: ${header.alg ?? "none"}`);
  }

  const jwk = await findJwk(header.kid, header.alg);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    header.alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    header.alg === "RS256"
      ? "RSASSA-PKCS1-v1_5"
      : { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlDecode(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("Bad ID token signature");

  const claims = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadPart)),
  ) as IdTokenClaims;

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== OIDC_ISSUER) throw new Error("Unexpected issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some((audience) => String(audience) === clientId)) {
    throw new Error("Unexpected audience");
  }
  if (typeof claims.exp !== "number" || claims.exp < now - 30) {
    throw new Error("ID token expired");
  }
  if (typeof claims.iat === "number" && claims.iat > now + 300) {
    throw new Error("ID token issued in the future");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) {
    throw new Error("ID token not active yet");
  }
  return claims;
}

async function findJwk(
  kid: string | undefined,
  alg: string,
): Promise<Jwk> {
  const kty = alg === "RS256" ? "RSA" : "EC";
  // Telegram rotates keys rarely and a login only happens occasionally, so a
  // fresh JWKS read keeps verification correct without a stale KV cache.
  const keys = await readJwks();
  const compatible = keys.filter(
    (key) => key.kty === kty && (!key.alg || key.alg === alg),
  );
  const match = kid
    ? compatible.find((key) => key.kid === kid) ??
      compatible.find((key) => !key.kid)
    : compatible[0];
  if (!match) throw new Error("No matching signing key");
  return match;
}

async function readJwks(): Promise<Jwk[]> {
  const response = await fetchWithTimeout(
    OIDC_JWKS_URL,
    { headers: { accept: "application/json" } },
    8_000,
  );
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
  const set = (await response.json()) as JwkSet;
  const keys = Array.isArray(set.keys) ? set.keys : [];
  if (!keys.length) throw new Error("JWKS is empty");
  return keys;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
