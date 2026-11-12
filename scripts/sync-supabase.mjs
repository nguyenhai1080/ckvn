// Đồng bộ phiên hôm nay lên Supabase, cập nhật hiệu quả tín hiệu và gửi cảnh báo.
// Chạy sau scripts/update-data.mjs.
//
// Biến môi trường:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (bắt buộc)
//   TELEGRAM_BOT_TOKEN                         (tuỳ chọn – gửi Telegram)
//   RESEND_API_KEY, RESEND_FROM                (tuỳ chọn – gửi email, VD: "Lướt sóng CK <alerts@ten-mien.vn>")
//   SITE_URL                                   (tuỳ chọn – link trong cảnh báo)
// Tham số: --dry-run  in ra thay vì ghi DB / gửi tin
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateTrade, newTrades, toBars } from './lib/trades.mjs';
import { buildEvents, composeForUser } from './lib/alerts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY, TELEGRAM_BOT_TOKEN, RESEND_API_KEY, RESEND_FROM, SITE_URL = '' } = process.env;
if (!SUPABASE_URL || !KEY) { console.log('Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY – bỏ qua đồng bộ.'); process.exit(0); }

// ---------- REST helper (PostgREST) ----------
async function rest(p, { method = 'GET', body, prefer, range } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}), ...(range ? { Range: range } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
async function restAll(p) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await rest(p, { range: `${from}-${from + 999}` });
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
const write = async (label, fn) => (DRY ? console.log(`[dry-run] ${label}`) : fn());

// ---------- 1. Snapshot phiên hôm nay ----------
globalThis.window = {};
await import(pathToFileURL(process.env.DATA_FILE || path.join(root, 'data.js')).href + `?t=${Date.now()}`);
const D = window.DATA;
console.log(`Phiên ${D.asof}: ${D.r.length} mã`);
await write(`upsert snapshot ${D.asof}`, () =>
  rest('snapshots?on_conflict=date', { method: 'POST', body: { date: D.asof, data: D }, prefer: 'resolution=merge-duplicates,return=minimal' }));
const [prevRow] = await rest(`snapshots?select=date,data&date=lt.${D.asof}&order=date.desc&limit=1`);
const prevD = prevRow?.data || null;
console.log('Phiên trước:', prevRow?.date || '(chưa có)');

// ---------- 2. Cập nhật lệnh đang mở ----------
const open = await restAll('trades?select=*&status=eq.open&order=id');
const closedToday = [];
const to = Math.floor(Date.now() / 1000);
for (const t of open) {
  if (t.signal_date >= D.asof) continue;
  const from = Math.floor(new Date(t.signal_date).getTime() / 1000) - 86400;
  let bars = [];
  try {
    const h = await (await fetch(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${t.symbol}&from=${from}&to=${to}`)).json();
    bars = toBars(h).filter(b => b.d <= D.asof);
  } catch (e) { console.warn(`Không lấy được giá ${t.symbol}: ${e.message}`); continue; }
  const upd = evaluateTrade(t, bars);
  if (upd.status !== 'open' && upd.exit_date === D.asof) closedToday.push({ ...t, ...upd });
  await write(`trade #${t.id} ${t.symbol} → ${upd.status} ${upd.ret_pct}%`, () =>
    rest(`trades?id=eq.${t.id}`, { method: 'PATCH', body: { ...upd, updated_at: new Date().toISOString() }, prefer: 'return=minimal' }));
}
console.log(`Lệnh mở: ${open.length}, đóng hôm nay: ${closedToday.length}`);

// ---------- 3. Lệnh mới ----------
// Không mở lại mã đang có lệnh mở, hoặc có lệnh vừa đóng trong phiên này (để chạy lại cho cùng kết quả)
const closedNow = DRY ? closedToday : await restAll(`trades?select=symbol,kind&exit_date=gte.${D.asof}`);
const fresh = newTrades(D, [...open, ...closedNow]);
if (fresh.length) await write(`thêm ${fresh.length} lệnh: ${fresh.map(t => `${t.symbol}/${t.kind}`).join(', ')}`, () =>
  rest('trades?on_conflict=signal_date,symbol,kind', { method: 'POST', body: fresh, prefer: 'resolution=ignore-duplicates,return=minimal' }));
console.log(`Lệnh mới: ${fresh.length}`);

// ---------- 4. Cảnh báo ----------
const events = buildEvents(D, prevD, closedToday);
const profiles = await restAll('profiles?select=*');
const wl = await restAll('watchlist?select=user_id,symbol');
const sent = new Set((await restAll(`alert_log?select=user_id&date=eq.${D.asof}`)).map(x => x.user_id));
const wlBy = new Map();
for (const w of wl) { if (!wlBy.has(w.user_id)) wlBy.set(w.user_id, []); wlBy.get(w.user_id).push(w.symbol); }

async function sendTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status} ${await res.text()}`);
}
async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status} ${await res.text()}`);
}

let nUsers = 0, nFail = 0;
for (const p of profiles) {
  if (sent.has(p.user_id)) continue;
  const msg = composeForUser(p, wlBy.get(p.user_id) || [], events, D, SITE_URL);
  if (!msg) continue;
  const channels = [];
  if (p.notify_telegram && p.telegram_chat_id && TELEGRAM_BOT_TOKEN) {
    try { DRY ? console.log(`[dry-run] Telegram ${p.email}:\n${msg.text}\n`) : await sendTelegram(p.telegram_chat_id, msg.text); channels.push('telegram'); }
    catch (e) { nFail++; console.warn(`Telegram lỗi (${p.email}): ${e.message}`); }
  }
  if (p.notify_email && p.email && RESEND_API_KEY && RESEND_FROM) {
    try { DRY ? console.log(`[dry-run] Email ${p.email}: ${msg.subject}`) : await sendEmail(p.email, msg.subject, msg.html); channels.push('email'); }
    catch (e) { nFail++; console.warn(`Email lỗi (${p.email}): ${e.message}`); }
  }
  if (!channels.length) continue;
  nUsers++;
  await write(`alert_log ${p.email}`, () =>
    rest('alert_log', { method: 'POST', body: { user_id: p.user_id, date: D.asof, channels, body: msg.text }, prefer: 'return=minimal' }));
}
console.log(`Đã gửi cảnh báo cho ${nUsers} người dùng${nFail ? `, ${nFail} lỗi gửi` : ''}.`);
