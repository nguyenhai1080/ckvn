// Kiểm thử giao diện bằng Playwright. Chạy: node tests/ui/run.cjs  (cần python3 để phục vụ file tĩnh)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '../..'), PORT = 8766, BASE = `http://localhost:${PORT}/`;
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-supabase.js'), 'utf8');
const SHOTS = process.env.SHOTS || '';

function mockDB() {
  if (!mockDB.today) { global.window = {}; require(path.join(ROOT, 'data.js')); mockDB.today = global.window.DATA; }
  const today = JSON.parse(JSON.stringify(mockDB.today));
  const old = JSON.parse(JSON.stringify(today)); old.asof = '2026-11-10';
  old.r = old.r.slice(0, 20); old.vni.p = 1743.07;
  return {
    users: [{ id: 'u1', email: 'andy@example.vn', password: 'matkhau123' }],
    profiles: [{ user_id: 'u1', email: 'andy@example.vn', notify_email: true, notify_telegram: true, alert_buy: true, alert_sell: true, alert_levels: true, alert_setup: false, alert_market: true, telegram_chat_id: null }],
    watchlist: [{ user_id: 'u1', symbol: 'FPT', added_at: '2026-11-01' }],
    snapshots: [{ date: '2026-11-11', data: today }, { date: '2026-11-10', data: old }],
    trades: [
      { id: 1, signal_date: '2026-11-04', symbol: 'NT2', kind: 'CHỜ', entry: 22, stop: 21, target: 23.4, status: 'target', sessions: 5, exit_price: 23.4, exit_date: '2026-11-11', ret_pct: 6.06, max_ret_pct: 6.8, min_ret_pct: -0.5, last_price: 23.2 },
      { id: 2, signal_date: '2026-11-06', symbol: 'TPB', kind: 'CHỜ', entry: 12.7, stop: 12.1, target: 13.9, status: 'open', sessions: 3, last_price: 13.1, ret_pct: 3.15, max_ret_pct: 3.9, min_ret_pct: -1.2 },
      { id: 3, signal_date: '2026-10-20', symbol: 'HPG', kind: 'MUA', entry: 21, stop: 20.2, target: 22.5, status: 'stop', sessions: 2, exit_price: 20.2, exit_date: '2026-10-22', ret_pct: -4.11, max_ret_pct: 1, min_ret_pct: -4.5, last_price: 20.1 },
    ],
    alert_log: [{ user_id: 'u1', date: '2026-11-10', channels: ['email'], body: '<b>Lướt sóng CK – phiên 10/11/2026</b>\n\n▼ BÁN VNM 54,50 (-1,6%)\n\nhttps://x.vn/\n<i>Công cụ sàng lọc tham khảo, không phải khuyến nghị đầu tư.</i>' }],
  };
}

