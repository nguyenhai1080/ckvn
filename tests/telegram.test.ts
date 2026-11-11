import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate } from '../supabase/functions/telegram-webhook/handler.ts';

const CODE = 'a'.repeat(32);
function setup(profiles: any[]) {
  const sent: any[] = [];
  const f = async (url: string, init: any = {}) => {
    if (url.startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(init.body)); return new Response('{}'); }
    const u = new URL(url), q = u.searchParams;
    let rows = profiles.filter(p => [...q.entries()].every(([k, v]) => {
      if (k === 'select') return true;
      const [op, ...r] = v.split('.'); const val = r.join('.');
      return op === 'eq' ? String(p[k]) === val : op === 'gt' ? p[k] != null && p[k] > val : true;
    }));
    if (init.method === 'PATCH') { const b = JSON.parse(init.body); rows.forEach(p => Object.assign(p, b)); }
    return new Response(JSON.stringify(rows));
  };
  return { f: f as any, sent };
}
const env = { supabaseUrl: 'https://sb.test', serviceKey: 'k', botToken: 'T', siteUrl: 'https://x.vn/' };
const msg = (text: string, id = 555, type = 'private') => ({ message: { chat: { id, type }, text } });
const future = new Date(Date.now() + 600e3).toISOString(), past = new Date(Date.now() - 1e3).toISOString();

test('/start với mã hợp lệ → liên kết, xoá mã', async () => {
  const P = [{ user_id: 'u1', email: 'a@x.vn', telegram_link_code: CODE, telegram_link_expires: future, telegram_chat_id: null }];
  const { f, sent } = setup(P);
  const r = await handleUpdate(msg(`/start ${CODE}`), env, f);
  assert.match(r!, /Đã kết nối với tài khoản a@x.vn/);
  assert.equal(P[0].telegram_chat_id, 555); assert.equal(P[0].telegram_link_code, null);
  assert.equal(sent[0].chat_id, 555);
});

test('mã hết hạn → từ chối, KHÔNG gỡ liên kết hiện có', async () => {
  const P = [
    { user_id: 'u1', email: 'a@x.vn', telegram_chat_id: 555 },
    { user_id: 'u2', email: 'b@x.vn', telegram_link_code: CODE, telegram_link_expires: past, telegram_chat_id: null },
  ];
  const { f } = setup(P);
  const r = await handleUpdate(msg(`/start ${CODE}`), env, f);
  assert.match(r!, /không hợp lệ hoặc đã hết hạn/);
  assert.equal(P[0].telegram_chat_id, 555); assert.equal(P[1].telegram_chat_id, null);
});

test('chuyển chat sang tài khoản khác', async () => {
  const P = [
    { user_id: 'u1', email: 'a@x.vn', telegram_chat_id: 555 },
    { user_id: 'u2', email: 'b@x.vn', telegram_link_code: CODE, telegram_link_expires: future, telegram_chat_id: null },
  ];
  const { f } = setup(P);
  await handleUpdate(msg(`/start ${CODE}`), env, f);
  assert.equal(P[0].telegram_chat_id, null); assert.equal(P[1].telegram_chat_id, 555);
});

test('/stop gỡ liên kết; tin nhắn khác → hướng dẫn; nhóm → bỏ qua', async () => {
  const P = [{ user_id: 'u1', email: 'a@x.vn', telegram_chat_id: 555 }];
  const { f, sent } = setup(P);
  assert.match((await handleUpdate(msg('/stop'), env, f))!, /Đã ngừng/);
  assert.equal(P[0].telegram_chat_id, null);
  assert.match((await handleUpdate(msg('chào'), env, f))!, /x\.vn\/#tai-khoan/);
  assert.equal(await handleUpdate(msg('/stop', 9, 'group'), env, f), null);
  assert.equal(sent.length, 2);
});

test('mã sai định dạng không chạm DB', async () => {
  const P = [{ user_id: 'u1', email: 'a@x.vn', telegram_chat_id: 1 }];
  const { f } = setup(P);
  const r = await handleUpdate(msg("/start x' or 1=1"), env, f);
  assert.match(r!, /Bot cảnh báo/);
});
