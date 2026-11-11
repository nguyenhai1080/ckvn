// Theo dõi hiệu quả thực tế của tín hiệu.
// Quy tắc giống backtest: vào lệnh ở giá đóng cửa phiên có tín hiệu, cắt lỗ / mục tiêu theo mức tại thời điểm đó,
// giữ tối đa 10 phiên, phí 0,3% khi đóng. Cùng phiên chạm cả cắt lỗ lẫn mục tiêu → tính là cắt lỗ (thận trọng).

export const MAX_SESSIONS = 10;
export const FEE_PCT = 0.3;

const r2 = x => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (a, b) => (a / b - 1) * 100;

/** Chuyển dữ liệu dchart {t,o,h,l,c} thành mảng nến [{d:'YYYY-MM-DD',h,l,c}] */
export function toBars(h) {
  if (!h || h.s !== 'ok' || !Array.isArray(h.t)) return [];
  return h.t.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), h: h.h[i], l: h.l[i], c: h.c[i] }));
}

/**
 * Đánh giá một lệnh đang mở dựa trên các nến SAU ngày tín hiệu.
 * @returns các trường cần cập nhật trong bảng trades
 */
export function evaluateTrade(trade, bars) {
  const entry = +trade.entry, stop = +trade.stop, target = +trade.target;
  const after = bars.filter(b => b.d > trade.signal_date).sort((a, b) => (a.d < b.d ? -1 : 1));
  let hi = entry, lo = entry, sessions = 0;
  const upd = { status: 'open', sessions: 0, last_price: entry, exit_price: null, exit_date: null, ret_pct: 0, max_ret_pct: 0, min_ret_pct: 0 };
  for (const b of after) {
    sessions++;
    hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    upd.sessions = sessions; upd.last_price = b.c;
    upd.max_ret_pct = r2(pct(hi, entry)); upd.min_ret_pct = r2(pct(lo, entry));
    let exit = null, status = null;
    if (b.l <= stop) { exit = stop; status = 'stop'; }
    else if (b.h >= target) { exit = target; status = 'target'; }
    else if (sessions >= MAX_SESSIONS) { exit = b.c; status = 'expired'; }
    if (status) {
      return { ...upd, status, exit_price: r2(exit), exit_date: b.d, ret_pct: r2(pct(exit, entry) - FEE_PCT) };
    }
    upd.ret_pct = r2(pct(b.c, entry));
  }
  return upd;
}

/**
 * Lệnh mới từ dữ liệu phiên D (window.DATA).
 * Bỏ qua mã đang có lệnh mở cùng loại.
 */
export function newTrades(D, openTrades = []) {
  const K = D.k, rows = D.r.map(r => Object.fromEntries(K.map((k, i) => [k, r[i]])));
  const open = new Set(openTrades.map(t => `${t.symbol}|${t.kind}`));
  const out = [];
  for (const r of rows) {
    if (r.stale) continue;
    const flags = (r.fl || '').split(' ');
    const kind = r.rec === 'MUA' ? 'MUA' : flags.includes('MKW') ? 'CHỜ' : null;
    if (!kind || open.has(`${r.s}|${kind}`)) continue;
    if (!(r.p > 0 && r.sl > 0 && r.tp > r.p && r.sl < r.p)) continue;
    out.push({ signal_date: D.asof, symbol: r.s, kind, entry: r.p, stop: r.sl, target: r.tp, status: 'open', sessions: 0, last_price: r.p, ret_pct: 0, max_ret_pct: 0, min_ret_pct: 0 });
  }
  return out;
}

/** Thống kê tóm tắt (dùng chung cho giao diện và kiểm thử) */
export function summarize(trades) {
  const closed = trades.filter(t => t.status !== 'open');
  const wins = closed.filter(t => +t.ret_pct > 0);
  const avg = closed.length ? closed.reduce((s, t) => s + +t.ret_pct, 0) / closed.length : null;
  return { closed: closed.length, open: trades.length - closed.length, win: closed.length ? r2(wins.length / closed.length * 100) : null, avg: r2(avg) };
}
