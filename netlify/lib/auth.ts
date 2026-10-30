/**
 * Lớp Xác thực & Phân quyền dùng chung cho toàn bộ Netlify Functions.
 *
 * Ba việc lớp này lo:
 *   1. Băm và đối chiếu mật khẩu bằng bcrypt (bcryptjs - bản thuần JavaScript,
 *      không cần biên dịch phần mở rộng gốc nên chạy được trong môi trường
 *      serverless bị đóng gói bằng esbuild).
 *   2. Ký và kiểm tra phiếu phiên JWT HS256 bằng Web Crypto có sẵn của runtime,
 *      không thêm thư viện ngoài.
 *   3. Middleware phân quyền: đọc phiếu từ header Authorization rồi khẳng định
 *      tài khoản còn hiệu lực VÀ đang giữ đúng quyền mà tuyến đường yêu cầu.
 *
 * Nguyên tắc: quyền luôn được đọc lại từ cơ sở dữ liệu ở mỗi lần gọi, KHÔNG tin
 * hoàn toàn vào nội dung phiếu. Nhờ vậy Quản trị thu hồi quyền hoặc khoá tài
 * khoản là có hiệu lực ngay, không phải chờ phiếu hết hạn.
 */
import bcrypt from "bcryptjs";
import { db } from "../../db/index.js";
import { users, siteConfigs } from "../../db/schema.js";
import { eq, sql } from "drizzle-orm";

/** Số vòng bcrypt cho mật khẩu MỚI. Chuỗi băm cũ (10 vòng) vẫn đối chiếu được
 *  bình thường; chúng lên 12 vòng ở lần đổi/đặt lại mật khẩu kế tiếp. */
const BCRYPT_ROUNDS = 12;

/** Tên đăng nhập của Quản trị viên hệ thống (tài khoản gốc của Trạm Y tế Bát Xát). */
export const DEFAULT_ADMIN_USERNAME = "tytbatxat@laocai.gov.vn";

/** Thời hạn phiếu phiên: 8 giờ, đủ một ca trực tại điểm trạm. */
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

/** Khoá lưu bí mật ký phiếu trong bảng site_configs khi không có biến môi trường. */
const JWT_SECRET_CONFIG_ID = "auth-jwt-secret";

export type UserRow = typeof users.$inferSelect;

export type TokenClaims = {
  sub: string;
  username: string;
  name: string;
  role: string;
  /** Phạm vi được cấp trong phiếu: "station", "doctor", "admin", "video", "attendance". */
  scopes: string[];
  stationCode: string | null;
  iat: number;
  exp: number;
  /**
   * Dấu phiên bản mật khẩu (passwordVersion). Đổi hoặc đặt lại mật khẩu là mọi
   * phiếu cấp trước đó mất hiệu lực ngay. Phiếu cũ không có trường này vẫn được
   * nhận tới khi hết hạn (tối đa 8 giờ) để không đẩy cán bộ đang trực ra ngoài
   * lúc triển khai.
   */
  pwv?: string;
  /**
   * Mã phiên (auth_sessions.id). Phiếu cấp qua /api/auth/login luôn có; phân hệ
   * Chấm công từ chối phiếu không có jti hoặc có jti đã bị thu hồi.
   */
  jti?: string;
};

export type AuthContext = {
  user: UserRow;
  claims: TokenClaims;
};

// ---------------------------------------------------------------------------
//  Mật khẩu
// ---------------------------------------------------------------------------

/** Băm mật khẩu dạng rõ thành chuỗi bcrypt ($2b$...). */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Đối chiếu mật khẩu rõ với chuỗi băm đã lưu. Không bao giờ ném lỗi ra ngoài.
 *
 * Mật khẩu nằm trong BLOCKED_PASSWORDS luôn bị coi là sai, kể cả khi khớp chuỗi
 * băm: các mật khẩu mặc định của tài khoản Quản trị từng được ghi rõ trong mã
 * nguồn công khai và vẫn còn trong lịch sử Git, nên ai cũng biết. Không chặn ở
 * đây thì người lạ đăng nhập thẳng, hoặc dùng lối đổi mật khẩu (chỉ đòi mật khẩu
 * hiện tại) để chiếm tài khoản còn giữ mật khẩu mặc định. Tài khoản bị ảnh hưởng
 * được Quản trị khác đặt lại mật khẩu tạm như bình thường.
 */
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!plain || !hash) return false;
  if (BLOCKED_PASSWORDS.has(plain.toLowerCase())) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** Mật khẩu từng xuất hiện công khai (README, mã nguồn) hoặc quá phổ biến. */
