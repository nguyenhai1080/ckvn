// Chạy engine.js trong Node và tạo nội dung data.js. Dùng chung cho CLI (update-data.mjs) và server.
import { readFile } from 'node:fs/promises';

/** Giờ Việt Nam (UTC+7, không có giờ mùa hè) — đọc bằng các hàm getUTC*() */
export const vnTime = (t = Date.now()) => new Date(t + 7 * 3600e3);
export const vnDate = (t = Date.now()) => vnTime(t).toISOString().slice(0, 10);

/** fetch có header giống trình duyệt + thử lại khi lỗi */
export async function vndFetch(url, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(30_000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          Origin: 'https://www.vndirect.com.vn',
          Referer: 'https://www.vndirect.com.vn/',
          Accept: 'application/json',
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
}

/** Mốc cắt nến: trước 15:30 giờ VN, phiên hôm nay chưa chốt → chỉ lấy đến hết hôm qua */
export function cutoffFor(now = Date.now()) {
  const v = vnTime(now), mins = v.getUTCHours() * 60 + v.getUTCMinutes();
  return mins < 15 * 60 + 30 ? Date.parse(vnDate(now) + 'T00:00:00Z') / 1000 - 1 : Math.floor(now / 1000);
}

/**
 * Chạy engine và trả về { asof, gen, rows, data (chuỗi data.js), summary, source, stats }.
 * engine.js được chạy với `window` và `fetch` riêng, không ảnh hưởng biến toàn cục của tiến trình.
 */
export async function computeData({ engineFile, fetchImpl = vndFetch, now = Date.now() }) {
  const src = await readFile(engineFile, 'utf8');
  const win = { __to: cutoffFor(now) };
  // Thống kê request theo host để chẩn đoán khi lỗi (hiện ở /status)
  const stats = {};
  const counted = async (url, opts) => {
    const host = new URL(url).hostname, s = (stats[host] ??= { ok: 0, fail: 0 });
    try {
      const res = await fetchImpl(url, opts);
      if (res.ok) s.ok++; else { s.fail++; s.lastStatus = res.status; }
      return res;
    } catch (e) { s.fail++; s.lastError = String(e.message || e).slice(0, 200); throw e; }
  };
  let summary;
  try {
    summary = await new Function('window', 'fetch', `return (\n${src}\n);`)(win, counted);
  } catch (e) {
    e.message += ' · request: ' + JSON.stringify(stats);
    e.stats = stats;
    throw e;
  }
  const R = win.__result;
  if (!R?.st?.r) throw new Error('Engine không trả về kết quả');
  if (R.st.r.length < 50) throw new Error(`Chỉ có ${R.st.r.length} mã — nghi lỗi dữ liệu, không dùng. request: ${JSON.stringify(stats)}`);
  const r2 = x => Math.round(x * 100) / 100;
  const data = 'window.DATA=' + JSON.stringify({
    asof: R.asof, gen: R.gen, vni: R.vni, bt: R.bt, k: R.st.k, r: R.st.r,
    ch: Object.fromEntries(Object.entries(R.ch).map(([s, [c]]) => [s, c.map(r2)])),
  }) + ';';
  return { asof: R.asof, gen: R.gen, rows: R.st.r.length, data, summary, source: R.src, stats };
}

/** Đọc asof từ nội dung data.js mà không cần chạy nó */
export const asofOf = text => (String(text).match(/"asof":"(\d{4}-\d{2}-\d{2})"/) || [])[1] || null;

/**
 * Có nên chạy cập nhật theo lịch lúc này không.
 * Thứ 2–6, từ 15:45 đến 18:00 giờ VN, khi chưa có dữ liệu phiên hôm nay; thử lại cách nhau ≥ 20 phút.
 * Sau 16:30 mà vẫn chưa có phiên hôm nay → coi là ngày nghỉ, ngừng thử (skipDate).
 */
export function shouldRun(now, st) {
  if (st.running) return false;
  const v = vnTime(now), day = v.getUTCDay(), mins = v.getUTCHours() * 60 + v.getUTCMinutes(), today = vnDate(now);
  if (day === 0 || day === 6) return false;
  if (mins < 15 * 60 + 45 || mins >= 18 * 60) return false;
  if (st.asof === today || st.skipDate === today) return false;
  if (st.lastAttempt && now - st.lastAttempt < 20 * 60e3) return false;
  return true;
}
