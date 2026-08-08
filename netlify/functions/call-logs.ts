/**
 * API Lịch sử cuộc gọi khám từ xa.
 *
 * Phục vụ khối "Lịch sử cuộc gọi khám từ xa" nằm ngay dưới mục CMS
 * "Danh sách Đăng ký Khám bệnh & Khám Từ xa". Mỗi bản ghi lưu đủ 5 nhóm thông
 * tin nghiệp vụ: thời gian + ngày gọi, điểm tiếp nhận cuộc gọi, cán bộ nhận
 * cuộc gọi, đơn thuốc đã kê trong lượt khám và toàn bộ nội dung trò chuyện.
 *
 *   GET  /api/call-logs?limit=&roomId=&station=&q=   danh sách lịch sử
 *   POST /api/call-logs { action: ... }
 *        start    mở bản ghi khi cán bộ bấm tiếp nhận cuộc gọi
 *        update   cập nhật đơn thuốc / hội thoại trong lúc đang khám
 *        finish   chốt bản ghi khi kết thúc cuộc gọi
 *        delete   xoá một bản ghi (chỉ Quản trị viên)
 *
 * Bản ghi chứa bệnh sử và lời thoại của bệnh nhân, nên KHÔNG có tuyến công
 * khai: mọi lượt gọi đều phải kèm phiếu phiên còn hiệu lực. Cán bộ có quyền
 * nhận cuộc gọi (video) ghi và đọc được lịch sử; riêng thao tác xoá dành cho
 * Quản trị viên.
 */
import { db } from "../../db/index.js";
import { callLogs } from "../../db/schema.js";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { authErrorResponse, requireScope, type AuthContext } from "../lib/auth.js";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { headers, status });

const text = (value: unknown) => String(value === undefined || value === null ? "" : value).trim();

/** Cắt bớt trường văn bản dài để một bản ghi lỗi không làm phình cơ sở dữ liệu. */
const clamp = (value: unknown, max: number) => text(value).slice(0, max);

const num = (value: unknown): number | null => {
  // null/undefined/chuỗi rỗng phải trả về null, KHÔNG phải 0: Number(null) === 0
  // sẽ ghi mốc thời gian rỗng thành 1970 và làm sai thời lượng cuộc gọi.
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Cán bộ trực (quyền video) được ghi và đọc lịch sử cuộc gọi; Quản trị viên
 * cũng vào được kể cả khi tài khoản không bật quyền nhận cuộc gọi.
 */
async function requireCallAccess(req: Request): Promise<AuthContext> {
  try {
    return await requireScope(req, "video");
  } catch (err) {
    return await requireScope(req, "admin");
  }
}

/**
 * Chuẩn hoá nội dung trò chuyện về JSON gọn: chỉ giữ người nói, nội dung và
 * mốc thời gian. Ảnh/tệp đính kèm trong khung chat được rút thành nhãn văn bản
 * thay vì lưu nguyên chuỗi base64.
 */
function normalizeTranscript(raw: unknown): { json: string; count: number } {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch (err) {
      list = [];
    }
  }
  if (!Array.isArray(list)) return { json: "[]", count: 0 };

  const cleaned = list.slice(-500).map((item: any) => {
    let body = text(item && item.text);
    // Ảnh/tệp gửi kèm đi vào chat dưới dạng thẻ HTML data-URI: thay bằng nhãn.
    body = body
      .replace(/<img[^>]*>/gi, "[Hình ảnh đính kèm]")
      .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "[Tệp đính kèm: $1]")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .trim();
    return {
      sender: clamp(item && item.sender, 120) || "Không rõ",
      text: body.slice(0, 2000),
      at: clamp(item && item.at, 40)
    };
  });

  return { json: JSON.stringify(cleaned), count: cleaned.length };
}

