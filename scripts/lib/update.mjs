// Chạy engine.js trong Node và tạo nội dung data.js. Dùng chung cho CLI (update-data.mjs) và server.
import { readFile } from 'node:fs/promises';

/** Giờ Việt Nam (UTC+7, không có giờ mùa hè) — đọc bằng các hàm getUTC*() */
export const vnTime = (t = Date.now()) => new Date(t + 7 * 3600e3);
export const vnDate = (t = Date.now()) => vnTime(t).toISOString().slice(0, 10);
const vnMinutes = t => { const v = vnTime(t); return v.getUTCHours() * 60 + v.getUTCMinutes(); };

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

// Phiên HOSE: sáng 9:00–11:30 (ATO 9:00–9:15), chiều 13:00–14:45 (ATC 14:30–14:45) → 255 phút
const AM = [9 * 60, 11 * 60 + 30], PM = [13 * 60, 14 * 60 + 45], SESSION_MIN = (AM[1] - AM[0]) + (PM[1] - PM[0]);

/**
 * Thông tin phiên tại thời điểm `now`:
 *  weekday  — thứ 2–6
 *  minutes  — số phút trong ngày (giờ VN)
 *  inSession — trong khung chạy cập nhật trong phiên: 9:15–11:35 và 13:05–14:55
 *  intraday — từ 9:15 đến trước 15:30 (kể cả nghỉ trưa): phiên hôm nay đang diễn ra, chưa chốt
 *  fraction — tỷ lệ thời gian giao dịch đã trôi qua (0–1), dùng để ước tính khối lượng cả phiên
 */
export function sessionInfo(now = Date.now()) {
  const day = vnTime(now).getUTCDay(), m = vnMinutes(now);
  const weekday = day >= 1 && day <= 5;
  const elapsed = Math.max(0, Math.min(m, AM[1]) - AM[0]) + Math.max(0, Math.min(m, PM[1]) - PM[0]);
  return {
    weekday, minutes: m,
    inSession: weekday && ((m >= AM[0] + 15 && m <= AM[1] + 5) || (m >= PM[0] + 5 && m <= PM[1] + 10)),
    intraday: weekday && m >= AM[0] + 15 && m < 15 * 60 + 30,
    fraction: Math.min(1, elapsed / SESSION_MIN),
  };
}

/** Mốc cắt nến cho bản chốt: trước 15:30 giờ VN, phiên hôm nay chưa chốt → chỉ lấy đến hết hôm qua */
export function cutoffFor(now = Date.now()) {
  return vnMinutes(now) < 15 * 60 + 30 ? Date.parse(vnDate(now) + 'T00:00:00Z') / 1000 - 1 : Math.floor(now / 1000);
}

/**
 * Chạy engine và trả về { asof, gen, rows, data (chuỗi data.js), live, summary, source, stats }.
 * mode 'final' (mặc định): dữ liệu chốt (bỏ nến hôm nay nếu trước 15:30).
 * mode 'live': lấy cả nến đang giao dịch của hôm nay; khối lượng hôm nay được ước tính cho cả phiên;
 *              data.js có thêm trường `live` để giao diện ghi rõ là tạm tính.
 * engine.js được chạy với `window` và `fetch` riêng, không ảnh hưởng biến toàn cục của tiến trình.
 */
export async function computeData({ engineFile, fetchImpl = vndFetch, now = Date.now(), mode = 'final' }) {
  const src = await readFile(engineFile, 'utf8');
  const today = vnDate(now), sess = sessionInfo(now);
  const win = mode === 'live'
    ? { __to: Math.floor(now / 1000), __today: today, __liveScale: 1 / Math.max(sess.fraction, 0.15) }
    : { __to: cutoffFor(now) };
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
  // Chỉ gắn nhãn tạm tính khi thật sự có nến hôm nay (ngày nghỉ thì vẫn là dữ liệu chốt của phiên trước)
  const live = mode === 'live' && R.asof === today
    ? { at: new Date(now).toISOString(), fraction: Math.round(sess.fraction * 100) / 100 } : null;
  const r2 = x => Math.round(x * 100) / 100;
  const data = 'window.DATA=' + JSON.stringify({
    asof: R.asof, gen: R.gen, ...(live ? { live } : {}), vni: R.vni, bt: R.bt, k: R.st.k, r: R.st.r,
    ch: Object.fromEntries(Object.entries(R.ch).map(([s, [c]]) => [s, c.map(r2)])),
  }) + ';';
  return { asof: R.asof, gen: R.gen, rows: R.st.r.length, data, live, summary, source: R.src, stats };
}

/** Đọc asof / gen từ nội dung data.js mà không cần chạy nó */
export const asofOf = text => (String(text).match(/"asof":"(\d{4}-\d{2}-\d{2})"/) || [])[1] || null;
export const genOf = text => (String(text).match(/"gen":"([^"]+)"/) || [])[1] || null;

/**
 * Việc cần chạy lúc này: 'final' | 'live' | null.
 *  final — thứ 2–6, 15:45–18:00, chưa có bản chốt hôm nay; thử lại cách nhau ≥ 20 phút.
 *  live  — trong phiên (9:15–11:35, 13:05–14:55), mỗi `intervalMin` phút (0 = tắt).
 * skipDate: ngày đã xác định là ngày nghỉ → không chạy gì.
 */
export function shouldRun(now, st, { intervalMin = 10 } = {}) {
  if (st.running) return null;
  const s = sessionInfo(now), today = vnDate(now);
  if (!s.weekday || st.skipDate === today) return null;
  if (s.minutes >= 15 * 60 + 45 && s.minutes < 18 * 60) {
    if (st.finalAsof === today) return null;
    if (st.lastFinalAttempt && now - st.lastFinalAttempt < 20 * 60e3) return null;
    return 'final';
  }
  if (intervalMin > 0 && s.inSession) {
    if (st.lastAttempt && now - st.lastAttempt < intervalMin * 60e3 - 30e3) return null;
    return 'live';
  }
  return null;
}
