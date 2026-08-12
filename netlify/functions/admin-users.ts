/**
 * API Quản lý tài khoản & phân quyền hệ thống.
 *
 * Phục vụ mục CMS "Quản trị hệ thống → Phân quyền hệ thống". Mọi tuyến đường
 * đều bắt buộc phiếu phiên có phạm vi "admin" - gõ thẳng URL không đi vòng qua
 * được, vì quyền được đọc lại từ cơ sở dữ liệu ở từng lần gọi.
 *
 *   GET  /api/admin-users                     danh sách tài khoản (không kèm mật khẩu)
 *   POST /api/admin-users  { action: ... }
 *        create           tạo tài khoản mới kèm mật khẩu ban đầu
 *        update           sửa hồ sơ + quyền (không đụng tới mật khẩu)
 *        reset_password   đặt lại mật khẩu, trả về mật khẩu tạm dùng một lần
 *        set_status       kích hoạt / khoá tài khoản
 *        set_permission   cấp hoặc thu hồi từng quyền riêng lẻ
 *        delete           xoá tài khoản
 */
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  authErrorResponse,
  generateTemporaryPassword,
  hashPassword,
  publicUser,
  requireScope,
  validatePasswordStrength,
  type AuthContext,
  type UserRow
} from "../lib/auth.js";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { headers, status });

const text = (value: unknown) => String(value === undefined || value === null ? "" : value).trim();
const flag = (value: unknown, fallback: "true" | "false") => {
  if (value === true || value === "true") return "true";
  if (value === false || value === "false") return "false";
  return fallback;
};

const VALID_STATUS = new Set(["ACTIVE", "DISABLED"]);

/** Tên đăng nhập: email công vụ hoặc chuỗi định danh không dấu cách. */
function validateUsername(username: string): string | null {
  if (!username) return "Tên đăng nhập là bắt buộc.";
  if (username.length < 4 || username.length > 120) return "Tên đăng nhập phải dài từ 4 đến 120 ký tự.";
  if (/\s/.test(username)) return "Tên đăng nhập không được chứa dấu cách.";
  return null;
}

/** Email hoặc Số điện thoại - bắt buộc phải có ít nhất một cách liên hệ. */
function validateContact(email: string, phone: string): string | null {
  if (!email && !phone) return "Phải nhập Email hoặc Số điện thoại liên hệ.";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Địa chỉ Email không hợp lệ.";
  if (phone && !/^[0-9+().\s-]{8,20}$/.test(phone)) return "Số điện thoại không hợp lệ.";
  return null;
}

async function findById(id: string): Promise<UserRow | null> {
  if (!id) return null;
  const found = await db.select().from(users).where(eq(users.id, id));
  return found.length ? found[0] : null;
}

async function handleCreate(body: Record<string, any>) {
  const name = text(body.name);
  const username = text(body.username).toLowerCase();
  const password = String(body.password || "");
  const email = text(body.email);
  const phone = text(body.phone);
  const stationCode = text(body.stationCode);
  const role = text(body.role) || "Cán bộ Điểm trạm (Station Operator)";

  // Các trường bắt buộc khi khởi tạo tài khoản.
  if (!name) return json({ success: false, error: "Họ và tên là bắt buộc." }, 400);
  const usernameError = validateUsername(username);
  if (usernameError) return json({ success: false, error: usernameError }, 400);
  const passwordError = validatePasswordStrength(password);
  if (passwordError) return json({ success: false, error: passwordError }, 400);
  const contactError = validateContact(email, phone);
  if (contactError) return json({ success: false, error: contactError }, 400);
  if (!stationCode) return json({ success: false, error: "Điểm trạm trực thuộc là bắt buộc." }, 400);

  const existing = await db.select().from(users).where(eq(users.username, username));
  if (existing.length) {
    return json({ success: false, error: `Tên đăng nhập "${username}" đã tồn tại.` }, 409);
  }

  const now = Date.now();
  const row = {
    id: `U${now}${Math.floor(Math.random() * 1000)}`,
    username,
    name,
    role,
    email,
    phone,
    stationCode,
    canReceiveVideo: flag(body.canReceiveVideo, "true"),
    stationAccess: flag(body.stationAccess, "false"),
    doctorAccess: flag(body.doctorAccess, "false"),
    status: VALID_STATUS.has(text(body.status).toUpperCase()) ? text(body.status).toUpperCase() : "ACTIVE",
    passwordHash: await hashPassword(password),
    mustChangePassword: flag(body.mustChangePassword, "true"),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null
  };

  await db.insert(users).values(row);
  return json({ success: true, message: "Đã tạo tài khoản thành công.", user: publicUser(row as UserRow) });
}