/** Dựng phần dữ liệu ghi xuống bảng từ nội dung mà giao diện gửi lên. */
function buildRecord(body: any, auth: AuthContext) {
  const startedAt = num(body.startedAt);
  const endedAt = num(body.endedAt);
  const transcript = body.chatTranscript === undefined ? null : normalizeTranscript(body.chatTranscript);

  const record: Record<string, unknown> = {
    roomId: clamp(body.roomId, 200),
    appointmentId: clamp(body.appointmentId, 120) || null,
    patientName: clamp(body.patientName, 200) || null,
    patientId: clamp(body.patientId, 60) || null,
    stationCode: clamp(body.stationCode, 60) || null,
    stationName: clamp(body.stationName, 200) || null,
    /* Cán bộ nhận cuộc gọi luôn lấy từ phiếu phiên, không lấy theo tên mà
       trình duyệt gửi lên: nhật ký phải trung thực với tài khoản đã đăng nhập. */
    operatorName: auth.user.name,
    operatorUsername: auth.user.username,
    operatorRole: auth.user.role,
    callDate: clamp(body.callDate, 40) || null,
    callTime: clamp(body.callTime, 40) || null,
    diagnosis: clamp(body.diagnosis, 4000) || null,
    treatmentPlan: clamp(body.treatmentPlan, 4000) || null,
    prescription: clamp(body.prescription, 8000) || null,
    doctorAdvice: clamp(body.doctorAdvice, 4000) || null,
    signerName: clamp(body.signerName, 200) || null,
    vitalsJson: body.vitals ? JSON.stringify(body.vitals).slice(0, 4000) : null
  };

  if (startedAt !== null) record.startedAt = startedAt;
  if (endedAt !== null) record.endedAt = endedAt;
  if (startedAt !== null && endedAt !== null) {
    record.durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  }
  if (transcript) {
    record.chatTranscript = transcript.json;
    record.chatCount = transcript.count;
  }

  // Bỏ các trường rỗng khi cập nhật để không xoá mất dữ liệu đã ghi trước đó.
  return record;
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers, status: 204 });

  try {
    const auth = await requireCallAccess(req);

    if (req.method === "GET") {
      const url = new URL(req.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 500);
      const roomId = text(url.searchParams.get("roomId"));
      const station = text(url.searchParams.get("station"));
      const q = text(url.searchParams.get("q"));

      const filters: SQL[] = [];
      if (roomId) filters.push(eq(callLogs.roomId, roomId));
      if (station) filters.push(eq(callLogs.stationCode, station));
      if (q) {
        const like = `%${q}%`;
        filters.push(
          or(
            ilike(callLogs.patientName, like),
            ilike(callLogs.operatorName, like),
            ilike(callLogs.roomId, like),
            ilike(callLogs.stationName, like)
          ) as SQL
        );
      }

      const rows = await db
        .select()
        .from(callLogs)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(callLogs.ts))
        .limit(limit);

      return json({ success: true, callLogs: rows });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return json({ success: false, error: "Nội dung yêu cầu không hợp lệ." }, 400);
      }

      const action = text((body as any).action) || "update";
      const id = clamp((body as any).id, 120);

      if (action === "delete") {
        // Xoá nhật ký là thao tác nhạy cảm: chỉ Quản trị viên được phép.
        await requireScope(req, "admin");
        if (!id) return json({ success: false, error: "Thiếu mã bản ghi cần xoá." }, 400);
        await db.delete(callLogs).where(eq(callLogs.id, id));
        return json({ success: true });
      }

      if (!id) return json({ success: false, error: "Thiếu mã bản ghi lịch sử cuộc gọi." }, 400);
      const record = buildRecord(body, auth);
      if (!record.roomId) return json({ success: false, error: "Thiếu mã phòng khám." }, 400);

      const existing = await db.select().from(callLogs).where(eq(callLogs.id, id));

      if (action === "start") {
        if (existing.length) {
          return json({ success: true, id, already: true });
        }
        await db.insert(callLogs).values({
          ...(record as any),
          id,
          status: "IN_CALL",
          ts: Date.now()
        });
        return json({ success: true, id });
      }

      // update / finish: chỉ ghi đè các trường thực sự có nội dung.
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (value !== null && value !== undefined && value !== "") patch[key] = value;
      }
      if (action === "finish") {
        patch.status = "COMPLETED";
        if (patch.endedAt === undefined) patch.endedAt = Date.now();
      }

      if (!existing.length) {
        await db.insert(callLogs).values({
          ...(patch as any),
          id,
          roomId: record.roomId as string,
          status: action === "finish" ? "COMPLETED" : "IN_CALL",
          ts: Date.now()
        });
        return json({ success: true, id, created: true });
      }

      await db.update(callLogs).set(patch as any).where(eq(callLogs.id, id));
      return json({ success: true, id });
    }

    return json({ success: false, error: "Method not allowed" }, 405);
  } catch (err: any) {
    const authResponse = authErrorResponse(err, headers);
    if (authResponse) return authResponse;
    console.error("call-logs", err);
    return json({ success: false, error: err?.message || "Lỗi máy chủ lịch sử cuộc gọi." }, 500);
  }
};

export const config = {
  path: "/api/call-logs"
};
