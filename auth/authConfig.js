/**
 * Cấu hình tập trung của Mô-đun Xác thực (Authentication Module).
 *
 * Mọi hằng số liên quan tới bảo mật đều nằm ở MỘT nơi duy nhất để khi cần siết
 * chặt chính sách (tăng vòng bcrypt, rút ngắn thời hạn phiếu) thì chỉ phải sửa
 * một tệp, không phải đi lùng khắp mã nguồn.
 */

/**
 * Số vòng băm bcrypt (cost factor).
 *
 * 10 vòng là mức tiêu chuẩn: đủ chậm để chống dò mật khẩu hàng loạt, nhưng vẫn
 * đủ nhanh (~60-100ms) để không làm nghẽn tiến trình Node.js khi nhiều cán bộ
 * điểm trạm cùng đăng nhập đầu ca trực.
 */
export const BCRYPT_COST_FACTOR = 10;

/** Thời hạn phiếu phiên JWT: 8 giờ - vừa đúng một ca trực tại điểm trạm. */
export const TOKEN_TTL = "8h";

/** Cùng thời hạn trên nhưng tính bằng giây, dùng khi cần trả expiresAt cho giao diện. */
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

/** Thuật toán ký phiếu. Khai báo tường minh để chặn tấn công "alg: none". */
export const JWT_ALGORITHM = "HS256";

/** Nhà phát hành phiếu - ghi vào claim `iss` để phân biệt phiếu của hệ thống khác. */
export const JWT_ISSUER = "tyt-batxat-cms";

/** Đối tượng sử dụng phiếu - ghi vào claim `aud`. */
export const JWT_AUDIENCE = "tyt-batxat-clients";

/**
 * Bí mật ký phiếu HS256.
 *
 * Thứ tự ưu tiên được giữ TRÙNG KHỚP với netlify/lib/auth.ts. Nhờ vậy, khi site
 * đặt biến môi trường STATION_JWT_SECRET (hoặc JWT_SECRET), cả hai tầng cùng ký
 * và kiểm bằng một khoá duy nhất, và phiếu do máy chủ Express này phát hành được
 * các Netlify Function chấp nhận. Chiều ngược lại thì không: mô-đun này bắt buộc
 * phiếu phải mang đúng `iss`/`aud` khai báo bên dưới, còn phiếu cũ do
 * netlify/lib/auth.ts phát hành không có hai claim đó. Đây là chủ ý - hai tầng
 * phục vụ hai môi trường khác nhau (Express khi phát triển tại máy, Functions
 * khi chạy thật), và siết `iss`/`aud` đáng giá hơn là nới lỏng để tương thích.
 *
 * Nếu không có biến môi trường, hệ thống sinh một bí mật ngẫu nhiên cho VÒNG ĐỜI
 * TIẾN TRÌNH hiện tại. Cách này an toàn (không có bí mật mặc định bị lộ trong mã
 * nguồn) nhưng khiến mọi phiếu mất hiệu lực sau khi khởi động lại máy chủ - vì
 * thế môi trường thật bắt buộc phải đặt biến môi trường.
 */
let cachedSecret = null;

export function getJwtSecret() {
  if (cachedSecret) return cachedSecret;

  const fromEnv = process.env.STATION_JWT_SECRET || process.env.JWT_SECRET;
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  // Không có biến môi trường: sinh bí mật tạm và cảnh báo thật to trong log.
  cachedSecret = randomSecret();
  console.warn(
    "[auth] Chưa đặt STATION_JWT_SECRET/JWT_SECRET. Đang dùng bí mật ngẫu nhiên " +
      "theo tiến trình: mọi phiên đăng nhập sẽ mất hiệu lực khi máy chủ khởi động lại."
  );
  return cachedSecret;
}

/** Sinh chuỗi bí mật 48 byte dạng base64url bằng Web Crypto sẵn có của Node 18+. */
function randomSecret() {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, "binary").toString("base64url");
}
