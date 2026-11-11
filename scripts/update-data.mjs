// Cập nhật data.js từ API VNDirect bằng Node 18+ (không cần trình duyệt).
// Dùng: node scripts/update-data.mjs
// Thoát mã 2 nếu hôm nay không có phiên mới (ngày nghỉ) -> không ghi đè data.js.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = {};

// fetch có header giống trình duyệt + thử lại khi lỗi mạng
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await nativeFetch(url, {
        ...opts,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          'Origin': 'https://www.vndirect.com.vn',
          'Referer': 'https://www.vndirect.com.vn/',
          'Accept': 'application/json',
          ...(opts.headers || {}),
        },
      });
      if (!res.ok && attempt < 3) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
};

const engine = await readFile(path.join(root, 'engine.js'), 'utf8');
const summary = await (0, eval)(engine);
const R = window.__result;
console.log('Engine:', JSON.stringify(summary));

const todayVN = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
if (R.asof !== todayVN && !process.argv.includes('--force')) {
  console.log(`Dữ liệu mới nhất là ${R.asof}, hôm nay (giờ VN) là ${todayVN}: thị trường nghỉ, không cập nhật.`);
  process.exit(2);
}

const r2 = x => Math.round(x * 100) / 100;
const data = 'window.DATA=' + JSON.stringify({
  asof: R.asof, gen: R.gen, vni: R.vni, bt: R.bt, k: R.st.k, r: R.st.r,
  ch: Object.fromEntries(Object.entries(R.ch).map(([s, [c]]) => [s, c.map(r2)])),
}) + ';';

// Kiểm tra trước khi ghi
if (R.st.r.length < 50) throw new Error(`Chỉ có ${R.st.r.length} mã — nghi lỗi dữ liệu, không ghi.`);
await writeFile(path.join(root, 'data.js'), data);
console.log(`Đã ghi data.js: phiên ${R.asof}, ${R.st.r.length} mã, ${data.length} ký tự.`);
