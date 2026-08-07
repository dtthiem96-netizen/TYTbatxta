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
import { isActive, publicUser, scopesFor, signToken, verifyPassword } from "../lib/auth.js";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

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

    if (!username || !password) {
      return json({
        success: false,
        code: "MISSING_CREDENTIALS",
        message: "Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu."
      }, 400);
    }

    // Bước 2: tra cứu tài khoản trong bảng users.
    const found = await db.select().from(users).where(eq(users.username, username));
    if (!found.length) {
      return json({ success: false, code: "INVALID_CREDENTIALS", message: INVALID_CREDENTIALS }, 401);
    }

    const user = found[0];

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

    // Bước 5: cấp phiếu phiên 8 giờ kèm danh sách phạm vi đọc lại từ cơ sở dữ liệu.
    const scopes = scopesFor(user);
    const { token, expiresAt } = await signToken(user, scopes);
    await touchLastLogin(user.id);

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
