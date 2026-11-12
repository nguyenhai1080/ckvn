import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRun, sessionInfo, asofOf, vnDate, computeData } from '../scripts/lib/update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Giờ VN → mốc thời gian UTC
const vn = (d, hm) => Date.parse(`${d}T${hm}:00+07:00`);

test('vnDate đổi sang ngày Việt Nam', () => {
  assert.equal(vnDate(Date.parse('2026-11-11T17:30:00Z')), '2026-11-12'); // 00:30 sáng 12/11 giờ VN
  assert.equal(vnDate(vn('2026-11-12', '15:45')), '2026-11-12');
});

test('shouldRun: bản chốt thứ 2–6, 15:45–18:00, chưa có bản chốt hôm nay', () => {
  const st = { asof: '2026-11-11', finalAsof: '2026-11-11' };
  assert.equal(shouldRun(vn('2026-11-12', '15:44'), st), null);
  assert.equal(shouldRun(vn('2026-11-12', '15:45'), st), 'final');   // thứ 5
  assert.equal(shouldRun(vn('2026-11-12', '17:59'), st), 'final');
  assert.equal(shouldRun(vn('2026-11-12', '18:00'), st), null);
  assert.equal(shouldRun(vn('2026-11-14', '16:00'), st), null);      // thứ 7
  assert.equal(shouldRun(vn('2026-11-15', '10:00'), st), null);      // chủ nhật, kể cả trong giờ
  assert.equal(shouldRun(vn('2026-11-12', '16:00'), { finalAsof: '2026-11-12' }), null);
  assert.equal(shouldRun(vn('2026-11-12', '16:00'), { ...st, asof: '2026-11-12' }), 'final', 'bản tạm tính hôm nay không thay được bản chốt');
  assert.equal(shouldRun(vn('2026-11-12', '16:00'), { ...st, running: true }), null);
  assert.equal(shouldRun(vn('2026-11-12', '16:00'), { ...st, skipDate: '2026-11-12' }), null);
  const tried = { ...st, lastFinalAttempt: vn('2026-11-12', '15:45') };
  assert.equal(shouldRun(vn('2026-11-12', '16:04'), tried), null);
  assert.equal(shouldRun(vn('2026-11-12', '16:05'), tried), 'final');
});

test('shouldRun: trong phiên mỗi N phút, nghỉ trưa và ngoài giờ thì không', () => {
  const st = { finalAsof: '2026-11-11' };
  for (const [hm, want] of [['09:14', null], ['09:15', 'live'], ['11:35', 'live'], ['11:36', null], ['12:30', null],
    ['13:04', null], ['13:05', 'live'], ['14:55', 'live'], ['14:56', null], ['15:30', null]])
    assert.equal(shouldRun(vn('2026-11-12', hm), st), want, hm);
  const last = { ...st, lastAttempt: vn('2026-11-12', '10:00') };
  assert.equal(shouldRun(vn('2026-11-12', '10:09'), last), null);
  assert.equal(shouldRun(vn('2026-11-12', '10:10'), last), 'live');
  assert.equal(shouldRun(vn('2026-11-12', '10:05'), last, { intervalMin: 5 }), 'live');
  assert.equal(shouldRun(vn('2026-11-12', '10:30'), st, { intervalMin: 0 }), null, '0 = tắt cập nhật trong phiên');
  assert.equal(shouldRun(vn('2026-11-12', '10:30'), { ...st, skipDate: '2026-11-12' }), null, 'ngày nghỉ');
});

test('sessionInfo: tỷ lệ thời gian giao dịch đã trôi qua', () => {
  assert.equal(sessionInfo(vn('2026-11-12', '09:00')).fraction, 0);
  assert.equal(sessionInfo(vn('2026-11-12', '11:30')).fraction, 150 / 255);
  assert.equal(sessionInfo(vn('2026-11-12', '12:15')).fraction, 150 / 255);   // nghỉ trưa
  assert.equal(sessionInfo(vn('2026-11-12', '14:45')).fraction, 1);
  assert.equal(sessionInfo(vn('2026-11-12', '12:15')).intraday, true);
  assert.equal(sessionInfo(vn('2026-11-12', '15:30')).intraday, false);
});

test('asofOf đọc ngày từ data.js', () => {
  assert.equal(asofOf('window.DATA={"asof":"2026-11-11","gen":"x"};'), '2026-11-11');
  assert.equal(asofOf('rác'), null);
});

