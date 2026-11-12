// Server cho VibeHost (hoặc bất kỳ nền tảng chạy `npm start`): phục vụ trang tĩnh
// VÀ tự cập nhật dữ liệu VNDirect lúc 15:45 giờ VN, thứ 2–6 — chạy ngay trên máy chủ ở Việt Nam.
//
// Biến môi trường (đều tuỳ chọn):
//   PORT                cổng (mặc định 3000)
//   AUTO_UPDATE=0       tắt tự cập nhật (chỉ phục vụ trang)
//   UPDATE_TOKEN        bật POST /admin/update (header "Authorization: Bearer <token>") để chạy tay
//   DATA_DIR            thư mục ghi data.js (mặc định thư mục dự án, lỗi thì dùng thư mục tạm)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, RESEND_API_KEY, RESEND_FROM, SITE_URL
//                       có thì sau mỗi phiên mới sẽ chạy scripts/sync-supabase.mjs (lịch sử, hiệu quả, cảnh báo)
import { createServer } from 'node:http';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeData, asofOf, shouldRun, vnDate } from './scripts/lib/update.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const AUTO = process.env.AUTO_UPDATE !== '0';
const ENGINE = process.env.ENGINE_FILE || path.join(ROOT, 'engine.js');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- Trạng thái dữ liệu (giữ trong bộ nhớ, ghi đĩa để sync đọc) ----------
let dataBuf = await readFile(path.join(ROOT, 'data.js'));
const st = {
  asof: asofOf(dataBuf), gen: null, source: 'repo', running: false,
  lastAttempt: 0, lastResult: null, lastError: null, lastSync: null, skipDate: null,
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

/** Chạy engine; nếu có phiên mới hơn dữ liệu đang phục vụ → thay dữ liệu và đồng bộ */
async function update(reason) {
  if (st.running) return { ok: false, message: 'Đang chạy' };
  st.running = true; st.lastAttempt = Date.now();
  const t0 = Date.now();
  log(`Cập nhật dữ liệu (${reason})…`);
  try {
    const res = await computeData({ engineFile: ENGINE });
    const newer = !st.asof || res.asof > st.asof;
    const sec = Math.round((Date.now() - t0) / 1000);
    if (newer || reason === 'admin') {
      dataBuf = Buffer.from(res.data);
      st.asof = res.asof; st.gen = res.gen; st.source = 'live';
      dataFile = await saveData(res.data);
      if (newer) runSync(dataFile);
    }
    const today = vnDate();
    if (res.asof !== today && reason === 'schedule') {
      // Sau 16:30 vẫn chưa có phiên hôm nay → ngày nghỉ, ngừng thử
      const hm = new Date(Date.now() + 7 * 3600e3).toISOString().slice(11, 16);
      if (hm >= '16:30') st.skipDate = today;
    }
    st.lastResult = { at: new Date().toISOString(), reason, asof: res.asof, rows: res.rows, newer, seconds: sec };
    st.lastError = null;
    log(`Xong sau ${sec}s: phiên ${res.asof}, ${res.rows} mã${newer ? ' (MỚI)' : ' (không đổi)'}`);
    return { ok: true, ...st.lastResult };
  } catch (e) {
    st.lastError = { at: new Date().toISOString(), reason, message: e.message };
    log('Lỗi cập nhật:', e);
    return { ok: false, message: e.message };
  } finally {
    st.running = false;
  }
}

if (AUTO) {
  // Chạy bù ngay khi khởi động (sau mỗi lần deploy/restart), rồi kiểm tra lịch mỗi phút
  setTimeout(() => update('startup'), 5_000);
  setInterval(() => { if (shouldRun(Date.now(), st)) update('schedule'); }, 60_000);
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
      return json(200, await update('admin'));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    if (url.pathname === '/healthz' || url.pathname === '/health') return send(200, 'ok', { 'Content-Type': 'text/plain' });
    if (url.pathname === '/status') {
      const { running, asof, gen, source, lastResult, lastError, lastSync } = st;
      return json(200, { asof, gen, source, running, autoUpdate: AUTO, lastResult, lastError,
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

server.listen(PORT, HOST, () => log(`Lướt sóng CK chạy tại http://${HOST}:${PORT} · dữ liệu phiên ${st.asof} · tự cập nhật: ${AUTO ? 'bật (15:45 thứ 2–6)' : 'tắt'}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
