// Cấu hình công khai cho trình duyệt. Anon key được phép công khai (dữ liệu được bảo vệ bằng RLS).
// KHÔNG đặt service_role key ở đây.
// Để trống supabaseUrl → trang chạy ở chế độ tĩnh (không đăng nhập, không lịch sử, không cảnh báo).
window.LSCK_CONFIG = {
  supabaseUrl: '',      // VD: 'https://abcdefgh.supabase.co'
  supabaseAnonKey: '',  // Project Settings → API → anon public key
  telegramBot: '',      // username bot, không có @, VD: 'LuotSongCKBot'
};
