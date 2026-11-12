import type { Env } from "./types";
import type { HallOfFameRow } from "./db";
import { getHallOfFame, getUserFirstName } from "./db";
import { sendMessage, sendWidget } from "./telegram";
import {
  BRAND_IMAGE,
  LOGO_CBE,
  LOGO_MPESA,
  LOGO_TELEBIRR,
} from "./widget-images";
import { errorMessage, escapeHtml, formatEtb, gatewayLabel } from "./util";
import { botUsername } from "./health";

/**
 * Two static widgets shown after the picker: the settlement card and the Hall
 * of Fame. Neither has client script or `chat_data` — the bot bakes the values
 * in when it sends them, so there is no state to keep in sync.
 *
 * Same limits as the picker: 32768 bytes of HTML, 4096 after zlib level 9, and
 * nothing outside widget profile 1.
 */

const GATEWAY_LOGO: Record<string, string> = {
  telebirr: LOGO_TELEBIRR,
  mpesa: LOGO_MPESA,
  cbe: LOGO_CBE,
};

const CELEBRATION_CAPTION = "Payment received — thank you! ✨";
const FAME_CAPTION = "Hall of Fame — the top 3 supporters.";

export type CelebrationOptions = {
  /** Charge amount in ETB, not minor units. */
  amount: number;
  gateway?: string | null;
  reference?: string | null;
  name?: string | null;
};

/** Small "1 200 ETB" style number without the currency, for the big display. */
function etbNumber(amount: number): string {
  return Math.round(amount).toLocaleString("en-US");
}

const CELEBRATION_CSS = `
body{margin:0;padding:16px 14px 14px;font-family:system-ui,sans-serif;color:var(--tg-theme-text-color);text-align:center}
.w{position:relative;display:flex;justify-content:center;margin:0 0 10px}
.gl{position:absolute;top:-16px;width:112px;height:112px;border-radius:50%;background:radial-gradient(circle,rgba(34,197,94,.28),rgba(34,197,94,0) 62%)}
.ck{position:relative;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#34d399,#059669)}
.ck svg{width:28px;height:28px;fill:none;stroke:#fff;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.hi{margin:0;font-size:1.02em;font-weight:600;line-height:1.3}
.am{margin:3px 0 0;font-size:clamp(1.5em,9vw,2em);font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.am span{font-size:.45em;font-weight:600;letter-spacing:.04em;color:var(--tg-theme-hint-color)}
.gw{display:inline-flex;align-items:center;gap:6px;margin:9px 0 0;padding:3px 10px 3px 4px;border-radius:999px;background:var(--tg-theme-secondary-bg-color);font-size:.78em;font-weight:600}
.gw img{width:20px;height:20px;border-radius:6px;object-fit:contain;box-sizing:border-box}
.gw img.t{background:#fff;padding:2px}
.ft{margin:10px 0 0;font-size:.75em;line-height:1.45;color:var(--tg-theme-hint-color)}
.ft b{color:var(--tg-theme-text-color);font-weight:600;font-variant-numeric:tabular-nums}
@keyframes pop{0%{transform:scale(.35)}100%{transform:scale(1)}}
@media (prefers-reduced-motion:no-preference){.ck{animation:pop .45s cubic-bezier(.2,1.5,.4,1) both}}
`;

/** "Thank you" card sent once when a donation completes. */
export function renderCelebration(options: CelebrationOptions): string {
  const { amount, reference } = options;
  const gateway = options.gateway ?? "";
  const name = options.name?.trim();

  const hello = name ? `Thank you, ${escapeHtml(name)}!` : "Thank you!";
  const known =
    gateway === "telebirr" || gateway === "mpesa" || gateway === "cbe";
  const method = known
    ? `<p class="gw"><img class="${gateway === "telebirr" ? "t" : ""}" src="${GATEWAY_LOGO[gateway]}">${escapeHtml(gatewayLabel(gateway))}</p>`
    : "";
  const receipt = reference
    ? `<p class="ft">Receipt <b>${escapeHtml(reference)}</b><br>Your support keeps this project going.</p>`
    : `<p class="ft">Your support keeps this project going.</p>`;

  return `<style>${CELEBRATION_CSS}</style>
<div class="w"><div class="gl"></div><div class="ck"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg></div></div>
<p class="hi">${hello}</p>
<p class="am">${etbNumber(amount)} <span>ETB</span></p>
${method}
${receipt}`;
}