const BLOCKED_PASSWORDS = new Set([
  "admin123@", "admin123", "admin@123", "123456789", "12345678", "password", "password1",
  "matkhau123", "tytbatxat", "tytbatxat123", "batxat123", "qwerty123", "abc12345"
]);

/**
 * Kiểm tra độ mạnh tối thiểu của mật khẩu mới (Quản trị đặt hoặc cán bộ tự đổi).
 * Trả về thông báo lỗi tiếng Việt, hoặc null nếu hợp lệ. Truyền username để
 * chặn mật khẩu chứa chính tên đăng nhập.
 */
export function validatePasswordStrength(plain: string, username?: string | null): string | null {
  if (typeof plain !== "string" || plain.length < 8) {
    return "Mật khẩu phải có tối thiểu 8 ký tự.";
  }
  if (plain.length > 128) {
    return "Mật khẩu không được vượt quá 128 ký tự.";
  }
  if (!/[A-Za-z]/.test(plain) || !/[0-9]/.test(plain)) {
    return "Mật khẩu phải gồm cả chữ và số.";
  }
  if (BLOCKED_PASSWORDS.has(plain.toLowerCase())) {
    return "Mật khẩu này đã bị công khai hoặc quá phổ biến. Vui lòng chọn mật khẩu khác.";
  }
  const name = String(username || "").trim().toLowerCase().split("@")[0];
  if (name.length >= 4 && plain.toLowerCase().includes(name)) {
    return "Mật khẩu không được chứa tên đăng nhập.";
  }
  return null;
}

/**
 * Dấu phiên bản mật khẩu: 16 ký tự đầu của SHA-256(chuỗi băm bcrypt). Không lộ
 * gì về mật khẩu (chuỗi băm đã có muối ngẫu nhiên), nhưng đổi mỗi lần mật khẩu
 * đổi - nên nhúng vào phiếu để thu hồi phiếu cũ mà không cần thêm cột.
 */
export async function passwordVersion(hash: string | null | undefined): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(hash || ""))));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Phiếu còn khớp mật khẩu hiện tại của tài khoản (phiếu cũ không mang pwv được nhận). */
export async function tokenMatchesPassword(claims: TokenClaims, user: Pick<UserRow, "passwordHash">): Promise<boolean> {
  if (!claims.pwv) return true;
  return claims.pwv === (await passwordVersion(user.passwordHash));
}

/** Sinh mật khẩu tạm khi Quản trị bấm "Đặt lại mật khẩu". */
export function generateTemporaryPassword(): string {
  // Bỏ các ký tự dễ đọc nhầm (0/O, 1/l/I) để cán bộ đọc qua điện thoại không sai.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  // Bảo đảm luôn có chữ và số để qua được validatePasswordStrength.
  return `Tyt${out}7`;
}

// ---------------------------------------------------------------------------
//  JWT HS256 (Web Crypto, không phụ thuộc thư viện ngoài)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedSecret: string | null = null;

/**
 * Bí mật ký phiếu.
 *
 * Ưu tiên biến môi trường. Nếu site chưa đặt biến nào thì sinh ngẫu nhiên MỘT
 * LẦN rồi cất trong bảng site_configs: các thực thể hàm khác nhau vẫn ký/kiểm
 * bằng cùng một khoá, và phiên không bị vô hiệu sau mỗi lần triển khai. Bí mật
 * chưa bao giờ được trả ra ngoài qua API - site_configs chỉ đọc được bởi
 * /api/cms, nên tuyến đó đã lọc bỏ khoá này (xem cms.ts).
 */
async function getSigningSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;

  const fromEnv = process.env.STATION_JWT_SECRET || process.env.JWT_SECRET;
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  const existing = await db.select().from(siteConfigs).where(eq(siteConfigs.id, JWT_SECRET_CONFIG_ID));
  if (existing.length && existing[0].value) {
    cachedSecret = existing[0].value;
    return cachedSecret;
  }

  const generated = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)));
  try {
    await db.insert(siteConfigs).values({ id: JWT_SECRET_CONFIG_ID, value: generated });
    cachedSecret = generated;
  } catch {
    // Hai thực thể hàm cùng khởi tạo một lúc: đọc lại bản ghi của bên thắng.
    const raced = await db.select().from(siteConfigs).where(eq(siteConfigs.id, JWT_SECRET_CONFIG_ID));
    cachedSecret = raced.length && raced[0].value ? raced[0].value : generated;
  }
  return cachedSecret as string;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Ký phiếu phiên cho một tài khoản với danh sách phạm vi đã được duyệt. */
