/**
 * Lớp nghiệp vụ xác thực: băm/đối chiếu mật khẩu và ký/kiểm phiếu phiên JWT.
 *
 * Tách riêng khỏi tầng tuyến đường (authRoutes.js) để logic bảo mật kiểm thử
 * được độc lập, và để middleware dùng lại đúng một bộ quy tắc kiểm phiếu.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  BCRYPT_COST_FACTOR,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  TOKEN_TTL,
  TOKEN_TTL_SECONDS,
  getJwtSecret
} from "./authConfig.js";

// ---------------------------------------------------------------------------
//  Mật khẩu
// ---------------------------------------------------------------------------

/**
 * Băm mật khẩu dạng rõ thành chuỗi bcrypt ($2b$10$...).
 * Dùng khi tạo tài khoản mới hoặc khi cán bộ đổi mật khẩu.
 *
 * @param {string} plainPassword mật khẩu người dùng vừa nhập
 * @returns {Promise<string>} chuỗi băm để lưu vào cột `password_hash`
 */
export async function hashPassword(plainPassword) {
  if (typeof plainPassword !== "string" || plainPassword.length === 0) {
    throw new TypeError("Mật khẩu cần băm phải là chuỗi khác rỗng.");
  }
  // bcrypt tự sinh salt ngẫu nhiên và nhúng vào chuỗi kết quả, nên hai tài khoản
  // đặt cùng một mật khẩu vẫn cho hai chuỗi băm khác nhau.
  return bcrypt.hash(plainPassword, BCRYPT_COST_FACTOR);
}

/**
 * Đối chiếu mật khẩu rõ với chuỗi băm đã lưu.
 *
 * Hàm này KHÔNG bao giờ ném lỗi ra ngoài: chuỗi băm hỏng hoặc rỗng đều được coi
 * là "không khớp". Nhờ vậy một bản ghi lỗi trong cơ sở dữ liệu không thể làm sập
 * tuyến đăng nhập.
 *
 * @returns {Promise<boolean>}
 */
export async function comparePassword(plainPassword, storedHash) {
  if (!plainPassword || !storedHash) return false;
  try {
    return await bcrypt.compare(plainPassword, storedHash);
  } catch (err) {
    console.error("[auth] Lỗi khi đối chiếu mật khẩu bcrypt:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
//  Phiếu phiên JWT
// ---------------------------------------------------------------------------

/**
 * Ký phiếu phiên cho một tài khoản, thời hạn 8 giờ.
 *
 * Phần thân phiếu (payload) chỉ chứa thông tin định danh và vai trò - tuyệt đối
 * không có mật khẩu hay chuỗi băm, vì payload của JWT chỉ được mã hoá base64url
 * chứ KHÔNG được mã hoá bí mật, ai cầm phiếu cũng đọc được.
 *
 * @param {object} user bản ghi tài khoản lấy từ kho tài khoản
 * @returns {{ token: string, expiresAt: number, expiresIn: number }}
 */
export function signAccessToken(user) {
  const payload = {
    sub: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    stationCode: user.stationCode || null
  };

  const token = jwt.sign(payload, getJwtSecret(), {
    algorithm: JWT_ALGORITHM,
    expiresIn: TOKEN_TTL, // "8h"
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  });

  return {
    token,
    // Mốc hết hạn tính bằng mili-giây để giao diện đếm ngược và tự đăng xuất.
    expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
    expiresIn: TOKEN_TTL_SECONDS
  };
}

/**
 * Kiểm tra chữ ký và hạn dùng của phiếu.
 *
 * Cố ý KHÔNG bắt lỗi tại đây: lời gọi cần phân biệt được "phiếu hết hạn"
 * (TokenExpiredError) với "phiếu giả mạo" (JsonWebTokenError) để trả thông báo
 * đúng cho cán bộ sử dụng.
 *
 * @param {string} token
 * @returns {object} phần thân phiếu đã được xác thực
 * @throws {jwt.JsonWebTokenError|jwt.TokenExpiredError}
 */
export function verifyAccessToken(token) {
  return jwt.verify(token, getJwtSecret(), {
    // Chốt cứng thuật toán: chặn tấn công đổi header sang "none" hoặc sang
    // thuật toán bất đối xứng để qua mặt khâu kiểm chữ ký.
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  });
}

/**
 * Tách phiếu từ header `Authorization: Bearer <token>`.
 *
 * @param {import("express").Request} req
 * @returns {string|null} chuỗi phiếu, hoặc null nếu header thiếu/sai định dạng.
 */
export function extractBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== "string") return null;

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}
