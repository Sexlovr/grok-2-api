export function buildAdminPage() {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grok2API Admin</title>
<style>
:root{--bg:#0b0d10;--card:#15181d;--mut:#8b93a1;--fg:#e7eaee;--acc:#7c5cff;--ok:#2fbf71;--err:#ff5470;--line:#252a31}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
.card h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
input,textarea,button{font:inherit;border-radius:8px;border:1px solid var(--line);background:#0f1216;color:var(--fg);padding:9px 11px}
textarea{width:100%;min-height:90px;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:12px}
input{width:100%}button{background:var(--acc);border:none;color:#fff;cursor:pointer;font-weight:600}
button:hover{filter:brightness(1.08)}button.ghost{background:#1b1f25;border:1px solid var(--line)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>*{flex:0 0 auto}
.grow{flex:1 1 auto}.mut{color:var(--mut)}.pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.ok{color:var(--ok)}.err{color:var(--err)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
.hide{display:none}.code{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}
#msg{position:fixed;top:14px;right:14px;background:var(--card);border:1px solid var(--line);padding:10px 14px;border-radius:8px;opacity:0;transition:.2s}
.small{font-size:12px}
</style></head><body>
<div id="msg"></div>
<div class="wrap">
  <h1>Grok2API <span class="pill">sig-relay</span></h1>
  <p class="sub">OpenAI-compatible proxy for grok.com · stateless full-dump · fed by a relayed x-statsig-id (no browser)</p>

  <div class="card" id="loginCard">
    <h2>Admin login</h2>
    <div class="row"><input id="pw" type="password" placeholder="admin password" class="grow"><button onclick="login()">Login</button></div>
  </div>

  <div id="app" class="hide">
    <div class="card">
      <h2>Status</h2>
      <div id="status" class="small mut">loading…</div>
      <div class="row" style="margin-top:10px"><button class="ghost" onclick="reload()">Reload active account</button></div>
    </div>

    <div class="card">
      <h2>Sig refresher <span class="pill">required</span></h2>
      <p class="small mut">A relayed <span class="code">x-statsig-id</span> lives only ~3-4 min, so a userscript on a real grok.com tab must keep feeding it. Install <b>Tampermonkey</b> (desktop) or <b>Violentmonkey</b> (Android/Firefox), then click install. Keep a grok.com tab open.</p>
      <div class="row" style="margin-top:8px">
        <a id="usLink" href="/grok-refresher.user.js"><button>Install refresher userscript</button></a>
        <span class="small mut">refresh token: <span class="code" id="rtHint">—</span></span>
      </div>
    </div>

    <div class="card">
      <h2>Add Grok account</h2>
      <p class="small mut">On grok.com, open DevTools → Network → send any message → right-click the <span class="code">conversations/new</span> request → Copy as cURL → paste below. We extract the session cookie (sso / sso-rw), user-agent, and the <span class="code">x-statsig-id</span> header (seeds an initial sig good for ~3-4 min — the refresher takes over after that).</p>
      <textarea id="curl" placeholder="curl 'https://grok.com/rest/app-chat/conversations/new' -H ... -b 'sso=...; sso-rw=...; cf_clearance=...'"></textarea>
      <div class="row" style="margin-top:8px"><input id="label" placeholder="label (optional)" class="grow"><button onclick="addAccount()">Add / Update</button></div>
    </div>

    <div class="card">
      <h2>Accounts</h2>
      <table id="accs"><thead><tr><th>ID</th><th>Label</th><th>User</th><th>Active</th><th>Reqs</th><th></th></tr></thead><tbody></tbody></table>
    </div>

    <div class="card">
      <h2>API keys</h2>
      <div class="row"><input id="keyName" placeholder="key name" class="grow"><button onclick="addKey()">Create key</button></div>
      <table id="keys" style="margin-top:10px"><thead><tr><th>Name</th><th>Key</th><th>Active</th><th>Reqs</th><th></th></tr></thead><tbody></tbody></table>
    </div>

    <div class="card">
      <h2>Models</h2>
      <table id="models"><thead><tr><th>Model ID</th><th>Display</th><th>Grok mode</th></tr></thead><tbody></tbody></table>
    </div>
  </div>
</div>
<script>
// Privacy browsers (Quetta, Brave strict, Firefox private) can THROW on
// localStorage access instead of returning null. A bare localStorage call at
// the top of the script would then kill the whole page (blank/stuck loading).
// Guard every access so the dashboard still works with storage disabled — it
// just won't persist the login token across reloads.
var SS={get:function(k){try{return localStorage.getItem(k)||'';}catch(e){return '';}},
        set:function(k,v){try{localStorage.setItem(k,v);}catch(e){}},
        del:function(k){try{localStorage.removeItem(k);}catch(e){}}};
let TOK=SS.get('g_tok');
const $=s=>document.querySelector(s);
function toast(t,bad){const m=$('#msg');m.textContent=t;m.style.opacity=1;m.style.borderColor=bad?'#ff5470':'#252a31';setTimeout(()=>m.style.opacity=0,2600);}
async function api(path,opts={}){opts.headers=Object.assign({'content-type':'application/json'},opts.headers||{},TOK?{authorization:'Bearer '+TOK}:{});const r=await fetch(path,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error?.message||j.error||r.status);return j;}
async function login(){try{const j=await api('/admin/login',{method:'POST',body:JSON.stringify({password:$('#pw').value})});TOK=j.token;SS.set('g_tok',TOK);enter();}catch(e){toast('Login failed',1);}}
function show(){$('#loginCard').classList.remove('hide');$('#app').classList.add('hide');}
function enter(){$('#loginCard').classList.add('hide');$('#app').classList.remove('hide');refresh();}
// On 401 (no/expired token — e.g. the Space restarted and rotated its secret),
// drop the token and show the login form. Do NOT location.reload(): with a
// stale token that loops forever instead of letting you log in.
function logout(){TOK='';SS.del('g_tok');$('#loginCard').classList.remove('hide');$('#app').classList.add('hide');}
async function refresh(){try{await Promise.all([loadStatus(),loadAccs(),loadKeys(),loadModels()]);}catch(e){if((''+e).includes('401'))logout();}}
function sigFmt(s){if(!s||!s.hasSig)return '<b class="err">none</b>';var a=s.ageSeconds;var cls=s.stale?'err':(a<120?'ok':'');var lbl=s.stale?'STALE':'fresh';return '<b class="'+cls+'">'+lbl+'</b> ('+a+'s old, max '+s.maxAgeSeconds+'s)';}
async function loadStatus(){try{const s=await api('/admin/status');$('#rtHint').textContent=s.refreshTokenHint||'—';$('#status').innerHTML='account: <b class="'+(s.hasAccount?'ok':'err')+'">'+(s.hasAccount?'loaded':'none')+'</b> · sig: '+sigFmt(s.sig);}catch(e){if((''+e).includes('401')){logout();}}}
async function loadAccs(){const a=await api('/admin/accounts');$('#accs tbody').innerHTML=a.map(x=>'<tr><td>'+x.id+'</td><td>'+(x.label||'')+'</td><td class="small mut">'+(x.user_id||'')+'</td><td>'+(x.active?'<span class="ok">yes</span>':'no')+'</td><td>'+x.request_count+'</td><td><button class="ghost small" onclick="delAcc('+x.id+')">del</button></td></tr>').join('');}
async function addAccount(){try{const j=await api('/admin/accounts',{method:'POST',body:JSON.stringify({curl:$('#curl').value,label:$('#label').value})});toast(j.message);$('#curl').value='';refresh();}catch(e){toast(e.message,1);}}
async function delAcc(id){await api('/admin/accounts/'+id,{method:'DELETE'});refresh();}
async function reload(){try{await api('/admin/reload',{method:'POST'});toast('Reloaded');loadStatus();}catch(e){toast(e.message,1);}}
async function loadKeys(){const k=await api('/admin/keys');$('#keys tbody').innerHTML=k.map(x=>'<tr><td>'+(x.name||'')+'</td><td class="code">'+x.key+'</td><td>'+(x.active?'<span class="ok">yes</span>':'no')+'</td><td>'+x.request_count+'</td><td><button class="ghost small" onclick="delKey('+x.id+')">del</button></td></tr>').join('');}
async function addKey(){try{const j=await api('/admin/keys',{method:'POST',body:JSON.stringify({name:$('#keyName').value})});toast('Created');$('#keyName').value='';refresh();}catch(e){toast(e.message,1);}}
async function delKey(id){await api('/admin/keys/'+id,{method:'DELETE'});refresh();}
async function loadModels(){const m=await api('/admin/models');$('#models tbody').innerHTML=m.map(x=>'<tr><td class="code">'+x.model_id+'</td><td>'+(x.display_name||'')+'</td><td class="small mut">'+x.mode_id+'</td></tr>').join('');}
if(TOK)enter();
// Live-refresh the sig freshness widget while the dashboard is open.
setInterval(function(){if(!document.getElementById('app').classList.contains('hide'))loadStatus();},5000);
</script>
</body></html>`;
}