const FAME_CSS = `
body{margin:0;padding:12px 12px 6px;font-family:system-ui,sans-serif;color:var(--tg-theme-text-color)}
.hd{display:flex;align-items:center;gap:9px;margin:0 0 12px}
.bd{width:30px;height:30px;flex:none;border-radius:9px;object-fit:contain;background:#fff}
.t1{margin:0;font-size:1em;font-weight:600;line-height:1.25}
.t2{margin:1px 0 0;font-size:.76em;line-height:1.25;color:var(--tg-theme-hint-color)}
.pod{display:flex;align-items:flex-end;gap:6px}
.col{flex:1;min-width:0;text-align:center}
.md{display:block;font-size:1.05em;line-height:1.3}
.nm{display:block;font-size:.76em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pt{display:block;font-size:.72em;color:var(--tg-theme-hint-color);white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}
.bar{display:block;border-radius:9px 9px 0 0;margin-top:6px}
.b1{height:74px;background:linear-gradient(180deg,#fbbf24,#d97706)}
.b2{height:56px;background:linear-gradient(180deg,#cbd5e1,#94a3b8)}
.b3{height:44px;background:linear-gradient(180deg,#d9a17a,#b45309)}
.em{margin:2px 0 8px;font-size:.82em;line-height:1.45;color:var(--tg-theme-hint-color);text-align:center}
.ct{margin:10px 0 4px;font-size:.72em;line-height:1.4;color:var(--tg-theme-hint-color);text-align:center}
@keyframes grow{0%{transform:scaleY(.1)}100%{transform:scaleY(1)}}
.bar{transform-origin:bottom}
@media (prefers-reduced-motion:no-preference){.b1{animation:grow .5s ease-out both}.b2{animation:grow .5s .08s ease-out both}.b3{animation:grow .5s .16s ease-out both}}
`;

const PODIUM = [
  { medal: "🥇", bar: "b1" },
  { medal: "🥈", bar: "b2" },
  { medal: "🥉", bar: "b3" },
];

/** Podium of the top three donors, drawn from one D1 aggregate. */
export function renderHallOfFame(rows: HallOfFameRow[]): string {
  const header = `<div class="hd"><img class="bd" src="${BRAND_IMAGE}"><div><p class="t1">Hall of Fame</p><p class="t2">Top supporters · all-time</p></div></div>`;

  if (rows.length === 0) {
    return `<style>${FAME_CSS}</style>${header}<p class="em">No completed donations yet.<br>Be the first on the podium.</p><p class="ct">Send /donate to join.</p>`;
  }

  // Podium order is 2nd, 1st, 3rd so the tallest column sits in the middle.
  const order = rows.length === 1 ? [0] : rows.length === 2 ? [1, 0] : [1, 0, 2];
  const columns = order
    .map((index) => {
      const row = rows[index];
      const slot = PODIUM[index];
      const name = escapeHtml(row.firstName?.trim() || "Anonymous");
      return `<div class="col"><span class="md">${slot.medal}</span><span class="nm">${name}</span><span class="pt">${formatEtb(row.totalMinor / 100)}</span><span class="bar ${slot.bar}"></span></div>`;
    })
    .join("");

  return `<style>${FAME_CSS}</style>${header}<div class="pod">${columns}</div><p class="ct">Send /donate to join them.</p>`;
}

const BRAND = BRAND_IMAGE;

