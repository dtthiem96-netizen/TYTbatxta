/**
 * Tuyến đường xác thực: POST /api/auth/login và GET /api/auth/session.
 *
 * Nguyên tắc chống dò tài khoản: mọi thất bại do sai tên đăng nhập HOẶC sai mật
 * khẩu đều trả về cùng một thông báo 401 giống hệt nhau. Kẻ tấn công không suy
 * ra được tài khoản nào có thật trong hệ thống.
 */
import { Router } from "express";
import { comparePassword, signAccessToken } from "./authService.js";
import { findUserByUsername, isActiveUser, toPublicUser } from "./userStore.js";
import { authMiddleware } from "./authMiddleware.js";

const router = Router();

/** Thông báo dùng chung cho mọi trường hợp đăng nhập thất bại. */
const INVALID_CREDENTIALS = "Tên đăng nhập hoặc mật khẩu không đúng.";

/**
 * POST /api/auth/login
 *
 * Body: { "username": "...", "password": "..." }
 *
 * Trả về:
 *   200 { success: true, token, expiresAt, user }   đăng nhập thành công
 *   400 thiếu username hoặc password
 *   401 sai thông tin đăng nhập
 *   403 tài khoản đã bị khoá
 *   500 sự cố hệ thống
 */
router.post("/login", async (req, res) => {
  try {
    // Bước 1: đọc và làm sạch dữ liệu đầu vào.
    // Ép kiểu chuỗi tường minh để chặn kiểu dữ liệu lạ (mảng, object) lọt vào
    // tầng truy vấn - một dạng tấn công nhồi kiểu (type confusion) khá phổ biến.
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        code: "MISSING_CREDENTIALS",
        message: "Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu."
      });
    }

    // Bước 2: tra cứu tài khoản.
    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(401).json({
        success: false,
        code: "INVALID_CREDENTIALS",
        message: INVALID_CREDENTIALS
      });
    }

    // Bước 3: đối chiếu mật khẩu với chuỗi băm bcrypt bằng bcrypt.compare.
    // Không bao giờ so sánh chuỗi trực tiếp: bcrypt.compare tự đọc salt và cost
    // factor nhúng trong chuỗi băm, đồng thời so sánh theo thời gian hằng định.
    const passwordMatches = await comparePassword(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        code: "INVALID_CREDENTIALS",
        message: INVALID_CREDENTIALS
      });
    }

    // Bước 4: tài khoản bị Quản trị khoá thì dừng lại, dù mật khẩu vẫn đúng.
    // Kiểm tra SAU khâu mật khẩu để không tiết lộ trạng thái tài khoản cho người
    // chưa chứng minh được danh tính.
    if (!isActiveUser(user)) {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_DISABLED",
        message: "Tài khoản đã bị khoá. Vui lòng liên hệ Quản trị viên hệ thống."
      });
    }

    // Bước 5: cấp phiếu phiên JWT thời hạn 8 giờ.
    const { token, expiresAt, expiresIn } = signAccessToken(user);

    return res.status(200).json({
      success: true,
      message: "Đăng nhập thành công.",
      token,
      tokenType: "Bearer",
      expiresIn, // giây
      expiresAt, // mốc thời gian mili-giây
      user: toPublicUser(user) // đã lọc bỏ password_hash
    });
  } catch (err) {
    console.error("[auth] Lỗi khi xử lý đăng nhập:", err);
    return res.status(500).json({
      success: false,
      code: "LOGIN_FAILED",
      message: "Hệ thống xác thực đang gián đoạn. Vui lòng thử lại sau."
    });
  }
});

/**
 * GET /api/auth/session
 *
 * Giao diện gọi khi tải lại trang để biết phiếu đang lưu còn dùng được không,
 * thay vì đợi tới lúc gọi một API nghiệp vụ mới phát hiện phiên đã hết hạn.
 */
router.get("/session", authMiddleware, (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      user: req.user,
      // exp trong JWT tính bằng giây; đổi sang mili-giây cho đồng bộ với client.
      expiresAt: req.user.expiresAt * 1000
    });
  } catch (err) {
    console.error("[auth] Lỗi khi kiểm tra phiên:", err);
    return res.status(500).json({
      success: false,
      code: "SESSION_CHECK_FAILED",
      message: "Không kiểm tra được phiên đăng nhập. Vui lòng thử lại sau."
    });
  }
});

export default router;
