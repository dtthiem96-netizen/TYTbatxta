/**
 * Khoá ngưỡng đánh giá sinh hiệu ở ba nơi lại với nhau.
 *
 *   node tools/vitals-parity.mjs
 *
 * Trạm bật biểu ngữ cảnh báo ngay tại trình duyệt bằng evaluateVitalsLocally()
 * trong app.js, bản ghi chính thức do evaluateVitals() trong
 * netlify/functions/vitals.ts tạo ra, còn AI điều phối đa bên quyết định có phát
 * [CẢNH BÁO CẤP CỨU] tới hai bác sĩ hay không bằng evaluateVitals() trong
 * netlify/functions/ai-coordinator.ts. Cả ba buộc phải cho cùng một mức nguy
 * hiểm: nếu lệch, cán bộ trạm thấy CẤP CỨU trong khi hồ sơ chỉ ghi WARNING (hoặc
 * AI vẫn nói chuyện bình thản với bệnh nhân ngay trước mặt người bệnh), và tuyến
 * trên đọc lại sẽ đánh giá thấp mức nguy hiểm thật.
 *
 * Không so sánh câu chữ của thông báo - ba bên được phép diễn đạt khác nhau.
 * Chỉ so sánh `status` và tập các mức `level` sinh ra.
 *
 * Cách lấy hàm ra: cả ba đều là hàm thuần, không phụ thuộc DOM hay mạng, nên
 * trích nguyên văn phần khai báo rồi đánh giá trong một Function riêng. Phần TS
 * được gỡ chú thích kiểu bằng module.stripTypeScriptTypes của Node 24.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = path.resolve(path.join(import.meta.dirname, '..'));

/** Cắt một khai báo `function name(...) { ... }` bằng cách đếm ngoặc nhọn. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Không tìm thấy hàm ${name}()`);
  let depth = 0;
  let i = source.indexOf('{', start);
  if (i === -1) throw new Error(`Hàm ${name}() không có thân hàm`);
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`Ngoặc nhọn của ${name}() không đóng`);
}

const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const fnSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/vitals.ts'), 'utf8');
const coordSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/ai-coordinator.ts'), 'utf8');

const localSrc = extractFunction(appSrc, 'evaluateVitalsLocally');
const serverSrcTs = extractFunction(fnSrc, 'evaluateVitals');
const coordSrcTs = extractFunction(coordSrc, 'evaluateVitals');
// stripTypeScriptTypes cần một mô-đun hợp lệ, nên bọc lại rồi lấy ra.
const serverSrc = stripTypeScriptTypes(serverSrcTs, { mode: 'strip' });
const coordJs = stripTypeScriptTypes(coordSrcTs, { mode: 'strip' });

const evaluateLocal = new Function(`${localSrc}; return evaluateVitalsLocally;`)();
const evaluateServer = new Function(`${serverSrc}; return evaluateVitals;`)();
const evaluateCoordinator = new Function(`${coordJs}; return evaluateVitals;`)();

/**
 * Các trường hợp phủ hai phía của từng ngưỡng, cộng thêm vài ca lâm sàng thật.
 * bpSys/bpDia/heartRate/spo2/temperature là tên trường phía trạm; phía máy chủ
 * dùng bp_sys/bp_dia/heart_rate nên phải chuyển đổi khi gọi.
 */
