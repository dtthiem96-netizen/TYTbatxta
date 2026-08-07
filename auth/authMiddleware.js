/**
 * Middleware bảo vệ tuyến đường (authMiddleware).
 *
 * Đặt hàm này trước bất kỳ tuyến đường nào cần đăng nhập. Quy ước mã lỗi:
 *
 *   401 Unauthorized  - KHÔNG có phiếu: thiếu header Authorization, sai lược đồ
 *                       (không phải Bearer), hoặc phần phiếu để trống.
 *                       => Giao diện phải đưa người dùng về màn hình đăng nhập.
 *
 *   403 Forbidden     - CÓ phiếu nhưng phiếu không dùng được: đã hết hạn, chữ ký
 *                       sai, bị sửa nội dung, hoặc sai nhà phát hành.
 *                       => Giao diện phải xoá phiếu đang lưu rồi đăng nhập lại.
 *
 * Khi phiếu hợp lệ, phần thân phiếu được gắn vào `req.user` để các tuyến đường
 * phía sau biết ai đang gọi mà không phải giải mã lại.
 */
import jwt from "jsonwebtoken";
import { extractBearerToken, verifyAccessToken } from "./authService.js";

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export function authMiddleware(req, res, next) {
  try {
    // Bước 1: lấy phiếu từ header `Authorization: Bearer <token>`.
    const token = extractBearerToken(req);

    // Bước 2: thiếu phiếu => 401. Đây là trạng thái "chưa đăng nhập", khác hẳn
    // với "đăng nhập rồi nhưng phiếu hỏng" ở bước sau.
    if (!token) {
      return res.status(401).json({
        success: false,
        code: "MISSING_TOKEN",
        message:
          "Thiếu phiếu xác thực. Vui lòng đăng nhập và gửi kèm header " +
          "'Authorization: Bearer <token>'."
      });
    }

    // Bước 3: kiểm chữ ký và hạn dùng.
    try {
      const decoded = verifyAccessToken(token);

      // Bước 4: đính kèm ngữ cảnh người dùng cho các tuyến đường phía sau.
      req.user = {
        id: decoded.sub,
        username: decoded.username,
        name: decoded.name,
        role: decoded.role,
        stationCode: decoded.stationCode || null,
        issuedAt: decoded.iat,
        expiresAt: decoded.exp
      };
      req.token = token;

      return next();
    } catch (verifyError) {
      // Phiếu hết hạn: thông báo riêng để giao diện hiển thị "phiên đã hết hạn"
      // thay vì "phiếu không hợp lệ" - hai tình huống người dùng hiểu rất khác nhau.
      if (verifyError instanceof jwt.TokenExpiredError) {
        return res.status(403).json({
          success: false,
          code: "TOKEN_EXPIRED",
          message: "Phiên đăng nhập đã hết hạn (8 giờ). Vui lòng đăng nhập lại.",
          expiredAt: verifyError.expiredAt
        });
      }

      // Chữ ký sai, nội dung bị sửa, sai issuer/audience, hoặc chuỗi không phải JWT.
      if (verifyError instanceof jwt.JsonWebTokenError) {
        return res.status(403).json({
          success: false,
          code: "INVALID_TOKEN",
          message: "Phiếu xác thực không hợp lệ. Vui lòng đăng nhập lại."
        });
      }

      // Trường hợp còn lại (ví dụ NotBeforeError) vẫn là phiếu không dùng được.
      throw verifyError;
    }
  } catch (err) {
    // Sự cố ngoài dự kiến: ghi log đầy đủ ở máy chủ, nhưng KHÔNG trả chi tiết kỹ
    // thuật ra trình duyệt để tránh lộ thông tin nội bộ.
    console.error("[auth] Lỗi không xác định trong authMiddleware:", err);
    return res.status(500).json({
      success: false,
      code: "AUTH_INTERNAL_ERROR",
      message: "Hệ thống xác thực đang gián đoạn. Vui lòng thử lại sau."
    });
  }
}

/**
 * Middleware phân quyền theo vai trò, dùng NỐI TIẾP sau authMiddleware.
 *
 * Ví dụ: `router.delete('/users/:id', authMiddleware, requireRole('admin'), handler)`
 *
 * @param {...string} allowedRoles danh sách vai trò được phép.
 */
export function requireRole(...allowedRoles) {
  const allowed = allowedRoles.map((r) => String(r).toLowerCase());

  return (req, res, next) => {
    // Gọi sai thứ tự middleware là lỗi lập trình - báo rõ để phát hiện sớm.
    if (!req.user) {
      console.error("[auth] requireRole được gọi trước authMiddleware.");
      return res.status(401).json({
        success: false,
        code: "MISSING_TOKEN",
        message: "Thiếu phiếu xác thực. Vui lòng đăng nhập."
      });
    }

    const role = String(req.user.role || "").toLowerCase();
    if (!allowed.includes(role)) {
      return res.status(403).json({
        success: false,
        code: "FORBIDDEN",
        message: "Tài khoản không đủ quyền thực hiện chức năng này."
      });
    }

    return next();
  };
}

export default authMiddleware;
