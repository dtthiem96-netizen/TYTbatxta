/**
 * POST /api/auth/login - cổng đăng nhập của CMS trên hạ tầng Netlify.
 *
 * Đây là bản chạy thật (serverless) của tuyến đường cùng tên trong Mô-đun Xác
 * thực Express (auth/authRoutes.js). Máy chủ Express chỉ chạy khi phát triển tại
 * máy (`npm start`); bản triển khai Netlify là tĩnh + Functions, nên tuyến đăng
 * nhập phải có mặt ở đây thì giao diện mới gọi được sau khi lên site.
 *
 * Khác biệt duy nhất so với bản Express là nguồn dữ liệu và thư viện JWT:
 *   - Tài khoản đọc thẳng từ bảng `users` trên Netlify Database (PostgreSQL),
 *     nơi bản di trú 20260807010000_add_cms_admin_account đã nạp tài khoản
 *     `admin-tytbatxat`.
 *   - Phiếu phiên được ký bằng netlify/lib/auth.ts (HS256 qua Web Crypto) để
 *     dùng chung một định dạng với /api/station-auth và toàn bộ CMS hiện có.
 * Quy tắc nghiệp vụ - đối chiếu bcrypt, thời hạn 8 giờ, mã lỗi 400/401/403 - giữ
 * nguyên như bản Express.
 */
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  isActive,
  publicUser,
  scopesFor,
  signToken,
  verifyPassword,
  findUserByUsername,
  TOKEN_TTL_SECONDS
} from "../lib/auth.js";
import { createSession, rateLimit, resetRateLimit, revokeOtherSessions, uaFamily } from "../lib/sessions.js";

/**
 * Giao diện gọi cùng tên miền nên không cần CORS: bỏ "Allow-Origin: *" để một
 * trang lạ không dùng được cổng đăng nhập này làm công cụ dò mật khẩu.
 */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

/** Giới hạn dò mật khẩu: 8 lần sai / 15 phút cho mỗi cặp IP + tài khoản, 40 lần / 15 phút cho mỗi IP. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_PER_ACCOUNT = 8;
const LOGIN_LIMIT_PER_IP = 40;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { headers, status });

/** Thông báo dùng chung cho mọi thất bại đăng nhập - không tiết lộ tài khoản nào có thật. */
const INVALID_CREDENTIALS = "Tên đăng nhập hoặc mật khẩu không đúng.";

/** Ghi lại thời điểm đăng nhập gần nhất; lỗi ở đây không được chặn luồng đăng nhập. */
async function touchLastLogin(id: string) {
  try {
    await db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, id));
  } catch (err) {
    console.warn("[auth-login] Không ghi được lastLoginAt:", err);
  }
}

/**
 * Đăng nhập khi tài khoản còn phiên sống ở nơi khác (yêu cầu 12: đăng nhập đồng
 * thời). Theo cấu hình "một phiên", phiên cũ bị đóng; nếu phiên cũ ở IP hoặc
 * trình duyệt khác thì sinh cảnh báo VÀNG cho Quản trị. Không bao giờ làm thất
 * bại lượt đăng nhập.
 */
