// Kiểm thử đầu-cuối scripts/sync-supabase.mjs với PostgREST/Telegram/Resend/dchart giả lập (không gọi mạng).
// Chạy: node tests/sync.e2e.mjs
import assert from 'node:assert/strict';

const db = {
  snapshots: [{ date: '2026-11-10', data: null }],
  trades: [
    { id: 1, signal_date: '2026-11-04', symbol: 'NT2', kind: 'CHỜ', entry: 22.0, stop: 21.0, target: 23.4, status: 'open' },
    { id: 2, signal_date: '2026-11-06', symbol: 'TPB', kind: 'CHỜ', entry: 12.7, stop: 12.1, target: 13.9, status: 'open' },
  ],
  profiles: [
    { user_id: 'u1', email: 'a@x.vn', notify_email: true, notify_telegram: true, telegram_chat_id: 111, alert_buy: true, alert_sell: true, alert_levels: true, alert_setup: true, alert_market: true },
    { user_id: 'u2', email: 'b@x.vn', notify_email: true, notify_telegram: false, telegram_chat_id: null, alert_buy: true, alert_sell: true, alert_levels: true, alert_setup: false, alert_market: false },
    { user_id: 'u3', email: 'c@x.vn', notify_email: true, notify_telegram: true, telegram_chat_id: null, alert_buy: true, alert_sell: true, alert_levels: true, alert_setup: true, alert_market: true },
  ],
  watchlist: [{ user_id: 'u1', symbol: 'NT2' }, { user_id: 'u1', symbol: 'DPG' }, { user_id: 'u2', symbol: 'VNM' }, { user_id: 'u3', symbol: 'FPT' }],
  alert_log: [{ user_id: 'u3', date: '2026-11-11' }],
};
// Phiên trước: copy hôm nay nhưng đổi vài trạng thái
globalThis.window = {};
await import('../data.js');
const today = window.DATA;
const prev = structuredClone(today); prev.asof = '2026-11-10'; prev.vni.ok = 1; // hôm qua trên MA50, hôm nay thủng
const iRec = prev.k.indexOf('rec'), iFl = prev.k.indexOf('fl');
for (const r of prev.r) { if (r[0] === 'VNM') r[iRec] = 'TRUNG LẬP'; if (r[0] === 'DPG') r[iFl] = 'UT'; }
db.snapshots[0].data = prev;

const calls = { telegram: [], email: [] };
const bars = (sym) => {
  // NT2: chạm mục tiêu ngày 11/11; TPB: vẫn mở
  const days = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11'];
  const t = days.map(d => Date.parse(d + 'T00:00:00Z') / 1000);
  const h = sym === 'NT2' ? [22, 22.3, 22.6, 22.8, 23.0, 23.5] : [12.7, 12.8, 12.9, 13.0, 13.0, 13.2];
  return { s: 'ok', t, o: h, h, l: h.map(x => x - 0.3), c: h.map(x => x - 0.1) };
};

function handleRest(url, opt) {
  const u = new URL(url), table = u.pathname.split('/').pop(), q = u.searchParams, method = opt.method || 'GET';
  let rows = db[table];
  const filt = r => [...q.entries()].every(([k, v]) => {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) return true;
    const [op, ...rest] = v.split('.'), val = rest.join('.');
    return op === 'eq' ? String(r[k]) === val : op === 'lt' ? r[k] < val : op === 'gte' ? r[k] != null && r[k] >= val : true;
  });
  if (method === 'GET') {
    let out = rows.filter(filt);
    if (q.get('order')) { const [c, d] = q.get('order').split('.'); out.sort((a, b) => (a[c] < b[c] ? -1 : 1) * (d === 'desc' ? -1 : 1)); }
    if (q.get('limit')) out = out.slice(0, +q.get('limit'));
    const [a, b] = (opt.headers.Range || '0-99999').split('-').map(Number);
    return out.slice(a, b + 1);
  }
  const body = JSON.parse(opt.body);
  if (method === 'PATCH') { rows.filter(filt).forEach(r => Object.assign(r, body)); return null; }
  if (method === 'POST') {
    const keys = (q.get('on_conflict') || '').split(',').filter(Boolean);
    for (const b of [].concat(body)) {
      const ex = keys.length && rows.find(r => keys.every(k => String(r[k]) === String(b[k])));
      if (ex) { if (/merge-duplicates/.test(opt.headers.Prefer)) Object.assign(ex, b); }
      else rows.push(table === 'trades' ? { id: rows.length + 1, ...b } : b);
    }
    return null;
  }
}

globalThis.fetch = async (url, opt = {}) => {
  opt.headers ||= {};
  const json = (x, status = 200) => new Response(x == null ? '' : JSON.stringify(x), { status });
  if (url.startsWith('https://sb.test/rest/v1/')) {
    assert.equal(opt.headers.apikey, 'service-key');
    return json(handleRest(url, opt));
  }
  if (url.startsWith('https://dchart-api.vndirect.com.vn/')) return json(bars(new URL(url).searchParams.get('symbol')));
  if (url.startsWith('https://api.telegram.org/botTG/')) { calls.telegram.push(JSON.parse(opt.body)); return json({ ok: true }); }
  if (url === 'https://api.resend.com/emails') { calls.email.push(JSON.parse(opt.body)); return json({ id: 'x' }); }
  throw new Error('Mạng không mong đợi: ' + url);
};

Object.assign(process.env, {
  SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', TELEGRAM_BOT_TOKEN: 'TG',
  RESEND_API_KEY: 're', RESEND_FROM: 'LSCK <a@lsck.vn>', SITE_URL: 'https://lsck.example/',
});
await import('../scripts/sync-supabase.mjs');

// --- Kiểm tra ---
assert.ok(db.snapshots.find(s => s.date === '2026-11-11'), 'đã lưu snapshot hôm nay');
const nt2 = db.trades.find(t => t.id === 1), tpb = db.trades.find(t => t.id === 2);
assert.equal(nt2.status, 'target'); assert.equal(nt2.exit_date, '2026-11-11');
assert.equal(tpb.status, 'open'); assert.equal(tpb.sessions, 3);
const fresh = db.trades.filter(t => t.signal_date === '2026-11-11');
assert.ok(fresh.length >= 10, 'thêm lệnh CHỜ mới cho các setup hôm nay');
assert.ok(!fresh.some(t => t.symbol === 'TPB' && t.kind === 'CHỜ'), 'không mở trùng TPB đang mở');

assert.equal(calls.telegram.length, 1, 'chỉ u1 có Telegram');
const tg = calls.telegram[0].text;
assert.equal(calls.telegram[0].chat_id, 111);
assert.match(tg, /VN-Index .* thủng MA50/); assert.match(tg, /NT2 chạm mục tiêu/); assert.match(tg, /DPG có setup mua/);
assert.equal(calls.email.length, 2, 'u1 + u2 nhận email; u3 đã gửi hôm nay');
const e2 = calls.email.find(e => e.to[0] === 'b@x.vn');
assert.match(e2.html, /BÁN VNM/); assert.doesNotMatch(e2.html, /VN-Index/);
assert.equal(db.alert_log.length, 3);

// Chạy lại: không gửi trùng
calls.telegram.length = 0; calls.email.length = 0;
const before = db.trades.length;
await import('../scripts/sync-supabase.mjs?again');
assert.equal(calls.telegram.length + calls.email.length, 0, 'không gửi trùng khi chạy lại');
assert.equal(db.trades.length, before, 'không thêm lệnh trùng');

console.log('\n✔ sync e2e: OK — Telegram mẫu:\n' + tg);