export async function signToken(
  user: UserRow,
  scopes: string[],
  ttlSeconds = TOKEN_TTL_SECONDS,
  jti?: string
): Promise<{ token: string; expiresAt: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    sub: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    scopes,
    stationCode: user.stationCode || null,
    iat: nowSec,
    exp: nowSec + ttlSeconds,
    pwv: await passwordVersion(user.passwordHash),
    ...(jti ? { jti } : {})
  };

  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const key = await importKey(await getSigningSecret());
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`))
  );

  return {
    token: `${header}.${payload}.${base64UrlEncode(signature)}`,
    expiresAt: claims.exp * 1000
  };
}

/** Kiểm tra chữ ký và hạn dùng của phiếu. Trả null nếu phiếu không dùng được. */
export async function verifyToken(token: string | null | undefined): Promise<TokenClaims | null> {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  try {
    const key = await importKey(await getSigningSecret());
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(signature),
      encoder.encode(`${header}.${payload}`)
    );
    if (!valid) return null;

    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as TokenClaims;
    if (!claims || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Tra cứu tài khoản
// ---------------------------------------------------------------------------

/**
 * Tìm tài khoản theo tên đăng nhập, KHÔNG phân biệt hoa/thường và bỏ qua khoảng
 * trắng thừa ở hai đầu.
 *
 * Trước đây mọi cổng đăng nhập đều so khớp chính xác cột username. Cách đó biến
 * một khác biệt vô hại - bàn phím điện thoại tự viết hoa chữ đầu, một dấu cách
 * dính theo khi cán bộ dán tên đăng nhập, hay một bản ghi cũ lưu lệch hoa/thường
 * - thành thông báo "Tên đăng nhập hoặc mật khẩu không đúng", dù mật khẩu gõ
 * hoàn toàn đúng. Tên đăng nhập là định danh, không phải bí mật, nên chuẩn hoá ở
 * đây không làm giảm độ an toàn: mật khẩu vẫn phải qua bcrypt như cũ.
 *
 * Bản di trú 20260807120000_reset_default_admin_credentials đã chuẩn hoá tên hai
 * tài khoản Quản trị về dạng viết thường, và /api/admin-users luôn lưu tên mới ở
 * dạng viết thường - nên trong thực tế chỉ có tối đa một bản ghi khớp. Nếu vẫn
 * có nhiều bản ghi (dữ liệu cũ), ưu tiên bản trùng khớp từng ký tự để kết quả
 * luôn xác định, không phụ thuộc thứ tự trả về của cơ sở dữ liệu.
 */
export async function findUserByUsername(username: string): Promise<UserRow | null> {
  const needle = String(username || "").trim().toLowerCase();
  if (!needle) return null;

  const found = await db
    .select()
    .from(users)
    .where(sql`lower(btrim(${users.username})) = ${needle}`);
  if (!found.length) return null;

  return found.find((u) => u.username === needle) || found[0];
}

// ---------------------------------------------------------------------------
//  Quyền
// ---------------------------------------------------------------------------

/** Vai trò nào được coi là Quản trị viên hệ thống. */
export function isAdminRole(role: string | null | undefined): boolean {
  return /admin|quản trị|quan tri/i.test(String(role || ""));
}

/**
 * Quyền vào Module Bảng điều khiển điểm trạm.
 *
 * Cột station_access là nguồn quyết định. Tài khoản tạo trước khi có cột này
 * còn để trống, khi đó suy ra từ vai trò để không khoá nhầm những tài khoản
 * vốn vẫn đang dùng Bảng điều khiển. Khi Quản trị đặt rõ 'true'/'false' thì giá
 * trị đó luôn thắng. Quy tắc này được nhân bản y hệt ở phía giao diện
 * (hasStationAccess trong index.html và app.js) - sửa một nơi phải sửa cả ba.
 */
export function hasStationAccess(user: Pick<UserRow, "stationAccess" | "role">): boolean {
  const granted = String(user.stationAccess || "").trim().toLowerCase();
  if (granted === "true") return true;
  if (granted === "false") return false;
  return /điểm trạm|diem tram|station|admin|quản trị|quan tri/i.test(String(user.role || ""));
}

/** Tài khoản đang giữ mật khẩu tạm (Quản trị vừa cấp/đặt lại) - phải đổi trước khi vào. */
export function needsPasswordChange(user: Pick<UserRow, "mustChangePassword">): boolean {
  return String(user.mustChangePassword || "false").trim().toLowerCase() === "true";
}

/**
 * Phản hồi chung của mọi cổng đăng nhập khi tài khoản còn dùng mật khẩu tạm.
 * KHÔNG cấp phiếu: cán bộ phải đổi mật khẩu (POST /api/station-auth,
 * action=change_password) rồi đăng nhập lại bằng mật khẩu mới. Trang đăng nhập
 * nạp /assets/password-change.js để mở hộp đổi mật khẩu ngay tại chỗ.
 */
export function passwordChangeRequiredBody() {
  const message = "Tài khoản đang dùng mật khẩu tạm. Vui lòng đặt mật khẩu riêng để tiếp tục đăng nhập.";
  return { success: false, code: "PASSWORD_CHANGE_REQUIRED", mustChangePassword: true, error: message, message };
}

/** Tài khoản bị khoá thì không đăng nhập được ở bất kỳ cổng nào. */
export function isActive(user: Pick<UserRow, "status">): boolean {
  return String(user.status || "ACTIVE").toUpperCase() !== "DISABLED";
}

/**
 * Quyền vào Module Bác sĩ tuyến trên (/bacsi).
 *
 * Đây là quyền RIÊNG, cấp tách khỏi quyền điểm trạm: bác sĩ tuyến trên hội chẩn
 * từ xa bằng tài khoản/mật khẩu của chính mình và không cần - cũng không mặc
 * nhiên có - quyền thao tác trên Bảng điều khiển của trạm. Cột doctor_access là
 * nguồn quyết định; tài khoản tạo trước khi có cột này suy ra từ vai trò để
 * những bác sĩ đang trực không bị khoá ngoài ngay sau khi triển khai.
 */
export function hasDoctorAccess(user: Pick<UserRow, "doctorAccess" | "role">): boolean {
  const granted = String(user.doctorAccess || "").trim().toLowerCase();
  if (granted === "true") return true;
  if (granted === "false") return false;
  return /bác s|bac s|doctor|tuyến trên|tuyen tren|admin|quản trị|quan tri/i.test(String(user.role || ""));
}

/**
 * Quyền vào Phân hệ Chấm công - Chấm trực (/chamcong).
 *
 * Quyền cấp RIÊNG như hai quyền trên: gần như mọi cán bộ của trạm đều phải chấm
 * công, kể cả người không bao giờ tham gia khám từ xa. Cột attendance_access là
 * nguồn quyết định; Quản trị viên hệ thống luôn vào được để còn thiết lập được
 * kỳ bảng công đầu tiên (nếu không, một cơ sở dữ liệu trắng sẽ không có ai đủ
 * quyền tạo hồ sơ cán bộ - phân hệ tự khoá chính nó ngoài cửa).
 *
 * Lưu ý: quyền này chỉ mở CỬA VÀO phân hệ. Vào rồi làm được gì thì do vai trò
 * trong att_employees.attendance_role quyết định (xem netlify/lib/attendance.ts).
 */
export function hasAttendanceAccess(user: Pick<UserRow, "attendanceAccess" | "role">): boolean {
  const granted = String(user.attendanceAccess || "").trim().toLowerCase();
  if (granted === "true") return true;
  if (isAdminRole(user.role)) return true;
  return false;
}

/** Danh sách phạm vi mà tài khoản đang thực sự được hưởng. */
export function scopesFor(user: UserRow): string[] {
  const scopes: string[] = [];
  if (hasStationAccess(user)) scopes.push("station");
  if (hasDoctorAccess(user)) scopes.push("doctor");
  if (hasAttendanceAccess(user)) scopes.push("attendance");
  if (isAdminRole(user.role)) scopes.push("admin");
  if (String(user.canReceiveVideo || "true") !== "false") scopes.push("video");
  return scopes;
}

/** Bản chiếu tài khoản an toàn để trả ra giao diện - tuyệt đối không có chuỗi băm. */
export function publicUser(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    email: user.email || "",
    phone: user.phone || "",
    stationCode: user.stationCode || "",
    canReceiveVideo: user.canReceiveVideo || "true",
    stationAccess: hasStationAccess(user) ? "true" : "false",
    doctorAccess: hasDoctorAccess(user) ? "true" : "false",
    attendanceAccess: hasAttendanceAccess(user) ? "true" : "false",
    status: String(user.status || "ACTIVE").toUpperCase(),
    hasPassword: Boolean(user.passwordHash),
    mustChangePassword: String(user.mustChangePassword || "false") === "true",
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    lastLoginAt: user.lastLoginAt || null
  };
}

// ---------------------------------------------------------------------------
//  Middleware
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Lấy phiếu từ header Authorization: Bearer, hoặc tham số ?token= khi cần. */
export function readBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (header && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, "").trim();
  }
  try {
    const fromQuery = new URL(req.url).searchParams.get("token");
    return fromQuery ? fromQuery.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Middleware phân quyền phía máy chủ.
 *
 * Ném AuthError khi phiếu thiếu/hết hạn (401), khi tài khoản đã bị xoá hoặc
 * khoá (401), hoặc khi quyền yêu cầu đã bị Quản trị thu hồi (403). Gọi hàm này
 * ở đầu mọi tuyến đường thuộc Module Bảng điều khiển điểm trạm để việc gõ thẳng
 * URL cũng không đi vòng qua được rào chắn của giao diện.
 */
export type AuthScope = "station" | "doctor" | "admin" | "video" | "attendance";

/** Thông báo từ chối tương ứng với từng phạm vi. */
const SCOPE_DENIED_MESSAGES: Record<AuthScope, string> = {
  station: "Tài khoản chưa được CMS Quản trị cấp quyền truy cập Mod Bảng điều khiển điểm trạm.",
  doctor: "Tài khoản chưa được CMS Quản trị cấp quyền truy cập Module Bác sĩ tuyến trên.",
  admin: "Chỉ Quản trị viên hệ thống mới được thao tác trên chức năng này.",
  video: "Tài khoản chưa được cấp quyền nhận cuộc gọi video.",
  attendance: "Tài khoản chưa được cấp quyền truy cập Phân hệ Chấm công - Chấm trực."
};

export async function requireScope(req: Request, scope: AuthScope): Promise<AuthContext> {
  return requireAnyScope(req, [scope]);
}

/**
 * Như requireScope nhưng chấp nhận MỘT TRONG các phạm vi liệt kê.
 *
 * Dùng cho những tuyến đường phục vụ đồng thời hai Module - ví dụ /api/vitals và
 * /api/examination-report được cả cán bộ điểm trạm lẫn bác sĩ tuyến trên gọi
 * trong cùng một lượt khám.
 */
export async function requireAnyScope(req: Request, scopes: AuthScope[]): Promise<AuthContext> {
  const claims = await verifyToken(readBearerToken(req));
  if (!claims) {
    throw new AuthError(401, "UNAUTHENTICATED", "Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.");
  }

  const found = await db.select().from(users).where(eq(users.id, claims.sub));
  if (!found.length) {
    throw new AuthError(401, "ACCOUNT_NOT_FOUND", "Tài khoản không còn tồn tại trong hệ thống.");
  }

  const user = found[0];
  if (!isActive(user)) {
    throw new AuthError(403, "ACCOUNT_DISABLED", "Tài khoản đã bị Quản trị khoá.");
  }
  if (!(await tokenMatchesPassword(claims, user))) {
    throw new AuthError(401, "PASSWORD_CHANGED", "Mật khẩu tài khoản vừa được đổi. Vui lòng đăng nhập lại.");
  }

  // Đọc lại quyền từ cơ sở dữ liệu: thu hồi quyền có hiệu lực tức thì.
  const granted = scopesFor(user);
  if (!scopes.some((scope) => granted.includes(scope))) {
    throw new AuthError(403, "FORBIDDEN", SCOPE_DENIED_MESSAGES[scopes[0]]);
  }

  return { user, claims };
}

/** Biến AuthError thành Response JSON; ném lại các lỗi khác cho tầng trên. */
export function authErrorResponse(err: unknown, headers: Record<string, string>): Response | null {
  if (err instanceof AuthError) {
    return new Response(
      JSON.stringify({ success: false, code: err.code, error: err.message }),
      { headers, status: err.status }
    );
  }
  return null;
}
