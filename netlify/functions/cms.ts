import { db } from "../../db/index.js";
import { news, vaccines, documents, services, users, siteConfigs, contacts, videos, appointments, prescriptionSigners } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { getStore } from "@netlify/blobs";
import { isAdminRole, publicUser, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD_HASH, type AuthContext } from "../lib/auth.js";
import { stationFromRoomId, stationMapCached } from "../lib/stations.js";
import {
  boundStationOf,
  canEditContent,
  canHandleAppointments,
  canManageSigners,
  clientIp,
  optionalAuth,
  plainText,
  safeId,
  safeUrl,
  servesAllStations,
  throttle
} from "../lib/guard.js";

/* Bộ tài khoản gieo hạt khi bảng users còn trống.
   Riêng Quản trị viên (U1) được nạp sẵn chuỗi băm bcrypt của mật khẩu mặc định
   để site mới dựng là đăng nhập được ngay; các tài khoản còn lại chưa có mật
   khẩu riêng và đi theo luồng mật khẩu khởi tạo trong station-auth.ts. */
const defaultUsers = [
  { id: 'U1', username: DEFAULT_ADMIN_USERNAME, name: 'Trạm trưởng', role: 'Quản trị viên (Admin)', canReceiveVideo: 'true', stationAccess: 'true', doctorAccess: 'true', passwordHash: DEFAULT_ADMIN_PASSWORD_HASH, email: DEFAULT_ADMIN_USERNAME, stationCode: 'TYT-BATXAT-01', status: 'ACTIVE', mustChangePassword: 'false' },
  { id: 'U2', username: 'bacsituvan@laocai.gov.vn', name: 'BS. Nguyễn Thị Mai (Tư vấn Telehealth)', role: 'Bác sĩ nhận cuộc gọi', canReceiveVideo: 'true', stationAccess: 'false', doctorAccess: 'true', passwordHash: null, email: 'bacsituvan@laocai.gov.vn', stationCode: 'TYT-BATXAT-01', status: 'ACTIVE', mustChangePassword: 'false' },
  { id: 'U3', username: 'bientapvien@laocai.gov.vn', name: 'Cán bộ Truyền thông', role: 'Cán bộ biên tập (Editor)', canReceiveVideo: 'false', stationAccess: 'false', doctorAccess: 'false', passwordHash: null, email: 'bientapvien@laocai.gov.vn', stationCode: 'TYT-BATXAT-01', status: 'ACTIVE', mustChangePassword: 'false' },
  { id: 'U4', username: 'canbotram@laocai.gov.vn', name: 'Y sĩ Cán bộ Điểm trạm', role: 'Cán bộ Điểm trạm (Station Operator)', canReceiveVideo: 'true', stationAccess: 'true', doctorAccess: 'false', passwordHash: null, email: 'canbotram@laocai.gov.vn', stationCode: 'TYT-BATXAT-01', status: 'ACTIVE', mustChangePassword: 'false' },
  { id: 'U5', username: 'bstuyentren@laocai.gov.vn', name: 'BS. CKI Tuyến trên (Hội chẩn từ xa)', role: 'Bác sĩ tuyến trên (Superior Doctor)', canReceiveVideo: 'true', stationAccess: 'false', doctorAccess: 'true', passwordHash: null, email: 'bstuyentren@laocai.gov.vn', stationCode: 'TYT-BATXAT-01', status: 'ACTIVE', mustChangePassword: 'true' }
];

/* Khoá cấu hình mang bí mật của hệ thống, không được đi ra trình duyệt cùng
   phần cấu hình công khai (tên phòng khám, ...). */
const PRIVATE_CONFIG_IDS = new Set(['auth-jwt-secret']);

const defaultSigners = [
  { id: 'SIG1', name: 'BS. Nguyễn Thị Mai (Tư vấn Telehealth)', title: 'Bác sĩ', license: '001234/LCA-CCHN', workplace: 'Trạm Y tế Bát Xát', signature: '', isDefault: 'true', ts: Date.now() },
  { id: 'SIG2', name: 'Trạm trưởng', title: 'BS. Trạm Trưởng', license: '001000/LCA-CCHN', workplace: 'Trạm Y tế Bát Xát', signature: '', isDefault: 'false', ts: Date.now() }
];

