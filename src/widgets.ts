import type { Gateway } from "./constants";
import { LOGO_CBE, LOGO_MPESA, LOGO_TELEBIRR } from "./widget-logos";

/** Caption on the amount picker. Older clients that can't draw widgets show
 * this text instead of the buttons, and it is what the chat list shows. */
export const PICKER_CAPTION =
  "Choose an amount and pay with Telebirr, M-Pesa or CBE Birr.";

/**
 * `chat_data` of the amount picker. The widget is fixed HTML, so every screen
 * is painted from this state: `a` = amounts, `g` = gateways, `p` = the phone
 * prompt was sent. Keep it in sync with the script in `PICKER_HTML`.
 */
export type PickerState =
  | { s: "a" }
  | { s: "g"; a: number }
  | { s: "p"; a: number; g: Gateway };

export function pickerState(state: PickerState): string {
  return JSON.stringify(state);
}

/**
 * The payment logos, inlined as `data:` PNGs. They are baked into the HTML at
 * send time because a widget never loads a network URL, and the whole document
 * must stay under 4096 bytes after zlib level 9. Regenerate with
 * `node scripts/build-widget-logos.mjs` after changing `images/`.
 */
const LOGOS = { t: LOGO_TELEBIRR, m: LOGO_MPESA, c: LOGO_CBE };

/**
 * The picker widget: one HTML document, no network, no libraries, nothing
 * outside Telegram's widget profile 1.
 *
 * - Amounts and logos are baked in at send time (the HTML never changes
 *   afterwards); everything else is drawn from `chat_data`.
 * - A tap calls `TelegramWidget.request`, the bot answers and pushes the next
 *   state with `editMessageWidgetData`, and `chatDataChanged` redraws.
 * - Limits: 32768 bytes of HTML and 4096 after zlib level 9. Most of that is
 *   the three logos, so the CSS is deliberately lean: no opacity, no blurred
 *   shadows, no filters, no `vh`, no form controls, no external fonts or
 *   images — the profile removes or counts all of those.
 * - Only `transform`, `background` and `color` animate, so the "heavy
 *   element" budget (16) is never touched, and motion honours
 *   `prefers-reduced-motion`.
 */
