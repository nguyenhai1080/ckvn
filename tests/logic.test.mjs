import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrade, newTrades, summarize, toBars } from '../scripts/lib/trades.mjs';
import { buildEvents, composeForUser } from '../scripts/lib/alerts.mjs';

const T = { signal_date: '2026-11-11', symbol: 'TPB', kind: 'MUA', entry: 13.1, stop: 12.35, target: 14.23 };
const bar = (d, h, l, c) => ({ d, h, l, c });

test('bỏ qua nến của chính ngày tín hiệu và trước đó', () => {
  const u = evaluateTrade(T, [bar('2026-11-10', 99, 1, 13), bar('2026-11-11', 99, 1, 13.1)]);
  assert.equal(u.status, 'open'); assert.equal(u.sessions, 0);
});

test('chạm mục tiêu', () => {
  const u = evaluateTrade(T, [bar('2026-11-12', 13.5, 13.0, 13.4), bar('2026-11-13', 14.3, 13.3, 14.1)]);
  assert.equal(u.status, 'target'); assert.equal(u.exit_price, 14.23); assert.equal(u.exit_date, '2026-11-13');
  assert.equal(u.ret_pct, Math.round(((14.23 / 13.1 - 1) * 100 - 0.3) * 100) / 100);
  assert.equal(u.sessions, 2);
});

test('chạm cắt lỗ; cùng phiên chạm cả hai thì tính cắt lỗ', () => {
  const u = evaluateTrade(T, [bar('2026-11-12', 14.5, 12.0, 13)]);
  assert.equal(u.status, 'stop'); assert.equal(u.exit_price, 12.35);
  assert.ok(u.ret_pct < -5);
});

test('hết 10 phiên → đóng theo giá đóng cửa', () => {
  const bars = Array.from({ length: 12 }, (_, i) => bar(`2026-11-${String(12 + i).padStart(2, '0')}`, 13.5, 13, 13.2 + i * 0.01));
  const u = evaluateTrade(T, bars);
  assert.equal(u.status, 'expired'); assert.equal(u.sessions, 10); assert.equal(u.exit_date, '2026-11-21'); assert.equal(u.exit_price, 13.29);
});

test('đang mở: lãi tạm tính, max/min', () => {
  const u = evaluateTrade(T, [bar('2026-11-12', 13.8, 12.9, 13.6)]);
  assert.equal(u.status, 'open'); assert.equal(u.last_price, 13.6);
  assert.equal(u.max_ret_pct, 5.34); assert.equal(u.min_ret_pct, -1.53);
});

test('toBars đổi định dạng dchart', () => {
  const t = Date.UTC(2026, 10, 12) / 1000;
  assert.deepEqual(toBars({ s: 'ok', t: [t], o: [1], h: [2], l: [0.5], c: [1.5] }), [{ d: '2026-11-12', h: 2, l: 0.5, c: 1.5 }]);
  assert.deepEqual(toBars({ s: 'no_data' }), []);
});

// Dữ liệu phiên giả
const K = ['s', 'p', 'd1', 'rec', 'fl', 'en', 'sl', 'tp', 'stale'];
const mk = (asof, ok, rows) => ({ asof, k: K, vni: { ok, p: 1746.9 }, r: rows });
const prev = mk('2026-11-10', 0, [['TPB', 12.7, 1, 'THEO DÕI', 'UT', 12.6, 12.1, 13.8, 0], ['VNM', 55.4, 0, 'TRUNG LẬP', '', 55, 53, 58, 0], ['HPG', 21, 0, 'MUA', 'PB', 21, 20, 22, 0]]);
const today = mk('2026-11-11', 1, [
  ['TPB', 13.1, 3.1, 'MUA', 'PB UT', 12.85, 12.35, 14.23, 0],
  ['VNM', 54.5, -1.6, 'BÁN', 'BR20', 54.5, 53.32, 57.3, 0],
  ['HPG', 21.35, 0.5, 'MUA', 'PB', 21.35, 20.42, 22.87, 0],
  ['DPG', 32.5, 0.8, 'THEO DÕI', 'RS MKW UT', 31.66, 30.26, 35.86, 0],
  ['OLD', 10, 0, 'MUA', '', 10, 9, 11, 1],
]);

test('newTrades: MUA + CHỜ, bỏ mã đang mở và mã stale', () => {
  const t = newTrades(today, [{ symbol: 'HPG', kind: 'MUA' }]);
  assert.deepEqual(t.map(x => `${x.symbol}/${x.kind}`), ['TPB/MUA', 'DPG/CHỜ']);
  assert.equal(t[0].entry, 13.1); assert.equal(t[0].stop, 12.35); assert.equal(t[0].signal_date, '2026-11-11');
});

test('buildEvents: chỉ báo khi trạng thái thay đổi', () => {
  const ev = buildEvents(today, prev, [{ symbol: 'NT2', kind: 'CHỜ', status: 'target', target: 25.52, signal_date: '2026-11-03', ret_pct: 7.1 }]);
  assert.deepEqual([...ev.bySymbol.keys()].sort(), ['DPG', 'NT2', 'TPB', 'VNM']); // HPG đã MUA từ hôm qua → không báo lại
  assert.equal(ev.bySymbol.get('TPB')[0].type, 'buy');
  assert.equal(ev.bySymbol.get('VNM')[0].type, 'sell');
  assert.equal(ev.bySymbol.get('DPG')[0].type, 'setup');
  assert.equal(ev.bySymbol.get('NT2')[0].type, 'levels');
  assert.match(ev.market.text, /vượt lên trên MA50/);
});

test('buildEvents không có phiên trước: không báo thị trường', () => {
  assert.equal(buildEvents(today, null).market, null);
});

const P = { alert_buy: true, alert_sell: true, alert_levels: true, alert_setup: false, alert_market: true };
test('composeForUser lọc theo danh mục và cài đặt, escape HTML', () => {
  const ev = buildEvents(today, prev);
  const m = composeForUser(P, ['TPB', 'DPG', 'FPT'], ev, today, 'https://x.vn/');
  assert.equal(m.count, 2); // thị trường + TPB (DPG là setup nhưng alert_setup=false)
  assert.match(m.text, /VN-Index/); assert.match(m.text, /MUA TPB/); assert.doesNotMatch(m.text, /DPG/);
  assert.match(m.subject, /11\/11\/2026/);
  assert.equal(composeForUser({ ...P, alert_market: false }, ['FPT'], ev, today), null);
  const m2 = composeForUser({ ...P, alert_setup: true, alert_market: false }, ['DPG'], ev, today);
  assert.match(m2.html, /setup mua/); assert.doesNotMatch(m2.html, /<script/);
});

test('summarize', () => {
  const s = summarize([{ status: 'target', ret_pct: 8 }, { status: 'stop', ret_pct: -6 }, { status: 'expired', ret_pct: 1 }, { status: 'open', ret_pct: 2 }]);
  assert.deepEqual(s, { closed: 3, open: 1, win: 66.67, avg: 1 });
});