// ---- engine.js thật, chạy với API VNDirect giả lập ----
function fakeVndirect({ n = 80, lastDay = '2026-11-12', dchartBlocked = false } = {}) {
  const codes = Array.from({ length: n }, (_, i) => 'M' + String(i).padStart(2, '0'));
  const end = Date.parse(lastDay + 'T00:00:00Z') / 1000;
  const days = [];
  for (let t = end; days.length < 280; t -= 86400) { const wd = new Date(t * 1000).getUTCDay(); if (wd && wd !== 6) days.unshift(t); }
  const cache = {};
  const series = sym => cache[sym] ??= (() => {
    let seed = [...sym].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) % 2147483646 + 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let p = sym === 'VNINDEX' ? 1700 : 10 + rnd() * 50; const o = [], h = [], l = [], c = [], v = [];
    for (const _ of days) { const pc = p; p = Math.max(1, p * (1 + (rnd() - 0.48) * 0.04)); o.push(pc); c.push(p); h.push(Math.max(p, pc) * 1.01); l.push(Math.min(p, pc) * 0.99); v.push(Math.round(1e5 + rnd() * 1e6)); }
    return { s: 'ok', t: days, o, h, l, c, v };
  })();
  const calls = { total: 0 };
  const fetchImpl = async url => {
    calls.total++;
    const u = new URL(url), j = x => new Response(JSON.stringify(x));
    if (u.pathname.endsWith('/stocks')) {
      const fl = /floor:(\w+)/.exec(u.searchParams.get('q'))[1];
      return j({ data: fl === 'HOSE' ? codes.map(code => ({ code, floor: 'HOSE', shortName: 'Cty ' + code })) : [] });
    }
    if (u.pathname.endsWith('/ratios/latest')) {
      const where = u.searchParams.get('where').replace('code:', '').split(','), item = u.searchParams.get('filter');
      if (item === 'itemCode:52007') return j({ data: where.map(code => ({ code, value: 2e10 })) });
      return j({ data: where.flatMap(code => [['51006', 12], ['52002', 0.18], ['52005', 0.2], ['53007', 3000], ['51003', 5e12], ['51007', 1], ['51012', 1.5]].map(([itemCode, value]) => ({ code, itemCode, value }))) });
    }
    if (u.pathname.endsWith('/industry_classification')) return j({ data: [{ vietnameseName: 'Ngân hàng', codeList: codes.slice(0, 20).join(',') }] });
    if (u.hostname.startsWith('dchart-api')) {
      if (dchartBlocked) return new Response('Forbidden', { status: 403 });
      return j(series(u.searchParams.get('symbol')));
    }
    if (u.pathname.endsWith('/stock_prices') || u.pathname.endsWith('/vnmarket_prices')) {
      const q = u.searchParams.get('q'), sym = /code:(\w+)/.exec(q)[1];
      const gte = /date:gte:([\d-]+)/.exec(q)[1], lte = /date:lte:([\d-]+)/.exec(q)[1];
      const h = series(sym), idx = u.pathname.endsWith('/vnmarket_prices');
      const rows = h.t.map((t, i) => ({ code: sym, date: new Date(t * 1000).toISOString().slice(0, 10),
        ...(idx ? { open: h.o[i], high: h.h[i], low: h.l[i], close: h.c[i], nmVolume: h.v[i], accumulatedVol: h.v[i] * 1.2 }
                : { adOpen: h.o[i], adHigh: h.h[i], adLow: h.l[i], adClose: h.c[i], nmVolume: h.v[i], close: h.c[i] * 2 }) }))
        .filter(r => r.date >= gte && r.date <= lte).reverse();
      calls.finfoPrices = (calls.finfoPrices || 0) + 1;
      return j({ data: rows });
    }
    throw new Error('URL lạ ' + url);
  };
  return { fetchImpl, calls };
}

test('computeData chạy engine.js thật trong Node (không đụng biến toàn cục)', async () => {
  const { fetchImpl, calls } = fakeVndirect();
  delete globalThis.window;
  const res = await computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl, now: vn('2026-11-12', '16:00') });
  assert.equal(res.asof, '2026-11-12'); assert.equal(res.source, 'dchart');
  assert.equal(res.rows, 80);
  assert.equal(globalThis.window, undefined, 'không tạo window toàn cục');
  globalThis.window = {}; new Function(res.data)();
  const D = globalThis.window.DATA; delete globalThis.window;
  assert.equal(D.asof, '2026-11-12'); assert.equal(D.r.length, 80); assert.ok(D.k.includes('rec'));
  assert.ok(D.vni.c.length === 60 && D.bt.n >= 0);
  assert.ok(calls.total > 80);
});

