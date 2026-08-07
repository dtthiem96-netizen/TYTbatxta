/**
 * Ví dụ tích hợp: tuyến đường CMS được bảo vệ bởi authMiddleware.
 *
 * Đây là khuôn mẫu cho mọi tuyến đường quản trị về sau - chỉ cần chèn
 * `authMiddleware` (và `requireRole` nếu cần siết theo vai trò) vào giữa đường
 * dẫn và hàm xử lý.
 */
import { Router } from "express";
import { authMiddleware, requireRole } from "./authMiddleware.js";

const router = Router();

/**
 * GET /api/cms/dashboard
 *
 * Chuỗi middleware chạy theo thứ tự:
 *   1. authMiddleware  - bắt buộc có phiếu hợp lệ (401 nếu thiếu, 403 nếu hỏng/hết hạn)
 *   2. requireRole     - bắt buộc vai trò 'admin' (403 nếu không đủ quyền)
 *   3. hàm xử lý       - lúc này chắc chắn req.user đã có và đáng tin
 *
 * Thử nhanh:
 *   curl -H "Authorization: Bearer <token>" http://localhost:8889/api/cms/dashboard
 */
router.get("/dashboard", authMiddleware, requireRole("admin"), (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      message: `Chào ${req.user.name}, bạn đang truy cập Bảng điều khiển CMS.`,
      // req.user do authMiddleware gắn vào sau khi jwt.verify thành công.
      account: {
        id: req.user.id,
        username: req.user.username,
        name: req.user.name,
        role: req.user.role,
        stationCode: req.user.stationCode
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
      // Mốc hết hạn phiếu (mili-giây) để giao diện đếm ngược phiên làm việc.
      sessionExpiresAt: req.user.expiresAt * 1000
    });
  } catch (err) {
    console.error("[cms] Lỗi khi dựng dữ liệu Bảng điều khiển:", err);
    return res.status(500).json({
      success: false,
      code: "DASHBOARD_FAILED",
      message: "Không tải được Bảng điều khiển. Vui lòng thử lại sau."
    });
  }
});

export default router;
