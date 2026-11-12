// Cập nhật data.js từ API VNDirect bằng Node 18+ (không cần trình duyệt).
// Dùng: node scripts/update-data.mjs [--force]
// Thoát mã 2 nếu hôm nay không có phiên mới (ngày nghỉ) -> không ghi đè data.js.
// Khi chạy trên VibeHost, server.mjs đã tự làm việc này lúc 15:45; script này dùng để chạy tay / dự phòng.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeData, vnDate } from './lib/update.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.DATA_FILE || path.join(root, 'data.js');

const res = await computeData({ engineFile: path.join(root, 'engine.js') });
console.log('Engine:', JSON.stringify(res.summary));

const today = vnDate();
if (res.asof !== today && !process.argv.includes('--force')) {
  console.log(`Dữ liệu mới nhất là ${res.asof}, hôm nay (giờ VN) là ${today}: thị trường nghỉ, không cập nhật.`);
  process.exit(2);
}
await writeFile(out, res.data);
console.log(`Đã ghi ${path.relative(root, out) || out}: phiên ${res.asof}, ${res.rows} mã, ${res.data.length} ký tự.`);
