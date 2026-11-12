import type { Gateway } from "./constants";

/** Caption on the amount picker. Older clients that can't draw widgets show
 * this text instead of the buttons, so it has to stand on its own. */
export const PICKER_CAPTION = "Choose a donation amount in ETB.";

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
 * The picker widget: one HTML document, no network, no libraries. Amounts are
 * baked in at send time (the code can't change later), everything else comes
 * from `chat_data`. Taps call `TelegramWidget.request`, the bot answers and
 * pushes the next state with `editMessageWidgetData`.
 *
 * Limit is 32768 bytes of HTML and 4096 bytes after zlib level 9, so keep this
 * small: SVG/CSS only, no images.
 */
const PICKER_HTML = `<!doctype html>
<meta charset="utf-8">
<style>
.h{margin:0 0 2px;font-weight:600}
.m{margin:0 0 10px;color:var(--tg-theme-hint-color);font-size:.9em}
.g{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.g button{width:100%;margin:0;padding:10px 2px}
.r{display:flex;gap:6px;margin-top:8px}
.r button{flex:1;margin:0;padding:9px 2px;color:var(--tg-theme-link-color)}
#e{margin:8px 0 0;color:var(--tg-theme-destructive-text-color);font-size:.85em}
</style>
<div id="w"></div>
<script>
var W=window.TelegramWidget,D=__DATA__,G=[["telebirr","Telebirr"],["mpesa","M-Pesa"],["cbe","CBE Birr"]],root=document.getElementById("w"),busy=false,note="";
function st(){if(!W)return{};try{return JSON.parse(W.chatData||"{}")||{}}catch(e){return{}}}
function etb(n){return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",")+" ETB"}
function nm(g){for(var i=0;i<G.length;i++)if(G[i][0]===g)return G[i][1];return g}
function dis(){return busy?" disabled":""}
function render(){
  var s=st(),h="",i;
  if(s.s==="g"&&s.a){
    h='<p class="h">'+etb(s.a)+'</p><p class="m">Select how you would like to pay.</p><div class="g">';
    for(i=0;i<G.length;i++)h+='<button data-x="gateway:'+s.a+":"+G[i][0]+'"'+dis()+">"+G[i][1]+"</button>";
    h+='</div><div class="r"><button data-x="back"'+dis()+">Back</button><button data-x=\\"cancel\\""+dis()+">Cancel</button></div>";
  }else if(s.s==="p"&&s.a){
    h='<p class="h">'+etb(s.a)+' &middot; '+nm(s.g)+'</p><p class="m">Reply to the message below with the number registered with your '+nm(s.g)+' account. It is only used to start this payment.</p><div class="r"><button data-x="cancel"'+dis()+">Cancel</button></div>";
  }else{
    h='<p class="h">Choose an amount</p><p class="m">Pick how much you would like to donate.</p><div class="g">';
    for(i=0;i<D.a.length;i++)h+='<button data-x="amount:'+D.a[i]+'"'+dis()+">"+D.a[i]+" ETB</button>";
    h+='</div><div class="r"><button data-x="cancel"'+dis()+">Cancel</button></div>";
  }
  if(note)h+='<p id="e">'+note+"</p>";
  root.innerHTML=h;
}
function ask(x){
  if(busy||!W||!W.request)return;
  busy=true;note="";render();
  W.request(x).then(function(){busy=false;render()},function(err){
    busy=false;
    var c=err&&err.code;
    note=c==="RATE_LIMITED"?"Too many taps. Wait a moment and try again."
      :c==="NOT_ALLOWED"?"This message is out of date. Send /donate for a new one."
      :c==="TIMEOUT"||c==="FAILED"?"The bot did not answer. Try again."
      :"Something went wrong. Try again.";
    render();
  });
}
root.addEventListener("click",function(ev){
  var el=ev.target;
  while(el&&el!==root){
    if(el.getAttribute&&el.getAttribute("data-x")){ask(el.getAttribute("data-x"));return}
    el=el.parentNode;
  }
});
if(W&&W.onEvent){
  W.onEvent("chatDataChanged",function(){busy=false;note="";render()});
  W.onEvent("publicDataChanged",function(){render()});
}
render();
if(W&&W.ready)W.ready();
</script>`;

/** Build the picker for the configured amounts. */
export function renderAmountPicker(amounts: number[]): string {
  return PICKER_HTML.replace("__DATA__", JSON.stringify({ a: amounts }));
}