const CASES = [
  { label: 'bình thường hoàn toàn', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 98, temperature: 36.8 },

  // SpO2
  { label: 'SpO2 95 (ngưỡng dưới của bình thường)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 95, temperature: 36.8 },
  { label: 'SpO2 94 (cảnh báo)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 94, temperature: 36.8 },
  { label: 'SpO2 92 (còn cảnh báo)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 92, temperature: 36.8 },
  { label: 'SpO2 91 (cấp cứu)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 91, temperature: 36.8 },

  // Huyết áp
  { label: 'HA 139/89 (bình thường)', bpSys: 139, bpDia: 89, heartRate: 72, spo2: 98, temperature: 36.8 },
  { label: 'HA 140/85 (cảnh báo)', bpSys: 140, bpDia: 85, heartRate: 72, spo2: 98, temperature: 36.8 },
  { label: 'HA 89/70 (tụt - cảnh báo)', bpSys: 89, bpDia: 70, heartRate: 72, spo2: 98, temperature: 36.8 },
  { label: 'HA 120/59 (cảnh báo)', bpSys: 120, bpDia: 59, heartRate: 72, spo2: 98, temperature: 36.8 },
  { label: 'HA 160/95 (cấp cứu)', bpSys: 160, bpDia: 95, heartRate: 72, spo2: 98, temperature: 36.8 },
  { label: 'HA 150/100 (cấp cứu theo tâm trương)', bpSys: 150, bpDia: 100, heartRate: 72, spo2: 98, temperature: 36.8 },

  // Nhịp tim
  { label: 'nhịp 100 (bình thường)', bpSys: 118, bpDia: 76, heartRate: 100, spo2: 98, temperature: 36.8 },
  { label: 'nhịp 101 (cảnh báo)', bpSys: 118, bpDia: 76, heartRate: 101, spo2: 98, temperature: 36.8 },
  { label: 'nhịp 54 (cảnh báo)', bpSys: 118, bpDia: 76, heartRate: 54, spo2: 98, temperature: 36.8 },
  { label: 'nhịp 129 (còn cảnh báo)', bpSys: 118, bpDia: 76, heartRate: 129, spo2: 98, temperature: 36.8 },
  { label: 'nhịp 130 (cấp cứu)', bpSys: 118, bpDia: 76, heartRate: 130, spo2: 98, temperature: 36.8 },
  { label: 'nhịp 45 (cấp cứu - chậm)', bpSys: 118, bpDia: 76, heartRate: 45, spo2: 98, temperature: 36.8 },

  // Nhiệt độ
  { label: 'nhiệt 38.4 (bình thường)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 98, temperature: 38.4 },
  { label: 'nhiệt 38.5 (cảnh báo)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 98, temperature: 38.5 },
  { label: 'nhiệt 39.0 (cảnh báo)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 98, temperature: 39.0 },
  { label: 'nhiệt 39.4 (còn cảnh báo)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 98, temperature: 39.4 },
  { label: 'nhiệt 39.5 (cấp cứu)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 98, temperature: 39.5 },
  { label: 'nhiệt 35.0 (cấp cứu - hạ nhiệt)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 98, temperature: 35.0 },
  { label: 'nhiệt 34.0 (cấp cứu - hạ nhiệt nặng)', bpSys: 118, bpDia: 76, heartRate: 72, spo2: 98, temperature: 34.0 },

  // Ca lâm sàng kết hợp
  { label: 'sốc nhiễm khuẩn', bpSys: 82, bpDia: 48, heartRate: 138, spo2: 89, temperature: 39.8 },
  { label: 'cơn tăng huyết áp kèm nhịp nhanh', bpSys: 196, bpDia: 118, heartRate: 112, spo2: 96, temperature: 37.1 },
  { label: 'hạ nhiệt kèm nhịp chậm', bpSys: 104, bpDia: 66, heartRate: 42, spo2: 95, temperature: 34.6 }
];

const toServer = (c) => ({
  bp_sys: c.bpSys,
  bp_dia: c.bpDia,
  heart_rate: c.heartRate,
  spo2: c.spo2,
  temperature: c.temperature
});

const levels = (r) => (r.alerts || []).map((a) => a.level).sort().join(',') || '-';

const mismatches = [];
for (const c of CASES) {
  const local = evaluateLocal(c);
  const server = evaluateServer(toServer(c));
  const coordinator = evaluateCoordinator(toServer(c));
  const differs =
    local.status !== server.status ||
    local.status !== coordinator.status ||
    levels(local) !== levels(server) ||
    levels(local) !== levels(coordinator);
  if (differs) {
    mismatches.push(
      `${c.label}\n      trạm       : status=${local.status} levels=${levels(local)}`
      + `\n      máy chủ    : status=${server.status} levels=${levels(server)}`
      + `\n      điều phối  : status=${coordinator.status} levels=${levels(coordinator)}`
    );
  }
}

console.log(`Đối chiếu ngưỡng sinh hiệu: ${CASES.length} trường hợp.`);
if (!mismatches.length) {
  console.log('✓ app.js, netlify/functions/vitals.ts và netlify/functions/ai-coordinator.ts cho cùng mức nguy hiểm ở mọi trường hợp.');
  process.exit(0);
}
console.log(`✗ ${mismatches.length} trường hợp lệch nhau:`);
for (const m of mismatches) console.log('    ' + m);
console.log('\nSửa để cả ba bên trùng ngưỡng. Đánh giá thấp hơn ở phía máy chủ là hướng nguy hiểm:');
console.log('hồ sơ chính thức sẽ nhẹ hơn điều cán bộ trạm đang nhìn thấy.');
process.exit(1);
