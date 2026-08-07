/**
 * GET /api/cms/dashboard - ví dụ tuyến đường CMS được bảo vệ bằng phiếu phiên.
 *
 * Bản chạy thật (serverless) của tuyến demo trong auth/cmsRoutes.js. Rào chắn ở
 * đây là `requireScope(req, "admin")` của netlify/lib/auth.ts - tương đương chuỗi
 * `authMiddleware` + `requireRole("admin")` bên Express, và có thêm một lớp chắc
 * chắn hơn: quyền được ĐỌC LẠI từ bảng `users` ở mỗi lần gọi, nên Quản trị thu
 * hồi quyền là có hiệu lực ngay chứ không phải chờ phiếu hết hạn.
 *
 * Mã lỗi trả về:
 *   401 thiếu phiếu, phiếu hết hạn/không hợp lệ, hoặc tài khoản không còn tồn tại
 *   403 tài khoản bị khoá hoặc không có quyền Quản trị
 */
import { AuthError, requireScope } from "../lib/auth.js";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { headers, status });

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  if (req.method !== "GET") {
    return json({ success: false, code: "METHOD_NOT_ALLOWED", message: "Chỉ hỗ trợ phương thức GET." }, 405);
  }

  try {
    // Rào chắn: ném AuthError nếu phiếu thiếu/hỏng/hết hạn hoặc không đủ quyền.
    const { user, claims } = await requireScope(req, "admin");

    return json({
      success: true,
      message: `Chào ${user.name}, bạn đang truy cập Bảng điều khiển CMS.`,
      account: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        stationCode: user.stationCode || null
      },
      // Dữ liệu tóm tắt minh hoạ - thay bằng truy vấn thật khi dựng CMS đầy đủ.
      summary: {
        stationName: "Trạm Y tế Bát Xát",
        modules: [
          { key: "news", label: "Quản lý Tin tức - Thông báo" },
          { key: "vaccines", label: "Lịch tiêm chủng" },
          { key: "documents", label: "Tài liệu - Biểu mẫu y tế" },
          { key: "telehealth", label: "Khám chữa bệnh từ xa" },
          { key: "users", label: "Phân quyền hệ thống" }
        ]
      },
      sessionExpiresAt: claims.exp * 1000
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ success: false, code: err.code, message: err.message }, err.status);
    }
    console.error("[cms-dashboard] Lỗi khi dựng dữ liệu Bảng điều khiển:", err);
    return json({
      success: false,
      code: "DASHBOARD_FAILED",
      message: "Không tải được Bảng điều khiển. Vui lòng thử lại sau."
    }, 500);
  }
};

export const config = {
  path: "/api/cms/dashboard"
};
