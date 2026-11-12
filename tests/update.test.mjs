import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRun, asofOf, vnDate, computeData } from '../scripts/lib/update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Giờ VN → mốc thời gian UTC
const vn = (d, hm) => Date.parse(`${d}T${hm}:00+07:00`);

test('vnDate đổi sang ngày Việt Nam', () => {
  assert.equal(vnDate(Date.parse('2026-11-11T17:30:00Z')), '2026-11-12'); // 00:30 sáng 12/11 giờ VN
  assert.equal(vnDate(vn('2026-11-12', '15:45')), '2026-11-12');
});

test('shouldRun: chỉ thứ 2–6, 15:45–18:00, chưa có phiên hôm nay', () => {
  const st = { asof: '2026-11-11' };
  assert.equal(shouldRun(vn('2026-11-12', '15:44'), st), false);
  assert.equal(shouldRun(vn('2026-11-12', '15:45'), st), true);   // thứ 5
  assert.equal(shouldRun(vn('2026-11-12', '17:59'), st), true);
  assert.equal(shouldRun(vn('2026-11-12', '18:00'), st), false);
  assert.equal(shouldRun(vn('2026-11-14', '16:00'), st), false);  // thứ 7
  assert.equal(shouldRun(vn('2026-11-15', '16:00'), st), false);  // chủ nhật
  assert.equal(shouldRun(vn('2026-11-12', '16:00'), { asof: '2026-11-12' }), false); // đã có phiên
  assert.equal(shouldRun(vn('2026-11-12', '16:00'), { ...st, running: true }), false);
  assert.equal(shouldRun(vn('2026-11-12', '16:00'), { ...st, skipDate: '2026-11-12' }), false); // ngày nghỉ
});

test('shouldRun: thử lại cách nhau ≥ 20 phút', () => {
  const st = { asof: '2026-11-11', lastAttempt: vn('2026-11-12', '15:45') };
  assert.equal(shouldRun(vn('2026-11-12', '16:04'), st), false);
  assert.equal(shouldRun(vn('2026-11-12', '16:05'), st), true);
});

test('asofOf đọc ngày từ data.js', () => {
  assert.equal(asofOf('window.DATA={"asof":"2026-11-11","gen":"x"};'), '2026-11-11');
  assert.equal(asofOf('rác'), null);
});

// ---- engine.js thật, chạy với API VNDirect giả lập ----
function fakeVndirect({ n = 80, lastDay = '2026-11-12' } = {}) {
  const codes = Array.from({ length: n }, (_, i) => 'M' + String(i).padStart(2, '0'));
  const end = Date.parse(lastDay + 'T00:00:00Z') / 1000;
  const days = [];
  for (let t = end; days.length < 280; t -= 86400) { const wd = new Date(t * 1000).getUTCDay(); if (wd && wd !== 6) days.unshift(t); }
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const series = sym => {
    let p = sym === 'VNINDEX' ? 1700 : 10 + rnd() * 50; const o = [], h = [], l = [], c = [], v = [];
    for (const _ of days) { const pc = p; p = Math.max(1, p * (1 + (rnd() - 0.48) * 0.04)); o.push(pc); c.push(p); h.push(Math.max(p, pc) * 1.01); l.push(Math.min(p, pc) * 0.99); v.push(Math.round(1e5 + rnd() * 1e6)); }
    return { s: 'ok', t: days, o, h, l, c, v };
  };
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
    if (u.hostname.startsWith('dchart-api')) return j(series(u.searchParams.get('symbol')));
    throw new Error('URL lạ ' + url);
  };
  return { fetchImpl, calls };
}

test('computeData chạy engine.js thật trong Node (không đụng biến toàn cục)', async () => {
  const { fetchImpl, calls } = fakeVndirect();
  delete globalThis.window;
  const res = await computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl });
  assert.equal(res.asof, '2026-11-12');
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
  await assert.rejects(computeData({ engineFile: path.join(ROOT, 'engine.js'), fetchImpl }), /Chỉ có 10 mã/);
});