test('computeData từ chối dữ liệu quá ít mã', async () => {
  const { fetchImpl } = fakeVndirect({ n: 10 });
  await assert.rejects(computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl, now: vn('2026-11-12', '16:00') }), /Chỉ có 10 mã/);
});

test('trước 15:30: bỏ nến đang giao dịch dở của hôm nay', async () => {
  const { fetchImpl } = fakeVndirect();
  const res = await computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl, now: vn('2026-11-12', '11:42') });
  assert.equal(res.asof, '2026-11-11');
  const res2 = await computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl, now: vn('2026-11-12', '15:30') });
  assert.equal(res2.asof, '2026-11-12');
});

test('dchart bị chặn → tự chuyển sang api-finfo, kết quả giống hệt', async () => {
  const a = await computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl: fakeVndirect().fetchImpl, now: vn('2026-11-12', '16:00') });
  const fb = fakeVndirect({ dchartBlocked: true });
  const b = await computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl: fb.fetchImpl, now: vn('2026-11-12', '16:00') });
  assert.equal(b.source, 'finfo'); assert.equal(b.asof, '2026-11-12'); assert.equal(b.rows, 80);
  assert.ok(fb.calls.finfoPrices >= 81);
  assert.equal(b.stats['dchart-api.vndirect.com.vn'].fail, 1); // chỉ thử dchart 1 lần (VNINDEX) rồi chuyển hẳn
  const strip = d => d.replace(/"gen":"[^"]+"/, '');
  assert.equal(strip(b.data), strip(a.data), 'cùng dữ liệu → cùng tín hiệu');
});

test('cả hai nguồn đều hỏng → lỗi rõ ràng kèm thống kê request', async () => {
  const fetchImpl = async url => /dchart|_prices/.test(url) ? new Response('nope', { status: 403 }) : fakeVndirect().fetchImpl(url);
  await assert.rejects(computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl, now: vn('2026-11-12', '16:00') }),
    e => /Không lấy được lịch sử VN-Index \(nguồn finfo\)/.test(e.message) && /dchart-api\.vndirect\.com\.vn/.test(e.message));
});

test('mode live: lấy nến hôm nay, ước tính khối lượng cả phiên, gắn nhãn tạm tính', async () => {
  const { fetchImpl } = fakeVndirect();
  const fin = await computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl, now: vn('2026-11-12', '16:00') });
  const live = await computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl, now: vn('2026-11-12', '10:00'), mode: 'live' });
  assert.equal(live.asof, '2026-11-12'); assert.ok(live.live); assert.equal(live.live.fraction, 0.24);
  assert.match(live.data, /"live":\{"at":"2026-11-12T03:00:00.000Z"/);
  assert.doesNotMatch(fin.data, /"live"/);
  const rows = d => { const g = {}; new Function('window', d)(g); const K = g.DATA.k; return Object.fromEntries(g.DATA.r.map(r => [r[0], Object.fromEntries(K.map((k, i) => [k, r[i]]))])); };
  const a = rows(fin.data), b = rows(live.data);
  // cùng giá, nhưng tỷ lệ khối lượng (vr) của bản tạm tính = bản chốt × 1/0,24 (khối lượng hôm nay được ước tính cả phiên)
  const s = Object.keys(a)[0];
  assert.equal(b[s].p, a[s].p);
  assert.ok(Math.abs(b[s].vr / a[s].vr - 255 / 60) < 0.05, `vr ${a[s].vr} → ${b[s].vr}`);
});

test('mode live vào ngày nghỉ: không có nến hôm nay → không gắn nhãn tạm tính', async () => {
  const { fetchImpl } = fakeVndirect({ lastDay: '2026-11-11' });
  const r = await computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl, now: vn('2026-11-12', '10:00'), mode: 'live' });
  assert.equal(r.asof, '2026-11-11'); assert.equal(r.live, null); assert.doesNotMatch(r.data, /"live"/);
});
