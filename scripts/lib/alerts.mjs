// Tạo nội dung cảnh báo cho từng người dùng theo danh mục theo dõi.

const fmt = (x, d = 2) => (x == null ? '—' : Number(x).toLocaleString('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const sign = x => (x > 0 ? '+' : '');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rowsOf = D => (D ? D.r.map(r => Object.fromEntries(D.k.map((k, i) => [k, r[i]]))) : []);
const dmy = d => d.split('-').reverse().join('/');

/**
 * Sự kiện của phiên hôm nay so với phiên trước.
 * @param D      window.DATA hôm nay
 * @param prevD  window.DATA phiên trước (có thể null)
 * @param closed các lệnh trong bảng trades vừa đóng trong phiên hôm nay
 * @returns { bySymbol: Map<symbol, Array<{type,text}>>, market: {type,text}|null }
 */
export function buildEvents(D, prevD, closed = []) {
  const today = rowsOf(D), prev = new Map(rowsOf(prevD).map(r => [r.s, r]));
  const bySymbol = new Map();
  const add = (s, e) => { if (!bySymbol.has(s)) bySymbol.set(s, []); bySymbol.get(s).push(e); };
  for (const r of today) {
    if (r.stale) continue;
    const p = prev.get(r.s), was = p?.rec, hadSetup = (p?.fl || '').split(' ').includes('MKW');
    const setup = (r.fl || '').split(' ').includes('MKW');
    const lv = `vùng mua ${fmt(r.en)}–${fmt(r.p)}, cắt lỗ ${fmt(r.sl)}, mục tiêu ${fmt(r.tp)}`;
    if (r.rec === 'MUA' && was !== 'MUA')
      add(r.s, { type: 'buy', text: `▲ MUA ${r.s} ${fmt(r.p)} (${sign(r.d1)}${fmt(r.d1, 1)}%): ${lv}` });
    else if ((r.rec === 'BÁN' || r.rec === 'CHỐT LỜI') && was !== r.rec)
      add(r.s, { type: 'sell', text: `${r.rec === 'BÁN' ? '▼ BÁN' : '◆ CHỐT LỜI'} ${r.s} ${fmt(r.p)} (${sign(r.d1)}${fmt(r.d1, 1)}%)` });
    if (setup && !hadSetup)
      add(r.s, { type: 'setup', text: `● ${r.s} có setup mua, chờ thị trường xác nhận: ${lv}` });
  }
  for (const t of closed) {
    if (t.status === 'target') add(t.symbol, { type: 'levels', text: `✔ ${t.symbol} chạm mục tiêu ${fmt(t.target)} (tín hiệu ${t.kind} ngày ${dmy(t.signal_date)}, ${sign(t.ret_pct)}${fmt(t.ret_pct)}%)` });
    else if (t.status === 'stop') add(t.symbol, { type: 'levels', text: `✖ ${t.symbol} chạm cắt lỗ ${fmt(t.stop)} (tín hiệu ${t.kind} ngày ${dmy(t.signal_date)}, ${fmt(t.ret_pct)}%)` });
  }
  let market = null;
  if (prevD && prevD.vni.ok !== D.vni.ok)
    market = D.vni.ok
      ? { type: 'market', text: `VN-Index ${fmt(D.vni.p)} vượt lên trên MA50 – tín hiệu MUA được kích hoạt lại.` }
      : { type: 'market', text: `VN-Index ${fmt(D.vni.p)} thủng MA50 – tạm dừng tín hiệu MUA mới.` };
  return { bySymbol, market };
}

const PREF = { buy: 'alert_buy', sell: 'alert_sell', setup: 'alert_setup', levels: 'alert_levels', market: 'alert_market' };

/**
 * Nội dung cảnh báo cho 1 người dùng, hoặc null nếu không có gì đáng báo.
 */
export function composeForUser(profile, symbols, events, D, siteUrl = '') {
  const lines = [];
  for (const s of [...new Set(symbols)].sort()) for (const e of events.bySymbol.get(s) || []) if (profile[PREF[e.type]]) lines.push(e.text);
  if (events.market && profile.alert_market) lines.unshift(events.market.text);
  if (!lines.length) return null;
  const title = `Lướt sóng CK – phiên ${dmy(D.asof)}`;
  const foot = 'Công cụ sàng lọc tham khảo, không phải khuyến nghị đầu tư.';
  const text = `<b>${esc(title)}</b>\n\n${lines.map(esc).join('\n')}\n\n${siteUrl ? `${esc(siteUrl)}\n` : ''}<i>${esc(foot)}</i>`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111">
<h2 style="font-size:17px;margin:0 0 12px">${esc(title)}</h2>
<ul style="padding-left:18px;margin:0 0 12px">${lines.map(l => `<li style="margin:4px 0">${esc(l)}</li>`).join('')}</ul>
${siteUrl ? `<p><a href="${esc(siteUrl)}">Mở dashboard</a> · <a href="${esc(siteUrl)}#tai-khoan">Cài đặt cảnh báo</a></p>` : ''}
<p style="color:#777;font-size:12px">${esc(foot)}</p></div>`;
  return { subject: `${title}: ${lines.length} cảnh báo`, text, html, count: lines.length };
}
