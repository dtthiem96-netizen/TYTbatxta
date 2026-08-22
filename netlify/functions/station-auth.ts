/**
 * Cổng đăng nhập của hệ thống - dùng chung cho Module Bảng điều khiển điểm trạm,
 * Module Bác sĩ tuyến trên và CMS Quản trị.
 *
 *   POST /api/station-auth            đăng nhập, trả về phiếu phiên (JWT HS256)
 *        { username, password, scope? }   scope: "control" | "station" (mặc định) | "doctor" | "cms"
 *   GET  /api/station-auth            kiểm tra phiếu phiên hiện tại còn hiệu lực
 *        Authorization: Bearer <token>
 *   POST /api/station-auth (action=change_password)
 *        cán bộ tự đổi mật khẩu sau khi Quản trị đặt lại
 *
 * Mật khẩu được đối chiếu với chuỗi băm bcrypt của TỪNG tài khoản. Quyền vào
 * Module Bảng điều khiển do CMS Quản trị cấp qua cột station_access, quyền vào
 * Module Bác sĩ tuyến trên cấp riêng qua cột doctor_access; tài khoản bị khoá
 * (status = DISABLED) không đăng nhập được ở bất kỳ cổng nào.
 *
 * ĐIỂM TRẠM ĐI KÈM TÀI KHOẢN. Cán bộ trực không tự chọn nơi trực khi đăng nhập:
 * điểm trạm - và do đó phòng gọi khám từ xa - lấy từ users.station_code do CMS
 * Quản trị chỉ định. Tài khoản có quyền trực khám nhưng chưa được gán điểm trạm
 * sẽ bị chặn ngay ở cổng, vì có vào cũng không có phòng nào để trực.
 */
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { getStation, stationRoomId } from "../lib/stations.js";
import {
  authErrorResponse,
  hasDoctorAccess,
  hasStationAccess,
  isActive,
  isAdminRole,
  publicUser,
  readBearerToken,
  scopesFor,
  signToken,
  validatePasswordStrength,
  verifyPassword,
  verifyToken,
  hashPassword,
  findUserByUsername
} from "../lib/auth.js";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { headers, status });

/**
 * Mật khẩu khởi tạo cho những tài khoản CHƯA từng được đặt mật khẩu riêng.
 *
 * Đây là lối vào duy nhất còn lại của cơ chế "một mật khẩu dùng chung" cũ, và
 * nó chỉ áp dụng khi cột password_hash còn trống. Tài khoản Quản trị
 * (tytbatxat@laocai.gov.vn) đã có chuỗi băm riêng nạp sẵn từ bản di trú
 * 20260806035628_set_default_admin_account nên KHÔNG còn đi qua lối này. Ngay
 * khi Quản trị đặt mật khẩu cho một tài khoản trong CMS (Quản trị hệ thống →
 * Phân quyền hệ thống), lối này cũng đóng lại vĩnh viễn với tài khoản đó. Đặt
 * biến môi trường STATION_PASSWORD để thay giá trị mặc định.
 */
function bootstrapPassword(): string {
  return process.env.STATION_PASSWORD || process.env.STATION_DEFAULT_PASSWORD || "Admin123@";
}

/**
 * Điểm trạm và phòng gọi mà CMS Quản trị đã gắn cho tài khoản.
 *
 * Giao diện đọc khối này để hiển thị đúng một điểm trạm cố định thay cho ô chọn
 * trạm cũ, và để biết ngay phòng gọi nào là của mình.
 */
async function boundStationOf(user: { stationCode: string | null }) {
  const code = String(user.stationCode || "").trim().toUpperCase();
  if (!code) return null;
  const station = await getStation(code);
  return {
    code,
    name: station?.stationName || code,
    roomId: stationRoomId(code),
    status: String(station?.status || "UNKNOWN").toUpperCase()
  };
}

/** Thời điểm đăng nhập gần nhất - ghi lại nhưng không được làm hỏng luồng đăng nhập. */
async function touchLastLogin(id: string) {
  try {
    await db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, id));
  } catch (err) {
    console.warn("Không ghi được lastLoginAt:", err);
  }
}

