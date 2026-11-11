// Server tĩnh tối giản cho môi trường chạy `npm start` (VibeHost, Render, Railway…).
// Không cần thư viện ngoài. Cổng lấy từ biến PORT (mặc định 3000).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
// Chỉ phục vụ file của trang; không lộ mã script, test, cấu hình máy chủ
const PUBLIC = new Set(['index.html', 'data.js', 'config.js', 'cloud.js', 'favicon.ico', 'robots.txt']);

const server = createServer(async (req, res) => {
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz' || url.pathname === '/health') return send(200, 'ok', { 'Content-Type': 'text/plain' });
    let name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (!PUBLIC.has(name)) {
      // Đường dẫn lạ (VD /bo-loc) → trả trang chính; file không công khai → 404
      if (path.extname(name)) return send(404, 'Not Found', { 'Content-Type': 'text/plain' });
      name = 'index.html';
    }
    const file = path.join(ROOT, name);
    await stat(file);
    const body = await readFile(file);
    const cache = name === 'index.html' || name === 'data.js' || name === 'config.js'
      ? 'no-cache' : 'public, max-age=300';
    send(200, body, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': cache });
  } catch (e) {
    if (e.code === 'ENOENT') return send(404, 'Not Found', { 'Content-Type': 'text/plain' });
    console.error(e);
    send(500, 'Internal Server Error', { 'Content-Type': 'text/plain' });
  }
});

server.listen(PORT, HOST, () => console.log(`Lướt sóng CK đang chạy tại http://${HOST}:${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
