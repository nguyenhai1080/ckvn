// Server cho VibeHost (hoặc bất kỳ nền tảng chạy `npm start`): phục vụ trang VÀ tự cập nhật dữ liệu VNDirect
// ngay trên máy chủ ở Việt Nam:
//   • Trong phiên (9:15–11:35, 13:05–14:55, thứ 2–6): mỗi INTRADAY_MINUTES phút → dữ liệu TẠM TÍNH
//     (không lưu lịch sử, không gửi cảnh báo)
//   • 15:45: bản CHỐT của phiên → lưu Supabase + gửi cảnh báo (nếu có cấu hình)
//
// Biến môi trường (đều tuỳ chọn):
//   PORT                cổng (mặc định 3000)
//   AUTO_UPDATE=0       tắt mọi tự cập nhật (chỉ phục vụ trang)
//   INTRADAY_MINUTES    chu kỳ cập nhật trong phiên, phút (mặc định 10, tối thiểu 5; 0 = tắt cập nhật trong phiên)
//   UPDATE_TOKEN        bật POST /admin/update (header "Authorization: Bearer <token>") để chạy tay
//   DATA_DIR            thư mục ghi data.js (mặc định thư mục dự án, lỗi thì dùng thư mục tạm)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, RESEND_API_KEY, RESEND_FROM, SITE_URL
//                       có thì sau mỗi bản chốt mới sẽ chạy scripts/sync-supabase.mjs (lịch sử, hiệu quả, cảnh báo)
import { createServer } from 'node:http';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeData, asofOf, genOf, shouldRun, sessionInfo, vnDate } from './scripts/lib/update.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const AUTO = process.env.AUTO_UPDATE !== '0';
const INTRADAY = (() => { const n = Number(process.env.INTRADAY_MINUTES ?? 10); return n > 0 ? Math.max(5, n) : 0; })();
const ENGINE = process.env.ENGINE_FILE || path.join(ROOT, 'engine.js');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- Trạng thái dữ liệu (giữ trong bộ nhớ, ghi đĩa để sync đọc) ----------
let dataBuf = await readFile(path.join(ROOT, 'data.js'));
const st = {
  asof: asofOf(dataBuf),          // phiên đang phục vụ
  gen: genOf(dataBuf),            // thời điểm tạo dữ liệu đang phục vụ (trang dùng để biết có dữ liệu mới)
  live: false,                    // dữ liệu đang phục vụ là tạm tính trong phiên?
  finalAsof: asofOf(dataBuf),     // bản chốt mới nhất đã có
  source: 'repo', running: false, lastAttempt: 0, lastFinalAttempt: 0,
  lastResult: null, lastError: null, lastSync: null, skipDate: null,
};
let dataFile = null;

async function saveData(text) {
  const dirs = [process.env.DATA_DIR, ROOT, path.join(os.tmpdir(), 'luot-song-ck')].filter(Boolean);
  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true });
      const f = path.join(dir, 'data.js');
      await writeFile(f, text);
      return f;
    } catch (e) { /* thử thư mục kế tiếp */ }
  }
  throw new Error('Không ghi được data.js vào thư mục nào');
}

function runSync(file) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  log('Đồng bộ Supabase + gửi cảnh báo…');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/sync-supabase.mjs')], {
    cwd: ROOT, env: { ...process.env, DATA_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => (out += d)); child.stderr.on('data', d => (out += d));
  child.on('close', code => {
    st.lastSync = { at: new Date().toISOString(), ok: code === 0, tail: out.trim().split('\n').slice(-6).join('\n') };
    log(`Sync kết thúc (mã ${code})\n${out.trim()}`);
  });
}

/**
 * Chạy engine.
 *  mode 'live'  → thay dữ liệu đang phục vụ bằng bản tạm tính (không sync).
 *  mode 'final' → bản chốt; thay dữ liệu nếu không cũ hơn dữ liệu đang phục vụ; có phiên chốt mới → sync + cảnh báo.
 */