const defaultNews = [
  { id: 'N3', title: 'Cảnh báo khẩn: Gia tăng ca mắc sốt xuất huyết tại địa bàn xã', description: 'Trạm Y tế Bát Xát khuyến cáo bà con diệt bọ gậy, dọn dẹp vật chứa nước.', date: '29/05/2026', icon: 'fa-mosquito', color: 'red', ts: 3, image: null },
  { id: 'N2', title: 'Hướng dẫn phòng tránh ngộ độc nấm độc rừng mùa hè', description: 'Tuyệt đối không hái nấm lạ, nấm có màu sắc sặc sỡ để ăn.', date: '25/05/2026', icon: 'fa-skull-crossbones', color: 'orange', ts: 2, image: null }
];

const defaultDocuments = [
  { id: 'D1', title: 'Mẫu Giấy xin chuyển tuyến BHYT chuẩn', type: 'Biểu mẫu y tế', url: '#', date: '26/05/2026', ts: 2 },
  { id: 'D2', title: 'Tài liệu hướng dẫn 3 bước phòng Sốt Rét tại nhà', type: 'Tài liệu y tế', url: '#', date: '25/05/2026', ts: 1 }
];

const defaultVaccines = [
  { id: 'V1', date: 'Sáng 05/06/2026', time: '07:30 - 11:30', target: 'Trẻ em & Phụ nữ mang thai thuộc: Thôn 1, Thôn 2, Thôn 3, Thôn 4, Thôn 5', ts: 2 },
  { id: 'V2', date: 'Sáng 06/06/2026', time: '07:30 - 11:30', target: 'Trẻ em & Phụ nữ mang thai thuộc: Thôn 6, Thôn 7, Thôn 8, Thôn 9, Thôn 10', ts: 1 }
];

const defaultServices = [
  { id: 'S1', name: 'Phòng Khám Chung / Đa Khoa', person: 'BS. Trạm Trưởng', zalo: '0382103002', ts: 3 },
  { id: 'S2', name: 'Phòng Khám Sản - Phụ Khoa', person: 'Nữ hộ sinh chuyên trách', zalo: '0382103002', ts: 2 },
  { id: 'S3', name: 'Phòng Y Học Cổ Truyền', person: 'Cán bộ Đông Y', zalo: '0382103002', ts: 1 }
];

const defaultContacts = [
  { id: 'C1', name: 'BS. Trạm Trưởng', role: 'Trạm trưởng Trạm Y tế', phone: '0382103002', ts: 3 },
  { id: 'C2', name: 'Nữ hộ sinh chuyên trách', role: 'Phòng Khám Sản - Phụ Khoa', phone: '0382103002', ts: 2 },
  { id: 'C3', name: 'Cán bộ Đông Y', role: 'Phòng Y Học Cổ Truyền', phone: '0382103002', ts: 1 }
];

const defaultVideos = [
  { id: 'VD1', title: 'Hướng dẫn rửa tay 6 bước chuẩn Bộ Y tế', description: 'Video hướng dẫn rửa tay bằng xà phòng đúng cách phòng tránh dịch bệnh truyền nhiễm hiệu quả.', url: 'https://www.youtube.com/embed/fA4P9B2U-q0', date: '01/06/2026', ts: 101, isCollapsed: 'false' },
  { id: 'VD2', title: 'Sơ cứu dị vật đường thở ở trẻ em', description: 'Hướng dẫn phụ huynh và giáo viên cách xử trí nhanh khi trẻ bị hóc dị vật bằng nghiệm pháp Heimlich an toàn.', url: 'https://www.youtube.com/embed/T00O3IitfRE', date: '28/05/2026', ts: 100, isCollapsed: 'false' }
];

