/**
 * Bộ kiểm thử bảo mật Module 0 (phân quyền, IDOR, rò rỉ dữ liệu cá nhân).
 *
 *   node tools/security-tests.mjs
 *
 * CÔ LẬP HOÀN TOÀN KHỎI DỮ LIỆU THẬT:
 *   - Cơ sở dữ liệu là một PostgreSQL nhúng (PGlite) dựng mới trong bộ nhớ, áp
 *     lần lượt toàn bộ migration trong netlify/database/migrations rồi chỉ nạp
 *     dữ liệu GIẢ. Biến NETLIFY_DB_URL bị xoá khỏi tiến trình trước khi nạp mã,
 *     nên không có đường nào chạm tới database production hay preview.
 *   - Netlify Blobs và Gemini được thay bằng bản giả trong bộ nhớ: không gọi
 *     mạng, không tốn chi phí AI.
 *   - Các Netlify Function được đóng gói bằng esbuild y như lúc triển khai, chỉ
 *     tráo db/index.ts, @netlify/blobs và @google/genai.
 *
 * PGlite không phải phụ thuộc của dự án. Cài một lần vào thư mục tạm:
 *   mkdir -p /tmp/sectest && cd /tmp/sectest && npm init -y && npm i @electric-sql/pglite@0.3
 * rồi chạy với SECTEST_DIR=/tmp/sectest (mặc định).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WORK = path.resolve(process.env.SECTEST_DIR || "/tmp/sectest");
const OUT = path.join(WORK, "out");

delete process.env.NETLIFY_DB_URL;
delete process.env.NETLIFY_DATABASE_URL;
delete process.env.DATABASE_URL;
process.env.STATION_JWT_SECRET = crypto.randomBytes(32).toString("hex");
delete process.env.STATION_PASSWORD;
process.env.GOOGLE_API_KEY = "sectest-fake-key"; // chỉ để chọn nhánh cấu hình; @google/genai đã bị thay bằng bản giả
delete process.env.STATION_DEFAULT_PASSWORD;

const requireWork = createRequire(path.join(WORK, "package.json"));
let PGlite;
try {
  ({ PGlite } = await import(pathToFileURL(requireWork.resolve("@electric-sql/pglite")).href));
} catch {
  console.error(`Thiếu @electric-sql/pglite trong ${WORK}. Xem hướng dẫn ở đầu tệp.`);
  process.exit(2);
}
const esbuild = await import(pathToFileURL(createRequire(path.join(ROOT, "package.json")).resolve("esbuild")).href);

// ---------------------------------------------------------------------------
//  Cơ sở dữ liệu nhúng + migration
// ---------------------------------------------------------------------------
const pg = new PGlite();
globalThis.__SECTEST_PG = pg;
const migDir = path.join(ROOT, "netlify/database/migrations");
for (const dir of fs.readdirSync(migDir).sort()) {
  const file = path.join(migDir, dir, "migration.sql");
  if (!fs.existsSync(file)) continue;
  const sql = fs.readFileSync(file, "utf8").split("--> statement-breakpoint").join("\n");
  await pg.exec(sql);
}

// ---------------------------------------------------------------------------
//  Bản giả của các dịch vụ ngoài
// ---------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(WORK, "stub-db.mjs"), `
import { drizzle } from "drizzle-orm/pglite";
import * as schema from ${JSON.stringify(path.join(ROOT, "db/schema.ts"))};
export const db = drizzle({ client: globalThis.__SECTEST_PG, schema });
`);
fs.writeFileSync(path.join(WORK, "stub-blobs.mjs"), `
const stores = globalThis.__SECTEST_BLOBS || (globalThis.__SECTEST_BLOBS = new Map());
export function getStore(name) {
  const s = stores.get(name) || new Map(); stores.set(name, s);
  return {
    async set(k, v, o) { s.set(k, { v, metadata: (o && o.metadata) || {} }); },
    async get(k, o) { const e = s.get(k); if (!e) return null; return o && o.type === "arrayBuffer" ? await e.v.arrayBuffer() : e.v; },
    async getMetadata(k) { const e = s.get(k); return e ? { metadata: e.metadata } : null; },
    async getWithMetadata(k, o) { const e = s.get(k); return e ? { data: e.v, metadata: e.metadata } : null; },
    async delete(k) { s.delete(k); },
    async list() { return { blobs: [...s.keys()].map((key) => ({ key })) }; }
  };
}
`);
fs.writeFileSync(path.join(WORK, "stub-genai.mjs"), `
export class GoogleGenAI {
  constructor() { this.models = { generateContent: async (req) => { (globalThis.__SECTEST_AI ||= []).push(req); return { text: "ok" }; } }; }
}
export const Type = new Proxy({}, { get: (_, k) => String(k) });
`);

const stubPlugin = {
  name: "sectest-stubs",
  setup(build) {
    build.onResolve({ filter: /(^|\/)db\/index(\.js|\.ts)?$/ }, () => ({ path: path.join(WORK, "stub-db.mjs") }));
    build.onResolve({ filter: /^@netlify\/blobs$/ }, () => ({ path: path.join(WORK, "stub-blobs.mjs") }));
    build.onResolve({ filter: /^@google\/genai$/ }, () => ({ path: path.join(WORK, "stub-genai.mjs") }));
  }
};

const FUNCTIONS = ["cms", "video", "station-auth", "signal", "vitals", "examination-report", "call-logs", "attachment", "ai", "clinical-ai", "admin-users", "cms-dashboard"];
const fn = {};
for (const name of FUNCTIONS) {
  const outfile = path.join(OUT, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "netlify/functions", `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    plugins: [stubPlugin],
    nodePaths: [path.join(ROOT, "node_modules")],
    external: ["@electric-sql/pglite"],
    logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  fn[name] = (await import(pathToFileURL(outfile).href + `?t=${Date.now()}`)).default;
}

// ---------------------------------------------------------------------------
//  Dữ liệu giả
// ---------------------------------------------------------------------------
const now = Date.now();
const bcrypt = (await import(pathToFileURL(createRequire(path.join(ROOT, "package.json")).resolve("bcryptjs")).href)).default;
const testPassword = "Th1s-is-a-test!";
const testHash = await bcrypt.hash(testPassword, 4);

const ST_A = "TYT-BATXAT-01";
const ST_B = "TYT-YTY-03";
const slug = (c) => c.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

await pg.query("delete from users");
const USERS = {
  admin:   { id: "T-ADMIN", username: "t-admin@test.local", name: "Quản trị Thử", role: "Quản trị viên (Admin)", station_access: "true", doctor_access: "true", can_receive_video: "true", station_code: ST_A },
  editor:  { id: "T-EDITOR", username: "t-editor@test.local", name: "Biên tập Thử", role: "Cán bộ biên tập (Editor)", station_access: "false", doctor_access: "false", can_receive_video: "false", station_code: ST_A },
  stationA:{ id: "T-STA", username: "t-sta@test.local", name: "Cán bộ Trạm A", role: "Cán bộ Điểm trạm (Station Operator)", station_access: "true", doctor_access: "false", can_receive_video: "true", station_code: ST_A },
  stationB:{ id: "T-STB", username: "t-stb@test.local", name: "Cán bộ Trạm B", role: "Cán bộ Điểm trạm (Station Operator)", station_access: "true", doctor_access: "false", can_receive_video: "true", station_code: ST_B },
  doctor:  { id: "T-DOC", username: "t-doc@test.local", name: "BS. Thử", role: "Bác sĩ tuyến trên (Superior Doctor)", station_access: "false", doctor_access: "true", can_receive_video: "true", station_code: ST_A },
  plain:   { id: "T-PLAIN", username: "t-plain@test.local", name: "Tài khoản thường", role: "Cán bộ", station_access: "false", doctor_access: "false", can_receive_video: "false", station_code: ST_A },
  nopass:  { id: "T-NOPASS", username: "t-nopass@test.local", name: "Chưa đặt mật khẩu", role: "Cán bộ Điểm trạm (Station Operator)", station_access: "true", doctor_access: "false", can_receive_video: "true", station_code: ST_A, nohash: true }
};
for (const u of Object.values(USERS)) {
  await pg.query(
    `insert into users (id, username, name, role, can_receive_video, station_access, doctor_access, password_hash, email, phone, station_code, status, must_change_password, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE','false',$12)`,
    [u.id, u.username, u.name, u.role, u.can_receive_video, u.station_access, u.doctor_access, u.nohash ? null : testHash, u.username, "0900000000", u.station_code, now]
  );
}
await pg.query("delete from station_rooms");
for (const [code, name] of [[ST_A, "Trạm A (giả)"], [ST_B, "Trạm B (giả)"]]) {
  await pg.query(`insert into station_rooms (station_code, station_name, status, duty_hours, updated_at) values ($1,$2,'ACTIVE','{"always":true}',$3)`, [code, name, now]);
}

const FAKE_ID = "000000000001";
const ROOM_A = `room-${slug(ST_A)}-sectest1`;
const ROOM_B = `room-${slug(ST_B)}-sectest2`;
await pg.query(
  `insert into appointments (id, patient_name, phone, id_card, service, appointment_date, symptoms, is_telehealth, status, room_id, ts) values
   ('APP-T1','Người Thử A','0911111111',$1,'Khám từ xa','01/01/2026','ho','true','PENDING',$2,$4),
   ('APP-T2','Người Thử B','0922222222','000000000002','Khám từ xa','01/01/2026','sốt','true','PENDING',$3,$4)`,
  [FAKE_ID, ROOM_A, ROOM_B, now]
);
await pg.query(`insert into station_vitals (room_id, station_code, patient_name, bp_sys, ts) values ($1,$2,'Người Thử A',120,$3),($4,$5,'Người Thử B',130,$3)`, [ROOM_A, ST_A, now, ROOM_B, ST_B]);
await pg.query(`insert into examination_reports (report_code, room_id, station_code, patient_name, ts) values ('PK-A',$1,$2,'Người Thử A',$3),('PK-B',$4,$5,'Người Thử B',$3)`, [ROOM_A, ST_A, now, ROOM_B, ST_B]);
await pg.query(`insert into call_logs (id, room_id, station_code, patient_name, operator_username, status, ts) values ('CL-A',$1,$2,'Người Thử A','t-sta@test.local','COMPLETED',$3),('CL-B',$4,$5,'Người Thử B','t-stb@test.local','COMPLETED',$3)`, [ROOM_A, ST_A, now, ROOM_B, ST_B]);
await pg.query(`insert into prescription_signers (id, name, title, signature, is_default, ts) values ('SIG-T','BS. Thử','Bác sĩ','data:image/png;base64,AAAA','true',$1)`, [now]);
await pg.query(`insert into telehealth_rooms (id, patient_name, patient_id, symptoms, status, station_code, routing_state, ringing_since, updated_at) values ($1,'Người Thử A',$2,'ho','WAITING',$3,'RINGING',$4,$4)`, [ROOM_A, FAKE_ID, ST_A, now]);
await pg.query(`insert into telehealth_peers (id, room_id, role, name, last_seen) values ('peer-patient-a',$1,'patient','Người Thử A',$2)`, [ROOM_A, now]);

// ---------------------------------------------------------------------------
//  Tiện ích gọi API
// ---------------------------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function tokenFor(key) {
  const u = USERS[key];
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify({ sub: u.id, username: u.username, name: u.name, role: u.role, scopes: [], stationCode: u.station_code, iat: nowSec, exp: nowSec + 3600 }));
  const sig = crypto.createHmac("sha256", process.env.STATION_JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}
let ipCounter = 1;
async function call(name, { method = "GET", path: p = "", body, as, ip, headers = {} } = {}) {
  const h = { "content-type": "application/json", "x-nf-client-connection-ip": ip || `10.0.0.${ipCounter++ % 250}`, ...headers };
  if (as) h.authorization = `Bearer ${tokenFor(as)}`;
  const req = new Request(`http://localhost/api/${p || name}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await fn[name](req, { ip: h["x-nf-client-connection-ip"] });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text, headers: res.headers };
}
const one = async (sql, params) => (await pg.query(sql, params)).rows[0];

// ---------------------------------------------------------------------------
//  Kịch bản
// ---------------------------------------------------------------------------
const results = [];
async function check(id, title, fnc) {
  let ok = false, detail = "";
  try {
    const r = await fnc();
    ok = r === true || (r && r.ok === true);
    detail = r && r.detail ? r.detail : "";
  } catch (err) {
    detail = "Lỗi: " + (err && err.message);
  }
  results.push({ id, title, ok, detail });
  console.log(`${ok ? "✓" : "✗"} [${id}] ${title}${detail ? " — " + detail : ""}`);
}

console.log("\n== /api/cms ==");
await check("CMS-01", "GET ẩn danh không trả số CCCD/BHYT, SĐT người dân", async () => {
  const r = await call("cms");
  const leaked = r.text.includes(FAKE_ID) || r.text.includes("0911111111");
  return { ok: r.status === 200 && !leaked && Array.isArray(r.data.appointments) && r.data.appointments.length === 0, detail: `HTTP ${r.status}, appointments=${r.data?.appointments?.length}, lộ CCCD/SĐT=${leaked}` };
});
await check("CMS-02", "GET ẩn danh không lộ email/SĐT/trạng thái mật khẩu của cán bộ, chữ ký số", async () => {
  const r = await call("cms");
  const u = r.data.users?.[0] || {};
  const s = r.data.prescriptionSigners?.[0] || {};
  const bad = ["email", "phone", "hasPassword", "lastLoginAt", "mustChangePassword"].filter((k) => k in u);
  return { ok: bad.length === 0 && !s.signature, detail: `trường lộ: [${bad.join(", ")}], chữ ký=${Boolean(s.signature)}` };
});
await check("CMS-03", "GET bằng Quản trị viên vẫn nhận đủ danh sách đăng ký khám", async () => {
  const r = await call("cms", { as: "admin" });
  return { ok: r.data.appointments?.length >= 2 && r.text.includes(FAKE_ID), detail: `appointments=${r.data.appointments?.length}` };
});
await check("CMS-04", "GET bằng tài khoản thường (không quyền) không nhận đăng ký khám", async () => {
  const r = await call("cms", { as: "plain" });
  return { ok: (r.data.appointments || []).length === 0, detail: `appointments=${r.data.appointments?.length}` };
});
await check("CMS-05", "GET bằng cán bộ Trạm B chỉ thấy đăng ký của Trạm B", async () => {
  const r = await call("cms", { as: "stationB" });
  const ids = (r.data.appointments || []).map((a) => a.id);
  return { ok: ids.includes("APP-T2") && !ids.includes("APP-T1"), detail: `thấy: [${ids.join(", ")}]` };
});
await check("CMS-06", "POST lưu tin tức khi chưa đăng nhập bị từ chối (401)", async () => {
  const r = await call("cms", { method: "POST", body: { action: "save", type: "news", data: { id: "N-HACK", title: "x", date: "x", ts: 1 } } });
  const row = await one("select id from news where id='N-HACK'");
  return { ok: r.status === 401 && !row, detail: `HTTP ${r.status}, đã ghi=${Boolean(row)}` };
});
await check("CMS-07", "POST lưu tin tức bằng cán bộ điểm trạm (không phải biên tập) bị từ chối (403)", async () => {
  const r = await call("cms", { method: "POST", as: "stationA", body: { action: "save", type: "news", data: { id: "N-HACK2", title: "x", date: "x", ts: 1 } } });
  return { ok: r.status === 403, detail: `HTTP ${r.status}` };
});
await check("CMS-08", "Biên tập viên lưu được tin tức; mã HTML độc bị vô hiệu hoá", async () => {
  const r = await call("cms", { method: "POST", as: "editor", body: { action: "save", type: "news", data: { id: "N-OK", title: 'Tin <img src=x onerror="alert(1)">', description: "<script>alert(1)</script>", date: "01/01/2026", ts: 5, image: '["javascript:alert(1)","https://example.org/a.jpg"]' } } });
  const row = await one("select title, description, image from news where id='N-OK'");
  const clean = row && !/[<>"]/.test(row.title) && !/<script/i.test(row.description) && !/javascript:/i.test(row.image || "");
  return { ok: r.status === 200 && clean, detail: `HTTP ${r.status}, sạch=${clean}` };
});
await check("CMS-09", "Xoá tin tức khi chưa đăng nhập bị từ chối; dữ liệu còn nguyên", async () => {
  const r = await call("cms", { method: "POST", body: { action: "delete", type: "news", id: "N-OK" } });
  const row = await one("select id from news where id='N-OK'");
  return { ok: r.status === 401 && Boolean(row), detail: `HTTP ${r.status}, còn bản ghi=${Boolean(row)}` };
});
await check("CMS-10", "Xoá đăng ký khám: biên tập viên/cán bộ trạm bị từ chối", async () => {
  const a = await call("cms", { method: "POST", as: "editor", body: { action: "delete", type: "appointments", id: "APP-T1" } });
  const b = await call("cms", { method: "POST", as: "stationA", body: { action: "delete", type: "appointments", id: "APP-T1" } });
  const row = await one("select id from appointments where id='APP-T1'");
  return { ok: a.status === 403 && b.status === 403 && Boolean(row), detail: `editor=${a.status}, trạm=${b.status}, còn bản ghi=${Boolean(row)}` };
});
await check("CMS-11", "Người dân vẫn đăng ký khám được khi chưa đăng nhập; trạng thái bị ép về PENDING", async () => {
  const r = await call("cms", { method: "POST", body: { action: "save", type: "appointments", data: { id: "APP-NEW1", patientName: "Dân <b>Thử</b>", phone: "0933333333", idCard: "000000000003", service: "Khám chung", appointmentDate: "02/01/2026", symptoms: "đau đầu", isTelehealth: "false", status: "COMPLETED", assignedDoctor: "hack", roomId: "room-xyz", ts: 9 } } });
  const row = await one("select status, patient_name, assigned_doctor from appointments where id='APP-NEW1'");
  const leaked = r.text.includes("000000000003");
  return { ok: r.status === 200 && row && row.status === "PENDING" && !row.assigned_doctor && !/[<>]/.test(row.patient_name) && !leaked, detail: `HTTP ${r.status}, status=${row?.status}` };
});
await check("CMS-12", "Người lạ không ghi đè được đăng ký khám đã có (đổi ID trong request)", async () => {
  const r = await call("cms", { method: "POST", body: { action: "save", type: "appointments", data: { id: "APP-T1", patientName: "Ghi đè", phone: "0", appointmentDate: "x", ts: 1 } } });
  const row = await one("select patient_name from appointments where id='APP-T1'");
  return { ok: r.status >= 400 && row.patient_name === "Người Thử A", detail: `HTTP ${r.status}, tên hiện tại giữ nguyên=${row.patient_name === "Người Thử A"}` };
});
await check("CMS-13", "Cán bộ trạm cập nhật được trạng thái đăng ký (luồng tiếp nhận cuộc gọi cũ)", async () => {
  const r = await call("cms", { method: "POST", as: "stationA", body: { action: "save", type: "appointments", data: { id: "APP-T1", patientName: "Người Thử A", phone: "0911111111", appointmentDate: "01/01/2026", status: "IN_CALL", ts: now } } });
  const row = await one("select status from appointments where id='APP-T1'");
  return { ok: r.status === 200 && row.status === "IN_CALL", detail: `HTTP ${r.status}, status=${row.status}` };
});
await check("CMS-14", "Tải tệp đính kèm lên khi chưa đăng nhập bị từ chối", async () => {
  const r = await call("cms", { method: "POST", body: { action: "upload_attachment_chunk", id: "F1", index: 0, total: 1, chunk: "data:text/html;base64,PHNjcmlwdD4=", mimeType: "text/html", fileName: "x.html" } });
  return { ok: r.status === 401, detail: `HTTP ${r.status}` };
});
await check("CMS-15", "Không ai (kể cả Quản trị) ghi được khoá bí mật JWT qua /api/cms", async () => {
  const r = await call("cms", { method: "POST", as: "admin", body: { action: "save", type: "siteConfigs", data: { id: "auth-jwt-secret", value: "x" } } });
  return { ok: r.status === 403, detail: `HTTP ${r.status}` };
});
await check("CMS-16", "Sửa người ký đơn thuốc khi chưa đăng nhập bị từ chối", async () => {
  const r = await call("cms", { method: "POST", body: { action: "save", type: "prescriptionSigners", data: { id: "SIG-T", name: "Giả mạo", title: "x", ts: 1 } } });
  const row = await one("select name from prescription_signers where id='SIG-T'");
  return { ok: r.status === 401 && row.name === "BS. Thử", detail: `HTTP ${r.status}` };
});
await check("CMS-17", "Giới hạn tần suất đăng ký khám ẩn danh từ một IP", async () => {
  let last = 0;
  for (let i = 0; i < 25; i++) {
    const r = await call("cms", { method: "POST", ip: "10.9.9.9", body: { action: "save", type: "appointments", data: { id: `APP-RL${i}`, patientName: "RL", phone: "0", appointmentDate: "x", ts: 1 } } });
    last = r.status;
    if (last === 429) break;
  }
  return { ok: last === 429, detail: `trạng thái cuối=${last}` };
});
await check("CMS-18", "Phản hồi /api/cms không còn CORS mở (*)", async () => {
  const r = await call("cms");
  return { ok: r.headers.get("access-control-allow-origin") !== "*", detail: `ACAO=${r.headers.get("access-control-allow-origin")}` };
});
await check("CMS-19", "Lỗi máy chủ không trả chi tiết kỹ thuật ra ngoài", async () => {
  const r = await call("cms", { method: "POST", as: "admin", body: { action: "save", type: "news", data: { id: "N-BAD" } } });
  return { ok: r.status >= 400 && !/violates|null value|column|relation/i.test(r.text), detail: `HTTP ${r.status}` };
});

await check("CMS-20", "Biên tập viên tải tệp PDF đính kèm tin tức thành công (luồng cũ giữ nguyên)", async () => {
  const r = await call("cms", { method: "POST", as: "editor", body: { action: "upload_attachment_chunk", id: "DOC_T1", index: 0, total: 1, chunk: "data:application/pdf;base64,JVBERi0xLjQ=", mimeType: "application/pdf", fileName: "ke-hoach.pdf" } });
  return { ok: r.status === 200 && r.data.complete === true && r.data.url === "/api/attachment?id=DOC_T1", detail: `HTTP ${r.status}` };
});
await check("CMS-21", "Biên tập viên tải video lên thành công", async () => {
  const r = await call("cms", { method: "POST", as: "editor", body: { action: "upload_chunk", id: "VID_T1", index: 0, total: 1, chunk: "data:video/mp4;base64,AAAA", mimeType: "video/mp4" } });
  return { ok: r.status === 200 && r.data.complete === true, detail: `HTTP ${r.status}` };
});
await check("CMS-22", "Cập nhật một phần (ẩn/hiện video) không xoá các trường khác", async () => {
  await call("cms", { method: "POST", as: "editor", body: { action: "save", type: "videos", data: { id: "VD-T", title: "Rửa tay", description: "Mô tả", url: "https://www.youtube.com/embed/abc", date: "01/01/2026", ts: 3, isCollapsed: "false" } } });
  const r = await call("cms", { method: "POST", as: "editor", body: { action: "save", type: "videos", data: { id: "VD-T", isCollapsed: "true" } } });
  const row = await one("select title, url, is_collapsed from videos where id='VD-T'");
  return { ok: r.status === 200 && row.title === "Rửa tay" && row.url.includes("youtube") && row.is_collapsed === "true", detail: `HTTP ${r.status}` };
});
await check("CMS-23", "Quản trị viên lưu tên phòng khám (siteConfigs) và xoá được đăng ký khám", async () => {
  const a = await call("cms", { method: "POST", as: "admin", body: { action: "save", type: "siteConfigs", data: { id: "station-clinic-name", value: "Phòng khám Thử" } } });
  const b = await call("cms", { method: "POST", as: "admin", body: { action: "delete", type: "appointments", id: "APP-RL0" } });
  return { ok: a.status === 200 && b.status === 200, detail: `${a.status}/${b.status}` };
});
await check("CMS-24", "Tệp không thuộc danh sách cho phép (HTML) bị từ chối kể cả với biên tập viên", async () => {
  const r = await call("cms", { method: "POST", as: "editor", body: { action: "upload_attachment_chunk", id: "F2", index: 0, total: 1, chunk: "PHNjcmlwdD4=", mimeType: "text/html", fileName: "x.html" } });
  return { ok: r.status === 415, detail: `HTTP ${r.status}` };
});

console.log("\n== /api/station-auth ==");
await check("AUTH-01", "Tài khoản chưa đặt mật khẩu KHÔNG đăng nhập được bằng mật khẩu mặc định công khai", async () => {
  const r = await call("station-auth", { method: "POST", body: { username: USERS.nopass.username, password: "Admin123@", scope: "station" } });
  return { ok: r.status === 401 || r.status === 403, detail: `HTTP ${r.status}` };
});
await check("AUTH-02", "Đăng nhập đúng mật khẩu vẫn hoạt động", async () => {
  const r = await call("station-auth", { method: "POST", ip: "10.8.8.1", body: { username: USERS.stationA.username, password: testPassword, scope: "station" } });
  return { ok: r.status === 200 && r.data.success === true && Boolean(r.data.token), detail: `HTTP ${r.status}` };
});
await check("AUTH-03", "Dò mật khẩu bị chặn sau nhiều lần sai (429)", async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const r = await call("station-auth", { method: "POST", ip: "10.7.7.7", body: { username: USERS.stationA.username, password: "sai-" + i, scope: "station" } });
    last = r.status;
    if (last === 429) break;
  }
  return { ok: last === 429, detail: `trạng thái cuối=${last}` };
});

console.log("\n== /api/signal (Telehealth) ==");
await check("SIG-01", "Hàng đợi cuộc gọi (CCCD, triệu chứng) không xem được khi chưa đăng nhập", async () => {
  const r = await call("signal", { path: "signal?action=rooms" });
  return { ok: r.status === 401 && !r.text.includes(FAKE_ID), detail: `HTTP ${r.status}, lộ CCCD=${r.text.includes(FAKE_ID)}` };
});
await check("SIG-02", "Cán bộ trạm đăng nhập vẫn xem được hàng đợi", async () => {
  const r = await call("signal", { path: "signal?action=rooms", as: "stationA" });
  return { ok: r.status === 200 && Array.isArray(r.data.rooms), detail: `HTTP ${r.status}, phòng=${r.data?.rooms?.length}` };
});
await check("SIG-03", "Người lạ đổi peerId để đọc phòng khám của người khác bị từ chối (IDOR)", async () => {
  const r = await call("signal", { path: `signal?roomId=${ROOM_A}&peerId=attacker-1&cursor=0` });
  return { ok: r.status === 403 && !r.text.includes(FAKE_ID), detail: `HTTP ${r.status}, lộ CCCD=${r.text.includes(FAKE_ID)}` };
});
await check("SIG-04", "Người lạ không ghi được sinh hiệu/ghi chú vào phòng khám không phải của mình", async () => {
  const a = await call("signal", { method: "POST", body: { action: "vitals", roomId: ROOM_A, peerId: "attacker-1", vitals: { bpSys: 999 } } });
  const b = await call("signal", { method: "POST", body: { action: "notes", roomId: ROOM_A, peerId: "attacker-1", notes: "giả" } });
  const row = await one("select vitals, notes from telehealth_rooms where id=$1", [ROOM_A]);
  return { ok: a.status === 403 && b.status === 403 && !row.vitals && !row.notes, detail: `vitals=${a.status}, notes=${b.status}` };
});
await check("SIG-05", "Người lạ không đánh dấu hoàn thành đăng ký khám của người khác", async () => {
  await pg.query("update appointments set status='PENDING' where id='APP-T2'");
  await call("signal", { method: "POST", body: { action: "complete", roomId: ROOM_B, peerId: "attacker-2", appointmentId: "APP-T2" } });
  const row = await one("select status from appointments where id='APP-T2'");
  return { ok: row.status === "PENDING", detail: `status=${row.status}` };
});
await check("SIG-06", "Người bệnh trong phòng vẫn nhận được bản tin của phòng mình", async () => {
  const r = await call("signal", { path: `signal?roomId=${ROOM_A}&peerId=peer-patient-a&cursor=999999999` });
  return { ok: r.status === 200 && r.data.ok === true, detail: `HTTP ${r.status}` };
});
await check("SIG-07", "Người dân vẫn bắt đầu được cuộc gọi mới (join vai patient)", async () => {
  const room = `room-${slug(ST_A)}-sectest9`;
  const r = await call("signal", { method: "POST", body: { action: "join", role: "patient", roomId: room, peerId: "peer-new-patient", name: "Dân Thử", patientName: "Dân Thử" } });
  return { ok: r.status === 200 && r.data.ok === true, detail: `HTTP ${r.status}` };
});

await check("SIG-08", "Cán bộ Trạm A vào phòng, gửi sinh hiệu và hoàn tất ca khám (đăng ký chuyển COMPLETED)", async () => {
  await pg.query("update appointments set status='PENDING' where id='APP-T1'");
  const j = await call("signal", { method: "POST", as: "stationA", body: { action: "join", role: "station", roomId: ROOM_A, peerId: "peer-sta", name: "Cán bộ Trạm A" } });
  const v = await call("signal", { method: "POST", as: "stationA", body: { action: "vitals", roomId: ROOM_A, peerId: "peer-sta", vitals: { bpSys: 125 } } });
  const c = await call("signal", { method: "POST", as: "stationA", body: { action: "complete", roomId: ROOM_A, peerId: "peer-sta", appointmentId: "APP-T1" } });
  const row = await one("select status from appointments where id='APP-T1'");
  return { ok: j.status === 200 && v.status === 200 && c.status === 200 && row.status === "COMPLETED", detail: `join=${j.status}, vitals=${v.status}, complete=${c.status}, status=${row.status}` };
});
await check("SIG-09", "Cán bộ Trạm B không vào được phòng của Trạm A", async () => {
  const r = await call("signal", { method: "POST", as: "stationB", body: { action: "join", role: "station", roomId: ROOM_A, peerId: "peer-stb", name: "Cán bộ Trạm B" } });
  return { ok: r.status === 403, detail: `HTTP ${r.status}` };
});
await check("SIG-10", "Người lạ không vào được phòng cố định của trạm (room-<mã trạm>) để nghe lén", async () => {
  const r = await call("signal", { method: "POST", body: { action: "join", role: "patient", roomId: `room-${slug(ST_A)}`, peerId: "lurker", name: "x" } });
  return { ok: r.status === 403, detail: `HTTP ${r.status}` };
});

console.log("\n== Sinh hiệu / Phiếu khám / Nhật ký cuộc gọi (phạm vi điểm trạm) ==");
await check("VIT-01", "Cán bộ Trạm B không đọc được sinh hiệu phòng của Trạm A", async () => {
  const r = await call("vitals", { path: `vitals/${ROOM_A}`, as: "stationB" });
  return { ok: r.status === 403, detail: `HTTP ${r.status}` };
});
await check("VIT-02", "Cán bộ Trạm A và Bác sĩ tuyến trên đọc được sinh hiệu phòng Trạm A", async () => {
  const a = await call("vitals", { path: `vitals/${ROOM_A}`, as: "stationA" });
  const d = await call("vitals", { path: `vitals/${ROOM_A}`, as: "doctor" });
  return { ok: a.status === 200 && d.status === 200 && a.data.data.length === 1, detail: `trạm A=${a.status}, bác sĩ=${d.status}` };
});
await check("VIT-03", "Sinh hiệu không đọc được khi chưa đăng nhập", async () => {
  const r = await call("vitals", { path: `vitals/${ROOM_A}` });
  return { ok: r.status === 401, detail: `HTTP ${r.status}` };
});
await check("RPT-01", "Cán bộ Trạm B không đọc được phiếu khám của Trạm A", async () => {
  const r = await call("examination-report", { path: `examination-report?roomId=${ROOM_A}`, as: "stationB" });
  return { ok: r.status === 403, detail: `HTTP ${r.status}` };
});
await check("RPT-02", "Cán bộ Trạm A đọc được phiếu khám của Trạm A", async () => {
  const r = await call("examination-report", { path: `examination-report?roomId=${ROOM_A}`, as: "stationA" });
  return { ok: r.status === 200 && r.data.data.length === 1, detail: `HTTP ${r.status}` };
});
await check("LOG-01", "Cán bộ Trạm B chỉ thấy nhật ký cuộc gọi của Trạm B", async () => {
  const r = await call("call-logs", { as: "stationB" });
  const ids = (r.data.callLogs || []).map((l) => l.id);
  return { ok: r.status === 200 && ids.includes("CL-B") && !ids.includes("CL-A"), detail: `thấy: [${ids.join(", ")}]` };
});
await check("LOG-02", "Quản trị viên thấy toàn bộ nhật ký cuộc gọi", async () => {
  const r = await call("call-logs", { as: "admin" });
  const ids = (r.data.callLogs || []).map((l) => l.id);
  return { ok: ids.includes("CL-A") && ids.includes("CL-B"), detail: `thấy ${ids.length} bản ghi` };
});
await check("LOG-03", "Cán bộ Trạm B không sửa được nhật ký cuộc gọi của Trạm A (đổi ID)", async () => {
  const r = await call("call-logs", { method: "POST", as: "stationB", body: { action: "update", id: "CL-A", roomId: ROOM_A, diagnosis: "giả mạo" } });
  const row = await one("select diagnosis from call_logs where id='CL-A'");
  return { ok: r.status === 403 && !row.diagnosis, detail: `HTTP ${r.status}` };
});

console.log("\n== Tệp đính kèm ==");
await check("ATT-01", "Tệp tải lên khai Content-Type text/html không chạy được như trang web", async () => {
  globalThis.__SECTEST_BLOBS = globalThis.__SECTEST_BLOBS || new Map();
  const { getStore } = await import(pathToFileURL(path.join(WORK, "stub-blobs.mjs")).href);
  await getStore("attachments").set("EVIL", new Blob(["<script>alert(1)</script>"]), { metadata: { contentType: "text/html" } });
  const r = await call("attachment", { path: "attachment?id=EVIL" });
  const ct = r.headers.get("content-type") || "";
  const csp = r.headers.get("content-security-policy") || "";
  return { ok: !/html/i.test(ct) && /sandbox/.test(csp), detail: `Content-Type=${ct}, CSP=${csp || "(không có)"}` };
});
await check("ATT-02", "Tệp PDF hợp lệ vẫn tải về bình thường", async () => {
  const { getStore } = await import(pathToFileURL(path.join(WORK, "stub-blobs.mjs")).href);
  await getStore("attachments").set("PDF1", new Blob(["%PDF-1.4"]), { metadata: { contentType: "application/pdf" } });
  const r = await call("attachment", { path: "attachment?id=PDF1" });
  return { ok: r.status === 200 && /pdf/.test(r.headers.get("content-type") || ""), detail: `HTTP ${r.status}` };
});

console.log("\n== Tệp đính kèm: công khai / riêng tư ==");
const up = (as, id, extra = {}) => call("cms", { method: "POST", as, body: { action: "upload_attachment_chunk", id, index: 0, total: 1, chunk: "data:application/pdf;base64,JVBERi0xLjQgVEhVLVRFU1Q=", mimeType: "application/pdf", fileName: "x.pdf", ...extra } });
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
await check("FILE-01", "Biên tập viên tải tài liệu công khai; ai cũng xem được, cache công khai", async () => {
  const u = await up("editor", "DOC_PUB1");
  const g = await call("attachment", { path: "attachment?id=DOC_PUB1" });
  return { ok: u.status === 200 && u.data.visibility === "public" && g.status === 200 && /pdf/.test(g.headers.get("content-type") || "") && /public/.test(g.headers.get("cache-control") || ""), detail: `tải lên=${u.status}, xem ẩn danh=${g.status}` };
});
await check("FILE-02", "Tệp riêng tư: chỉ cán bộ y tế tải lên được (ẩn danh 401, tài khoản thường 403, biên tập viên 403)", async () => {
  const a = await up(undefined, "PRIV_X1", { visibility: "private" });
  const b = await up("plain", "PRIV_X2", { visibility: "private" });
  const c = await up("editor", "PRIV_X3", { visibility: "private" });
  const d = await up("stationA", "PRIV_A1", { visibility: "private", chunk: PNG, mimeType: "image/png" });
  return { ok: a.status === 401 && b.status === 403 && c.status === 403 && d.status === 200 && d.data.visibility === "private", detail: `ẩn danh=${a.status}, thường=${b.status}, biên tập=${c.status}, cán bộ trạm A=${d.status}` };
});
await check("FILE-03", "Tệp riêng tư không xem được khi chưa đăng nhập / không quyền / khác trạm", async () => {
  const a = await call("attachment", { path: "attachment?id=PRIV_A1" });
  const b = await call("attachment", { path: "attachment?id=PRIV_A1", as: "plain" });
  const c = await call("attachment", { path: "attachment?id=PRIV_A1", as: "editor" });
  const d = await call("attachment", { path: "attachment?id=PRIV_A1", as: "stationB" });
  const leaked = [a, b, c, d].some((r) => /image\/png/.test(r.headers.get("content-type") || ""));
  return { ok: a.status === 401 && b.status === 403 && c.status === 403 && d.status === 403 && !leaked, detail: `ẩn danh=${a.status}, thường=${b.status}, biên tập=${c.status}, trạm B=${d.status}` };
});
await check("FILE-04", "Tệp riêng tư xem được bởi cán bộ cùng trạm, bác sĩ tuyến trên, Quản trị; không cache", async () => {
  const a = await call("attachment", { path: "attachment?id=PRIV_A1", as: "stationA" });
  const b = await call("attachment", { path: "attachment?id=PRIV_A1", as: "doctor" });
  const c = await call("attachment", { path: "attachment?id=PRIV_A1", as: "admin" });
  return { ok: [a, b, c].every((r) => r.status === 200) && /no-store/.test(a.headers.get("cache-control") || ""), detail: `trạm A=${a.status}, bác sĩ=${b.status}, QT=${c.status}, cache=${a.headers.get("cache-control")}` };
});
await check("FILE-05", "Không tải đè lên tệp đã có bằng cách đổi ID (công khai ↔ riêng tư, cùng loại)", async () => {
  const a = await up("editor", "PRIV_A1");
  const b = await up("stationB", "DOC_T1", { visibility: "private" });
  const c = await up("editor", "DOC_PUB1");
  const g = await call("attachment", { path: "attachment?id=PRIV_A1", as: "stationA" });
  return { ok: a.status === 409 && b.status === 409 && c.status === 409 && /image\/png/.test(g.headers.get("content-type") || ""), detail: `đè riêng tư=${a.status}, đè công khai=${b.status}, đè cùng loại=${c.status}, tệp gốc còn nguyên=${/png/.test(g.headers.get("content-type") || "")}` };
});
await check("FILE-06", "Không chen phần tệp vào lượt tải của người khác", async () => {
  const half = "data:application/pdf;base64,JVBERi0=";
  const a0 = await call("cms", { method: "POST", as: "stationA", body: { action: "upload_attachment_chunk", visibility: "private", id: "PRIV_A2", index: 0, total: 2, chunk: half, mimeType: "application/pdf" } });
  const b1 = await call("cms", { method: "POST", as: "stationB", body: { action: "upload_attachment_chunk", visibility: "private", id: "PRIV_A2", index: 1, total: 2, chunk: "data:application/pdf;base64,R0lBTkdJQQ==", mimeType: "application/pdf" } });
  const a1 = await call("cms", { method: "POST", as: "stationA", body: { action: "upload_attachment_chunk", visibility: "private", id: "PRIV_A2", index: 1, total: 2, chunk: "data:application/pdf;base64,MS40", mimeType: "application/pdf" } });
  const g = await call("attachment", { path: "attachment?id=PRIV_A2", as: "stationA" });
  return { ok: a0.data.complete === false && b1.data.complete === false && a1.data.complete === true && g.text === "%PDF-1.4", detail: `B chen phần: complete=${b1.data.complete}; nội dung cuối đúng của A=${g.text === "%PDF-1.4"}` };
});
await check("FILE-07", "Mã tệp sai định dạng / đường dẫn ../ trả 404 (không còn 500), thiếu mã trả 400", async () => {
  const codes = [];
  for (const id of ["../../etc/passwd", "a/b", "x%00y", "<script>", "PRIV_A1/../DOC_T1"]) codes.push((await call("attachment", { path: `attachment?id=${encodeURIComponent(id)}` })).status);
  const v = await call("video", { path: `video?id=${encodeURIComponent("../../x")}` });
  const m = await call("attachment", { path: "attachment" });
  return { ok: codes.every((c) => c === 404) && v.status === 404 && m.status === 400, detail: `attachment=[${codes}], video=${v.status}, thiếu mã=${m.status}` };
});
await check("FILE-08", "Không có lối xoá/ghi tệp qua /api/attachment, /api/video (POST/PUT/DELETE → 405), tệp còn nguyên", async () => {
  const codes = [];
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    codes.push((await call("attachment", { method: m, path: "attachment?id=DOC_T1", as: "admin" })).status);
    codes.push((await call("video", { method: m, path: "video?id=VID_T1", as: "admin" })).status);
  }
  const still = (await call("attachment", { path: "attachment?id=DOC_T1" })).status === 200 && (await call("video", { path: "video?id=VID_T1" })).status === 200;
  return { ok: codes.every((c) => c === 405) && still, detail: `[${codes}], tệp còn=${still}` };
});
await check("FILE-09", "Tệp cũ (tải lên trước Module 0, không có nhãn) vẫn mở được; Sửa video vẫn thay được tệp", async () => {
  const { getStore } = await import(pathToFileURL(path.join(WORK, "stub-blobs.mjs")).href);
  await getStore("attachments").set("DOC_1700000000000_old01", new Blob(["%PDF-1.3"]), { metadata: { contentType: "application/pdf" } });
  await getStore("attachments").set("OLDIMG", new Blob(["\x89PNG"]), { metadata: { contentType: "image/jpeg" } });
  const a = await call("attachment", { path: "attachment?id=DOC_1700000000000_old01" });
  const i = await call("attachment", { path: "attachment?id=OLDIMG" });
  const v = await call("cms", { method: "POST", as: "editor", body: { action: "upload_chunk", id: "VID_T1", index: 0, total: 1, chunk: "data:video/mp4;base64,BBBB", mimeType: "video/mp4" } });
  return { ok: a.status === 200 && i.status === 200 && /image\/jpeg/.test(i.headers.get("content-type") || "") && v.status === 200 && v.data.complete === true, detail: `PDF cũ=${a.status}, ảnh cũ=${i.status}, sửa video=${v.status}` };
});
await check("FILE-10", "Phiếu tệp riêng tư qua ?token= (cho thẻ <img>) cũng phải đúng quyền", async () => {
  const ok = await call("attachment", { path: `attachment?id=PRIV_A1&token=${tokenFor("stationA")}` });
  const no = await call("attachment", { path: `attachment?id=PRIV_A1&token=${tokenFor("stationB")}` });
  return { ok: ok.status === 200 && no.status === 403, detail: `trạm A=${ok.status}, trạm B=${no.status}` };
});

console.log("\n== /api/ai ==");
await check("AI-01", "Số CCCD và số điện thoại bị che trước khi gửi tới dịch vụ AI bên ngoài", async () => {
  globalThis.__SECTEST_AI = [];
  await call("ai", { method: "POST", body: { prompt: "Tôi tên A, CCCD 001203004567, SĐT 0912345678, bị ho" } });
  const sent = JSON.stringify(globalThis.__SECTEST_AI);
  return { ok: globalThis.__SECTEST_AI.length === 1 && !sent.includes("001203004567") && !sent.includes("0912345678"), detail: `đã gửi=${globalThis.__SECTEST_AI.length}, còn CCCD=${sent.includes("001203004567")}` };
});
await check("AI-02", "Giới hạn tần suất gọi AI ẩn danh từ một IP", async () => {
  let last = 0;
  for (let i = 0; i < 40; i++) {
    const r = await call("ai", { method: "POST", ip: "10.6.6.6", body: { prompt: "hỏi " + i } });
    last = r.status;
    if (last === 429) break;
  }
  return { ok: last === 429, detail: `trạng thái cuối=${last}` };
});

console.log("\n== API quản trị ==");
await check("ADM-01", "Danh sách tài khoản: chưa đăng nhập 401, tài khoản thường 403, Quản trị 200", async () => {
  const a = await call("admin-users");
  const b = await call("admin-users", { as: "plain" });
  const c = await call("admin-users", { as: "admin" });
  return { ok: a.status === 401 && b.status === 403 && c.status === 200, detail: `${a.status}/${b.status}/${c.status}` };
});
await check("ADM-02", "Thống kê CMS: tài khoản thường bị từ chối", async () => {
  const a = await call("cms-dashboard", { path: "cms/dashboard" });
  const b = await call("cms-dashboard", { path: "cms/dashboard", as: "plain" });
  return { ok: a.status === 401 && b.status === 403, detail: `${a.status}/${b.status}` };
});

const failed = results.filter((r) => !r.ok);
console.log(`\nTổng: ${results.length} kịch bản, ${results.length - failed.length} đạt, ${failed.length} không đạt.`);
if (process.env.SECTEST_JSON) fs.writeFileSync(process.env.SECTEST_JSON, JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