const PICKER_HTML = `<style>
body{margin:0;padding:10px 12px;font-family:system-ui,sans-serif;color:var(--tg-theme-text-color)}
.hd{display:flex;align-items:center;gap:9px;margin:0 0 10px}
.bg{width:34px;height:34px;flex:none;border-radius:11px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#6366f1,#a855f7)}
.bg svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.t1{margin:0;font-size:1.02em;font-weight:600;line-height:1.25}
.t2{margin:1px 0 0;font-size:.79em;line-height:1.25;color:var(--tg-theme-hint-color)}
.sr{display:flex;align-items:center;gap:5px;margin:0 0 11px}
.s{width:18px;height:18px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.66em;font-weight:700;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-hint-color)}
.s.on{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
.s.dn{color:var(--tg-theme-text-color)}
.l{flex:1;height:2px;border-radius:2px;background:var(--tg-theme-section-separator-color)}
.l.dn{background:var(--tg-theme-button-color)}
.ag{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;margin:0;padding:9px 2px;border:1px solid var(--tg-theme-section-separator-color);border-radius:12px;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color);line-height:1.12;transition:transform .12s ease,background .12s ease}
.a b{font-size:1.12em;font-weight:600;font-variant-numeric:tabular-nums}
.a i{font-style:normal;font-size:.62em;font-weight:500;letter-spacing:.06em;color:var(--tg-theme-hint-color)}
.a:last-child:nth-child(odd){grid-column:1/-1}
.rw{display:flex;align-items:center;gap:7px;margin:0 0 10px}
.bk,.pt{display:inline-flex;align-items:center;gap:4px;margin:0;padding:4px 10px;border:1px solid var(--tg-theme-section-separator-color);border-radius:999px;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color);font-size:.82em;font-weight:600;line-height:1.4}
.bk{padding-left:5px;color:var(--tg-theme-link-color)}
.pt{background:var(--tg-theme-button-color);border-color:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font-variant-numeric:tabular-nums}
.cv{width:15px;height:15px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.gw{display:flex;flex-direction:column;gap:7px}
.g{display:flex;align-items:center;gap:10px;width:100%;margin:0;padding:7px 10px;border:1px solid var(--tg-theme-section-separator-color);border-radius:12px;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color);text-align:left;transition:transform .12s ease,background .12s ease}
.lg{width:28px;height:28px;flex:none;border-radius:8px;object-fit:contain;box-sizing:border-box}
.lg-t{background:#fff;padding:3px}
.gn{flex:1;min-width:0;font-size:.96em;font-weight:600}
.dn{display:flex;justify-content:center;padding:7px 0 2px;color:var(--tg-theme-button-color)}
.dn svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.rr{display:flex;gap:7px;margin:10px 0 0}
.rr button{flex:1;margin:0;padding:8px 2px;border:1px solid var(--tg-theme-section-separator-color);border-radius:10px;background:transparent;color:var(--tg-theme-link-color);font-size:.84em;font-weight:500}
.nt{margin:9px 0 0;font-size:.75em;line-height:1.35;color:var(--tg-theme-hint-color)}
.er{color:var(--tg-theme-destructive-text-color);font-weight:500}
@keyframes bob{50%{transform:translateY(4px)}}
@media (prefers-reduced-motion:no-preference){.dn svg{animation:bob 1.8s ease-in-out infinite}}
@media (prefers-reduced-motion:no-preference){.a:active,.g:active{transform:scale(.97)}}
</style>
<div id="w"></div>
<script>
var W=window.TelegramWidget,D=__DATA__,L=__LOGOS__,root=document.getElementById("w"),busy=false,note="";
var G=[["telebirr","Telebirr","t"],["mpesa","M-Pesa","m"],["cbe","CBE Birr","c"]];
function st(){if(!W)return{};try{return JSON.parse(W.chatData||"{}")||{}}catch(e){return{}}}
function fmt(n){return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",")}
function nm(g){for(var i=0;i<G.length;i++)if(G[i][0]===g)return G[i];return null}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function dis(){return busy?" disabled":""}
function buzz(fn){try{if(W&&W.HapticFeedback)W.HapticFeedback[fn]()}catch(e){}}
function head(sub){
  var v=W&&W.viewer,name=v&&v.first_name?("Selam, "+esc(v.first_name)):"Support the project";
  return '<div class="hd"><div class="bg"><svg viewBox="0 0 24 24"><path d="M12 20.4S4 15.6 4 10.3A4.5 4.5 0 0 1 12 7.1a4.5 4.5 0 0 1 8 3.2c0 5.3-8 10.1-8 10.1z"/></svg></div><div><p class="t1">'+name+'</p><p class="t2">'+sub+'</p></div></div>';
}
function steps(n){
  var h='<div class="sr">',i;
  for(i=1;i<=3;i++){
    if(i>1)h+='<span class="l'+(i<=n?" dn":"")+'"></span>';
    h+='<span class="s'+(i===n?" on":(i<n?" dn":""))+'">'+i+"</span>";
  }
  return h+"</div>";
}
function scrA(){
  var h='<div class="ag">',i;
  for(i=0;i<D.a.length;i++)h+='<button class="a" data-x="amount:'+D.a[i]+'"'+dis()+"><b>"+fmt(D.a[i])+'</b><i>ETB</i></button>';
  return h+"</div>";
}
function scrG(a){
  var h='<div class="rw"><button class="bk" data-x="back"'+dis()+'><svg class="cv" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Back</button><span class="pt">'+fmt(a)+' ETB</span></div><div class="gw">',i;
  for(i=0;i<G.length;i++)h+='<button class="g" data-x="gateway:'+a+":"+G[i][0]+'"'+dis()+'><img class="lg lg-'+G[i][2]+'" src="'+L[G[i][2]]+'"><b class="gn">'+G[i][1]+'</b><svg class="cv" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>';
  return h+"</div>";
}
function scrP(a,g){
  var m=nm(g),label=m?m[1]:g;
  return '<div class="rw"><span class="pt">'+fmt(a)+' ETB</span><span class="t2" style="margin:0">'+esc(label)+'</span></div>'
    +'<p class="t2" style="margin:0">Reply in the chat below with the mobile number registered with your '+esc(label)+' account.</p>'
    +'<div class="dn"><svg viewBox="0 0 24 24"><path d="M12 4v13M6.5 12l5.5 5.5L17.5 12"/></svg></div>'
    +'<p class="nt">The number is only used to start this payment and is not stored.</p>'
    +'<div class="rr"><button data-x="back"'+dis()+'>Change amount</button><button data-x="cancel"'+dis()+'>Cancel</button></div>';
}
function render(){
  var s=st(),n=1,sub="Choose an amount · ETB",body;
  if(s.s==="g"&&s.a){n=2;sub="How would you like to pay?";body=scrG(s.a)}
  else if(s.s==="p"&&s.a){n=3;sub="One more step";body=scrP(s.a,s.g)}
  else body=scrA();
  var h=head(sub)+steps(n)+body;
  if(note)h+='<p class="nt er">'+note+"</p>";
  root.innerHTML=h;
}
function fail(c){
  if(c==="BUSY")return"";
  if(c==="RATE_LIMITED")return"Too many taps. Try again.";
  if(c==="NOT_ALLOWED")return"This card is out of date. Send /donate.";
  if(c==="TIMEOUT")return"No answer from the bot. Try again.";
  if(c==="INVALID_ANSWER")return"That answer was invalid.";
  return"Something went wrong. Try again.";
}
function ask(x){
  if(busy||!W||!W.request)return;
  busy=true;note="";render();
  W.request(x).then(function(){busy=false;render()},function(err){
    busy=false;note=fail(err&&err.code);render();
  });
}
root.addEventListener("click",function(ev){
  var el=ev.target;
  while(el&&el!==root){
    var x=el.getAttribute&&el.getAttribute("data-x");
    if(x){buzz("selectionChanged");ask(x);return}
    el=el.parentNode;
  }
});
if(W&&W.onEvent){
  W.onEvent("chatDataChanged",function(){busy=false;note="";render()});
}
render();
if(W&&W.ready)W.ready();
</script>`;

/** Build the picker for the configured amounts. */
export function renderAmountPicker(amounts: number[]): string {
  return PICKER_HTML.replace("__DATA__", JSON.stringify({ a: amounts })).replace(
    "__LOGOS__",
    JSON.stringify(LOGOS),
  );
}