async function update(reason, mode = 'final', now = Date.now()) {
  if (st.running) return { ok: false, message: 'Đang chạy' };
  st.running = true; st.lastAttempt = now;
  if (mode === 'final') st.lastFinalAttempt = now;
  const t0 = Date.now();
  log(`Cập nhật dữ liệu (${reason}, ${mode})…`);
  try {
    const res = await computeData({ engineFile: ENGINE, mode, now });
    const sec = Math.round((Date.now() - t0) / 1000);
    const today = vnDate(now), sess = sessionInfo(now);
    let replaced = false, newFinal = false;
    if (res.live) {
      dataBuf = Buffer.from(res.data);
      Object.assign(st, { asof: res.asof, gen: res.gen, live: true, source: 'live' });
      replaced = true;
    } else {
      newFinal = !st.finalAsof || res.asof > st.finalAsof;
      if (res.asof >= st.asof || reason === 'admin') {
        dataBuf = Buffer.from(res.data);
        Object.assign(st, { asof: res.asof, gen: res.gen, live: false, source: 'live' });
        replaced = true;
      }
      if (newFinal) st.finalAsof = res.asof;
      if (replaced || newFinal) dataFile = await saveData(res.data);
      if (newFinal) runSync(dataFile);
    }
    // Phát hiện ngày nghỉ: đã 10:00 (trong phiên) hoặc 16:30 (bản chốt) mà vẫn không có nến hôm nay
    if (res.asof !== today && sess.weekday && (mode === 'live' ? sess.minutes >= 10 * 60 : sess.minutes >= 16 * 60 + 30)) {
      st.skipDate = today;
      log(`Không có phiên ${today} → coi là ngày nghỉ, ngừng cập nhật hôm nay`);
    }
    st.lastResult = { at: new Date(now).toISOString(), reason, mode, asof: res.asof, live: !!res.live, rows: res.rows,
      replaced, newFinal, seconds: sec, priceSource: res.source, requests: res.stats };
    st.lastError = null;
    log(`Xong sau ${sec}s: phiên ${res.asof}${res.live ? ' (tạm tính)' : ''}, ${res.rows} mã${newFinal ? ' · BẢN CHỐT MỚI' : ''}`);
    return { ok: true, ...st.lastResult };
  } catch (e) {
    st.lastError = { at: new Date(now).toISOString(), reason, mode, message: String(e.message).slice(0, 1500) };
    log('Lỗi cập nhật:', e);
    return { ok: false, message: e.message };
  } finally {
    st.running = false;
  }
}

if (AUTO) {
  // Chạy bù khi khởi động (sau mỗi lần deploy/restart): đang trong phiên → bản tạm tính, ngoài phiên → bản chốt
  setTimeout(() => update('startup', INTRADAY && sessionInfo().intraday ? 'live' : 'final'), 5_000);
  setInterval(() => { const mode = shouldRun(Date.now(), st, { intervalMin: INTRADAY }); if (mode) update('schedule', mode); }, 30_000);
}

// ---------- HTTP ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
// Chỉ phục vụ file của trang; không lộ mã script, test, cấu hình máy chủ
const PUBLIC = new Set(['index.html', 'config.js', 'cloud.js', 'favicon.ico', 'robots.txt']);

function authorized(req) {
  const token = process.env.UPDATE_TOKEN;
  if (!token) return false;
  const got = Buffer.from(req.headers.authorization || ''), want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

const server = createServer(async (req, res) => {
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const json = (code, obj) => send(code, JSON.stringify(obj, null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/admin/update') {
      if (req.method !== 'POST') return send(405, 'Method Not Allowed', { Allow: 'POST' });
      if (!authorized(req)) return json(401, { ok: false, message: 'Unauthorized' });
      const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'final';
      return json(200, await update('admin', mode));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    if (url.pathname === '/healthz' || url.pathname === '/health') return send(200, 'ok', { 'Content-Type': 'text/plain' });
    if (url.pathname === '/status') {
      const { running, asof, gen, live, finalAsof, source, lastResult, lastError, lastSync } = st;
      return json(200, { asof, gen, live, finalAsof, source, running, autoUpdate: AUTO, intradayMinutes: INTRADAY, lastResult, lastError,
        lastSync: lastSync && { at: lastSync.at, ok: lastSync.ok }, now: new Date().toISOString() });
    }
    let name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (name === 'data.js') {
      return send(200, dataBuf, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-cache' });
    }
    if (!PUBLIC.has(name)) {
      // Đường dẫn lạ (VD /bo-loc) → trang chính; file không công khai → 404
      if (path.extname(name)) return send(404, 'Not Found', { 'Content-Type': 'text/plain' });
      name = 'index.html';
    }
    const file = path.join(ROOT, name);
    await stat(file);
    const cache = name === 'cloud.js' ? 'public, max-age=300' : 'no-cache';
    send(200, await readFile(file), { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': cache });
  } catch (e) {
    if (e.code === 'ENOENT') return send(404, 'Not Found', { 'Content-Type': 'text/plain' });
    log(e);
    send(500, 'Internal Server Error', { 'Content-Type': 'text/plain' });
  }
});

server.listen(PORT, HOST, () => log(`Lướt sóng CK chạy tại http://${HOST}:${PORT} · dữ liệu phiên ${st.asof} · tự cập nhật: ${AUTO ? `bật (trong phiên ${INTRADAY ? `mỗi ${INTRADAY} phút` : 'tắt'}, bản chốt 15:45, thứ 2–6)` : 'tắt'}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
