import { useState } from "react";
import {
  ArrowRight,
  CircleAlert,
  KeyRound,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { SessionInfo } from "../types";
import { Mark, TelegramIcon } from "../ui";

const AUTH_ERRORS: Record<string, { title: string; detail: string }> = {
  config: {
    title: "Dashboard login is not configured",
    detail:
      "Set TELEGRAM_OIDC_CLIENT_ID and ADMIN_TELEGRAM_IDS, add the OIDC client secret, then redeploy.",
  },
  not_allowed: {
    title: "This Telegram account is not an admin",
    detail:
      "Your Telegram id is not on ADMIN_TELEGRAM_IDS. Ask the owner to add you and redeploy.",
  },
  state: {
    title: "That sign-in attempt expired",
    detail: "Login attempts are single-use and last ten minutes. Start again.",
  },
  denied: {
    title: "Sign-in was cancelled",
    detail: "No access was granted. You can try again whenever you are ready.",
  },
  exchange: {
    title: "Telegram rejected the sign-in",
    detail:
      "Check that the client id, client secret, and /admin/auth/callback URL match BotFather.",
  },
  token: {
    title: "The identity token could not be verified",
    detail:
      "Make sure the Login Widget is allowed to share profile information, then try again.",
  },
};

export function Login({ session }: { session: SessionInfo }) {
  const [problem] = useState(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (!code) return null;
    window.history.replaceState(null, "", "/admin");
    return AUTH_ERRORS[code] ?? {
      title: "Sign-in failed",
      detail: "Something went wrong. Please try again.",
    };
  });

  const missing = [
    {
      ok: session.config.oidcConfigured,
      label: "Telegram OIDC client id + secret",
      hint: "BotFather → your bot → Login Widget",
    },
    {
      ok: session.config.allowlistCount > 0,
      label: "At least one admin",
      hint: "ADMIN_TELEGRAM_IDS",
    },
    {
      ok: session.config.sessionSecretConfigured,
      label: "Session signing secret",
      hint: "ADMIN_SESSION_SECRET or the OIDC client secret",
    },
  ].filter((item) => !item.ok);

  return (
    <main className="login">
      <section className="login-visual">
        <div className="orbit" aria-hidden="true">
          <span className="orbit-ring orbit-ring-a" />
          <span className="orbit-ring orbit-ring-b" />
          <span className="orbit-ring orbit-ring-c" />
          <span className="orbit-core">
            <Mark size={46} />
          </span>
          <span className="orbit-dot orbit-dot-a" />
          <span className="orbit-dot orbit-dot-b" />
        </div>

        <div className="login-brand">
          <Mark size={36} />
          <span>
            donate <em>to</em> me
          </span>
        </div>

        <div className="login-copy">
          <p className="eyebrow">Private admin console</p>
          <h1>
            Every donation,
            <br />
            <span>in one place.</span>
          </h1>
          <p className="login-lede">
            A live view of checkouts, settled payments, and the people behind
            them — for the team that runs the bot.
          </p>
        </div>

        <div className="login-rails" aria-hidden="true">
          <span className="login-rails-label">Payment rails</span>
          <span className="rail-pill">
            <i className="gateway-dot gateway-telebirr" /> Telebirr
          </span>
          <span className="rail-pill">
            <i className="gateway-dot gateway-mpesa" /> M-Pesa
          </span>
          <span className="rail-pill">
            <i className="gateway-dot gateway-cbe" /> CBE Birr
          </span>
        </div>

        <p className="login-foot">Telegram OIDC · PKCE · HttpOnly sessions</p>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="login-card-head">
            <p className="eyebrow">Access</p>
            <h2>Control room</h2>
            <p>
              Sign in with the Telegram account that was added to the admin
              allowlist.
            </p>
          </div>

          {problem ? (
            <div className="alert" role="alert">
              <CircleAlert size={17} />
              <div>
                <strong>{problem.title}</strong>
                <p>{problem.detail}</p>
              </div>
            </div>
          ) : null}

          {missing.length > 0 ? (
            <div className="setup">
              <strong>Setup still needed</strong>
              <ul>
                {missing.map((item) => (
                  <li key={item.label}>
                    <span className="setup-dot" />
                    <span>
                      {item.label}
                      <small>{item.hint}</small>
                    </span>
                  </li>
                ))}
              </ul>
              <p>
                Register <code>{window.location.origin}/admin/auth/callback</code>{" "}
                as an allowed URL in the Login Widget.
              </p>
            </div>
          ) : null}

          <a
            className={`tg-btn ${session.ready ? "" : "is-disabled"}`.trim()}
            href="/admin/auth/login"
            aria-disabled={!session.ready}
            onClick={(event) => {
              if (!session.ready) event.preventDefault();
            }}
          >
            <span className="tg-btn-icon">
              <TelegramIcon size={19} />
            </span>
            <span>Continue with Telegram</span>
            <ArrowRight size={16} />
          </a>

          <div className="login-note">
            <ShieldCheck size={14} />
            <span>
              Only allowlisted Telegram ids are accepted. Sessions live in an
              HttpOnly cookie and expire after 12 hours.
            </span>
          </div>

          <div className="login-meta">
            <span>
              {session.config.allowlistCount} admin
              {session.config.allowlistCount === 1 ? "" : "s"} configured
            </span>
            <span className="dot-sep" />
            <span>OIDC + PKCE</span>
          </div>
        </div>

        <div className="login-side-notes" aria-hidden="true">
          <span>
            <KeyRound size={13} /> No passwords stored
          </span>
          <span>
            <Users size={13} /> Allowlist enforced on every request
          </span>
        </div>
      </section>
    </main>
  );
}
