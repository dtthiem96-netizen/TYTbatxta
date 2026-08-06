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
import { eq } from "drizzle-orm";

/** Số vòng bcrypt. 10 là mức cân bằng giữa an toàn và thời gian chạy hàm. */
const BCRYPT_ROUNDS = 10;

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
  /** Phạm vi được cấp trong phiếu: "station" và/hoặc "admin", "video". */
  scopes: string[];
  stationCode: string | null;
  iat: number;
  exp: number;
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

/** Đối chiếu mật khẩu rõ với chuỗi băm đã lưu. Không bao giờ ném lỗi ra ngoài. */
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Kiểm tra độ mạnh tối thiểu của mật khẩu do Quản trị đặt.
 * Trả về thông báo lỗi tiếng Việt, hoặc null nếu hợp lệ.
 */
export function validatePasswordStrength(plain: string): string | null {
  if (typeof plain !== "string" || plain.length < 8) {
    return "Mật khẩu phải có tối thiểu 8 ký tự.";
  }
  if (plain.length > 128) {
    return "Mật khẩu không được vượt quá 128 ký tự.";
  }
  if (!/[A-Za-z]/.test(plain) || !/[0-9]/.test(plain)) {
    return "Mật khẩu phải gồm cả chữ và số.";
  }
  return null;
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
  ttlSeconds = TOKEN_TTL_SECONDS
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
    exp: nowSec + ttlSeconds
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

/** Tài khoản bị khoá thì không đăng nhập được ở bất kỳ cổng nào. */
export function isActive(user: Pick<UserRow, "status">): boolean {
  return String(user.status || "ACTIVE").toUpperCase() !== "DISABLED";
}

/** Danh sách phạm vi mà tài khoản đang thực sự được hưởng. */
export function scopesFor(user: UserRow): string[] {
  const scopes: string[] = [];
  if (hasStationAccess(user)) scopes.push("station");
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
export async function requireScope(req: Request, scope: "station" | "admin" | "video"): Promise<AuthContext> {
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

  // Đọc lại quyền từ cơ sở dữ liệu: thu hồi quyền có hiệu lực tức thì.
  if (!scopesFor(user).includes(scope)) {
    const messages: Record<string, string> = {
      station: "Tài khoản chưa được CMS Quản trị cấp quyền truy cập Mod Bảng điều khiển điểm trạm.",
      admin: "Chỉ Quản trị viên hệ thống mới được thao tác trên chức năng này.",
      video: "Tài khoản chưa được cấp quyền nhận cuộc gọi video."
    };
    throw new AuthError(403, "FORBIDDEN", messages[scope]);
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
