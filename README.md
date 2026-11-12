# Lướt sóng CK

Bộ lọc và tín hiệu lướt sóng ngắn hạn cho cổ phiếu Việt Nam (HOSE/HNX/UPCoM, GTGD TB 20 phiên ≥ 10 tỷ).

- **Trang tĩnh** (deploy lên VibeHost): tín hiệu hôm nay, bộ lọc, danh mục theo dõi, phương pháp.
- **Supabase** (tuỳ chọn, gói miễn phí đủ dùng) thêm:
  - Đăng nhập email + mật khẩu, đồng bộ danh mục theo dõi giữa các thiết bị
  - Xem lại tín hiệu của các phiên trước (chọn ngày ở đầu trang)
  - Tab **Hiệu quả tín hiệu**: theo dõi thực tế từng tín hiệu MUA / setup chờ xác nhận đến khi chạm cắt lỗ, mục tiêu hoặc hết 10 phiên
  - Cảnh báo sau phiên (~15:50) qua **email** và **Telegram** cho các mã trong danh mục của từng người

Chưa cấu hình Supabase thì trang vẫn chạy bình thường ở chế độ tĩnh.

## Cấu trúc

| File | Vai trò |
|---|---|
| `index.html`, `cloud.js`, `config.js` | Giao diện; `cloud.js` chứa các tính năng Supabase; `config.js` chứa URL + anon key công khai |
| `server.mjs` | Server cho VibeHost: phục vụ trang + **tự cập nhật dữ liệu lúc 15:45** (thứ 2–6) và đồng bộ Supabase |
| `data.js` | Dữ liệu ban đầu khi khởi động; sau đó server phục vụ dữ liệu mới từ bộ nhớ |
| `engine.js` | Lấy dữ liệu VNDirect + tính chỉ báo, tín hiệu, backtest |
| `scripts/lib/update.mjs` | Chạy `engine.js` trong Node + lịch chạy (dùng chung cho server và CLI) |
| `scripts/update-data.mjs` | Chạy tay: lấy dữ liệu, ghi `data.js` |
| `scripts/sync-supabase.mjs` | Lưu phiên vào Supabase, cập nhật hiệu quả tín hiệu, gửi cảnh báo |
| `supabase/schema.sql` | Bảng, bảo mật theo dòng (RLS), hàm liên kết Telegram |
| `supabase/functions/telegram-webhook/` | Edge Function nhận lệnh `/start`, `/stop` từ bot Telegram |
| `.github/workflows/update-data.yml` | Kiểm thử khi đẩy code; chạy tay cập nhật dữ liệu khi cần dự phòng |
| `tests/` | Kiểm thử logic, đồng bộ, webhook, giao diện |

## Cài đặt từng bước

### 1. GitHub + VibeHost (trang tĩnh)

```bash
gh repo create luot-song-ck --public --source . --push
```

VibeHost: chọn repo, nhánh `main`. VibeHost nhận diện đây là app Node và chạy `npm start` → `server.mjs`
(không cần thư viện, nghe cổng `PORT`, health check ở `/healthz`). Không có lệnh build. Nhớ bật chế độ công khai.
**Phải chạy ở chế độ Node (không chọn "Static site")** vì server tự cập nhật dữ liệu mỗi ngày.

Server tự lấy dữ liệu VNDirect, thứ 2–6, giờ VN:
- **Trong phiên** (9:15–11:35 và 13:05–14:55): mỗi 10 phút (`INTRADAY_MINUTES`) → dữ liệu **tạm tính**; khối lượng hôm nay được ước tính
  cho cả phiên theo thời gian đã giao dịch. Bản tạm tính không lưu lịch sử, không gửi cảnh báo. Trang đang mở sẽ hiện nút "Tải lại" khi có dữ liệu mới.
- **15:45**: bản **chốt** của phiên (thử lại mỗi 20 phút đến 18:00) → lưu Supabase, cập nhật hiệu quả tín hiệu, gửi cảnh báo.
- Ngày nghỉ: 10:00 (hoặc 16:30) vẫn chưa có nến hôm nay → ngừng cập nhật hôm đó.
- Chạy bù ngay sau mỗi lần khởi động / deploy. Xem tình trạng tại `SITE_URL/status`.

Mỗi lần chạy ~160 request tới api-finfo trong ~45 giây; 10 phút/lần ≈ 25 lần/ngày.
Ghi lại địa chỉ trang, VD `https://luot-song-ck.vibehost.app/` (dùng ở các bước sau, gọi là `SITE_URL`).

### 2. Supabase

1. Tạo project tại supabase.com (chọn region Singapore cho gần Việt Nam).
2. **SQL Editor** → dán toàn bộ `supabase/schema.sql` → Run.
3. **Authentication → URL Configuration**: Site URL = `SITE_URL`; thêm `SITE_URL` vào Redirect URLs.
4. **Authentication → Providers → Email**: bật Email, giữ "Confirm email".
5. **Project Settings → API**: copy `Project URL`, `anon public` key, `service_role` key.
6. Sửa `config.js`: điền `supabaseUrl`, `supabaseAnonKey` (anon key được phép công khai). Commit + push.

> Email xác nhận / quên mật khẩu mặc định của Supabase chỉ gửi được vài email mỗi giờ. Khi có người dùng thật,
> vào **Authentication → SMTP Settings** và dùng SMTP của Resend (bước 3) để gửi không giới hạn.

### 3. Email cảnh báo (Resend)

