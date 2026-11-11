// Tính năng dùng Supabase: đăng nhập, đồng bộ danh mục theo dõi, xem phiên cũ,
// hiệu quả tín hiệu, cài đặt cảnh báo (email / Telegram).
// Nếu chưa cấu hình (config.js trống) hoặc không tải được thư viện, Cloud.enabled = false và trang chạy ở chế độ tĩnh.
window.Cloud = (() => {
  const cfg = window.LSCK_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase?.createClient);
  const sb = enabled ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (x, d = 2) => (x == null || !isFinite(x) ? '—' : Number(x).toLocaleString('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pc = (x, d = 2) => (x == null ? '—' : `<span class="${x > 0 ? 'up' : x < 0 ? 'dn' : ''}">${x > 0 ? '+' : ''}${fmt(x, d)}%</span>`);
  const dmy = d => (d ? d.split('-').reverse().join('/') : '—');
  const pageUrl = hash => location.origin + location.pathname + (hash || '');

  let user = null, profile = null, recovery = false, wlBinding = null, tgPoll = null;
  let ctx = { asof: null, latest: null };

  // ---------- Thông báo nhỏ ----------
  function toast(msg, bad) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.append(t); }
    t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = 'toast'), 3500);
  }
  const viErr = e => {
    const m = e?.message || String(e);
    if (/Invalid login credentials/i.test(m)) return 'Sai email hoặc mật khẩu.';
    if (/Email not confirmed/i.test(m)) return 'Email chưa được xác nhận. Hãy bấm link trong email đăng ký.';
    if (/already registered|already been registered/i.test(m)) return 'Email này đã được đăng ký. Hãy đăng nhập.';
    if (/Password should be at least/i.test(m)) return 'Mật khẩu quá ngắn.';
    if (/rate limit|too many/i.test(m)) return 'Thao tác quá nhiều lần, vui lòng thử lại sau ít phút.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Không kết nối được máy chủ. Kiểm tra mạng và thử lại.';
    return m;
  };

  // ---------- Dữ liệu ----------
  async function loadSnapshot(date) {
    const { data, error } = await sb.from('snapshots').select('data').eq('date', date).maybeSingle();
    if (error) throw error;
    return data?.data || null;
  }
  async function listDates() {
    const { data, error } = await sb.from('snapshots').select('date').order('date', { ascending: false }).limit(250);
    if (error) throw error;
    return data.map(x => x.date);
  }

  // ---------- Danh mục theo dõi ----------
  // main() gọi bindWatchlist({ get, set }) để Cloud đọc/ghi danh mục trên trang.
  function bindWatchlist(b) { wlBinding = b; if (user) syncWatchlist(); }
  async function syncWatchlist() {
    if (!user || !wlBinding) return;
    const { data, error } = await sb.from('watchlist').select('symbol').order('added_at');
    if (error) return toast('Không tải được danh mục: ' + viErr(error), true);
    const remote = data.map(x => x.symbol), local = wlBinding.get();
    const missing = local.filter(s => !remote.includes(s));
    if (missing.length) {
      const { error: e2 } = await sb.from('watchlist').upsert(missing.map(symbol => ({ symbol })), { onConflict: 'user_id,symbol', ignoreDuplicates: true });
      if (e2) toast('Không đồng bộ được danh mục: ' + viErr(e2), true);
    }
    wlBinding.set([...remote, ...missing]);
    if (location.hash === '#tai-khoan') renderAccount();
  }
  async function setWatch(symbol, on) {
    if (!user) return;
    const q = on ? sb.from('watchlist').upsert({ symbol }, { onConflict: 'user_id,symbol', ignoreDuplicates: true })
                 : sb.from('watchlist').delete().eq('symbol', symbol);
    const { error } = await q;
    if (error) toast('Chưa lưu được danh mục: ' + viErr(error), true);
  }

  // ---------- Xem phiên cũ ----------
  async function renderDayPicker() {
    const el = $('#dayline'); if (!el) return;
    let dates = [];
    try { dates = await listDates(); } catch (e) { return; }
    if (!dates.includes(ctx.latest)) dates.unshift(ctx.latest);
    if (dates.length < 2) { el.innerHTML = ''; return; }
    el.innerHTML = `<label class="day">Xem phiên <select id="day-sel" aria-label="Chọn phiên">${dates.map(d =>
      `<option value="${esc(d)}" ${d === ctx.asof ? 'selected' : ''}>${dmy(d)}${d === ctx.latest ? ' (mới nhất)' : ''}</option>`).join('')}</select></label>`;
    $('#day-sel').onchange = e => {
      const d = e.target.value, u = new URL(location.href);
      if (d === ctx.latest) u.searchParams.delete('d'); else u.searchParams.set('d', d);
      location.href = u.toString();
    };
  }

  // ---------- Hiệu quả tín hiệu ----------
  let trades = null, perfFilter = { kind: '', status: '' };
  function summarize(list) {
    const closed = list.filter(t => t.status !== 'open'), wins = closed.filter(t => +t.ret_pct > 0);
    const avg = closed.length ? closed.reduce((s, t) => s + +t.ret_pct, 0) / closed.length : null;
    const openAvg = list.filter(t => t.status === 'open');
    return {
      closed: closed.length, open: openAvg.length, win: closed.length ? wins.length / closed.length * 100 : null, avg,
      openAvg: openAvg.length ? openAvg.reduce((s, t) => s + +t.ret_pct, 0) / openAvg.length : null,
    };
  }
  const ST = { open: ['Đang theo dõi', 'b-THEO'], target: ['Chạm mục tiêu', 'b-MUA'], stop: ['Chạm cắt lỗ', 'b-BÁN'], expired: ['Hết 10 phiên', 'b-TRUNG'] };
  async function renderPerf() {
    const el = $('#perf'); if (!el) return;
    if (!enabled) { el.innerHTML = '<p class="muted">Tính năng này cần cấu hình Supabase (xem README).</p>'; return; }
    if (!trades) {
      el.innerHTML = '<p class="muted">Đang tải…</p>';
      const { data, error } = await sb.from('trades').select('*').order('signal_date', { ascending: false }).order('symbol').limit(2000);
      if (error) { el.innerHTML = `<p class="dn">Không tải được dữ liệu: ${esc(viErr(error))}</p>`; return; }
      trades = data;
    }
    if (!trades.length) { el.innerHTML = '<p class="muted">Chưa có tín hiệu nào được ghi nhận. Hệ thống bắt đầu theo dõi từ phiên đầu tiên sau khi kết nối Supabase.</p>'; return; }
    const card = (title, list, note) => { const s = summarize(list); return `<div class="card"><div class="k-label">${title}</div>
      <div class="k-val">${s.win == null ? '—' : fmt(s.win, 0) + '%'}</div>
      <div class="k-note">thắng · ${s.closed} lệnh đã đóng · TB ${s.avg == null ? '—' : pc(s.avg)}</div>
      <div class="k-note">${s.open} đang theo dõi${s.open ? ` · tạm tính ${pc(s.openAvg)}` : ''}${note ? ' · ' + note : ''}</div></div>`; };
    const list = trades.filter(t => (!perfFilter.kind || t.kind === perfFilter.kind) && (!perfFilter.status || (perfFilter.status === 'closed' ? t.status !== 'open' : t.status === perfFilter.status)));
    const btn = (k, v, t) => `<button data-f="${k}" data-v="${v}" class="${perfFilter[k] === v ? 'on' : ''}">${t}</button>`;
    el.innerHTML = `<div class="grid perf-kpis">
        ${card('Tín hiệu MUA', trades.filter(t => t.kind === 'MUA'))}
        ${card('Setup chờ xác nhận', trades.filter(t => t.kind === 'CHỜ'), 'mua dù thị trường yếu')}
        ${card('Tất cả', trades)}</div>
      <p class="count">Mỗi tín hiệu được tính như một lệnh mua ở giá đóng cửa phiên phát tín hiệu, thoát khi chạm cắt lỗ / mục tiêu hoặc sau 10 phiên, phí 0,3%. Cùng phiên chạm cả hai mức thì tính cắt lỗ.</p>
      <div class="presets" id="perf-f">${btn('kind', '', 'Mọi loại')}${btn('kind', 'MUA', 'MUA')}${btn('kind', 'CHỜ', 'Chờ xác nhận')}
        <span style="width:12px"></span>${btn('status', '', 'Mọi trạng thái')}${btn('status', 'open', 'Đang theo dõi')}${btn('status', 'closed', 'Đã đóng')}</div>
      <div class="tbl-wrap"><table><thead><tr><th class="l">Ngày</th><th class="l">Mã</th><th class="l">Loại</th><th>Giá vào</th><th>Cắt lỗ</th><th>Mục tiêu</th>
        <th class="l">Trạng thái</th><th>Phiên</th><th>Giá hiện tại / thoát</th><th>Lãi/lỗ</th><th>Cao nhất</th><th>Thấp nhất</th></tr></thead>
      <tbody>${list.map(t => `<tr data-s="${esc(t.symbol)}"><td class="l">${dmy(t.signal_date)}</td><td class="l"><b>${esc(t.symbol)}</b></td><td class="l">${esc(t.kind)}</td>
        <td>${fmt(t.entry)}</td><td>${fmt(t.stop)}</td><td>${fmt(t.target)}</td>
        <td class="l"><span class="badge ${ST[t.status]?.[1] || ''}">${ST[t.status]?.[0] || esc(t.status)}</span>${t.exit_date ? ` <span class="muted">${dmy(t.exit_date)}</span>` : ''}</td>
        <td>${t.sessions}</td><td>${fmt(t.exit_price ?? t.last_price)}</td><td>${pc(t.ret_pct == null ? null : +t.ret_pct)}</td>
        <td>${pc(t.max_ret_pct == null ? null : +t.max_ret_pct, 1)}</td><td>${pc(t.min_ret_pct == null ? null : +t.min_ret_pct, 1)}</td></tr>`).join('')}</tbody></table></div>
      <p class="count">${list.length} tín hiệu</p>`;
    $('#perf-f').onclick = e => { const b = e.target.closest('button'); if (!b) return; perfFilter[b.dataset.f] = b.dataset.v; renderPerf(); };
    el.querySelector('tbody').onclick = e => { const tr = e.target.closest('tr[data-s]'); if (tr && window.openDrawer) window.openDrawer(tr.dataset.s); };
  }

  // ---------- Tài khoản ----------
  let authMode = 'in';
  function renderAuthForm(el) {
    const t = (m, l) => `<button data-m="${m}" class="${authMode === m ? 'on' : ''}">${l}</button>`;
    el.innerHTML = `<div class="card acc">
      <div class="presets">${t('in', 'Đăng nhập')}${t('up', 'Đăng ký')}${t('forgot', 'Quên mật khẩu')}</div>
      <p class="muted">${authMode === 'up' ? 'Tạo tài khoản để đồng bộ danh mục theo dõi giữa các thiết bị và nhận cảnh báo qua email / Telegram.'
        : authMode === 'forgot' ? 'Nhập email đã đăng ký, chúng tôi sẽ gửi link đặt lại mật khẩu.' : 'Đăng nhập để đồng bộ danh mục theo dõi và nhận cảnh báo.'}</p>
      <form id="auth-f" class="form">
        <label>Email<input type="email" name="email" autocomplete="email" required></label>
        ${authMode !== 'forgot' ? `<label>Mật khẩu<input type="password" name="pw" minlength="8" autocomplete="${authMode === 'up' ? 'new-password' : 'current-password'}" required></label>` : ''}
        ${authMode === 'up' ? '<label>Nhập lại mật khẩu<input type="password" name="pw2" minlength="8" autocomplete="new-password" required></label>' : ''}
        <button class="btn primary" type="submit">${authMode === 'up' ? 'Tạo tài khoản' : authMode === 'forgot' ? 'Gửi link đặt lại' : 'Đăng nhập'}</button>
        <p class="form-msg" id="auth-msg" role="status"></p>
      </form></div>`;
    el.querySelector('.presets').onclick = e => { const b = e.target.closest('button'); if (b) { authMode = b.dataset.m; renderAccount(); } };
    $('#auth-f').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target), email = f.get('email').trim(), pw = f.get('pw'), msg = $('#auth-msg');
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; msg.className = 'form-msg'; msg.textContent = 'Đang xử lý…';
      try {
        if (authMode === 'up') {
          if (pw !== f.get('pw2')) throw new Error('Hai mật khẩu không khớp.');
          const { data, error } = await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: pageUrl('#tai-khoan') } });
          if (error) throw error;
          if (data.user && Array.isArray(data.user.identities) && !data.user.identities.length) throw new Error('Email này đã được đăng ký. Hãy đăng nhập.');
          msg.textContent = data.session ? 'Đã tạo tài khoản.' : 'Đã gửi email xác nhận. Hãy mở email và bấm link để kích hoạt tài khoản.';
        } else if (authMode === 'forgot') {
          const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: pageUrl('#tai-khoan') });
          if (error) throw error;
          msg.textContent = 'Nếu email đã đăng ký, bạn sẽ nhận được link đặt lại mật khẩu trong vài phút.';
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password: pw });
          if (error) throw error;
          msg.textContent = '';
        }
      } catch (err) { msg.className = 'form-msg bad'; msg.textContent = viErr(err); }
      finally { btn.disabled = false; }
    };
  }

  function renderRecovery(el) {
    el.innerHTML = `<div class="card acc"><h2>Đặt mật khẩu mới</h2>
      <form id="rec-f" class="form"><label>Mật khẩu mới<input type="password" name="pw" minlength="8" autocomplete="new-password" required></label>
      <label>Nhập lại<input type="password" name="pw2" minlength="8" autocomplete="new-password" required></label>
      <button class="btn primary" type="submit">Lưu mật khẩu</button><p class="form-msg" id="rec-msg" role="status"></p></form></div>`;
    $('#rec-f').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target), msg = $('#rec-msg');
      if (f.get('pw') !== f.get('pw2')) { msg.className = 'form-msg bad'; msg.textContent = 'Hai mật khẩu không khớp.'; return; }
      const { error } = await sb.auth.updateUser({ password: f.get('pw') });
      if (error) { msg.className = 'form-msg bad'; msg.textContent = viErr(error); return; }
      recovery = false; toast('Đã đổi mật khẩu.'); renderAccount();
    };
  }

  async function loadProfile() {
    const { data, error } = await sb.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    profile = data;
  }

  const PREFS = [
    ['alert_buy', 'Mã trong danh mục có tín hiệu MUA'],
    ['alert_sell', 'Mã trong danh mục chuyển sang BÁN / CHỐT LỜI'],
    ['alert_levels', 'Tín hiệu đang theo dõi chạm cắt lỗ / mục tiêu'],
    ['alert_setup', 'Xuất hiện setup mua chờ thị trường xác nhận'],
    ['alert_market', 'VN-Index vượt lên / thủng MA50 (không phụ thuộc danh mục)'],
  ];
  async function renderSignedIn(el) {
    if (!profile) { try { await loadProfile(); } catch (e) { el.innerHTML = `<p class="dn">${esc(viErr(e))}</p>`; return; } }
    if (!profile) { el.innerHTML = '<p class="muted">Đang khởi tạo hồ sơ… tải lại trang sau vài giây.</p>'; return; }
    const p = profile, wl = wlBinding ? wlBinding.get() : [];
    const tgLinked = !!p.telegram_chat_id;
    const chk = (k, label, off = false) => `<label class="chk"><input type="checkbox" data-k="${k}" ${p[k] && !off ? 'checked' : ''} ${off ? 'disabled' : ''}> ${label}</label>`;
    const { data: logs } = await sb.from('alert_log').select('date,channels,body').order('date', { ascending: false }).limit(10);
    el.innerHTML = `<div class="grid acc-grid">
      <div class="card acc"><h2>Tài khoản</h2>
        <p>${esc(user.email)}</p>
        <p class="muted">Danh mục theo dõi: <b>${wl.length}</b> mã, đồng bộ trên mọi thiết bị đăng nhập tài khoản này.${wl.length ? '' : ' Bấm ★ ở bảng Bộ lọc để thêm.'}</p>
        <div class="row"><button class="btn" id="acc-pw">Đổi mật khẩu</button><button class="btn" id="acc-out">Đăng xuất</button></div>
      </div>
      <div class="card acc"><h2>Kênh nhận cảnh báo</h2>
        ${chk('notify_email', `Email (${esc(p.email || user.email)})`)}
        ${chk('notify_telegram', tgLinked ? 'Telegram' : 'Telegram <span class="muted">(kết nối bên dưới để bật)</span>', !tgLinked)}
        <div class="tg">${tgLinked
          ? `<span class="badge b-MUA">Đã kết nối Telegram</span> <button class="btn sm" id="tg-unlink">Huỷ kết nối</button>`
          : cfg.telegramBot ? `<button class="btn" id="tg-link">Kết nối Telegram</button><div id="tg-step"></div>` : '<span class="muted">Telegram chưa được cấu hình trên trang này.</span>'}</div>
        <p class="muted">Cảnh báo gửi khoảng 15:50 mỗi ngày giao dịch, chỉ khi có sự kiện mới.</p>
      </div>
      <div class="card acc"><h2>Loại cảnh báo</h2>${PREFS.map(([k, l]) => chk(k, l)).join('')}</div>
      <div class="card acc"><h2>Cảnh báo gần đây</h2>${logs?.length ? `<ul class="logs">${logs.map(l => `<li><b>${dmy(l.date)}</b> <span class="muted">${esc((l.channels || []).join(', '))}</span><div class="muted">${esc((l.body || '').replace(/<[^>]+>/g, '')).split('\n').filter(x => x && !/^https?:|khuyến nghị đầu tư/.test(x)).slice(1).join('<br>')}</div></li>`).join('')}</ul>` : '<p class="muted">Chưa có cảnh báo nào.</p>'}</div>
    </div>`;
    el.querySelectorAll('input[data-k]').forEach(i => i.onchange = async () => {
      const k = i.dataset.k, v = i.checked;
      const { error } = await sb.from('profiles').update({ [k]: v }).eq('user_id', user.id);
      if (error) { i.checked = !v; toast('Chưa lưu được: ' + viErr(error), true); } else { profile[k] = v; toast('Đã lưu cài đặt.'); }
    });
    $('#acc-out').onclick = () => sb.auth.signOut();
    $('#acc-pw').onclick = () => { recovery = true; renderAccount(); };
    const unlink = $('#tg-unlink');
    if (unlink) unlink.onclick = async () => {
      const { error } = await sb.rpc('unlink_telegram');
      if (error) return toast(viErr(error), true);
      profile.telegram_chat_id = null; toast('Đã huỷ kết nối Telegram.'); renderAccount();
    };
    const link = $('#tg-link');
    if (link) link.onclick = async () => {
      link.disabled = true;
      const { data: code, error } = await sb.rpc('create_telegram_link');
      link.disabled = false;
      if (error) return toast(viErr(error), true);
      const url = `https://t.me/${encodeURIComponent(cfg.telegramBot)}?start=${encodeURIComponent(code)}`;
      $('#tg-step').innerHTML = `<p>1. Mở <a href="${esc(url)}" target="_blank" rel="noopener">@${esc(cfg.telegramBot)}</a> và bấm <b>Start</b>.<br>
        2. Trang sẽ tự cập nhật khi kết nối xong. Link hết hạn sau 15 phút.</p>`;
      window.open(url, '_blank', 'noopener');
      clearInterval(tgPoll);
      const until = Date.now() + 15 * 60e3;
      tgPoll = setInterval(async () => {
        if (Date.now() > until || location.hash !== '#tai-khoan' || !user) return clearInterval(tgPoll);
        const { data } = await sb.from('profiles').select('telegram_chat_id').eq('user_id', user.id).maybeSingle();
        if (data?.telegram_chat_id) { clearInterval(tgPoll); profile = null; toast('Đã kết nối Telegram.'); renderAccount(); }
      }, 3000);
    };
  }

  async function renderAccount() {
    const el = $('#account'); if (!el) return;
    if (!enabled) { el.innerHTML = '<p class="muted">Đăng nhập và cảnh báo cần cấu hình Supabase (xem README).</p>'; return; }
    if (recovery && user) return renderRecovery(el);
    if (!user) return renderAuthForm(el);
    return renderSignedIn(el);
  }

  function updateTab() {
    const a = $('#tab-acc'); if (!a) return;
    a.textContent = user ? 'Tài khoản' : 'Đăng nhập';
    a.title = user ? user.email : '';
  }

  // ---------- Khởi động ----------
  function init(c) {
    ctx = c;
    if (!enabled) { updateTab(); return; }
    renderDayPicker();
    sb.auth.onAuthStateChange((event, session) => {
      const prev = user?.id;
      user = session?.user || null;
      if (event === 'PASSWORD_RECOVERY') { recovery = true; if (location.hash !== '#tai-khoan') location.hash = '#tai-khoan'; }
      if (user?.id !== prev) { profile = null; clearInterval(tgPoll); }
      updateTab();
      // Không gọi Supabase trực tiếp trong callback (tránh deadlock) → đẩy sang lượt sau
      setTimeout(() => {
        if (user && user.id !== prev) {
          syncWatchlist();
          if (event === 'SIGNED_IN' && !location.hash) location.hash = '#tai-khoan';
        }
        if (location.hash === '#tai-khoan') renderAccount();
      }, 0);
    });
  }

  return { enabled, init, loadSnapshot, bindWatchlist, setWatch, renderPerf, renderAccount, refreshTrades: () => { trades = null; } };
})();
