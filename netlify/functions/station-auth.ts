import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";

export default async (req: Request) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { headers, status: 405 });
    }

    const body = await req.json();
    const { username, password } = body || {};
    if (!username || !password) {
      return new Response(JSON.stringify({ success: false, error: "Missing username or password" }), { headers, status: 400 });
    }

    const found = await db.select().from(users).where(eq(users.username, username));
    if (!found || found.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { headers, status: 401 });
    }

    const user = found[0];
    const role = (user.role || "").toString();

    // Password check using environment variable; fallback to a development password.
    const secret = process.env.STATION_PASSWORD || process.env.STATION_DEFAULT_PASSWORD || null;
    if (secret) {
      if (password !== secret) {
        return new Response(JSON.stringify({ success: false, error: "Invalid credentials" }), { headers, status: 401 });
      }
    } else {
      // Development fallback (insecure): accept a known dev password for local testing only.
      if (password !== 'admin123') {
        return new Response(JSON.stringify({ success: false, error: "Invalid credentials" }), { headers, status: 401 });
      }
    }

    /*
     * Quyền vào Module Bảng điều khiển trạm do CMS Quản trị cấp qua cột station_access.
     * Cột này mới được thêm nên các tài khoản tạo từ trước còn để trống; khi đó suy ra
     * quyền từ vai trò (Cán bộ Điểm trạm / Quản trị viên) để không khoá nhầm những
     * tài khoản vốn đã sử dụng Bảng điều khiển. Khi Quản trị đặt rõ ràng 'true'/'false'
     * thì giá trị đó luôn thắng.
     */
    const granted = (user.stationAccess || "").toString().trim().toLowerCase();
    const inferredFromRole = /điểm trạm|diem tram|station|admin|quản trị|quan tri/i.test(role);
    const allowed = granted === "true" || (granted !== "false" && inferredFromRole);

    if (!allowed) {
      return new Response(JSON.stringify({
        success: false,
        error: "Tài khoản chưa được CMS Quản trị cấp quyền truy cập Bảng điều khiển trạm"
      }), { headers, status: 403 });
    }

    return new Response(JSON.stringify({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        canReceiveVideo: user.canReceiveVideo,
        stationAccess: allowed ? "true" : "false"
      }
    }), { headers, status: 200 });
  } catch (err: any) {
    console.error(err);
    return new Response(JSON.stringify({ error: err?.message || String(err) }), { headers, status: 500 });
  }
};

export const config = {
  path: "/api/station-auth",
};