/* =============================================================================
   PHÂN QUYỀN /api/cms (Module 0 - vá bảo mật khẩn)

   Trước bản vá, tuyến này KHÔNG kiểm tra đăng nhập: ai cũng tải được toàn bộ
   danh sách đăng ký khám (họ tên, SĐT, số CCCD, triệu chứng) và ai cũng thêm/
   sửa/xoá được tin tức, tài liệu, đăng ký khám, người ký đơn thuốc. Đường dẫn,
   các action/type và định dạng phản hồi giữ nguyên để giao diện cũ chạy tiếp;
   thứ thay đổi là AI được làm gì:

     GET  ẩn danh          nội dung công khai; appointments = [], danh sách cán bộ
                           rút gọn (không email/SĐT/trạng thái mật khẩu), người ký
                           đơn không kèm ảnh chữ ký.
     GET  cán bộ y tế      (station/doctor/admin) thêm đăng ký khám và chữ ký số;
                           cán bộ điểm trạm chỉ thấy đăng ký của trạm mình.
     POST nội dung         Quản trị viên hoặc Biên tập viên.
     POST người ký đơn     Quản trị viên hoặc Bác sĩ.
     POST đăng ký khám     người dân chỉ được TẠO MỚI (trạng thái ép về PENDING,
                           có giới hạn tần suất); sửa cần cán bộ y tế; xoá chỉ
                           Quản trị viên.
   ============================================================================= */

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { headers, status });

const CONTENT_TYPES = new Set(["news", "vaccines", "documents", "services", "contacts", "videos", "siteConfigs"]);
const APPOINTMENT_STATUSES = new Set(["PENDING", "CONFIRMED", "IN_CALL", "COMPLETED", "REJECTED", "CANCELLED"]);

/** Người dân: tối đa 20 lượt đăng ký khám / giờ / IP. */
const PUBLIC_APPOINTMENT_LIMIT = 20;
const PUBLIC_APPOINTMENT_WINDOW_MS = 60 * 60 * 1000;

const ATTACHMENT_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain"
]);
const VIDEO_MIME = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]);
const MAX_ATTACHMENT_CHUNKS = 8; // 8 x 3MB, giao diện đã giới hạn 15MB
const MAX_VIDEO_CHUNKS = 120;

/* Đặc tả trường cho phép ghi của từng bảng. Trường không có trong đặc tả bị bỏ
   qua (chống gán hàng loạt); trường không gửi lên thì không đụng tới, nên lệnh
   cập nhật một phần không xoá mất dữ liệu đang có. */
type FieldKind = "num" | "bool" | "url" | "img" | "imgs" | "atts" | "icon" | "color" | "status" | "id" | `text:${number}` | `raw:${number}`;
const FIELDS: Record<string, Record<string, FieldKind>> = {
  news: { title: "text:300", description: "text:20000", date: "text:40", ts: "num", icon: "icon", color: "color", image: "imgs", attachments: "atts" },
  vaccines: { date: "text:100", time: "text:100", target: "text:2000", ts: "num" },
  documents: { title: "text:500", type: "text:200", url: "url", date: "text:40", ts: "num" },
  services: { name: "text:300", person: "text:300", zalo: "text:30", ts: "num" },
  contacts: { name: "text:300", role: "text:300", phone: "text:30", ts: "num" },
  videos: { title: "text:500", description: "text:5000", url: "url", date: "text:40", ts: "num", isCollapsed: "bool" },
  siteConfigs: { value: "raw:200000" },
  prescriptionSigners: { name: "text:300", title: "text:200", license: "text:100", workplace: "text:300", signature: "img", isDefault: "bool", ts: "num" },
  appointments: {
    patientName: "text:200", phone: "text:30", dob: "text:40", gender: "text:20", idCard: "text:32", service: "text:300",
    appointmentDate: "text:60", symptoms: "text:4000", isTelehealth: "bool", status: "status", roomId: "id",
    assignedDoctor: "text:200", ts: "num"
  }
};

function cleanImages(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value);
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      const kept = list.map((u) => safeUrl(u, { allowImageData: true })).filter(Boolean);
      return kept.length ? JSON.stringify(kept) : null;
    }
  } catch {
    /* không phải JSON: một đường dẫn ảnh đơn lẻ (dữ liệu cũ) */
  }
  return safeUrl(raw, { allowImageData: true }) || null;
}

