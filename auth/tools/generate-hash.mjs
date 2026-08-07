/**
 * Công cụ dòng lệnh: sinh chuỗi băm bcrypt và câu lệnh SQL tương ứng.
 *
 * Dùng khi cần đổi mật khẩu tài khoản Quản trị mà không muốn viết mật khẩu dạng
 * rõ vào bất kỳ tệp nào của kho mã.
 *
 *   node auth/tools/generate-hash.mjs 'MatKhauMoi@123'
 *
 * Không truyền tham số thì công cụ dùng mật khẩu khởi tạo `Admin123@` để in lại
 * đúng lệnh INSERT đang nằm trong db/sql/create-admin-account.sql.
 */
import bcrypt from "bcryptjs";
import { BCRYPT_COST_FACTOR } from "../authConfig.js";

const password = process.argv[2] || "Admin123@";
const username = process.argv[3] || "admin-tytbatxat";

try {
  const hash = await bcrypt.hash(password, BCRYPT_COST_FACTOR);

  // Tự kiểm chứng ngay: chuỗi băm in ra phải đối chiếu lại được với mật khẩu gốc.
  const verified = await bcrypt.compare(password, hash);
  if (!verified) {
    throw new Error("Chuỗi băm vừa sinh không đối chiếu lại được - dừng lại để tránh khoá tài khoản.");
  }

  console.log(`Cost factor : ${BCRYPT_COST_FACTOR}`);
  console.log(`Tên đăng nhập: ${username}`);
  console.log(`Chuỗi băm   : ${hash}`);
  console.log("");
  console.log("-- Cập nhật mật khẩu trong bảng users:");
  console.log(`UPDATE "users" SET "password_hash" = '${hash}', "updated_at" = (EXTRACT(EPOCH FROM now()) * 1000)::bigint`);
  console.log(`WHERE lower("username") = '${username.toLowerCase()}';`);
} catch (err) {
  console.error("Không sinh được chuỗi băm:", err);
  process.exitCode = 1;
}
