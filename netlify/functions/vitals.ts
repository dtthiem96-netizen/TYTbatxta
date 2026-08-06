import { db } from "../../db/index.js";
import { stationVitals, telehealthRooms, telehealthSignals } from "../../db/schema.js";
import { desc, eq } from "drizzle-orm";
import { authErrorResponse, requireScope, type AuthContext } from "../lib/auth.js";

/**
 * Sinh hiệu bệnh nhân do Bảng điều khiển điểm trạm (public/index.html) gửi lên.
 *
 *   - POST /api/vitals            lưu chỉ số + đánh giá cảnh báo + đẩy thẳng lên màn hình Bác sĩ
 *   - GET  /api/vitals/:roomId    10 lần đo gần nhất của phòng khám
 *
 * Bản tin đẩy sang Bác sĩ dùng đúng định dạng mà engine telehealth trong index.html
 * đang đọc ({ bp, hr, spo2, temp, weight, at }) để hai đầu hiểu nhau mà không cần chuyển đổi.
 *
 * Đây là dữ liệu sức khoẻ của bệnh nhân, nên cả hai chiều đều nằm sau middleware
 * phân quyền: người gọi phải có phiếu phiên còn hạn kèm quyền "station" mà CMS
 * Quản trị đã cấp cho tài khoản.
 */

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers, status });

type Vitals = {
  bp_sys: number;
  bp_dia: number;
  heart_rate: number;
  spo2: number;
  temperature: number;
  weight: number;
};

/**
 * Đánh giá mức độ nguy hiểm của sinh hiệu để bật cảnh báo tại điểm trạm.
 *
 * Ngưỡng phải TRÙNG với evaluateVitalsLocally() trong app.js: trạm bật biểu ngữ
 * cảnh báo ngay tại trình duyệt, còn bản ghi chính thức thì do hàm này tạo ra.
 * Nếu hai bên lệch nhau thì cán bộ trạm thấy CẤP CỨU trong khi hồ sơ chỉ ghi
 * WARNING (hoặc NORMAL) - tuyến trên đọc lại sẽ đánh giá thấp mức nguy hiểm.
 * `tools/vitals-parity.mjs` khoá hai bản này lại với nhau.
 */
function evaluateVitals(v: Vitals) {
  const alerts: Array<{ level: string; msg: string }> = [];
  let status = "NORMAL";

  const critical = (msg: string) => {
    alerts.push({ level: "CRITICAL", msg });
    status = "CRITICAL";
  };
  const warn = (msg: string) => {
    alerts.push({ level: "WARNING", msg });
    if (status !== "CRITICAL") status = "WARNING";
  };

  if (v.spo2 < 92) {
    critical(`CẢNH BÁO CẤP CỨU: Nồng độ Oxy SpO2 giảm nguy hiểm (${v.spo2}% < 92%). Cần thở Oxy hỗ trợ khẩn cấp!`);
  } else if (v.spo2 < 95) {
    warn(`Cảnh báo: SpO2 nhẹ/vừa (${v.spo2}%). Theo dõi sát đường hô hấp.`);
  }

  if (v.bp_sys >= 160 || v.bp_dia >= 100) {
    critical(
      `CẢNH BÁO CẤP CỨU: Cơn tăng huyết áp cấp cứu (${v.bp_sys}/${v.bp_dia} mmHg). Nguy cơ biến cố tim mạch/đột quỵ!`
    );
  } else if (v.bp_sys >= 140 || v.bp_sys < 90 || v.bp_dia >= 90 || v.bp_dia < 60) {
    warn(`Cảnh báo Huyết áp bất thường: ${v.bp_sys}/${v.bp_dia} mmHg.`);
  }

  if (v.heart_rate >= 130 || v.heart_rate <= 45) {
    critical(
      `CẢNH BÁO CẤP CỨU: Nhịp tim ${v.heart_rate} bpm ngoài ngưỡng an toàn. Cần điện tâm đồ ECG ngay!`
    );
  } else if (v.heart_rate > 100 || v.heart_rate < 55) {
    warn(`Nhịp tim bất thường (${v.heart_rate} bpm). Cần kiểm tra điện tâm đồ ECG.`);
  }

  if (v.temperature >= 39.5 || v.temperature <= 35) {
    critical(
      `CẢNH BÁO CẤP CỨU: Nhiệt độ ${v.temperature}°C. Nguy cơ sốt cao/hạ nhiệt độ.`
    );
  } else if (v.temperature >= 38.5) {
    warn(`Sốt cao (${v.temperature}°C). Cần chườm ấm & xem xét hạ sốt khẩn.`);
  }

  return { status, alerts };
}