function cleanAttachments(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const list = JSON.parse(String(value));
    if (!Array.isArray(list)) return null;
    const kept = list
      .map((a: any) => ({ name: plainText(a && a.name, 255), url: safeUrl(a && a.url) }))
      .filter((a) => a.url);
    return kept.length ? JSON.stringify(kept) : null;
  } catch {
    return null;
  }
}

function cleanValue(kind: FieldKind, value: unknown): unknown {
  if (kind.startsWith("text:")) return value === null ? null : plainText(value, Number(kind.slice(5)));
  if (kind.startsWith("raw:")) return String(value ?? "").slice(0, Number(kind.slice(4)));
  switch (kind) {
    case "num": {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : Date.now();
    }
    case "bool":
      return value === true || String(value) === "true" ? "true" : "false";
    case "url":
      return safeUrl(value) || "#";
    case "img":
      return safeUrl(value, { allowImageData: true });
    case "imgs":
      return cleanImages(value);
    case "atts":
      return cleanAttachments(value);
    case "icon":
      return /^fa[a-z]?-[a-z0-9-]+$/i.test(String(value || "")) ? String(value) : "fa-bullhorn";
    case "color":
      return /^[a-z]{2,20}$/i.test(String(value || "")) ? String(value) : "medical";
    case "status": {
      const st = String(value || "").toUpperCase();
      return APPOINTMENT_STATUSES.has(st) ? st : "PENDING";
    }
    case "id":
      return value === null ? null : safeId(value, 200) || null;
  }
  return null;
}

function cleanRecord(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const spec = FIELDS[type] || {};
  const out: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(spec)) {
    if (Object.prototype.hasOwnProperty.call(data, field)) out[field] = cleanValue(kind, data[field]);
  }
  return out;
}

const TABLES: Record<string, any> = {
  news, vaccines, documents, services, contacts, videos, siteConfigs, appointments, prescriptionSigners
};

/** Danh sách cán bộ cho người chưa đăng nhập: đủ để dựng ô chọn tài khoản trực. */
function rosterUser(u: any) {
  const p = publicUser(u);
  return {
    id: p.id,
    username: p.username,
    name: p.name,
    role: p.role,
    stationCode: p.stationCode,
    canReceiveVideo: p.canReceiveVideo,
    stationAccess: p.stationAccess,
    doctorAccess: p.doctorAccess,
    attendanceAccess: p.attendanceAccess,
    status: p.status
  };
}

async function appointmentStation(roomId: string | null | undefined): Promise<string> {
  if (!roomId) return "";
  const stations = await stationMapCached(Date.now());
  return stationFromRoomId(String(roomId), stations.keys()).toUpperCase();
}

