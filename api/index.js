import fs from 'node:fs';
import path from 'node:path';
import { isAuthed, applySecurityHeaders } from '../lib/auth.js';

let cachedApp = null;

function loadApp() {
    if (cachedApp) return cachedApp;
    const candidates = [
        path.join(process.cwd(), 'src', 'app.html'),
        path.join(process.cwd(), 'app.html'),
    ];
    for (const p of candidates) {
        try {
            cachedApp = fs.readFileSync(p, 'utf8');
            return cachedApp;
        } catch { /* try next */ }
    }
    throw new Error('app.html not found');
}

const GATE = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Nonthon — Akses Terbatas</title>
<style>
  :root{--bg:#07070b;--surface:#12121a;--surface2:#1a1a24;--primary:#e50914;--text:#fff;--dim:#8b8b9c;--border:#26262f;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);
       min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;overflow:hidden}
  .bg{position:fixed;inset:0;z-index:0;
      background:radial-gradient(circle at 20% 20%,rgba(229,9,20,.14),transparent 45%),
                 radial-gradient(circle at 80% 75%,rgba(80,20,160,.14),transparent 45%);}
  .grid{position:fixed;inset:0;z-index:0;opacity:.35;
      background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),
                       linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);
      background-size:44px 44px;}
  .card{position:relative;z-index:1;width:100%;max-width:404px;background:var(--surface);
        border:1px solid var(--border);border-radius:18px;padding:34px 28px 26px;
        box-shadow:0 24px 70px rgba(0,0,0,.65);animation:rise .45s ease}
  @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
  .lock{width:58px;height:58px;margin:0 auto 16px;border-radius:16px;display:flex;align-items:center;
        justify-content:center;font-size:1.7rem;background:linear-gradient(145deg,#1f1f2b,#15151d);
        border:1px solid var(--border);box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
  h1{font-size:1.5rem;font-weight:800;text-align:center;letter-spacing:-.5px}
  h1 span{color:var(--primary)}
  .sub{text-align:center;color:var(--dim);font-size:.86rem;margin:8px 0 24px;line-height:1.5}
  label{display:block;font-size:.76rem;text-transform:uppercase;letter-spacing:.8px;color:var(--dim);
        font-weight:700;margin-bottom:7px}
  .field{position:relative}
  input{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:10px;
        color:var(--text);padding:13px 44px 13px 14px;font-size:.98rem;outline:none;
        transition:border-color .18s,box-shadow .18s;letter-spacing:.5px}
  input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(229,9,20,.14)}
  .peek{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;
        color:var(--dim);cursor:pointer;font-size:1rem;padding:8px 10px;border-radius:8px}
  .peek:hover{color:var(--text)}
  button.go{width:100%;margin-top:16px;background:var(--primary);border:none;border-radius:10px;
        color:#fff;font-size:.98rem;font-weight:700;padding:13px;cursor:pointer;transition:filter .18s}
  button.go:hover:not(:disabled){filter:brightness(1.12)}
  button.go:disabled{opacity:.6;cursor:not-allowed}
  .msg{margin-top:14px;font-size:.85rem;text-align:center;min-height:20px;line-height:1.45}
  .err{color:#ff6b74}
  .ok{color:#4ade80}
  .foot{margin-top:24px;padding-top:16px;border-top:1px solid var(--border);text-align:center}
  .brand{font-size:.74rem;font-weight:800;letter-spacing:1.4px;color:var(--primary)}
  .note{font-size:.7rem;color:var(--dim);margin-top:6px}
  .shake{animation:sh .4s}
  @keyframes sh{0%,100%{transform:none}20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}
</style>
</head>
<body>
<div class="bg"></div><div class="grid"></div>
<div class="card" id="card">
  <div class="lock">🔐</div>
  <h1>Nontho<span>n</span></h1>
  <p class="sub">Situs privat. Masukkan sandi akses untuk membuka katalog film &amp; series.</p>
  <form id="f" autocomplete="off">
    <label for="p">Sandi Akses</label>
    <div class="field">
      <input id="p" name="password" type="password" placeholder="••••••••••••" required
             autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="256" autofocus>
      <button type="button" class="peek" id="peek" aria-label="Tampilkan sandi">👁</button>
    </div>
    <button class="go" id="go" type="submit">Buka Akses</button>
  </form>
  <div class="msg" id="m"></div>
  <div class="foot">
    <div class="brand">CREATED BY NxrHunt Labs</div>
    <div class="note">Percobaan gagal dibatasi &amp; dicatat</div>
  </div>
</div>
<script>
const f=document.getElementById('f'),p=document.getElementById('p'),m=document.getElementById('m'),
      go=document.getElementById('go'),card=document.getElementById('card');
document.getElementById('peek').onclick=()=>{p.type=p.type==='password'?'text':'password';p.focus()};
f.addEventListener('submit',async e=>{
  e.preventDefault();
  const v=p.value;
  if(!v){return}
  go.disabled=true;go.textContent='Memeriksa…';m.className='msg';m.textContent='';
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
                                     body:JSON.stringify({password:v})});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.ok){m.className='msg ok';m.textContent='✓ Akses diberikan, memuat…';
      setTimeout(()=>location.replace('/'),350);return}
    if(r.status===429){m.className='msg err';
      m.textContent='Terlalu banyak percobaan. Coba lagi dalam '+(d.retryAfter||600)+' detik.'}
    else{m.className='msg err';m.textContent='✗ Sandi salah.'}
    card.classList.remove('shake');void card.offsetWidth;card.classList.add('shake');
    p.value='';p.focus();
  }catch(err){m.className='msg err';m.textContent='Gagal menghubungi server.'}
  finally{go.disabled=false;go.textContent='Buka Akses'}
});
</script>
</body>
</html>`;

export default function handler(req, res) {
    applySecurityHeaders(res, { html: true });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (!isAuthed(req)) {
        // Cache the gate briefly; it contains no secrets.
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(GATE);
    }

    res.setHeader('Cache-Control', 'private, no-store');
    try {
        return res.status(200).send(loadApp());
    } catch (e) {
        return res.status(500).send('<h1>500</h1>');
    }
}