1. Tạo tài khoản resend.com, thêm và xác minh tên miền của bạn (bản ghi DNS).
2. Tạo API key.
3. `RESEND_FROM` dạng `Lướt sóng CK <canhbao@ten-mien-cua-ban.vn>`.

### 4. Telegram

1. Chat với **@BotFather** → `/newbot` → lấy token, VD bot `LuotSongCKBot`.
2. Điền `telegramBot: 'LuotSongCKBot'` trong `config.js`.
3. Deploy webhook (cần Supabase CLI):
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase secrets set TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<chuỗi ngẫu nhiên> SITE_URL=<SITE_URL>
   supabase functions deploy telegram-webhook --no-verify-jwt
   curl "https://api.telegram.org/bot<token>/setWebhook" \
     -d "url=https://<project-ref>.supabase.co/functions/v1/telegram-webhook" \
     -d "secret_token=<chuỗi ngẫu nhiên>" -d 'allowed_updates=["message"]'
   ```

### 5. Biến môi trường trên VibeHost

Trong cài đặt dự án VibeHost (Environment variables), thêm:

| Tên | Giá trị |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (**tuyệt đối không đưa vào config.js**) |
| `TELEGRAM_BOT_TOKEN` | token bot |
| `RESEND_API_KEY` | API key Resend |
| `RESEND_FROM` | VD `Lướt sóng CK <canhbao@ten-mien.vn>` |
| `SITE_URL` | địa chỉ trang |
| `UPDATE_TOKEN` | (tuỳ chọn) chuỗi ngẫu nhiên dài, để chạy tay: `curl -X POST -H "Authorization: Bearer <token>" SITE_URL/admin/update` (thêm `?mode=live` để chạy bản tạm tính) |
| `AUTO_UPDATE` | (tuỳ chọn) `0` để tắt mọi tự cập nhật |
| `INTRADAY_MINUTES` | (tuỳ chọn) chu kỳ cập nhật trong phiên, mặc định `10`, tối thiểu `5`; `0` = chỉ cập nhật bản chốt 15:45 |

Sau khi lưu biến, deploy lại: server chạy bù ngay khi khởi động và tạo phiên đầu tiên trong Supabase.

### 6. (Tuỳ chọn) GitHub Secrets cho workflow dự phòng

Chỉ cần nếu muốn chạy tay workflow trên GitHub. Repo → **Settings → Secrets and variables → Actions**:

| Loại | Tên | Giá trị |
|---|---|---|
| Secret | `SUPABASE_URL` | Project URL |
| Secret | `SUPABASE_SERVICE_ROLE_KEY` | service_role key (**tuyệt đối không đưa vào config.js**) |
| Secret | `TELEGRAM_BOT_TOKEN` | token bot |
| Secret | `RESEND_API_KEY` | API key Resend |
| Secret | `RESEND_FROM` | VD `Lướt sóng CK <canhbao@ten-mien.vn>` |
| Variable | `SITE_URL` | địa chỉ trang |

Chạy: **Actions → Cập nhật dữ liệu (dự phòng, chạy tay) → Run workflow**. Lưu ý VNDirect có thể chặn máy chủ GitHub (ở Mỹ).

## Cách hoạt động mỗi ngày

1. Trong phiên, `server.mjs` chạy `engine.js` mỗi 10 phút (tạm tính); 15:45 chạy bản chốt → thay dữ liệu đang phục vụ ngay (không cần deploy lại).
2. Nếu có biến Supabase, server chạy `sync-supabase.mjs`:
   - lưu phiên vào bảng `snapshots` (cho tính năng xem phiên cũ)
   - cập nhật các lệnh đang theo dõi trong `trades` theo giá cao/thấp/đóng cửa mới; mở lệnh mới cho mã có tín hiệu MUA hoặc setup chờ xác nhận
   - so với phiên trước, gửi cảnh báo cho từng người (chỉ mã trong danh mục của họ, theo loại họ chọn), ghi `alert_log` để không gửi trùng khi chạy lại

Lịch sử chỉ bắt đầu từ phiên đầu tiên sau khi kết nối Supabase.

## Kiểm thử

```bash
node --test tests/*.test.mjs        # logic theo dõi tín hiệu, cảnh báo, lịch chạy, engine với API giả lập
node --test tests/telegram.test.ts  # webhook Telegram (Node ≥ 22.18)
node tests/sync.e2e.mjs             # luồng đồng bộ với Supabase/Telegram/Resend giả lập
node tests/ui/run.cjs               # giao diện (cần Playwright + python3)
node scripts/sync-supabase.mjs --dry-run   # chạy thật với Supabase nhưng chỉ in, không ghi/gửi
```

## Lưu ý

- Dữ liệu mới nằm trong bộ nhớ server; `data.js` trong repo chỉ là dữ liệu khởi động. Sau mỗi lần deploy/restart server tự chạy bù (~1–2 phút),
  trong lúc đó trang hiển thị dữ liệu trong repo.
- Nếu VibeHost chạy nhiều bản server cùng lúc, mỗi bản đều tự cập nhật; cảnh báo không bị gửi trùng nhờ `alert_log`.
- Dữ liệu lấy từ API công khai của VNDirect; hãy kiểm tra điều khoản sử dụng trước khi phát hành rộng rãi.
- Khi có người dùng đăng ký, bạn đang lưu email của họ: nên thêm trang chính sách bảo mật ngắn và cách xoá tài khoản (Supabase → Authentication → Users → Delete; dữ liệu liên quan tự xoá theo).
- Đây là công cụ sàng lọc tham khảo, **không phải khuyến nghị đầu tư**.
