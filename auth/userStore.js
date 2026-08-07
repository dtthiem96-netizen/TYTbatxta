/**
 * Kho tài khoản của Mô-đun Xác thực.
 *
 * KIẾN TRÚC LƯU TRỮ - đọc kỹ trước khi sửa:
 *
 *   - Nguồn dữ liệu THẬT của hệ thống là bảng `users` trên Netlify Database
 *     (PostgreSQL). Tài khoản Quản trị `admin-tytbatxat` được nạp vào đó bằng
 *     bản di trú netlify/database/migrations/20260807010000_add_cms_admin_account
 *     (bản sao đọc được của lệnh INSERT nằm ở db/sql/create-admin-account.sql).
 *     Tầng chạy thật trên Netlify - netlify/functions/auth-login.ts - truy vấn
 *     thẳng bảng này.
 *
 *   - Tệp hiện tại phục vụ máy chủ Express độc lập (`npm start`), vốn chạy tách
 *     rời khỏi hạ tầng Netlify khi phát triển hoặc trình diễn tại điểm trạm. Nó
 *     KHÔNG phải nơi lưu trữ lâu dài: hằng số bên dưới chỉ chép lại đúng bản ghi
 *     mà bản di trú đã ghi vào cơ sở dữ liệu, để hai môi trường cho cùng kết quả
 *     đăng nhập.
 *
 *   - Khi cần đấu nối kho tài khoản thật (PostgreSQL, LDAP...), gọi
 *     `setUserProvider()` một lần lúc khởi động; toàn bộ mô-đun sẽ đi qua đó.
 *
 * Mật khẩu tuyệt đối KHÔNG bao giờ xuất hiện dạng rõ ở đây - chỉ có chuỗi băm.
 */

/**
 * Tài khoản Quản trị khởi tạo.
 *
 * Chuỗi băm bên dưới là kết quả bcrypt của mật khẩu `Admin123@` với cost
 * factor = 10, sinh bằng `node auth/tools/generate-hash.mjs`. Giá trị này khớp
 * từng ký tự với bản di trú và với db/sql/create-admin-account.sql.
 */
const SEEDED_USERS = [
  {
    id: "U-ADMIN-CMS-TYTBATXAT",
    username: "admin-tytbatxat",
    name: "Quản trị viên CMS Trạm Y tế Bát Xát",
    role: "admin",
    passwordHash: "$2b$10$1323U8CdUjVB7/v72SnQC.1yuch8Nvrp.9NQ9Wgw0vq17WkN3gYLC",
    email: "tytbatxat@laocai.gov.vn",
    stationCode: "TYT-BATXAT-01",
    status: "ACTIVE"
  }
];

/**
 * Hàm tra cứu tài khoản đang có hiệu lực.
 * Mặc định đọc từ danh sách gieo hạt ở trên; thay được bằng setUserProvider().
 */
let lookupUser = async (username) => {
  const needle = String(username || "").trim().toLowerCase();
  return SEEDED_USERS.find((u) => u.username.toLowerCase() === needle) || null;
};

/**
 * Đấu nối kho tài khoản thật.
 * @param {(username: string) => Promise<object|null>} provider
 */
export function setUserProvider(provider) {
  if (typeof provider !== "function") {
    throw new TypeError("setUserProvider yêu cầu một hàm bất đồng bộ nhận username.");
  }
  lookupUser = provider;
}

/**
 * Tìm tài khoản theo tên đăng nhập (không phân biệt hoa/thường).
 * @returns {Promise<object|null>} bản ghi tài khoản, hoặc null nếu không có.
 */
export async function findUserByUsername(username) {
  if (!username || typeof username !== "string") return null;
  try {
    return await lookupUser(username);
  } catch (err) {
    // Lỗi hạ tầng kho tài khoản không được biến thành "sai mật khẩu": ném lên
    // để tuyến đăng nhập trả 500 đúng bản chất sự cố.
    console.error("[auth] Không truy vấn được kho tài khoản:", err);
    throw err;
  }
}

/** Tài khoản bị khoá (status = DISABLED) không được phép đăng nhập ở bất kỳ cổng nào. */
export function isActiveUser(user) {
  return String(user?.status || "ACTIVE").toUpperCase() !== "DISABLED";
}

/**
 * Bản chiếu tài khoản an toàn để trả ra giao diện.
 * Hàm này là hàng rào cuối cùng chặn chuỗi băm mật khẩu rò rỉ qua API.
 */
export function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    email: user.email || "",
    stationCode: user.stationCode || "",
    status: String(user.status || "ACTIVE").toUpperCase()
  };
}