async function handleUpdate(body: Record<string, any>) {
  const target = await findById(text(body.id));
  if (!target) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);

  const name = text(body.name) || target.name;
  const email = body.email === undefined ? text(target.email) : text(body.email);
  const phone = body.phone === undefined ? text(target.phone) : text(body.phone);
  const stationCode = text(body.stationCode) || text(target.stationCode);

  const contactError = validateContact(email, phone);
  if (contactError) return json({ success: false, error: contactError }, 400);
  if (!stationCode) return json({ success: false, error: "Điểm trạm trực thuộc là bắt buộc." }, 400);

  // Tên đăng nhập đổi được nhưng phải giữ tính duy nhất.
  const username = text(body.username).toLowerCase() || target.username;
  if (username !== target.username) {
    const usernameError = validateUsername(username);
    if (usernameError) return json({ success: false, error: usernameError }, 400);
    const clash = await db.select().from(users).where(eq(users.username, username));
    if (clash.length) return json({ success: false, error: `Tên đăng nhập "${username}" đã tồn tại.` }, 409);
  }

  const status = VALID_STATUS.has(text(body.status).toUpperCase())
    ? text(body.status).toUpperCase()
    : String(target.status || "ACTIVE").toUpperCase();

  const patch: Partial<UserRow> = {
    username,
    name,
    role: text(body.role) || target.role,
    email,
    phone,
    stationCode,
    canReceiveVideo: flag(body.canReceiveVideo, (target.canReceiveVideo as "true" | "false") || "true"),
    stationAccess: flag(body.stationAccess, (target.stationAccess as "true" | "false") || "false"),
    doctorAccess: flag(body.doctorAccess, (target.doctorAccess as "true" | "false") || "false"),
    status,
    updatedAt: Date.now()
  };

  // Mật khẩu chỉ đổi khi Quản trị chủ động nhập giá trị mới trong biểu mẫu sửa.
  const newPassword = String(body.password || "");
  if (newPassword) {
    const passwordError = validatePasswordStrength(newPassword);
    if (passwordError) return json({ success: false, error: passwordError }, 400);
    patch.passwordHash = await hashPassword(newPassword);
    patch.mustChangePassword = flag(body.mustChangePassword, "true");
  }

  await db.update(users).set(patch).where(eq(users.id, target.id));
  return json({
    success: true,
    message: "Đã cập nhật tài khoản.",
    user: publicUser({ ...target, ...patch } as UserRow)
  });
}

async function handleResetPassword(body: Record<string, any>) {
  const target = await findById(text(body.id));
  if (!target) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);

  // Quản trị có thể tự đặt mật khẩu mới, hoặc để hệ thống sinh mật khẩu tạm.
  const provided = String(body.password || "");
  const password = provided || generateTemporaryPassword();
  const passwordError = validatePasswordStrength(password);
  if (passwordError) return json({ success: false, error: passwordError }, 400);

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), mustChangePassword: "true", updatedAt: Date.now() })
    .where(eq(users.id, target.id));

  return json({
    success: true,
    message: `Đã đặt lại mật khẩu cho ${target.name}.`,
    // Mật khẩu tạm chỉ xuất hiện đúng một lần trong phản hồi này; hệ thống
    // không lưu bản rõ nên không có cách nào đọc lại sau đó.
    temporaryPassword: password,
    user: publicUser({ ...target, mustChangePassword: "true" } as UserRow)
  });
}

