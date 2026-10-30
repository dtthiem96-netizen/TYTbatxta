/**
 * Kiểm tra bảo mật trên một bản Deploy Preview đã triển khai (Module 0).
 *
 *   node tools/preview-security-check.mjs https://deploy-preview-NN--soft-churros-077805.netlify.app
 *
 * CHỈ ĐỌC VÀ ẨN DANH: không đăng nhập tài khoản thật, không tạo/sửa/xoá bản ghi
 * nào (mọi lệnh ghi thử dùng mã SECTEST-... không tồn tại và phải bị từ chối),
 * không in nội dung phản hồi - chỉ in mã trạng thái, tên trường và kết quả dò
 * mẫu CCCD/BHYT/SĐT. Việc duy nhất để lại dấu là bộ đếm giới hạn đăng nhập của
 * một tên đăng nhập không tồn tại. KHÔNG chạy với tên miền Production.
 */
const P = String(process.argv[2] || "").replace(/\/$/, "");
if (!/^https:\/\/[a-z0-9-]+--soft-churros-077805\.netlify\.app$/.test(P)) {
  console.error("Cần địa chỉ Deploy Preview dạng https://deploy-preview-NN--soft-churros-077805.netlify.app (không dùng Production).");
  process.exit(2);
}
const out = [];
const t = async (id, title, f) => { let ok = false, d = ""; try { const r = await f(); ok = r.ok; d = r.d; } catch (e) { d = "Lỗi: " + e.message; } out.push({ id, title, ok, d }); console.log(`${ok ? "✓" : "✗"} [${id}] ${title} — ${d}`); };
const req = async (path, init = {}) => { const r = await fetch(P + path, { redirect: "manual", ...init }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { s: r.status, h: r.headers, text, j }; };
const post = (path, body, headers = {}) => req(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
// Mẫu nhận diện số định danh: CCCD 12 số, BHYT 2 chữ + 13 số, SĐT VN 10 số
const PII_RE = [/(?<!\d)\d{12}(?!\d)/, /\b[A-Z]{2}\d{13}\b/, /(?<!\d)0[35789]\d{8}(?!\d)/];
const piiHits = (text) => PII_RE.filter((re) => re.test(text)).length;
const FAKE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJVMSIsInNjb3BlcyI6WyJhZG1pbiJdLCJleHAiOjQxMDI0NDQ4MDB9.ZmFrZS1zaWduYXR1cmU";

console.log("Đích kiểm thử:", P);
await t("LV-CMS-01", "GET /api/cms ẩn danh: không có đăng ký khám, không trường nhạy cảm của cán bộ, không ảnh chữ ký", async () => {
  const r = await req("/api/cms");
  const u = (r.j.users || [])[0] || {};
  const userKeys = Object.keys(u);
  const sens = ["email", "phone", "hasPassword", "lastLoginAt", "mustChangePassword", "passwordHash"].filter((k) => userKeys.includes(k));
  const sig = (r.j.prescriptionSigners || []).filter((s) => s.signature).length;
  const apptKeyLeak = /"(idCard|patientName|symptoms)"\s*:/.test(r.text);
  return { ok: r.s === 200 && Array.isArray(r.j.appointments) && r.j.appointments.length === 0 && !sens.length && !sig && !apptKeyLeak, d: `HTTP ${r.s}, appointments=${r.j.appointments?.length}, users=${r.j.users?.length} (trường: ${userKeys.join(",")}), chữ ký hiện=${sig}, có trường idCard/symptoms=${apptKeyLeak}` };
});
await t("LV-CMS-02", "GET /api/cms ẩn danh: không chuỗi nào có dạng CCCD/BHYT trong toàn bộ phản hồi", async () => {
  const r = await req("/api/cms");
  // Bỏ ảnh nhúng base64 và mã bản ghi dạng tiền tố + mốc thời gian (VD1793…) - nguồn báo nhầm đã xác minh.
  const text = r.text.replace(/data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/g, "").replace(/"(id|url)":"[^"]*"/g, "");
  const cccd = /(?<!\d)\d{12}(?!\d)/.test(text), bhyt = /\b[A-Z]{2}\d{13}\b/.test(text);
  return { ok: !cccd && !bhyt, d: `dạng CCCD=${cccd}, dạng BHYT=${bhyt} (đã loại ảnh base64 và mã bản ghi khỏi phép dò)` };
});
await t("LV-CMS-03", "GET /api/cms với phiếu giả mạo: vẫn không có đăng ký khám", async () => {
  const r = await req("/api/cms", { headers: { authorization: `Bearer ${FAKE}` } });
  return { ok: r.s === 200 && r.j.appointments.length === 0, d: `HTTP ${r.s}, appointments=${r.j.appointments.length}` };
});
for (const m of ["PUT", "PATCH", "DELETE"]) {
  await t(`LV-CMS-${m}`, `${m} /api/cms không được hỗ trợ`, async () => {
    const r = await req("/api/cms", { method: m, headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", type: "news", id: "SECTEST-KHONG-TON-TAI" }) });
    return { ok: r.s === 405, d: `HTTP ${r.s}` };
  });
}
await t("LV-CMS-04", "POST ghi/xoá khi chưa đăng nhập (dùng mã bản ghi không tồn tại) → 401", async () => {
  const codes = [];
  for (const body of [
    { action: "save", type: "news", data: { id: "SECTEST-NONEXIST-1", title: "x", date: "x", ts: 1 } },
    { action: "delete", type: "news", id: "SECTEST-NONEXIST-1" },
    { action: "delete", type: "appointments", id: "SECTEST-NONEXIST-2" },
    { action: "save", type: "prescriptionSigners", data: { id: "SECTEST-NONEXIST-3", name: "x", title: "x", ts: 1 } },
    { action: "save", type: "siteConfigs", data: { id: "SECTEST-NONEXIST-4", value: "x" } },
    { action: "upload_attachment_chunk", id: "SECTEST-NONEXIST-5", index: 0, total: 1, chunk: "JVBERg==", mimeType: "application/pdf" }
  ]) codes.push((await post("/api/cms", body)).s);
  return { ok: codes.every((c) => c === 401), d: `[${codes.join(", ")}]` };
});
await t("LV-CMS-05", "POST ghi bằng phiếu giả mạo → 401", async () => {
  const r = await post("/api/cms", { action: "delete", type: "news", id: "SECTEST-NONEXIST-6" }, { authorization: `Bearer ${FAKE}` });
  return { ok: r.s === 401, d: `HTTP ${r.s}` };
});
await t("LV-CMS-06", "POST SQL Injection qua mã bản ghi → bị từ chối (400/401), không lỗi máy chủ", async () => {
  const a = await post("/api/cms", { action: "delete", type: "news", id: "' or '1'='1" });
  const b = await post("/api/cms", { action: "save", type: "news", data: { id: "x'; drop table news;--", title: "x" } });
  return { ok: [400, 401].includes(a.s) && [400, 401].includes(b.s), d: `${a.s}/${b.s}` };
});
await t("LV-SIG-01", "Hàng đợi Telehealth ẩn danh / phiếu giả → 401", async () => {
  const a = await req("/api/signal?action=rooms");
  const b = await req("/api/signal?action=rooms", { headers: { authorization: `Bearer ${FAKE}` } });
  return { ok: a.s === 401 && b.s === 401 && !piiHits(a.text + b.text), d: `${a.s}/${b.s}` };
});
await t("LV-SIG-02", "IDOR: đọc/ghi phòng khám bằng peerId tự đặt → 403", async () => {
  const room = "room-tyt-batxat-01-sectest";
  const a = await req(`/api/signal?roomId=${room}&peerId=sectest-attacker&cursor=0`);
  const b = await post("/api/signal", { action: "vitals", roomId: room, peerId: "sectest-attacker", vitals: { bpSys: 1 } });
  const c = await post("/api/signal", { action: "notes", roomId: room, peerId: "sectest-attacker", notes: "x" });
  const d = await post("/api/signal", { action: "complete", roomId: room, peerId: "sectest-attacker", appointmentId: "SECTEST-NONEXIST" });
  return { ok: [a, b, c, d].every((x) => x.s === 403), d: `poll=${a.s}, vitals=${b.s}, notes=${c.s}, complete=${d.s}` };
});
await t("LV-SIG-03", "Người lạ vào phòng cố định của trạm (room-tyt-batxat-01) → 403", async () => {
  const r = await post("/api/signal", { action: "join", role: "patient", roomId: "room-tyt-batxat-01", peerId: "sectest-lurker", name: "x" });
  return { ok: r.s === 403, d: `HTTP ${r.s}` };
});
await t("LV-SIG-04", "Màn hình người dân vẫn xem được số cán bộ đang trực (không lộ dữ liệu người bệnh)", async () => {
  const r = await req("/api/signal?action=on-duty");
  return { ok: r.s === 200 && r.j.ok === true && !/patientId|symptoms|vitals/.test(r.text), d: `HTTP ${r.s}` };
});
await t("LV-API-01", "API dữ liệu sức khoẻ / quản trị khi chưa đăng nhập → 401", async () => {
  // /api/notify (khoá công khai Web Push) và /api/ai-status (trạng thái, không khoá) công khai theo thiết kế.
  const paths = ["/api/vitals/room-tyt-batxat-01-x", "/api/examination-report?roomId=x", "/api/call-logs", "/api/admin-users", "/api/cms/dashboard", "/api/station-rooms?admin=1", "/api/attendance/admin?view=roster", "/api/attendance/reports", "/api/ai-status?ping=1"];
  const res = [];
  for (const p of paths) res.push(`${p.split("?")[0]}=${(await req(p)).s}`);
  return { ok: res.every((x) => x.endsWith("=401")), d: res.join(", ") };
});
await t("LV-API-02", "Cùng các API với phiếu giả mạo → 401", async () => {
  const res = [];
  for (const p of ["/api/admin-users", "/api/call-logs", "/api/vitals/x", "/api/cms/dashboard"]) res.push((await req(p, { headers: { authorization: `Bearer ${FAKE}` } })).s);
  return { ok: res.every((s) => s === 401), d: `[${res.join(", ")}]` };
});
await t("LV-AUTH-01", "Tài khoản mẫu (canbotram@) không đăng nhập được bằng mật khẩu mặc định công khai", async () => {
  const r = await post("/api/station-auth", { username: "canbotram@laocai.gov.vn", password: "Admin123@", scope: "station" });
  return { ok: r.s === 401 || r.s === 403, d: `HTTP ${r.s}` };
});
await t("LV-AUTH-02", "SQL Injection qua tên đăng nhập → 401", async () => {
  const r = await post("/api/station-auth", { username: "' OR '1'='1' --", password: "' OR '1'='1", scope: "cms" });
  return { ok: r.s === 401 || r.s === 429, d: `HTTP ${r.s}` };
});
await t("LV-RL-01", "Rate limit đăng nhập: tài khoản không tồn tại, sai liên tục → 429", async () => {
  let last = 0, n = 0;
  for (; n < 12; n++) { last = (await post("/api/station-auth", { username: "sectest-khong-ton-tai@example.invalid", password: "sai-" + n, scope: "station" })).s; if (last === 429) break; }
  return { ok: last === 429, d: `bị chặn ở lần thứ ${n + 1}, HTTP ${last}` };
});
await t("LV-CORS-01", "CORS: preflight từ tên miền lạ không được cấp quyền", async () => {
  const bad = [];
  for (const p of ["/api/cms", "/api/signal", "/api/station-auth", "/api/admin-users", "/api/vitals", "/api/ai", "/api/attachment", "/api/call-logs"]) {
    const r = await req(p, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    const a = r.h.get("access-control-allow-origin");
    if (a === "*" || a === "https://evil.example") bad.push(p);
  }
  return { ok: !bad.length, d: `mở CORS: [${bad.join(", ")}]` };
});
await t("LV-FILE-01", "Tệp đính kèm: mã tệp lạ/đường dẫn ../ → 404, không lộ lỗi kỹ thuật", async () => {
  const a = await req("/api/attachment?id=..%2F..%2Fetc%2Fpasswd");
  const b = await req("/api/video?id=SECTEST-NONEXIST");
  return { ok: a.s === 404 && b.s === 404 && !/stack|at \w+ \(|Error:/.test(a.text + b.text), d: `${a.s}/${b.s}` };
});
await t("LV-SRC-01", "Mã nguồn máy chủ, sơ đồ CSDL, bộ kiểm thử không tải được qua web", async () => {
  const paths = ["/netlify/lib/guard.ts", "/netlify/functions/cms.ts", "/db/schema.ts", "/tools/security-tests.mjs", "/auth/userStore.js", "/telehealth.db", "/package.json", "/server.js", "/public/admin/index.html"];
  const res = [];
  for (const p of paths) res.push(`${p}=${(await req(p)).s}`);
  return { ok: res.every((x) => /=(404|401)$/.test(x)), d: res.join(", ") };
});
await t("LV-HDR-01", "HTTPS/HSTS và header bảo mật có mặt", async () => {
  const r = await req("/");
  const h = ["strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy"].map((k) => `${k}=${r.h.get(k) ? "có" : "THIẾU"}`);
  return { ok: !h.some((x) => x.endsWith("THIẾU")), d: h.join(", ") };
});
await t("LV-HDR-02", "/admin không trả nội dung quản trị khi chưa đăng nhập Netlify Identity", async () => {
  const r = await req("/admin/");
  return { ok: r.s >= 400 && r.text.length < 20000, d: `HTTP ${r.s}, ${r.text.length} byte` };
});
await t("LV-FILE-02", "Tệp: mọi phương thức ghi/xoá trên /api/attachment và /api/video → 405", async () => {
  const codes = [];
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    codes.push((await req("/api/attachment?id=SECTEST-NONEXIST", { method: m })).s);
    codes.push((await req("/api/video?id=SECTEST-NONEXIST", { method: m })).s);
  }
  return { ok: codes.every((c) => c === 405), d: `[${codes.join(", ")}]` };
});
await t("LV-FILE-03", "Tệp: tải lên riêng tư khi chưa đăng nhập → 401", async () => {
  const r = await post("/api/cms", { action: "upload_attachment_chunk", visibility: "private", id: "SECTEST-NONEXIST-P", index: 0, total: 1, chunk: "JVBERg==", mimeType: "application/pdf" });
  return { ok: r.s === 401, d: `HTTP ${r.s}` };
});
const fail = out.filter((x) => !x.ok).length;
console.log(`\nTổng: ${out.length} phép thử trực tiếp, ${out.length - fail} đạt, ${fail} không đạt.`);
process.exit(fail ? 1 : 0);