/** Cán bộ điểm trạm chỉ thấy/sửa đăng ký thuộc trạm mình (hoặc chưa gắn trạm). */
async function appointmentVisibleTo(ctx: AuthContext, roomId: string | null | undefined): Promise<boolean> {
  if (servesAllStations(ctx)) return true;
  const station = await appointmentStation(roomId);
  return !station || station === boundStationOf(ctx);
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  try {
    const ctx = await optionalAuth(req);
    const deny = () =>
      ctx
        ? json({ success: false, code: "FORBIDDEN", error: "Tài khoản không có quyền thực hiện thao tác này." }, 403)
        : json({ success: false, code: "UNAUTHENTICATED", error: "Vui lòng đăng nhập CMS để thực hiện thao tác này." }, 401);

    if (req.method === "GET") {
      /* Mười bảng lưu trữ này trước đây đọc nối tiếp nhau: mỗi truy vấn phải chờ
         truy vấn trước trả về, nên trang chủ và Bảng điều khiển điểm trạm đứng hình
         đúng bằng TỔNG thời gian của cả mười lượt đi - về cơ sở dữ liệu. Chúng độc
         lập với nhau nên gom hết vào một Promise.all: cả mười cùng chạy, thời gian
         nạp chỉ còn bằng truy vấn chậm nhất. Bảng đăng ký khám chỉ được đọc khi
         người gọi là cán bộ y tế. */
      const staff = canHandleAppointments(ctx);
      let [
        newsList,
        vaccinesList,
        docsList,
        servicesList,
        usersList,
        contactsList,
        videosList,
        appointmentsList,
        configsList,
        signersList
      ] = await Promise.all([
        db.select().from(news),
        db.select().from(vaccines),
        db.select().from(documents),
        db.select().from(services),
        db.select().from(users),
        db.select().from(contacts),
        db.select().from(videos),
        staff ? db.select().from(appointments) : Promise.resolve([] as (typeof appointments.$inferSelect)[]),
        db.select().from(siteConfigs),
        db.select().from(prescriptionSigners)
      ]);

      /* Bảng nào còn trống thì nạp dữ liệu mẫu rồi đọc lại - cũng chạy song song và
         chỉ đụng tới đúng những bảng thực sự trống. Lần chạy đầu tiên của một cơ sở
         dữ liệu mới vì thế cũng không cộng dồn độ trễ. */
      const seedJobs: Promise<void>[] = [];
      if (newsList.length === 0) {
        seedJobs.push(db.insert(news).values(defaultNews).then(async () => { newsList = await db.select().from(news); }));
      }
      if (vaccinesList.length === 0) {
        seedJobs.push(db.insert(vaccines).values(defaultVaccines).then(async () => { vaccinesList = await db.select().from(vaccines); }));
      }
      if (docsList.length === 0) {
        seedJobs.push(db.insert(documents).values(defaultDocuments).then(async () => { docsList = await db.select().from(documents); }));
      }
      if (servicesList.length === 0) {
        seedJobs.push(db.insert(services).values(defaultServices).then(async () => { servicesList = await db.select().from(services); }));
      }
      if (usersList.length === 0) {
        seedJobs.push(db.insert(users).values(defaultUsers).then(async () => { usersList = await db.select().from(users); }));
      }
      if (contactsList.length === 0) {
        seedJobs.push(db.insert(contacts).values(defaultContacts).then(async () => { contactsList = await db.select().from(contacts); }));
      }
      if (videosList.length === 0) {
        seedJobs.push(db.insert(videos).values(defaultVideos).then(async () => { videosList = await db.select().from(videos); }));
      }
      // Danh sách người ký đơn thuốc kèm chữ ký số đã lưu sẵn
      if (signersList.length === 0) {
        seedJobs.push(db.insert(prescriptionSigners).values(defaultSigners).then(async () => { signersList = await db.select().from(prescriptionSigners); }));
      }
      if (seedJobs.length) await Promise.all(seedJobs);

      configsList = configsList.filter(c => !PRIVATE_CONFIG_IDS.has(c.id));

      /* Tự động đồng bộ các Bác sĩ được cấp quyền nhận cuộc gọi Video
         (canReceiveVideo = true) sang danh sách Người ký số. Gom các bản ghi còn
         thiếu rồi ghi một lượt duy nhất, đồng thời nối thẳng vào kết quả trả về nên
         bỏ được cả vòng ghi từng dòng lẫn lượt đọc lại cả bảng ở cuối. */
      const newSigners: any[] = [];
      for (const u of usersList) {
        if (u.canReceiveVideo !== 'true') continue;
        const trung = (ten: string) => ten.toLowerCase().includes(u.name.toLowerCase()) || u.name.toLowerCase().includes(ten.toLowerCase());
        const exists = signersList.some(s => s.id === u.id || trung(s.name)) || newSigners.some(s => trung(s.name));
        if (exists) continue;
        newSigners.push({
          id: 'SIG_' + u.id,
          name: u.name,
          title: u.name.startsWith('BS.') ? 'Bác sĩ' : 'Bác sĩ/Y sĩ',
          license: '00' + Math.floor(100000 + Math.random() * 900000) + '/LCA-CCHN',
          workplace: 'Trạm Y tế Bát Xát',
          signature: '',
          isDefault: 'false',
          ts: Date.now()
        });
      }
      if (newSigners.length) {
        await db.insert(prescriptionSigners).values(newSigners);
        signersList = signersList.concat(newSigners as any);
      }

      if (staff && ctx && !servesAllStations(ctx)) {
        const stations = await stationMapCached(Date.now());
        const bound = boundStationOf(ctx);
        appointmentsList = appointmentsList.filter((a) => {
          const st = a.roomId ? stationFromRoomId(a.roomId, stations.keys()).toUpperCase() : "";
          return !st || st === bound;
        });
      }

      return json({
        news: newsList,
        vaccines: vaccinesList,
        documents: docsList,
        services: servicesList,
        /* Chuỗi băm mật khẩu không bao giờ rời máy chủ (publicUser). Người chưa
           đăng nhập chỉ nhận bản rút gọn: không email, SĐT, trạng thái mật khẩu
           hay giờ đăng nhập - những thứ chỉ giúp kẻ dò tài khoản. */
        users: ctx && servesAllStations(ctx) ? usersList.map(publicUser) : usersList.map(rosterUser),
        contacts: contactsList,
        videos: videosList,
        appointments: appointmentsList,
        siteConfigs: configsList,
        // Ảnh chữ ký số chỉ đi tới cán bộ y tế đã đăng nhập (chống giả mạo đơn thuốc).
        prescriptionSigners: staff ? signersList : signersList.map((s) => ({ ...s, signature: "" }))
      });
    }

    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const body = (await req.json().catch(() => null)) as Record<string, any> | null;
    if (!body || typeof body !== "object") return json({ error: "Nội dung yêu cầu không hợp lệ." }, 400);
    const { action, type } = body;

    if (action === "upload_chunk" || action === "upload_attachment_chunk") {
      if (!canEditContent(ctx)) return deny();
      const isVideo = action === "upload_chunk";
      const fileId = safeId(body.id);
      const index = Number(body.index);
      const total = Number(body.total);
      const chunk = typeof body.chunk === "string" ? body.chunk : "";
      const mimeType = String(body.mimeType || "").toLowerCase();
      const maxChunks = isVideo ? MAX_VIDEO_CHUNKS : MAX_ATTACHMENT_CHUNKS;
      if (!fileId || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > maxChunks || index < 0 || index >= total || !chunk) {
        return json({ error: "Missing parameters" }, 400);
      }
      if (!(isVideo ? VIDEO_MIME : ATTACHMENT_MIME).has(mimeType)) {
        return json({ error: "Loại tệp không được phép tải lên." }, 415);
      }

      const base64Data = chunk.split(",")[1] || chunk;
      const buffer = Buffer.from(base64Data, "base64");
      if (buffer.length > 3.5 * 1024 * 1024) return json({ error: "Phần tệp quá lớn." }, 413);

      const chunkStore = getStore(isVideo ? "video-chunks" : "attachment-chunks");
      await chunkStore.set(`${fileId}/${index}`, new Blob([buffer]));

      let allUploaded = true;
      const chunkList: Buffer[] = [];
      for (let i = 0; i < total; i++) {
        const got = await chunkStore.get(`${fileId}/${i}`, { type: "arrayBuffer" });
        if (!got) {
          allUploaded = false;
          break;
        }
        chunkList.push(Buffer.from(got));
      }

      if (!allUploaded) return json({ success: true, complete: false });

      const finalBuffer = Buffer.concat(chunkList);
      const finalStore = getStore(isVideo ? "videos" : "attachments");
      await finalStore.set(fileId, new Blob([finalBuffer]), { metadata: { contentType: mimeType } });
      for (let i = 0; i < total; i++) {
        await chunkStore.delete(`${fileId}/${i}`);
      }
      return isVideo
        ? json({ success: true, complete: true, url: `/api/video?id=${fileId}` })
        : json({ success: true, complete: true, url: `/api/attachment?id=${fileId}`, name: plainText(body.fileName, 255) });
    }

    if (action !== "save" && action !== "delete") {
      return json({ error: "Invalid action" }, 400);
    }

    if (type === "users") {
      /* Tài khoản KHÔNG ghi được qua tuyến này. Mọi thao tác tài khoản đi qua
         /api/admin-users, nơi bắt buộc phiếu phiên có phạm vi "admin". */
      return json({
        error: "Thao tác tài khoản phải thực hiện qua /api/admin-users (yêu cầu quyền Quản trị)."
      }, 403);
    }
    const table = TABLES[String(type)];
    if (!table) return json({ error: "Invalid type" }, 400);

    if (action === "delete") {
      const id = safeId(body.id, 200);
      if (!id) return json({ error: "Thiếu mã bản ghi." }, 400);
      if (type === "siteConfigs" && PRIVATE_CONFIG_IDS.has(id)) {
        return json({ error: "Không được xoá cấu hình hệ thống này." }, 403);
      }
      const allowed =
        type === "appointments" ? Boolean(ctx && isAdminRole(ctx.user.role))
        : type === "prescriptionSigners" ? canManageSigners(ctx)
        : canEditContent(ctx);
      if (!allowed) return deny();
      const key = type === "siteConfigs" ? siteConfigs.id : table.id;
      await db.delete(table).where(eq(key, id));
      return json({ success: true });
    }

    // action === "save"
    const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
    const id = safeId(data.id, 200);
    if (!id) return json({ error: "Thiếu hoặc sai mã bản ghi." }, 400);
    if (type === "siteConfigs" && PRIVATE_CONFIG_IDS.has(id)) {
      return json({ error: "Không được sửa cấu hình hệ thống này." }, 403);
    }

    const record = cleanRecord(String(type), data);

    if (type === "appointments") {
      const existing = await db.select().from(appointments).where(eq(appointments.id, id));

      if (canHandleAppointments(ctx)) {
        if (existing.length) {
          if (!(await appointmentVisibleTo(ctx as AuthContext, existing[0].roomId))) return deny();
          await db.update(appointments).set(record).where(eq(appointments.id, id));
        } else {
          await db.insert(appointments).values({ ...(record as any), id });
        }
        return json({ success: true });
      }

      /* Người dân (chưa đăng nhập): chỉ được tạo đăng ký MỚI. Không ghi đè bản
         ghi đã có dù biết mã, không tự đặt trạng thái hay bác sĩ phụ trách. */
      if (existing.length) return deny();
      const wait = await throttle(`cms-appt:${clientIp(req)}`, PUBLIC_APPOINTMENT_LIMIT, PUBLIC_APPOINTMENT_WINDOW_MS);
      if (wait) {
        return json({ success: false, code: "TOO_MANY_REQUESTS", error: `Gửi quá nhiều đăng ký. Vui lòng thử lại sau ${Math.ceil(wait / 60)} phút.` }, 429);
      }
      await db.insert(appointments).values({
        ...(record as any),
        id,
        status: "PENDING",
        assignedDoctor: null,
        ts: Date.now()
      });
      return json({ success: true });
    }

    const allowed = type === "prescriptionSigners" ? canManageSigners(ctx) : CONTENT_TYPES.has(String(type)) && canEditContent(ctx);
    if (!allowed) return deny();

    const key = type === "siteConfigs" ? siteConfigs.id : table.id;
    const existing = await db.select().from(table).where(eq(key, id));
    if (existing.length > 0) {
      await db.update(table).set(record).where(eq(key, id));
    } else {
      await db.insert(table).values({ ...record, id });
    }
    return json({ success: true });
  } catch (err: any) {
    /* Không ghi err.message: lỗi truy vấn của Drizzle chép nguyên tham số (họ tên,
       số CCCD...) vào thông điệp. Log chỉ giữ loại lỗi và mã lỗi Postgres. */
    console.error("cms error:", err?.name || "Error", err?.cause?.code || err?.code || "");
    return json({ error: "Máy chủ không xử lý được yêu cầu. Vui lòng kiểm tra dữ liệu và thử lại." }, 500);
  }
};

export const config = {
  path: "/api/cms",
};
