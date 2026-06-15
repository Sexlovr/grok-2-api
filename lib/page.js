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
  <h1>Grok2API <span class="pill">browser-signed</span></h1>
  <p class="sub">OpenAI-compatible proxy for grok.com · stateless full-dump · auto-discovered x-statsig-id</p>

  <div class="card" id="loginCard">
    <h2>Admin login</h2>
    <div class="row"><input id="pw" type="password" placeholder="admin password" class="grow"><button onclick="login()">Login</button></div>
  </div>

  <div id="app" class="hide">
    <div class="card">
      <h2>Status</h2>
      <div id="status" class="small mut">loading…</div>
      <div class="row" style="margin-top:10px"><button class="ghost" onclick="reload()">Reload session / re-discover signer</button></div>
    </div>

    <div class="card">
      <h2>Add Grok account</h2>
      <p class="small mut">On grok.com, open DevTools → Network → send any message → right-click the <span class="code">conversations/new</span> request → Copy as cURL → paste below. We extract the session cookie (sso / sso-rw), cf_clearance and user-agent.</p>
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
let TOK=localStorage.getItem('g_tok')||'';
const $=s=>document.querySelector(s);
function toast(t,bad){const m=$('#msg');m.textContent=t;m.style.opacity=1;m.style.borderColor=bad?'#ff5470':'#252a31';setTimeout(()=>m.style.opacity=0,2600);}
async function api(path,opts={}){opts.headers=Object.assign({'content-type':'application/json'},opts.headers||{},TOK?{authorization:'Bearer '+TOK}:{});const r=await fetch(path,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error?.message||j.error||r.status);return j;}
async function login(){try{const j=await api('/admin/login',{method:'POST',body:JSON.stringify({password:$('#pw').value})});TOK=j.token;localStorage.setItem('g_tok',TOK);show();}catch(e){toast('Login failed',1);}}
function show(){$('#loginCard').classList.add('hide');$('#app').classList.remove('hide');refresh();}
async function refresh(){await Promise.all([loadStatus(),loadAccs(),loadKeys(),loadModels()]);}
async function loadStatus(){try{const s=await api('/admin/status');$('#status').innerHTML='browser: <b class="'+(s.browserUp?'ok':'err')+'">'+(s.browserUp?'up':'down')+'</b> · session: <b class="'+(s.sessionLoaded?'ok':'err')+'">'+(s.sessionLoaded?'loaded':'none')+'</b> · signer module: <span class="code">'+(s.signer?.moduleId||'—')+'</span> · headless: '+s.headless;}catch(e){if((''+e).includes('401')){TOK='';localStorage.removeItem('g_tok');location.reload();}}}
async function loadAccs(){const a=await api('/admin/accounts');$('#accs tbody').innerHTML=a.map(x=>'<tr><td>'+x.id+'</td><td>'+(x.label||'')+'</td><td class="small mut">'+(x.user_id||'')+'</td><td>'+(x.active?'<span class="ok">yes</span>':'no')+'</td><td>'+x.request_count+'</td><td><button class="ghost small" onclick="delAcc('+x.id+')">del</button></td></tr>').join('');}
async function addAccount(){try{const j=await api('/admin/accounts',{method:'POST',body:JSON.stringify({curl:$('#curl').value,label:$('#label').value})});toast(j.message);$('#curl').value='';refresh();}catch(e){toast(e.message,1);}}
async function delAcc(id){await api('/admin/accounts/'+id,{method:'DELETE'});refresh();}
async function reload(){try{const j=await api('/admin/reload',{method:'POST'});toast('Reloaded · signer '+(j.signer?.moduleId||'?'));loadStatus();}catch(e){toast(e.message,1);}}
async function loadKeys(){const k=await api('/admin/keys');$('#keys tbody').innerHTML=k.map(x=>'<tr><td>'+(x.name||'')+'</td><td class="code">'+x.key+'</td><td>'+(x.active?'<span class="ok">yes</span>':'no')+'</td><td>'+x.request_count+'</td><td><button class="ghost small" onclick="delKey('+x.id+')">del</button></td></tr>').join('');}
async function addKey(){try{const j=await api('/admin/keys',{method:'POST',body:JSON.stringify({name:$('#keyName').value})});toast('Created');$('#keyName').value='';refresh();}catch(e){toast(e.message,1);}}
async function delKey(id){await api('/admin/keys/'+id,{method:'DELETE'});refresh();}
async function loadModels(){const m=await api('/admin/models');$('#models tbody').innerHTML=m.map(x=>'<tr><td class="code">'+x.model_id+'</td><td>'+(x.display_name||'')+'</td><td class="small mut">'+x.mode_id+'</td></tr>').join('');}
if(TOK)show();
</script>
</body></html>`;
}