/**
 * Send the settlement card, falling back to the plain text when Telegram
 * refuses widgets. Returns true when the widget went out.
 */
export async function sendCelebration(
  env: Env,
  chatId: number,
  options: CelebrationOptions,
  fallbackText: string,
): Promise<boolean> {
  try {
    const name = options.name ?? (await getUserFirstName(env, chatId));
    await sendWidget(env, chatId, renderCelebration({ ...options, name }), {
      caption: CELEBRATION_CAPTION,
    });
    return true;
  } catch (error) {
    console.warn(
      "Celebration widget rejected, using text",
      errorMessage(error),
    );
    try {
      await sendMessage(env, chatId, fallbackText);
    } catch (sendError) {
      console.warn("Could not notify donor", errorMessage(sendError));
    }
    return false;
  }
}

/** Send the Hall of Fame card, falling back to the plain text list. */
export async function sendHallOfFame(
  env: Env,
  chatId: number,
): Promise<void> {
  const rows = await getHallOfFame(env, 3);
  const keyboard = await fameKeyboard(env, rows);
  const options = {
    caption: FAME_CAPTION,
    ...(keyboard ? { replyMarkup: keyboard } : {}),
  };
  try {
    await sendWidget(env, chatId, renderHallOfFame(rows), options);
  } catch (error) {
    console.warn(
      "Hall of Fame widget rejected, using text",
      errorMessage(error),
    );
    await sendMessage(env, chatId, hallOfFameText(rows), keyboard);
  }
}

/**
 * A widget message can't be forwarded: in production Telegram sends every
 * widget with protected content and only allows widgets in private chats. So
 * "share" means a deep link that makes the bot send a fresh podium in the
 * recipient's own chat, plus a copyable text version for channels.
 */
async function fameKeyboard(
  env: Env,
  rows: HallOfFameRow[],
): Promise<unknown | undefined> {
  const username = await botUsername(env);
  if (!username) return undefined;
  const link = `https://t.me/${username}?start=fame`;
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
    "I support this project — see who else does 👇",
  )}`;
  return {
    inline_keyboard: [
      [
        { text: "Share 🏆", url: share, style: "primary" },
        {
          text: "Copy top 3",
          copy_text: { text: hallOfFameShareText(rows) },
          style: "success",
        },
      ],
    ],
  };
}

/** Plain-text podium for the copy button; must stay under 256 characters. */
export function hallOfFameShareText(rows: HallOfFameRow[]): string {
  const lines = ["🏆 Hall of Fame — top supporters of this project"];
  if (rows.length === 0) {
    lines.push("No donations yet — be the first!");
  } else {
    const medals = ["🥇", "🥈", "🥉"];
    rows.forEach((row, index) => {
      const name = (row.firstName || "Anonymous").slice(0, 24);
      lines.push(`${medals[index]} ${name} · ${formatEtb(row.totalMinor / 100)}`);
    });
  }
  return lines.join("\n").slice(0, 256);
}

/** Plain-text Hall of Fame, used when widgets are unavailable. */
export function hallOfFameText(rows: HallOfFameRow[]): string {
  const header = "🏆 <b>HALL OF FAME</b>\n<i>Top supporters · all-time total</i>";
  if (rows.length === 0) {
    return `${header}\n\nNo completed donations yet.\nSend /donate and take the top spot!`;
  }
  const medals = ["🥇", "🥈", "🥉"];
  const lines = rows.map((row, index) => {
    const name = row.firstName || "Anonymous";
    const donations = `donation${row.donationCount === 1 ? "" : "s"}`;
    return (
      `${medals[index]} <b>${escapeHtml(name)}</b>\n` +
      `     ${formatEtb(row.totalMinor / 100)} · ${row.donationCount} ${donations}`
    );
  });
  return `${header}\n━━━━━━━━━━━━━━\n${lines.join("\n\n")}\n━━━━━━━━━━━━━━`;
}
