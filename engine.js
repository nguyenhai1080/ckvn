// Engine: chạy trong trang vndirect.com.vn (trình duyệt) hoặc Node 18+ — lấy dữ liệu + tính chỉ báo + tín hiệu.
// Trả về JSON gọn để nhúng vào dashboard.
(async () => {
const F = 'https://api-finfo.vndirect.com.vn/v4';
const MIN_VAL = 1e10; // GTGD TB 20 phiên >= 10 tỷ
const j = async u => (await fetch(u)).json();

// 1. Danh sách + thanh khoản
let stocks = [];
for (const fl of ['HOSE', 'HNX', 'UPCOM']) {
  const r = await j(`${F}/stocks?q=type:stock~status:listed~floor:${fl}&size=3000&fields=code,floor,shortName`);
  stocks.push(...r.data);
}
const meta = Object.fromEntries(stocks.map(s => [s.code, s]));
const codes = stocks.map(s => s.code), liq = {};
for (let i = 0; i < codes.length; i += 150) {
  const r = await j(`${F}/ratios/latest?filter=itemCode:52007&where=code:${codes.slice(i, i + 150).join(',')}&order=reportDate&size=500&fields=code,value`);
  for (const d of r.data) liq[d.code] = d.value;
}
const uni = Object.keys(liq).filter(c => liq[c] >= MIN_VAL);

// 2. Cơ bản
const items = '51001,51002,51003,51006,51007,51012,52002,52005,53006,53007';
const fund = {};
for (let i = 0; i < uni.length; i += 40) {
  const r = await j(`${F}/ratios/latest?filter=itemCode:${items}&where=code:${uni.slice(i, i + 40).join(',')}&order=reportDate&size=2000&fields=code,itemCode,value`);
  for (const d of r.data) (fund[d.code] ??= {})[d.itemCode] = d.value;
}
const indr = await j(`${F}/industry_classification?q=industryLevel:2&size=200`);
const ind = {};
for (const d of indr.data) for (const c of (d.codeList || '').split(',')) if (c) ind[c] = d.vietnameseName;

// 3. Giá (đã điều chỉnh). Nguồn chính: dchart; nếu dchart không dùng được (VD bị chặn từ máy chủ) → api-finfo.
// window.__to (giây, tuỳ chọn): bỏ các nến sau mốc này — dùng để loại nến đang giao dịch dở trong ngày.
const to = window.__to || Math.floor(Date.now() / 1000), from = to - 420 * 86400;
const ymd = t => new Date(t * 1000).toISOString().slice(0, 10);
const dchart = async s => {
  const h = await j(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${s}&from=${from}&to=${to}`);
  if (!h || h.s !== 'ok' || !Array.isArray(h.t)) throw new Error('dchart ' + (h && h.s));
  const keep = h.t.map((t, i) => t <= to ? i : -1).filter(i => i >= 0);
  return { s: 'ok', t: keep.map(i => h.t[i]), o: keep.map(i => h.o[i]), h: keep.map(i => h.h[i]), l: keep.map(i => h.l[i]), c: keep.map(i => h.c[i]), v: keep.map(i => h.v[i]) };
};
const finfo = async s => {
  const idx = s === 'VNINDEX';
  const r = await j(`${F}/${idx ? 'vnmarket_prices' : 'stock_prices'}?sort=date&q=code:${s}~date:gte:${ymd(from)}~date:lte:${ymd(to)}&size=500`);
  const d = (r.data || []).slice().reverse().filter(x => { const t = Date.parse(x.date + 'T00:00:00Z') / 1000; return t >= from && t <= to; });
  const k = idx ? ['open', 'high', 'low', 'close', 'nmVolume'] : ['adOpen', 'adHigh', 'adLow', 'adClose', 'nmVolume'];
  return { s: 'ok', t: d.map(x => Date.parse(x.date + 'T00:00:00Z') / 1000), o: d.map(x => x[k[0]]), h: d.map(x => x[k[1]]), l: d.map(x => x[k[2]]), c: d.map(x => x[k[3]]), v: d.map(x => x[k[4]]) };
};
let src = dchart, priceSource = 'dchart';
try { const v = await dchart('VNINDEX'); if (v.t.length < 60) throw new Error('dchart thiếu dữ liệu'); }
catch (e) { src = finfo; priceSource = 'finfo'; }
const hist = {};
const syms = [...uni, 'VNINDEX'];
for (let i = 0; i < syms.length; i += 10) {
  await Promise.all(syms.slice(i, i + 10).map(async s => {
    try { const h = await src(s); if (h.t.length > 60) hist[s] = h; } catch (e) {}
  }));
}
if (!hist.VNINDEX) throw new Error(`Không lấy được lịch sử VN-Index (nguồn ${priceSource})`);

// 4. Chỉ báo
const sma = (a, n) => a.map((_, i) => i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n);
const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; return a.map((x, i) => (e = i ? x * k + e * (1 - k) : x)); };
const rsiS = (c, n = 14) => { const out = Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); } }
  return out; };
const atrS = (h, l, c, n = 14) => { const tr = c.map((x, i) => i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]); return ema(tr, n); };
const pct = (a, b) => (a / b - 1) * 100;
const r1 = x => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10;
const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;

const V = hist.VNINDEX, vc = V.c, vIdx = Object.fromEntries(V.t.map((t, i) => [t, i]));

const vm50 = sma(vc, 50);
function analyze(h) {
  const c = h.c, H = h.h, L = h.l, v = h.v, n = c.length;
  const m10 = sma(c, 10), m20 = sma(c, 20), m50 = sma(c, 50), m200 = sma(c, 200);
  const O = h.o, rsi = rsiS(c), e12 = ema(c, 12), e26 = ema(c, 26), macd = e12.map((x, i) => x - e26[i]), sig = ema(macd, 9), hist_ = macd.map((x, i) => x - sig[i]);
  const atr = atrS(H, L, c), v20 = sma(v, 20);
  const sd20 = c.map((_, i) => i < 19 ? null : Math.sqrt(c.slice(i - 19, i + 1).reduce((s, x) => s + (x - m20[i]) ** 2, 0) / 20));
  const bbw = c.map((_, i) => m20[i] ? 4 * sd20[i] / m20[i] * 100 : null);
  return { c, H, L, O, v, n, m10, m20, m50, m200, rsi, macd, sig, hist: hist_, atr, v20, bbw };
}

// Tín hiệu tại phiên i — dùng cả cho hiện tại và backtest
function signalAt(A, i, rsDelta) {
  const { c, H, m10, m20, m50, rsi, hist, atr, v, v20, bbw } = A;
  if (i < 60 || m50[i] == null) return null;
  const vr = v20[i - 1] ? v[i] / v20[i - 1] : 1;
  const hh20 = Math.max(...H.slice(i - 20, i));
  const breakout = c[i] > hh20 && vr >= 1.5;
  const upTrend = c[i] > m20[i] && m20[i] > m50[i] && m50[i] > m50[i - 5];
  const macdUp = hist[i] > 0 && hist[i] > hist[i - 1];
  const macdCrossUp = hist[i] > 0 && Math.min(hist[i - 1], hist[i - 2], hist[i - 3]) <= 0;
  const macdCrossDn = hist[i] < 0 && Math.max(hist[i - 1], hist[i - 2], hist[i - 3]) >= 0;
  const ext = pct(c[i], m20[i]);
  const pullback = upTrend && Math.abs(pct(c[i], m20[i])) <= 2.5 && c[i] > c[i - 1];
  const bbws = bbw.slice(i - 60, i).filter(x => x != null);
  const squeeze = bbw[i] != null && bbw[i] <= Math.min(...bbws) * 1.1;
  const oversoldBounce = rsi[i - 1] < 32 && rsi[i] > rsi[i - 1] && c[i] > c[i - 1];
  // Điểm kỹ thuật 0-100
  let t = 0;
  t += c[i] > m20[i] ? 10 : 0; t += m20[i] > m50[i] ? 10 : 0; t += m50[i] > m50[i - 5] ? 10 : 0;
  t += rsi[i] >= 50 && rsi[i] <= 70 ? 15 : rsi[i] > 70 && rsi[i] <= 78 ? 8 : rsi[i] >= 45 ? 5 : 0;
  t += macdUp ? 10 : hist[i] > 0 ? 5 : 0;
  t += vr >= 1.5 && c[i] > c[i - 1] ? 15 : vr >= 1.1 && c[i] > c[i - 1] ? 8 : 0;
  t += breakout ? 15 : c[i] >= hh20 * 0.97 ? 7 : 0;
  t += rsDelta > 5 ? 15 : rsDelta > 0 ? 8 : 0;
  // Khuyến nghị
  const mktOK = A.mkt ? A.mkt[i] : true;
  const bo55 = c[i] > Math.max(...H.slice(i - 55, i)) && vr >= 1.3;
  const pb20 = upTrend && A.L[i] <= m20[i] * 1.01 && c[i] > A.O[i];
  const momo = rsDelta > 10 && upTrend;
  const setup = bo55 || pb20 || momo;
  let rec = 'TRUNG LẬP';
  const sellBreak = c[i] < m20[i] && c[i - 1] >= m20[i - 1] && vr >= 1.2 && c[i] < c[i - 1];
  const sellTrend = c[i] < m50[i] && c[i - 1] >= m50[i - 1];
  if (setup && mktOK && rsi[i] < 75 && ext < 10) rec = 'MUA';
  else if (sellBreak || sellTrend || (macdCrossDn && c[i] < m20[i])) rec = 'BÁN';
  else if (rsi[i] > 80 || ext > 15) rec = 'CHỐT LỜI';
  else if (setup || t >= 55 || squeeze && upTrend || oversoldBounce) rec = 'THEO DÕI';
  else if (t < 30 && c[i] < m50[i]) rec = 'TRÁNH';
  const flags = [bo55 && 'BO55', breakout && 'BO', pb20 && 'PB', momo && 'RS', setup && !mktOK && 'MKW', macdCrossUp && 'MX', macdCrossDn && 'MXD', squeeze && 'SQ', oversoldBounce && 'OS', upTrend && 'UT', sellBreak && 'BR20', sellTrend && 'BR50', vr >= 2 && 'VS'].filter(Boolean);
  return { t, rec, vr, ext, flags, breakout, upTrend };
}

// 5. Backtest tín hiệu MUA: lợi nhuận 10 phiên sau, có cắt lỗ 2*ATR
const bt = { n: 0, win: 0, sum: 0, rets: [] }, base = { n: 0, sum: 0 };
const out = [], charts = {};
const lastT = V.t.at(-1);
for (const s of uni) {
  const h = hist[s]; if (!h) continue;
  const A = analyze(h), i = A.n - 1;
  A.mkt = h.t.map(t => { const k = vIdx[t]; return k != null && vm50[k] != null && vc[k] >= vm50[k]; });
  const rsAt = k => { const vi = vIdx[h.t[k]], vj = vIdx[h.t[k - 20]]; return vi != null && vj != null ? pct(A.c[k], A.c[k - 20]) - pct(vc[vi], vc[vj]) : 0; };
  for (let k = 60; k < A.n - 10; k++) {
    base.n++; base.sum += pct(A.c[k + 10], A.c[k]);
    const sg = signalAt(A, k, rsAt(k)); if (!sg || sg.rec !== 'MUA') continue;
    const entry = A.c[k], stop = entry - 2 * A.atr[k]; let exit = A.c[k + 10];
    for (let m = k + 1; m <= k + 10; m++) if (A.L[m] <= stop) { exit = stop; break; }
    const r = pct(exit, entry) - 0.3; bt.n++; bt.sum += r; if (r > 0) bt.win++; bt.rets.push(r);
    k += 10; // tránh đếm trùng tín hiệu liên tiếp
  }
  const rs20 = rsAt(i);
  const vi = vIdx[h.t[i]], vj60 = vIdx[h.t[Math.max(0, i - 60)]];
  const rs60 = vi != null && vj60 != null ? pct(A.c[i], A.c[Math.max(0, i - 60)]) - pct(vc[vi], vc[vj60]) : null;
  const sg = signalAt(A, i, rs20);
  const f = fund[s] || {};
  const pe = f['51006'], roe = f['52002'], gr = f['52005'], eps = f['53007'];
  let fs = 0;
  fs += eps > 0 ? 20 : 0; fs += roe >= 0.2 ? 25 : roe >= 0.15 ? 18 : roe >= 0.1 ? 10 : 0;
  fs += gr >= 0.3 ? 30 : gr >= 0.15 ? 22 : gr > 0 ? 10 : 0;
  fs += pe > 0 && pe <= 12 ? 25 : pe > 0 && pe <= 18 ? 15 : pe > 0 && pe <= 25 ? 5 : 0;
  const atr = A.atr[i], p = A.c[i];
  const hi52 = Math.max(...A.H.slice(-250)), lo52 = Math.min(...A.L.slice(-250));
  out.push({
    s, ex: meta[s]?.floor, nm: meta[s]?.shortName, ind: ind[s] || 'Khác',
    p: r2(p), d1: r1(pct(p, A.c[i - 1])), d5: r1(pct(p, A.c[i - 5])), d20: r1(pct(p, A.c[i - 20])), d60: r1(pct(p, A.c[Math.max(0, i - 60)])),
    rs20: r1(rs20), rs60: r1(rs60), val: Math.round(liq[s] / 1e9), vr: r2(sg.vr), rsi: r1(A.rsi[i]), mh: r2(A.hist[i]),
    m20: r1(pct(p, A.m20[i])), m50: r1(pct(p, A.m50[i])), m200: A.m200[i] ? r1(pct(p, A.m200[i])) : null,
    h52: r1(pct(p, hi52)), l52: r1(pct(p, lo52)), atr: r1(atr / p * 100), bbw: r1(A.bbw[i]),
    fl: sg.flags.join(' '), ts: sg.t, fs, sc: Math.round(sg.t * 0.65 + fs * 0.35), rec: sg.rec,
    en: r2(Math.min(p, A.m10[i] * 1.01)), sl: r2(Math.max(p - 2 * atr, A.m20[i] * 0.97 < p ? A.m20[i] * 0.97 : p - 2 * atr)), tp: r2(p + 3 * atr),
    pe: r1(pe), pb: r1(f['51012']), roe: r1(roe * 100), gr: r1(gr * 100), eps: eps ? Math.round(eps) : null, cap: f['51003'] ? Math.round(f['51003'] / 1e9) : null, beta: r2(f['51007']),
    stale: h.t[i] !== lastT ? 1 : 0
  });
}
out.sort((a, b) => b.sc - a.sc);
const pick = new Set([...out.slice(0, 30).map(x => x.s), ...out.filter(x => x.rec === 'MUA' || x.rec === 'BÁN').map(x => x.s)]);
for (const s of pick) { const h = hist[s]; charts[s] = [h.c.slice(-60), h.v.slice(-60).map(x => Math.round(x / 1000))]; }
const VA = analyze(V), vi = VA.n - 1;
bt.rets.sort((a, b) => a - b);
window.__result = {
  asof: new Date(lastT * 1000).toISOString().slice(0, 10), gen: new Date().toISOString(), src: priceSource,
  vni: { ok: vc[vi] >= vm50[vi] ? 1 : 0, p: r2(vc[vi]), d1: r2(pct(vc[vi], vc[vi - 1])), d20: r2(pct(vc[vi], vc[vi - 20])), rsi: r1(VA.rsi[vi]), m20: r1(pct(vc[vi], VA.m20[vi])), m50: r1(pct(vc[vi], VA.m50[vi])), c: vc.slice(-60).map(r2), t: V.t.slice(-60).map(x => new Date(x * 1000).toISOString().slice(5, 10)) },
  bt: { n: bt.n, win: r1(bt.win / bt.n * 100), avg: r2(bt.sum / bt.n), med: r2(bt.rets[Math.floor(bt.n / 2)]), base: r2(base.sum / base.n) },
  st: { k: Object.keys(out[0]), r: out.map(o => Object.values(o)) }, ch: charts
};
window.__json = JSON.stringify(window.__result);
return { src: priceSource, len: window.__json.length, n: out.length, charts: Object.keys(charts).length, size: JSON.stringify(window.__result).length, bt: window.__result.bt, recs: out.reduce((m, x) => (m[x.rec] = (m[x.rec] || 0) + 1, m), {}) };
})()