async function handleLogin(body: Record<string, any>) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  /* Các cổng đăng nhập:
       "control" = Bảng điều khiển trạm y tế (module hợp nhất ở chân trang, gồm
                   khu Trực khám và khu Quản trị điểm trạm),
       "station" = tên cũ của cổng trên, chỉ mở khu Trực khám,
       "doctor"  = Module Bác sĩ tuyến trên,
       "cms"     = CMS Quản trị. */
  const requested = String(body.scope || "station").toLowerCase();
  const scope = requested === "cms" || requested === "doctor" || requested === "control"
    ? requested
    : "station";

  if (!username || !password) {
    return json({ success: false, error: "Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu." }, 400);
  }

  const found = await findUserByUsername(username);
  if (!found) {
    // Không tiết lộ tài khoản có tồn tại hay không.
    return json({ success: false, error: "Tên đăng nhập hoặc mật khẩu không đúng." }, 401);
  }

  const user = found;

  let passwordOk = false;
  let usedBootstrap = false;
  if (user.passwordHash) {
    passwordOk = await verifyPassword(password, user.passwordHash);
  } else {
    passwordOk = password === bootstrapPassword();
    usedBootstrap = passwordOk;
  }

  if (!passwordOk) {
    return json({ success: false, error: "Tên đăng nhập hoặc mật khẩu không đúng." }, 401);
  }

  if (!isActive(user)) {
    return json({
      success: false,
      code: "ACCOUNT_DISABLED",
      error: "Tài khoản đã bị Quản trị khoá. Vui lòng liên hệ Quản trị viên hệ thống."
    }, 403);
  }

  if (scope === "station" && !hasStationAccess(user)) {
    return json({
      success: false,
      code: "NO_STATION_ACCESS",
      error: "Tài khoản chưa được CMS Quản trị cấp quyền truy cập Mod Bảng điều khiển điểm trạm."
    }, 403);
  }

  /* Bảng điều khiển hợp nhất có hai khu làm việc dùng hai quyền khác nhau: khu
     Trực khám cần station_access, khu Quản trị điểm trạm cần vai trò Quản trị.
     Có MỘT trong hai là đủ để qua cổng - phiếu cấp ra mang đúng phạm vi của tài
     khoản nên giao diện chỉ mở đúng khu mà người đó được phép, và mọi tuyến API
     vẫn kiểm tra lại phạm vi ở từng lệnh gọi. */
  if (scope === "control" && !hasStationAccess(user) && !isAdminRole(user.role)) {
    return json({
      success: false,
      code: "NO_STATION_ACCESS",
      error: "Tài khoản chưa được CMS Quản trị cấp quyền trực khám tại điểm trạm, cũng không có vai trò Quản trị viên để cấu hình điểm trạm."
    }, 403);
  }

  /* Cán bộ trực khám phải có điểm trạm được chỉ định. Quản trị viên vào Bảng
     điều khiển để cấu hình thì không cần, nên chỉ chặn khi tài khoản KHÔNG có
     vai trò Quản trị. */
  if ((scope === "station" || scope === "control") && !isAdminRole(user.role) && !String(user.stationCode || "").trim()) {
    return json({
      success: false,
      code: "NO_STATION_ASSIGNED",
      error: "Tài khoản chưa được CMS Quản trị gán vào điểm trạm nào nên chưa có phòng gọi khám từ xa để trực. Vui lòng liên hệ Quản trị viên hệ thống."
    }, 403);
  }

  if (scope === "doctor" && !hasDoctorAccess(user)) {
    return json({
      success: false,
      code: "NO_DOCTOR_ACCESS",
      error: "Tài khoản chưa được CMS Quản trị cấp quyền truy cập Module Bác sĩ tuyến trên."
    }, 403);
  }

  if (scope === "cms" && !isAdminRole(user.role)) {
    // Tài khoản không phải Quản trị vẫn vào được CMS, nhưng phiếu không mang
    // phạm vi "admin" nên mọi thao tác quản lý tài khoản sẽ bị chặn ở máy chủ.
    console.info(`Tài khoản ${user.username} đăng nhập CMS không có quyền Quản trị.`);
  }

  const scopes = scopesFor(user);
  const [{ token, expiresAt }, station] = await Promise.all([signToken(user, scopes), boundStationOf(user)]);
  await touchLastLogin(user.id);

  return json({
    success: true,
    token,
    expiresAt,
    scopes,
    // Điểm trạm duy nhất tài khoản này được trực - giao diện không cho chọn khác.
    station,
    // mustChangePassword bật khi tài khoản đăng nhập bằng mật khẩu khởi tạo
    // hoặc vừa được Quản trị đặt lại mật khẩu.
    mustChangePassword: usedBootstrap || String(user.mustChangePassword || "false") === "true",
    user: publicUser(user)
  });
}

