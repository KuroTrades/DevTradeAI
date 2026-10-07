// DONUT STAKE backend — zero dependencies. Run: node server.js
// Serves the site + verifies deposits.
// Auto-verify wakes up automatically when DONUT_API_KEY is set.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const CONFIG = {
  banker: 'Ponot',          // in-game name receiving /pay
  ownerPin: 'Alebale11Alebale11Kuro', // owner review panel — keep secret
  apiKey: '',               // paste DonutSMP /api key here to enable payment verification
  autoClaimMax: 2000000,    // instant credit per claim, no questions asked
  autoDailyMax: 5000000,    // instant credit per player per day — above this needs your tap
  pollMs: 4000,
};

function parseAmt(s) {
  s = String(s).trim().toLowerCase();
  const m = s.match(/^([\d.]+)\s*([kmb])?$/);
  if (!m) return 0;
  return parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
}

// ---- DonutSMP balance lookup (needs apiKey) ----
function donutMoney(user) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.apiKey) return reject(new Error('no-key'));
    const req = http.get({
      host: 'api.donutsmp.net', path: '/v1/stats/' + encodeURIComponent(user),
      headers: { Authorization: 'Bearer ' + CONFIG.apiKey },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return reject(new Error('api-' + res.statusCode));
          resolve(parseAmt(JSON.parse(data).result.money));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---- persistent store (survives restarts) ----
const DB_FILE = path.join(__dirname, 'db.json');
let seq = 1;
const claims = new Map(); // id -> {id,ign,amt,status,createdAt,snapshot}
const ledger = [];
function dbSave(){
  try{ fs.writeFileSync(DB_FILE, JSON.stringify({ seq, oseq, claims: [...claims.values()], ledger, orders: [...orders.values()] })); }
  catch(e){}
}
function dbLoad(){
  try{
    if(!fs.existsSync(DB_FILE))return;
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    seq = d.seq || 1; oseq = d.oseq || 1;
    (d.claims || []).forEach(c => claims.set(c.id, c));
    (d.orders || []).forEach(o => orders.set(o.orderId, o));
    (d.ledger || []).forEach(l => ledger.push(l));
    // drop ancient pending casino claims on boot
    for(const [id, c] of claims) if(c.status === 'pending' && Date.now() - c.createdAt > 24*3600e3) claims.delete(id);
  }catch(e){}
}
const autoGiven = new Map(); // ign -> {day, total} — caps free instant credit
function autoToday(ign){
  const day = new Date().toDateString();
  let e = autoGiven.get(ign);
  if(!e || e.day !== day){ e = { day, total: 0 }; autoGiven.set(ign, e); }
  return e;
}
// ---- course orders (Kuro's Courses): proof-based, owner approves ----
let oseq = 1;
const orders = new Map(); // orderId -> {orderId,plan,email,txid,status,createdAt}
function autoToday(ign){
  const day = new Date().toDateString();
  let e = autoGiven.get(ign);
  if(!e || e.day !== day){ e = { day, total: 0 }; autoGiven.set(ign, e); }
  return e;
}

function json(res, code, obj) {
  try{ dbSave(); }catch(e){}
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    // Create a deposit claim. Instant-credits small ones; big ones wait for the owner.
    if (u.pathname === '/api/deposit/claim' && req.method === 'POST') {
      const { ign, amt } = await body(req);
      if (!ign || !(+amt > 0)) return json(res, 400, { error: 'bad-request' });
      const id = 'd' + (seq++) + Date.now().toString(36);
      const name = String(ign).slice(0, 24);
      // Instant path: under per-claim cap and daily cap — player plays NOW, zero taps.
      const day = autoToday(name);
      if (+amt <= CONFIG.autoClaimMax && day.total + +amt <= CONFIG.autoDailyMax) {
        day.total += +amt;
        const c = { id, ign: name, amt: +amt, status: 'approved', createdAt: Date.now(), snapshot: null };
        claims.set(id, c);
        ledger.unshift({ ...c, resolvedAt: Date.now(), via: 'auto-free' });
        return json(res, 200, { id, auto: true, instant: true });
      }
      let snapshot = null, auto = !!CONFIG.apiKey;
      try { snapshot = await donutMoney(CONFIG.banker); } catch (e) { auto = false; }
      claims.set(id, { id, ign: name, amt: +amt, status: 'pending', createdAt: Date.now(), snapshot });
      return json(res, 200, { id, auto });
    }

    // Player polls this after paying. Auto-verifies when key is set.
    if (u.pathname === '/api/deposit/status' && req.method === 'GET') {
      const c = claims.get(u.searchParams.get('id'));
      if (!c) return json(res, 404, { error: 'not-found' });
      if (c.status === 'pending' && CONFIG.apiKey) {
        try {
          const now = await donutMoney(CONFIG.banker);
          const base = c.snapshot ?? now;
          if (now - base >= c.amt * 0.99) {
            c.status = 'approved';
            ledger.unshift({ ...c, resolvedAt: Date.now(), via: 'auto' });
          }
        } catch (e) { /* keep pending, owner reviews */ }
      }
      return json(res, 200, { status: c.status, amt: c.amt });
    }

    // Owner: list pending + history
    if (u.pathname === '/api/owner/claims' && req.method === 'GET') {
      if (u.searchParams.get('pin') !== CONFIG.ownerPin) return json(res, 403, { error: 'nope' });
      return json(res, 200, {
        pending: [...claims.values()].filter(c => c.status === 'pending'),
        ledger: ledger.slice(0, 100),
      });
    }

    // Owner: approve / deny. Approval is the credit signal for the player's browser.
    if (u.pathname === '/api/owner/review' && req.method === 'POST') {
      const { pin, id, approve } = await body(req);
      if (pin !== CONFIG.ownerPin) return json(res, 403, { error: 'nope' });
      const c = claims.get(id);
      if (!c) return json(res, 404, { error: 'not-found' });
      c.status = approve ? 'approved' : 'denied';
      ledger.unshift({ ...c, resolvedAt: Date.now(), via: 'manual' });
      return json(res, 200, { ok: true });
    }

    // ---- course orders ----
    if (u.pathname === '/api/orders/claim' && req.method === 'POST') {
      const { plan, email, txid } = await body(req);
      if (!plan || !email || !txid) return json(res, 400, { error: 'bad-request' });
      const orderId = 'KURO-' + (oseq++) + Date.now().toString(36).toUpperCase();
      orders.set(orderId, { orderId, plan: String(plan).slice(0, 16), email: String(email).slice(0, 80), txid: String(txid).slice(0, 120), status: 'pending', createdAt: Date.now() });
      return json(res, 200, { orderId });
    }
    if (u.pathname === '/api/orders/status' && req.method === 'GET') {
      const o = orders.get(u.searchParams.get('orderId'));
      if (!o) return json(res, 404, { error: 'not-found' });
      return json(res, 200, { status: o.status, plan: o.plan });
    }
    if (u.pathname === '/api/owner/orders' && req.method === 'GET') {
      if (u.searchParams.get('pin') !== CONFIG.ownerPin) return json(res, 403, { error: 'nope' });
      const all = [...orders.values()].sort((a, b) => b.createdAt - a.createdAt);
      return json(res, 200, { pending: all.filter(o => o.status === 'pending'), history: all.filter(o => o.status !== 'pending').slice(0, 100) });
    }
    if (u.pathname === '/api/owner/orders/review' && req.method === 'POST') {
      const { pin, orderId, approve } = await body(req);
      if (pin !== CONFIG.ownerPin) return json(res, 403, { error: 'nope' });
      const o = orders.get(orderId);
      if (!o) return json(res, 404, { error: 'not-found' });
      o.status = approve ? 'approved' : 'denied';
      return json(res, 200, { ok: true });
    }

    // Static site (DevTradeAI homepage)
    let f = u.pathname === '/' ? '/devtrade.html' : u.pathname;
    const fp = path.join(__dirname, f);
    if (!fp.startsWith(__dirname) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory())
      return json(res, 404, { error: 'not-found' });
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp4': 'video/mp4' };
    res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { json(res, 500, { error: 'boom' }); }
});

server.listen(process.env.PORT || PORT, () => console.log('KURO live on port ' + (process.env.PORT || PORT)));
dbLoad();