async function handleGet(url: URL) {
  // Hỗ trợ cả /api/vitals/:roomId lẫn /api/vitals?roomId=...
  const fromPath = url.pathname.replace(/^\/api\/vitals\/?/, "");
  const roomId = decodeURIComponent(fromPath) || url.searchParams.get("roomId") || "";
  if (!roomId) return json({ success: false, message: "Thiếu roomId" }, 400);

  const records = await db
    .select()
    .from(stationVitals)
    .where(eq(stationVitals.roomId, roomId))
    .orderBy(desc(stationVitals.ts))
    .limit(10);

  return json({ success: true, data: records });
}

async function handlePost(req: Request, ctx: AuthContext) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ success: false, message: "Body không hợp lệ" }, 400);

  const num = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const roomId = String(body.roomId || "default-room");
  const peerId = String(body.peerId || "station");
  const stationCode = String(body.stationCode || "TYT-BATXAT");
  // Cán bộ đo sinh hiệu lấy từ phiếu phiên đã xác thực, không lấy theo thân yêu cầu.
  const operatorName = ctx.user.name || String(body.operatorName || "Cán bộ Y tế");
  const patientName = String(body.patientName || "Bệnh nhân");
  const patientGender = String(body.patientGender || "Nam");
  const patientAge = Math.trunc(num(body.patientAge, 45));
  const symptoms = String(body.symptoms || "");

  const vitals: Vitals = {
    bp_sys: Math.trunc(num(body.bpSys, 120)),
    bp_dia: Math.trunc(num(body.bpDia, 80)),
    heart_rate: Math.trunc(num(body.heartRate, 75)),
    spo2: num(body.spo2, 98),
    temperature: num(body.temperature, 36.8),
    weight: num(body.weight, 60)
  };

  const evaluation = evaluateVitals(vitals);
  const now = Date.now();

  await db.insert(stationVitals).values({
    roomId,
    stationCode,
    operatorName,
    patientName,
    patientAge,
    patientGender,
    bpSys: vitals.bp_sys,
    bpDia: vitals.bp_dia,
    heartRate: vitals.heart_rate,
    spo2: vitals.spo2,
    temperature: vitals.temperature,
    weight: vitals.weight,
    symptoms,
    status: evaluation.status,
    ts: now
  });

  // Định dạng bản tin đúng như màn hình Bác sĩ trong index.html đang đọc.
  const wireVitals = {
    bp: `${vitals.bp_sys}/${vitals.bp_dia}`,
    hr: String(vitals.heart_rate),
    spo2: String(vitals.spo2),
    temp: String(vitals.temperature),
    weight: String(vitals.weight),
    at: new Date(now).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
  };

  // Ghi vào phòng khám để Bác sĩ vào sau vẫn thấy chỉ số mới nhất.
  const existing = await db.select().from(telehealthRooms).where(eq(telehealthRooms.id, roomId));
  if (existing.length) {
    await db
      .update(telehealthRooms)
      .set({ vitals: JSON.stringify(wireVitals), patientName, symptoms, updatedAt: now })
      .where(eq(telehealthRooms.id, roomId));
  } else {
    await db
      .insert(telehealthRooms)
      .values({ id: roomId, patientName, symptoms, vitals: JSON.stringify(wireVitals), updatedAt: now });
  }

  // Đẩy ngay cho các thành viên đang trong phòng (Bác sĩ nhận qua vòng long-poll /api/signal).
  await db.insert(telehealthSignals).values({
    roomId,
    fromPeer: peerId,
    toPeer: null,
    type: "vitals",
    payload: JSON.stringify(wireVitals),
    ts: now
  });

  return json({
    success: true,
    message: "Sinh hiệu bệnh nhân đã được đồng bộ trực tiếp lên màn hình khám.",
    data: {
      timestamp: new Date(now).toISOString(),
      stationCode,
      operatorName,
      patientName,
      patientAge,
      patientGender,
      vitals,
      wireVitals,
      symptoms,
      evaluation
    }
  });
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  try {
    const ctx = await requireScope(req, "station");
    if (req.method === "GET") return await handleGet(new URL(req.url));
    if (req.method === "POST") return await handlePost(req, ctx);
    return json({ success: false, message: "Method not allowed" }, 405);
  } catch (err: any) {
    const authResponse = authErrorResponse(err, headers);
    if (authResponse) return authResponse;
    console.error("vitals error", err);
    return json({ success: false, message: err?.message || "Lỗi xử lý sinh hiệu" }, 500);
  }
};

export const config = {
  path: ["/api/vitals", "/api/vitals/:roomId"]
};
