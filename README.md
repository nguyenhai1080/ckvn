# Lướt sóng CK

Bộ lọc và tín hiệu lướt sóng ngắn hạn cho cổ phiếu Việt Nam (HOSE/HNX/UPCoM, GTGD TB 20 phiên ≥ 10 tỷ).
Đây là trang tĩnh, không cần backend.

| File | Vai trò |
|---|---|
| `index.html` | Giao diện (không cần đổi hằng ngày) |
| `data.js` | Dữ liệu phiên gần nhất (`window.DATA = …`), thay mỗi ngày |
| `engine.js` | Lấy dữ liệu VNDirect + tính chỉ báo, tín hiệu, backtest |
| `scripts/update-data.mjs` | Chạy `engine.js` bằng Node 18+ và ghi `data.js` |
| `.github/workflows/update-data.yml` | GitHub Actions chạy cập nhật 15:45 giờ VN, thứ 2–6 |

## Chạy thử trên máy

```bash
npm run update      # lấy dữ liệu mới, ghi data.js (thoát mã 2 nếu hôm nay nghỉ)
npm run check       # kiểm tra data.js đọc được
npx serve .         # mở http://localhost:3000
```

## Đẩy lên GitHub

```bash
git init -b main
git add .
git commit -m "Lướt sóng CK: trang tĩnh + cập nhật tự động"
gh repo create luot-song-ck --public --source . --push
# hoặc: git remote add origin https://github.com/<user>/luot-song-ck.git && git push -u origin main
```

Sau đó vào **Actions → Cập nhật dữ liệu hằng ngày → Run workflow** để chạy thử lần đầu.
Nếu bước "Lấy dữ liệu" lỗi kết nối/403 thì VNDirect đang chặn IP máy chủ GitHub; khi đó
chạy `npm run update` trên máy ở Việt Nam rồi `git push`, hoặc dùng self-hosted runner.

## Deploy lên VibeHost

Trang là static, không có bước build: thư mục xuất bản là **gốc repo** (`.`), lệnh build để trống.

- Nếu VibeHost cho kết nối repo GitHub: chọn repo `luot-song-ck`, nhánh `main`, output `.`;
  mỗi lần Actions commit `data.js` mới, VibeHost sẽ tự deploy lại.
- Nếu dùng VibeHost CLI: đăng nhập rồi deploy thư mục gốc repo (xem tài liệu VibeHost cho lệnh chính xác),
  và thêm bước deploy đó vào cuối workflow với token lưu trong GitHub Secrets.

Lưu ý: deploy VibeHost mặc định có thể tạo link riêng tư; hãy bật chế độ công khai trong cài đặt dự án nếu muốn ai cũng xem được.

## Lưu ý khi công khai

- Dữ liệu lấy từ API công khai của VNDirect; hãy kiểm tra điều khoản sử dụng của VNDirect trước khi phát hành rộng rãi.
- Trang đã ghi rõ đây là công cụ sàng lọc tham khảo, **không phải khuyến nghị đầu tư**. Nên giữ nguyên dòng này.
