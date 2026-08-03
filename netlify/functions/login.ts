import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers, status });

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  if (req.method !== "POST") {
    return json({ success: false, message: "Method not allowed" }, 405);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    const { stationCode, operatorName, role, username, password } = body;

    // Station Operator Quick Session Login
    if (stationCode || operatorName) {
      const code = String(stationCode || "TYT-BATXAT-01").trim();
      const opName = String(operatorName || "Cán bộ Y tế").trim();
      const roomId = `room-${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

      return json({
        success: true,
        data: {
          stationCode: code,
          operatorName: opName,
          role: role || "station_operator",
          roomId,
          sessionToken: `token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        }
      });
    }

    // Username/Password authentication
    if (username && password) {
      const found = await db.select().from(users).where(eq(users.username, username));
      if (!found || found.length === 0) {
        return json({ success: false, error: "Unauthorized" }, 401);
      }

      const user = found[0];
      const userRole = user.role || "";
      const isStation = /điểm trạm|diem tram|station|cán bộ/i.test(userRole);

      return json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          canReceiveVideo: user.canReceiveVideo,
          isStation
        }
      });
    }

    return json({ success: false, message: "Vui lòng nhập thông tin đăng nhập." }, 400);
  } catch (err: any) {
    return json({ success: false, message: err.message || "Lỗi xử lý đăng nhập" }, 500);
  }
};