async function handleSetStatus(body: Record<string, any>, ctx: AuthContext) {
  const target = await findById(text(body.id));
  if (!target) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);

  const status = text(body.status).toUpperCase();
  if (!VALID_STATUS.has(status)) {
    return json({ success: false, error: "Trạng thái chỉ nhận ACTIVE hoặc DISABLED." }, 400);
  }
  // Tự khoá chính mình sẽ đẩy Quản trị ra khỏi hệ thống ngay lần gọi kế tiếp.
  if (status === "DISABLED" && target.id === ctx.user.id) {
    return json({ success: false, error: "Không thể tự khoá tài khoản đang đăng nhập." }, 400);
  }

  await db.update(users).set({ status, updatedAt: Date.now() }).where(eq(users.id, target.id));
  return json({
    success: true,
    message: status === "ACTIVE" ? `Đã kích hoạt tài khoản ${target.name}.` : `Đã khoá tài khoản ${target.name}.`,
    user: publicUser({ ...target, status } as UserRow)
  });
}

async function handleSetPermission(body: Record<string, any>) {
  const target = await findById(text(body.id));
  if (!target) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);

  const permission = text(body.permission);
  const granted = flag(body.granted, "false");

  const columns: Record<string, "stationAccess" | "doctorAccess" | "canReceiveVideo"> = {
    // "Quyền truy cập Mod Bảng điều khiển điểm trạm"
    station: "stationAccess",
    stationAccess: "stationAccess",
    // "Quyền truy cập Module Bác sĩ tuyến trên" - cấp tách khỏi quyền điểm trạm.
    doctor: "doctorAccess",
    doctorAccess: "doctorAccess",
    video: "canReceiveVideo",
    canReceiveVideo: "canReceiveVideo"
  };
  const column = columns[permission];
  if (!column) return json({ success: false, error: "Quyền không hợp lệ." }, 400);

  await db.update(users).set({ [column]: granted, updatedAt: Date.now() }).where(eq(users.id, target.id));

  const labels: Record<string, string> = {
    stationAccess: "Mod Bảng điều khiển điểm trạm",
    doctorAccess: "Module Bác sĩ tuyến trên",
    canReceiveVideo: "nhận cuộc gọi Video"
  };
  const label = labels[column];
  return json({
    success: true,
    message: `Đã ${granted === "true" ? "cấp" : "thu hồi"} quyền ${label} cho ${target.name}.`,
    user: publicUser({ ...target, [column]: granted } as UserRow)
  });
}

async function handleDelete(body: Record<string, any>, ctx: AuthContext) {
  const target = await findById(text(body.id));
  if (!target) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);
  if (target.id === ctx.user.id) {
    return json({ success: false, error: "Không thể xoá tài khoản đang đăng nhập." }, 400);
  }

  await db.delete(users).where(eq(users.id, target.id));
  return json({ success: true, message: `Đã xoá tài khoản ${target.name}.` });
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  try {
    // Middleware phân quyền: chỉ Quản trị viên còn hiệu lực mới đi tiếp được.
    const ctx = await requireScope(req, "admin");

    if (req.method === "GET") {
      const list = await db.select().from(users);
      return json({ success: true, users: list.map(publicUser) });
    }

    if (req.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }

    const body = (await req.json().catch(() => null)) as Record<string, any> | null;
    if (!body) return json({ success: false, error: "Body không hợp lệ" }, 400);

    switch (text(body.action)) {
      case "create":
        return await handleCreate(body);
      case "update":
        return await handleUpdate(body);
      case "reset_password":
        return await handleResetPassword(body);
      case "set_status":
        return await handleSetStatus(body, ctx);
      case "set_permission":
        return await handleSetPermission(body);
      case "delete":
        return await handleDelete(body, ctx);
      default:
        return json({ success: false, error: "Hành động không hợp lệ." }, 400);
    }
  } catch (err: any) {
    const authResponse = authErrorResponse(err, headers);
    if (authResponse) return authResponse;
    console.error("admin-users error", err);
    return json({ success: false, error: "Không thực hiện được thao tác quản lý tài khoản." }, 500);
  }
};

export const config = {
  path: "/api/admin-users"
};