/** Cán bộ tự đổi mật khẩu - phải chứng minh mật khẩu hiện tại. */
async function handleChangePassword(body: Record<string, any>) {
  const username = String(body.username || "").trim();
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");

  if (!username || !currentPassword || !newPassword) {
    return json({ success: false, error: "Thiếu thông tin đổi mật khẩu." }, 400);
  }

  const weak = validatePasswordStrength(newPassword);
  if (weak) return json({ success: false, error: weak }, 400);

  const found = await findUserByUsername(username);
  if (!found) return json({ success: false, error: "Tên đăng nhập hoặc mật khẩu không đúng." }, 401);

  const user = found;
  const ok = user.passwordHash
    ? await verifyPassword(currentPassword, user.passwordHash)
    : currentPassword === bootstrapPassword();
  if (!ok) return json({ success: false, error: "Mật khẩu hiện tại không đúng." }, 401);
  if (!isActive(user)) return json({ success: false, error: "Tài khoản đã bị khoá." }, 403);

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: "false",
      updatedAt: Date.now()
    })
    .where(eq(users.id, user.id));

  return json({ success: true, message: "Đã đổi mật khẩu thành công." });
}

/** Kiểm tra phiếu phiên: giao diện gọi trước khi mở thân Module. */
async function handleSession(req: Request) {
  const claims = await verifyToken(readBearerToken(req));
  if (!claims) {
    return json({ success: false, code: "UNAUTHENTICATED", error: "Phiên đăng nhập đã hết hạn." }, 401);
  }

  const found = await db.select().from(users).where(eq(users.id, claims.sub));
  if (!found.length) {
    return json({ success: false, code: "ACCOUNT_NOT_FOUND", error: "Tài khoản không còn tồn tại." }, 401);
  }

  const user = found[0];
  if (!isActive(user)) {
    return json({ success: false, code: "ACCOUNT_DISABLED", error: "Tài khoản đã bị Quản trị khoá." }, 403);
  }

  // Quyền đọc lại từ cơ sở dữ liệu, không lấy theo phiếu: Quản trị thu hồi
  // quyền là phiên đang mở mất hiệu lực ngay ở lần kiểm tra kế tiếp.
  const scopes = scopesFor(user);
  const station = await boundStationOf(user);
  return json({ success: true, scopes, station, expiresAt: claims.exp * 1000, user: publicUser(user) });
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  try {
    if (req.method === "GET") return await handleSession(req);

    if (req.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }

    const body = (await req.json().catch(() => null)) as Record<string, any> | null;
    if (!body) return json({ success: false, error: "Body không hợp lệ" }, 400);

    if (String(body.action || "") === "change_password") {
      return await handleChangePassword(body);
    }
    return await handleLogin(body);
  } catch (err: any) {
    const authResponse = authErrorResponse(err, headers);
    if (authResponse) return authResponse;
    console.error("station-auth error", err);
    // Chi tiết kỹ thuật chỉ nằm trong log, không trả ra trình duyệt.
    return json({ success: false, error: "Hệ thống xác thực đang gián đoạn. Vui lòng thử lại." }, 500);
  }
};

export const config = {
  path: "/api/station-auth"
};