async function handleConcurrentLogin(
  userId: string,
  sessionId: string,
  ip: string,
  userAgent: string,
  concurrent: { id: string; ip: string | null; userAgent: string | null; createdAt: number }[]
) {
  try {
    const { getSecurity, raiseAlert } = await import("../lib/security.js");
    const security = await getSecurity();
    const elsewhere = concurrent.filter((s) => (s.ip && s.ip !== ip) || uaFamily(s.userAgent) !== uaFamily(userAgent));
    if (security.singleSession && concurrent.length) {
      await revokeOtherSessions(userId, sessionId, "SUPERSEDED");
    }
    if (elsewhere.length) {
      await raiseAlert({
        level: "YELLOW",
        category: "CONCURRENT_LOGIN",
        userId,
        title: "Đăng nhập đồng thời trên thiết bị khác",
        cause: `Tài khoản đăng nhập mới trong khi còn ${elsewhere.length} phiên đang mở ở IP/trình duyệt khác.${
          security.singleSession ? " Phiên cũ đã bị đóng." : ""
        }`,
        evidence: {
          newSession: { ip, browser: uaFamily(userAgent) },
          otherSessions: elsewhere.map((s) => ({ ip: s.ip, browser: uaFamily(s.userAgent), since: s.createdAt }))
        },
        dedupeKey: `CONCURRENT_LOGIN|${sessionId}`
      });
    }
  } catch (err) {
    console.warn("[auth-login] Không xử lý được đăng nhập đồng thời:", err);
  }
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  if (req.method !== "POST") {
    return json({ success: false, code: "METHOD_NOT_ALLOWED", message: "Chỉ hỗ trợ phương thức POST." }, 405);
  }

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return json({ success: false, code: "INVALID_BODY", message: "Nội dung yêu cầu không hợp lệ." }, 400);
    }

    // Bước 1: làm sạch đầu vào, ép kiểu chuỗi tường minh.
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");

    if (username.length > 200 || password.length > 256) {
      return json({ success: false, code: "INVALID_BODY", message: "Thông tin đăng nhập quá dài." }, 400);
    }

    // Bước 1b: chặn dò mật khẩu TRƯỚC khi chạy bcrypt (bcrypt tốn CPU có chủ ý).
    const ip = req.headers.get("x-nf-client-connection-ip") || "";
    const userAgent = (req.headers.get("user-agent") || "").slice(0, 250);
    const accountKey = `login:${ip}:${username.toLowerCase()}`;
    const [perAccount, perIp] = await Promise.all([
      rateLimit(accountKey, LOGIN_LIMIT_PER_ACCOUNT, LOGIN_WINDOW_MS),
      rateLimit(`login-ip:${ip}`, LOGIN_LIMIT_PER_IP, LOGIN_WINDOW_MS)
    ]);
    if (!perAccount.allowed || !perIp.allowed) {
      const retry = Math.max(perAccount.retryAfterSec, perIp.retryAfterSec);
      return new Response(
        JSON.stringify({
          success: false,
          code: "TOO_MANY_ATTEMPTS",
          message: `Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(retry / 60)} phút.`
        }),
        { status: 429, headers: { ...headers, "Retry-After": String(retry) } }
      );
    }

    if (!username || !password) {
      return json({
        success: false,
        code: "MISSING_CREDENTIALS",
        message: "Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu."
      }, 400);
    }

    // Bước 2: tra cứu tài khoản trong bảng users (không phân biệt hoa/thường).
    const user = await findUserByUsername(username);
    if (!user) {
      return json({ success: false, code: "INVALID_CREDENTIALS", message: INVALID_CREDENTIALS }, 401);
    }

    // Bước 3: đối chiếu mật khẩu với chuỗi băm bcrypt (bcrypt.compare).
    const passwordMatches = await verifyPassword(password, user.passwordHash);
    if (!passwordMatches) {
      return json({ success: false, code: "INVALID_CREDENTIALS", message: INVALID_CREDENTIALS }, 401);
    }

    // Bước 4: tài khoản bị khoá thì dừng, dù mật khẩu vẫn đúng. Kiểm tra sau khâu
    // mật khẩu để không lộ trạng thái tài khoản cho người chưa chứng minh danh tính.
    if (!isActive(user)) {
      return json({
        success: false,
        code: "ACCOUNT_DISABLED",
        message: "Tài khoản đã bị khoá. Vui lòng liên hệ Quản trị viên hệ thống."
      }, 403);
    }

    // Bước 5: mở một phiên thu hồi được rồi cấp phiếu 8 giờ mang mã phiên (jti).
    const scopes = scopesFor(user);
    const sessionExpiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;
    const session = await createSession({ userId: user.id, ip, userAgent, expiresAt: sessionExpiresAt });
    const { token, expiresAt } = await signToken(user, scopes, TOKEN_TTL_SECONDS, session.id);
    await Promise.all([touchLastLogin(user.id), resetRateLimit(accountKey)]);
    if (scopes.includes("attendance")) {
      await handleConcurrentLogin(user.id, session.id, ip, userAgent, session.concurrent);
    }

    return json({
      success: true,
      message: "Đăng nhập thành công.",
      token,
      tokenType: "Bearer",
      expiresIn: Math.round((expiresAt - Date.now()) / 1000),
      expiresAt,
      scopes,
      user: publicUser(user) // đã lọc bỏ password_hash
    });
  } catch (err) {
    // Chi tiết kỹ thuật chỉ nằm trong log, không trả ra trình duyệt.
    console.error("[auth-login] Lỗi khi xử lý đăng nhập:", err);
    return json({
      success: false,
      code: "LOGIN_FAILED",
      message: "Hệ thống xác thực đang gián đoạn. Vui lòng thử lại sau."
    }, 500);
  }
};

export const config = {
  path: "/api/auth/login"
};
