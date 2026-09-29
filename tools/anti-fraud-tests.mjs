/**
 * Kiểm thử các lớp chống gian lận của phân hệ Chấm công - chấm trực.
 *
 *   node tools/anti-fraud-tests.mjs
 *
 * Phần 1 chạy trực tiếp các hàm thuần trong netlify/lib/antifraud.ts (Node 24 tự
 * gỡ chú thích kiểu TypeScript khi import), không cần cơ sở dữ liệu hay mạng:
 * vùng chấm công, dấu hiệu GPS giả, ca trực qua đêm, chữ ký thiết bị, ảnh
 * selfie, mức rủi ro.
 *
 * Phần 2 đọc mã nguồn để khoá các bảo đảm không nằm trong hàm thuần: trigger CSDL
 * chặn sửa/xoá bản gốc, chuỗi băm nhật ký, giao diện không còn gửi giờ/khoảng
 * cách do trình duyệt tự tính.
 *
 * Kiểm thử đầu-cuối qua API (cần máy chủ đang chạy và tài khoản thử) nằm trong
 * docs/chamcong-antifraud-testcases.md.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const af = await import(join(root, "netlify/lib/antifraud.ts"));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${err && err.message}`);
  }
}
const codes = (reasons) => reasons.map((r) => r.code);

// Toạ độ tham chiếu (giả định) của Trạm để kiểm thử.
const STATION = { lat: 22.53261, lng: 103.89412 };
const settings = (over = {}) =>
  af.normalizeSecurity({ geofence: { enabled: true, lat: STATION.lat, lng: STATION.lng, radiusM: 150, maxAccuracyM: 100 }, ...over });
// Dịch điểm theo hướng bắc khoảng `m` mét.
const north = (m) => ({ lat: STATION.lat + m / 111195, lng: STATION.lng });

console.log("1. Vùng chấm công (máy chủ tự tính khoảng cách)");

await test("haversine: 0,01 độ vĩ ≈ 1,11 km", () => {
  const d = af.haversineM(22, 103, 22.01, 103);
  assert.ok(Math.abs(d - 1112) < 5, `d=${d}`);
});

await test("[TC-01] trong vùng, sai số tốt → không có lý do", () => {
  const p = north(40);
  const g = af.checkGeofence(settings(), { lat: p.lat + 0.0000013, lng: p.lng + 0.0000017, accuracy: 12 });
  assert.equal(g.inside, true);
  assert.deepEqual(g.reasons, []);
  assert.ok(g.distanceM >= 35 && g.distanceM <= 45);
});

await test("[TC-02] ngoài vùng 2 km → RED OUTSIDE_GEOFENCE", () => {
  const p = north(2000);
  const g = af.checkGeofence(settings(), { ...p, accuracy: 15 });
  assert.equal(g.inside, false);
  assert.ok(codes(g.reasons).includes("OUTSIDE_GEOFENCE"));
  assert.equal(af.combineLevel(g.reasons), "RED");
});

await test("sai số lớn không 'kéo' được vị trí xa vào vùng (bù tối đa = bán kính)", () => {
  const p = north(400);
  const g = af.checkGeofence(settings(), { ...p, accuracy: 5000 });
  assert.equal(g.inside, false);
  assert.ok(codes(g.reasons).includes("LOW_ACCURACY"));
});

await test("rìa vùng (trong phần bù sai số) → YELLOW GEOFENCE_EDGE", () => {
  const p = north(180);
  const g = af.checkGeofence(settings(), { ...p, accuracy: 50 });
  assert.equal(g.inside, true);
  assert.deepEqual(codes(g.reasons), ["GEOFENCE_EDGE"]);
});

await test("không có vị trí khi bật vùng → RED NO_LOCATION", () => {
  const g = af.checkGeofence(settings(), null);
  assert.deepEqual(codes(g.reasons), ["NO_LOCATION"]);
});

await test("chưa cấu hình toạ độ → YELLOW, không làm tê liệt chấm công", () => {
  const g = af.checkGeofence(af.normalizeSecurity({}), { ...STATION, accuracy: 10 });
  assert.equal(af.combineLevel(g.reasons), "YELLOW");
});

await test("parseLocation từ chối toạ độ không hợp lệ", () => {
  assert.equal(af.parseLocation({ lat: 91, lng: 0, accuracy: 5 }), null);
  assert.equal(af.parseLocation({ lat: "abc", lng: 0, accuracy: 5 }), null);
  assert.equal(af.parseLocation({ lat: 1, lng: 2, accuracy: -1 }), null);
  assert.ok(af.parseLocation({ lat: 22.5, lng: 103.9, accuracy: 8 }));
});

await test("normalizeSecurity kẹp giá trị ngoài khoảng và không ném lỗi", () => {
  const s = af.normalizeSecurity({ geofence: { radiusM: 1, maxAccuracyM: 1e9 }, qrMode: "hack", selfieRetentionDays: -5 });
  assert.equal(s.geofence.radiusM, 20);
  assert.equal(s.geofence.maxAccuracyM, 1000);
  assert.equal(s.qrMode, af.DEFAULT_SECURITY.qrMode);
  assert.equal(s.selfieRetentionDays, 7);
  assert.doesNotThrow(() => af.normalizeSecurity("rác"));
});

console.log("2. Dấu hiệu vị trí giả (mock location / fake GPS)");

const ctx = (over = {}) => ({ serverTs: Date.UTC(2026, 8, 29, 1, 0), maxSpeedKmh: 120, maxClockSkewSec: 300, ...over });
const realLoc = { lat: 22.5326134, lng: 103.8941271, accuracy: 14 };

await test("vị trí thật → không có tín hiệu", () => {
  assert.deepEqual(af.gpsSignals(realLoc, ctx({ clientTs: ctx().serverTs })), []);
});

await test("[TC-03] sai số ≤ 1 m và toạ độ tròn → MOCK_ACCURACY, MOCK_ROUNDED", () => {
  const c = codes(af.gpsSignals({ lat: 22.5326, lng: 103.8941, accuracy: 1 }, ctx()));
  assert.ok(c.includes("MOCK_ACCURACY") && c.includes("MOCK_ROUNDED"));
});

await test("toạ độ trùng khít lượt trước → MOCK_IDENTICAL", () => {
  const c = codes(af.gpsSignals(realLoc, ctx({ recentCoords: [{ lat: realLoc.lat, lng: realLoc.lng }] })));
  assert.ok(c.includes("MOCK_IDENTICAL"));
});

await test("[TC-04] GPS nhảy 300 km trong 10 phút → RED GPS_JUMP", () => {
  const serverTs = ctx().serverTs;
  const r = af.gpsSignals(realLoc, ctx({ previous: { lat: 21.0285, lng: 105.8542, ts: serverTs - 10 * 60000 } }));
  assert.ok(codes(r).includes("GPS_JUMP"));
  assert.equal(af.combineLevel(r), "RED");
});

await test("[TC-05] đồng hồ máy bị chỉnh lệch 1 giờ → CLOCK_SKEW", () => {
  const r = af.gpsSignals(realLoc, ctx({ clientTs: ctx().serverTs - 3600000 }));
  assert.ok(codes(r).includes("CLOCK_SKEW"));
});

await test("vị trí đo từ 10 phút trước → STALE_LOCATION", () => {
  const t = ctx().serverTs;
  const r = af.gpsSignals({ ...realLoc, positionTs: t - 10 * 60000 }, ctx({ clientTs: t }));
  assert.ok(codes(r).includes("STALE_LOCATION"));
});

await test("trình duyệt tự động (webdriver) → RED AUTOMATION", () => {
  const r = af.gpsSignals(realLoc, ctx({ clientFlags: { webdriver: true } }));
  assert.equal(af.combineLevel(r), "RED");
});

await test("IP nước ngoài → YELLOW IP_COUNTRY_MISMATCH", () => {
  assert.ok(codes(af.gpsSignals(realLoc, ctx({ ipCountry: "us" }))).includes("IP_COUNTRY_MISMATCH"));
});

console.log("3. Mức rủi ro");

await test("combineLevel lấy mức cao nhất", () => {
  assert.equal(af.combineLevel([]), "GREEN");
  assert.equal(af.combineLevel([af.reason("A", "YELLOW", ""), af.reason("B", "GREEN", "")]), "YELLOW");
  assert.equal(af.combineLevel([af.reason("A", "YELLOW", ""), af.reason("B", "RED", "")]), "RED");
});

console.log("4. Ca trực qua đêm 17:00 → 07:00");

await test("[TC-06] ca 17:00-07:00 vắt qua nửa đêm, kết ca thuộc ngày trực trước", () => {
  assert.equal(af.crossesMidnight("17:00", "07:00"), true);
  assert.equal(af.crossesMidnight("07:00", "07:00"), true);
  assert.equal(af.crossesMidnight("07:00", "17:00"), false);
  const w = af.dutyWindow("2026-09-30", "17:00", "07:00");
  assert.equal(w.endDate, "2026-10-01");
  assert.equal(w.endAt - w.startAt, 14 * 3600000);
});

await test("nhận ca: sớm 30 phút được, sớm 3 giờ bị chặn, muộn quá nửa ca bị chặn", () => {
  const d = "2026-09-30";
  assert.equal(af.checkInAllowed(af.vnEpochPure(d, "16:30"), d, "17:00", "07:00").ok, true);
  assert.equal(af.checkInAllowed(af.vnEpochPure(d, "14:00"), d, "17:00", "07:00").ok, false);
  assert.equal(af.checkInAllowed(af.vnEpochPure("2026-10-01", "01:00"), d, "17:00", "07:00").ok, false);
});

await test("kết ca 06:50 sáng hôm sau hợp lệ; 2 giờ chiều hôm sau quá hạn", () => {
  const d = "2026-09-30";
  const ok = af.checkOutAllowed(af.vnEpochPure("2026-10-01", "06:50"), d, "17:00", "07:00");
  assert.equal(ok.ok, true);
  assert.equal(ok.early, false);
  assert.equal(af.checkOutAllowed(af.vnEpochPure("2026-10-01", "14:00"), d, "17:00", "07:00").ok, false);
  assert.equal(af.checkOutAllowed(af.vnEpochPure(d, "20:00"), d, "17:00", "07:00").early, true);
});

console.log("5. Chữ ký thiết bị và nonce một lần");

const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = await crypto.subtle.exportKey("jwk", keys.publicKey);
const pubJson = JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y });
const sign = async (text) => {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(text)));
  return Buffer.from(sig).toString("base64url");
};
const payload = af.signingPayload({ nonce: "n1", action: "PUNCH_IN", type: "IN", lat: 22.53, lng: 103.89, selfieSha256: "ab" });

await test("chuỗi ký gồm nonce|thao tác|loại|vĩ độ|kinh độ|sha ảnh", () => {
  assert.equal(payload, "n1|PUNCH_IN|IN|22.53|103.89|ab");
  assert.equal(af.signingPayload({ nonce: "n", action: "DEVICE_REGISTER", type: "h" }), "n|DEVICE_REGISTER|h|||");
});

await test("chữ ký hợp lệ được chấp nhận", async () => {
  assert.equal(await af.verifyDeviceSignature(pubJson, payload, await sign(payload)), true);
});

await test("[TC-07] sửa toạ độ sau khi ký / dùng lại chữ ký với nonce khác → bị từ chối", async () => {
  const sig = await sign(payload);
  const moved = af.signingPayload({ nonce: "n1", action: "PUNCH_IN", type: "IN", lat: 22.6, lng: 103.89, selfieSha256: "ab" });
  const replay = af.signingPayload({ nonce: "n2", action: "PUNCH_IN", type: "IN", lat: 22.53, lng: 103.89, selfieSha256: "ab" });
  assert.equal(await af.verifyDeviceSignature(pubJson, moved, sig), false);
  assert.equal(await af.verifyDeviceSignature(pubJson, replay, sig), false);
});

await test("[TC-08] khoá của thiết bị khác không giả được chữ ký", async () => {
  const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const otherPub = await crypto.subtle.exportKey("jwk", other.publicKey);
  const json = JSON.stringify({ kty: "EC", crv: "P-256", x: otherPub.x, y: otherPub.y });
  assert.equal(await af.verifyDeviceSignature(json, payload, await sign(payload)), false);
});

await test("khoá công khai lẫn khoá bí mật (d) hoặc sai đường cong bị từ chối", async () => {
  const priv = await crypto.subtle.exportKey("jwk", keys.privateKey);
  assert.equal(await af.verifyDeviceSignature(JSON.stringify(priv), payload, await sign(payload)), false);
  assert.equal(await af.deviceHashOf(JSON.stringify(priv)), null);
  assert.equal(await af.deviceHashOf(JSON.stringify({ ...pub, crv: "P-384" })), null);
  assert.equal(await af.verifyDeviceSignature("không phải json", payload, "x"), false);
});

await test("mã thiết bị = sha256(x|y), ổn định", async () => {
  const h = await af.deviceHashOf(pubJson);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await af.sha256Hex(`${pub.x}|${pub.y}`));
});

await test("randomToken không lặp", () => {
  const set = new Set(Array.from({ length: 200 }, () => af.randomToken()));
  assert.equal(set.size, 200);
});

console.log("6. Ảnh selfie và vector sinh trắc");

await test("[TC-09] tệp không phải JPEG bị nhận diện", () => {
  assert.equal(af.isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(af.isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0])), true);
});

await test("[TC-10] ảnh có EXIF (ảnh chụp sẵn/thư viện) bị nhận diện", () => {
  const exif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0, 0, 0, 0, 0, 0]);
  const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0, 0, 0, 0, 0]);
  assert.equal(af.hasExif(exif), true);
  assert.equal(af.hasExif(plain), false);
});

const synthetic = (w, h, fn) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = fn(x, y);
      const p = (y * w + x) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  return af.toGray(w, h, rgba);
};
const faceA = synthetic(120, 120, (x, y) => (Math.hypot(x - 60, y - 55) < 35 ? 200 : 40) + ((x * 7 + y * 3) % 11));
const faceA2 = synthetic(120, 120, (x, y) => (Math.hypot(x - 61, y - 56) < 35 ? 195 : 45) + ((x * 5 + y * 3) % 9));
const faceB = synthetic(120, 120, (x, y) => (x < 60 ? 220 : 20) + (y % 13));

await test("vector đặc trưng: cùng 'khuôn mặt' giống nhau hơn khác 'khuôn mặt'", () => {
  const a = af.faceVector(faceA);
  assert.equal(a.length, 1024);
  const same = af.cosineSimilarity(a, af.faceVector(faceA2));
  const diff = af.cosineSimilarity(a, af.faceVector(faceB));
  assert.ok(same > 0.9, `same=${same}`);
  assert.ok(same > diff, `same=${same} diff=${diff}`);
});

await test("[TC-11] hai khung selfie y hệt (ảnh tĩnh) → dHash khoảng cách 0", () => {
  assert.equal(af.hamming(af.dHash(faceA), af.dHash(faceA)), 0);
  assert.ok(af.hamming(af.dHash(faceA), af.dHash(faceB)) > 5);
});

await test("ảnh phẳng (che camera) có độ tương phản thấp", () => {
  const flat = synthetic(64, 64, () => 128);
  assert.ok(af.contrast(flat) < af.contrast(faceA));
});

await test("thử thách liveness được chọn trong danh sách", () => {
  for (const r of [0, 0.3, 0.99]) assert.ok(af.LIVENESS_CHALLENGES.includes(af.pickChallenge(r)));
});

console.log("7. Bảo đảm ở tầng CSDL và mã nguồn");

const migDir = join(root, "netlify/database/migrations");
const migs = readdirSync(migDir).sort();
const triggersDir = migs.find((m) => m.endsWith("_add_attendance_integrity_triggers"));
const triggers = readFileSync(join(migDir, triggersDir, "migration.sql"), "utf8");
const attendanceFn = readFileSync(join(root, "netlify/functions/attendance.ts"), "utf8");
const clientJs = readFileSync(join(root, "chamcong.js"), "utf8");

await test("[TC-12] trigger chặn DELETE/UPDATE bản gốc lượt chấm và nhật ký trực", () => {
  assert.match(triggers, /att_punches_guard/);
  assert.match(triggers, /att_duty_logs_guard/);
  assert.match(triggers, /TG_OP = 'DELETE'/);
  assert.match(triggers, /NEW\.punch_at IS DISTINCT FROM OLD\.punch_at/);
});

await test("[TC-13] bằng chứng, điều chỉnh, nhật ký kiểm toán chỉ ghi thêm; chặn TRUNCATE", () => {
  for (const t of ["att_attempts_append_only", "att_adjustments_append_only", "att_audits_append_only", "att_audits_no_truncate"]) {
    assert.ok(triggers.includes(t), t);
  }
  assert.match(triggers, /att_audits_chain/);
});

await test("[TC-14] chống chấm VÀO hai lần / RA khi chưa VÀO", () => {
  assert.match(attendanceFn, /"DUPLICATE"/);
  assert.match(attendanceFn, /"NO_OPEN_IN"/);
  assert.match(attendanceFn, /isUniqueViolation\(err\)/);
});

await test("[TC-15] giờ chấm lấy theo máy chủ: không đọc giờ/khoảng cách từ body", () => {
  assert.doesNotMatch(attendanceFn, /body\.(punchAt|time|distance|distanceM|inside)\b/);
  assert.match(attendanceFn, /punchAt: now/);
});

await test("[TC-16] trình duyệt chỉ gửi toạ độ thô + chữ ký, không tự tính khoảng cách", () => {
  assert.doesNotMatch(clientJs, /haversine/i);
  assert.match(clientJs, /signText\(/);
  assert.match(clientJs, /extractable|false, \['sign'/);
});

await test("[TC-17] chấm ngoại tuyến chỉ thành đề nghị điều chỉnh, không tạo lượt chấm", () => {
  assert.match(clientJs, /offline_sync/);
  assert.match(attendanceFn, /offline_sync/);
});

await test("[TC-18] không có nút sửa/xoá bản gốc trong giao diện; chỉ 'Huỷ hiệu lực' có lý do", () => {
  assert.doesNotMatch(clientJs, /action: 'punch_delete' }/);
  assert.match(clientJs, /Huỷ hiệu lực/);
});

console.log(`\n${passed} đạt, ${failures.length} lỗi.`);
if (failures.length) process.exit(1);
