// Xử lý tin nhắn Telegram: liên kết / huỷ liên kết tài khoản Lướt sóng CK.
// Tách riêng khỏi index.ts để kiểm thử được.

export interface Env {
  supabaseUrl: string;
  serviceKey: string;
  botToken: string;
  siteUrl?: string;
}

type Fetch = typeof fetch;

export async function handleUpdate(update: any, env: Env, f: Fetch = fetch): Promise<string | null> {
  const msg = update?.message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = (msg?.text || '').trim();
  if (!chatId || msg?.chat?.type !== 'private') return null;

  const rest = async (path: string, init: RequestInit = {}) => {
    const res = await f(`${env.supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: env.serviceKey,
        Authorization: `Bearer ${env.serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(init.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };

  let reply: string;
  const m = text.match(/^\/start(?:@\w+)?\s+([a-f0-9]{32})$/i);
  if (m) {
    const code = m[1].toLowerCase();
    const valid = await rest(
      `profiles?select=user_id&telegram_link_code=eq.${code}&telegram_link_expires=gt.${encodeURIComponent(new Date().toISOString())}`,
    );
    let rows: any[] = [];
    if (valid.length) {
      // Chat này chỉ gắn với 1 tài khoản: bỏ liên kết cũ (nếu có) rồi gắn vào tài khoản mới
      await rest(`profiles?telegram_chat_id=eq.${chatId}`, {
        method: 'PATCH', body: JSON.stringify({ telegram_chat_id: null }),
      });
      rows = await rest(`profiles?user_id=eq.${valid[0].user_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ telegram_chat_id: chatId, telegram_link_code: null, telegram_link_expires: null, notify_telegram: true }),
      });
    }
    reply = rows.length
      ? `✅ Đã kết nối với tài khoản ${rows[0].email}.\nBạn sẽ nhận cảnh báo sau mỗi phiên (~15:50) cho các mã trong danh mục theo dõi.\nGửi /stop để ngừng nhận.`
      : '⚠️ Mã liên kết không hợp lệ hoặc đã hết hạn (15 phút). Hãy bấm "Kết nối Telegram" lại trên trang.';
  } else if (/^\/stop\b/i.test(text)) {
    const rows = await rest(`profiles?telegram_chat_id=eq.${chatId}`, {
      method: 'PATCH', body: JSON.stringify({ telegram_chat_id: null }),
    });
    reply = rows.length ? '🔕 Đã ngừng gửi cảnh báo tới Telegram này.' : 'Telegram này chưa kết nối với tài khoản nào.';
  } else {
    reply = 'Bot cảnh báo Lướt sóng CK.\nĐể nhận cảnh báo: đăng nhập trang, vào "Tài khoản" → "Kết nối Telegram".'
      + (env.siteUrl ? `\n${env.siteUrl}#tai-khoan` : '') + '\n/stop – ngừng nhận cảnh báo';
  }

  await f(`https://api.telegram.org/bot${env.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: reply, disable_web_page_preview: true }),
  });
  return reply;
}