async function page(browser, { cloud, width = 1280 }) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && !/favicon|ERR_|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await p.route('https://cdn.jsdelivr.net/**', r => cloud ? r.fulfill({ contentType: 'text/javascript', body: MOCK }) : r.abort());
  if (cloud) {
    await p.route(BASE + 'config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.LSCK_CONFIG={supabaseUrl:'https://x.supabase.co',supabaseAnonKey:'anon',telegramBot:'LuotSongCKBot'}" }));
    await p.addInitScript(db => { window.__mockDB = db; window.open = () => null; }, mockDB());
  }
  return { p, errors, ctx };
}
const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch();
  try {
    // ---- 1. Chế độ tĩnh: CDN lỗi / chưa cấu hình → trang vẫn chạy ----
    {
      const { p, errors, ctx } = await page(browser, { cloud: false });
      await p.goto(BASE);
      await p.waitForSelector('#setup .sig');
      assert.equal(await p.locator('#setup .sig').count(), 12);
      assert.equal(await p.textContent('#tab-acc'), 'Đăng nhập');
      await p.goto(BASE + '#tai-khoan'); await p.waitForTimeout(200);
      assert.match(await p.textContent('#account'), /cần cấu hình Supabase/);
      await p.goto(BASE + '#bo-loc'); await p.locator('[data-star="TPB"]').click();
      assert.equal(await p.evaluate(() => localStorage.getItem('lsck-wl')), '["TPB"]');
      assert.deepEqual(errors, []);
      console.log('✔ chế độ tĩnh');
      await ctx.close();
    }
    // ---- 2. Chế độ Supabase ----
    {
      const { p, errors, ctx } = await page(browser, { cloud: true });
      await p.goto(BASE + '#bo-loc');
      await p.waitForSelector('#day-sel');
      // Thêm TPB khi chưa đăng nhập → sau đăng nhập phải được gộp với FPT trên server
      await p.locator('[data-star="TPB"]').click();
      await p.goto(BASE + '#tai-khoan');
      await p.fill('input[name=email]', 'andy@example.vn'); await p.fill('input[name=pw]', 'saimatkhau');
      await p.click('#auth-f button[type=submit]'); await p.waitForTimeout(200);
      assert.match(await p.textContent('#auth-msg'), /Sai email hoặc mật khẩu/);
      await p.fill('input[name=pw]', 'matkhau123'); await p.click('#auth-f button[type=submit]');
      await p.waitForSelector('text=Kênh nhận cảnh báo');
      assert.equal(await p.textContent('#tab-acc'), 'Tài khoản');
      const wl = await p.evaluate(() => window.__mockDB.watchlist.filter(w => w.user_id === 'u1').map(w => w.symbol).sort());
      assert.deepEqual(wl, ['FPT', 'TPB'], 'gộp danh mục local + server');
      assert.match(await p.textContent('#account'), /Danh mục theo dõi: 2 mã/);
      assert.match(await p.textContent('#account'), /BÁN VNM/);
      await shot(p, 'account');
      // Đổi cài đặt
      await p.locator('input[data-k=alert_setup]').check(); await p.waitForTimeout(100);
      assert.equal(await p.evaluate(() => window.__mockDB.profiles[0].alert_setup), true);
      // Kết nối Telegram (mock tự liên kết sau 1,5s, trang poll 3s)
      await p.click('#tg-link');
      await p.waitForSelector('#tg-step a[href*="t.me/LuotSongCKBot?start="]');
      await p.waitForSelector('text=Đã kết nối Telegram', { timeout: 8000 });
      await p.click('#tg-unlink'); await p.waitForSelector('#tg-link');
      // Bỏ theo dõi FPT → xoá trên server
      await p.goto(BASE + '#bo-loc'); await p.locator('[data-star="FPT"]').click(); await p.waitForTimeout(100);
      assert.deepEqual(await p.evaluate(() => window.__mockDB.watchlist.map(w => w.symbol)), ['TPB']);
      // Hiệu quả tín hiệu
      await p.goto(BASE + '#hieu-qua'); await p.waitForSelector('#perf table');
      assert.equal(await p.locator('#perf tbody tr').count(), 3);
      const perf = await p.textContent('#perf');
      assert.match(perf, /Chạm mục tiêu/); assert.match(perf, /Chạm cắt lỗ/); assert.match(perf, /Đang theo dõi/);
      await p.click('#perf-f button[data-v="MUA"]');
      assert.equal(await p.locator('#perf tbody tr').count(), 1);
      await p.click('#perf-f button[data-f="kind"][data-v=""]');
      await shot(p, 'perf');
      // Xem phiên cũ
      await p.goto(BASE + '#tin-hieu'); await p.waitForSelector('#day-sel');
      await Promise.all([p.waitForURL(/d=2026-11-10/), p.selectOption('#day-sel', '2026-11-10')]);
      await p.waitForSelector('.banner.old');
      assert.match(await p.textContent('#sub'), /10\/11\/2026/);
      assert.match(await p.textContent('#sub'), /20 cổ phiếu/);
      await shot(p, 'history');
      await p.click('.banner.old a'); await p.waitForTimeout(300);
      assert.match(await p.textContent('#sub'), /11\/11\/2026/);
      // Đăng xuất
      await p.goto(BASE + '#tai-khoan'); await p.waitForSelector('#acc-out'); await p.click('#acc-out');
      await p.waitForSelector('#auth-f'); assert.equal(await p.textContent('#tab-acc'), 'Đăng nhập');
      // Đăng ký email đã tồn tại
      await p.click('[data-m=up]'); await p.fill('input[name=email]', 'andy@example.vn');
      await p.fill('input[name=pw]', 'abcdefgh'); await p.fill('input[name=pw2]', 'abcdefgh'); await p.click('#auth-f button[type=submit]');
      await p.waitForTimeout(200); assert.match(await p.textContent('#auth-msg'), /đã được đăng ký/);
      assert.deepEqual(errors, []);
      console.log('✔ chế độ Supabase: đăng nhập, gộp & đồng bộ danh mục, cài đặt, Telegram, hiệu quả, phiên cũ, đăng xuất');
      await ctx.close();
    }
    // ---- 3. Điện thoại ----
    {
      const { p, errors, ctx } = await page(browser, { cloud: true, width: 390 });
      await p.goto(BASE + '#hieu-qua'); await p.waitForSelector('#perf table');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false, 'không cuộn ngang trên điện thoại');
      await shot(p, 'mobile');
      assert.deepEqual(errors, []);
      console.log('✔ điện thoại 390px');
      await ctx.close();
    }
    // ---- 4. Server thật (server.mjs) với dữ liệu trong phiên + báo có dữ liệu mới ----
    {
      const NPORT = 8767, NBASE = `http://localhost:${NPORT}/`, H = { Authorization: 'Bearer t0k3n' };
      const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lsck-'));
      const node = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: 'ignore',
        env: { ...process.env, PORT: String(NPORT), AUTO_UPDATE: '0', UPDATE_TOKEN: 't0k3n', DATA_DIR: tmp, ENGINE_FILE: path.join(__dirname, 'fake-engine.js') } });
      try {
        await new Promise(r => setTimeout(r, 1200));
        const live = await (await fetch(NBASE + 'admin/update?mode=live', { method: 'POST', headers: H })).json();
        assert.equal(live.live, true);
        const { p, errors, ctx } = await page(browser, { cloud: false });
        await p.goto(NBASE + '#tin-hieu'); await p.waitForSelector('.banner.live');
        assert.match(await p.textContent('.banner.live'), /Dữ liệu trong phiên, cập nhật lúc \d\d:\d\d/);
        assert.match(await p.textContent('#kpis'), /tạm tính trong phiên/);
        await shot(p, 'live');
        assert.equal(await p.locator('.newdata').count(), 0);
        await new Promise(r => setTimeout(r, 1100)); // gen khác nhau
        await fetch(NBASE + 'admin/update', { method: 'POST', headers: H }); // bản chốt
        await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await p.waitForSelector('.newdata');
        assert.match(await p.textContent('.newdata'), /Đã có dữ liệu mới lúc/);
        await Promise.all([p.waitForNavigation(), p.click('.newdata button')]);
        await p.waitForSelector('#setup .sig');
        assert.equal(await p.locator('.banner.live').count(), 0, 'bản chốt không còn banner tạm tính');
        assert.deepEqual(errors, []);
        console.log('✔ server thật: banner tạm tính, báo dữ liệu mới, tải lại ra bản chốt');
        await ctx.close();
      } finally { node.kill(); }
    }
  } finally { await browser.close(); srv.kill(); }
})().catch(e => { console.error(e); process.exit(1); });
