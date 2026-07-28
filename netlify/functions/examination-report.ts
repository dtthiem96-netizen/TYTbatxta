import { db } from "../../db/index.js";
import { examinationReports } from "../../db/schema.js";
import { desc, eq } from "drizzle-orm";

/**
 * Phiếu khám bệnh từ xa.
 *
 *   - POST /api/examination-report          lưu phiếu và trả về mã phiếu để in
 *   - GET  /api/examination-report?roomId=  các phiếu đã xuất của một phòng khám
 */

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers, status });

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  try {
    if (req.method === "GET") {
      const roomId = new URL(req.url).searchParams.get("roomId");
      if (!roomId) return json({ success: false, message: "Thiếu roomId" }, 400);
      const rows = await db
        .select()
        .from(examinationReports)
        .where(eq(examinationReports.roomId, roomId))
        .orderBy(desc(examinationReports.ts))
        .limit(20);
      return json({ success: true, data: rows });
    }

    if (req.method !== "POST") {
      return json({ success: false, message: "Method not allowed" }, 405);
    }

    const body = (await req.json().catch(() => null)) as Record<string, any> | null;
    if (!body) return json({ success: false, message: "Body không hợp lệ" }, 400);

    const now = Date.now();
    const reportCode = `PKTX-${String(now).slice(-6)}-${Math.trunc(now % 997)}`;
    const patientAge = Number(body.patientAge);

    await db.insert(examinationReports).values({
      reportCode,
      roomId: String(body.roomId || "room-01"),
      stationCode: String(body.stationCode || "TYT-STATION"),
      operatorName: String(body.operatorName || "Cán bộ Y tế"),
      patientName: String(body.patientName || "Bệnh nhân"),
      patientAge: Number.isFinite(patientAge) ? Math.trunc(patientAge) : 30,
      patientGender: String(body.patientGender || "Nam"),
      vitalsJson: JSON.stringify(body.vitals || {}),
      clinicalNotes: String(body.clinicalNotes || ""),
      diagnosis: String(body.diagnosis || ""),
      icd10: String(body.icd10 || ""),
      treatmentPlan: String(body.treatmentPlan || ""),
      prescription: String(body.prescription || ""),
      doctorNotes: String(body.doctorNotes || ""),
      status: "COMPLETED",
      ts: now
    });

    return json({
      success: true,
      message: "Đã hoàn tất và xuất Phiếu khám bệnh từ xa thành công!",
      data: {
        reportCode,
        createdAt: new Date(now).toLocaleString("vi-VN"),
        patientName: body.patientName,
        stationCode: body.stationCode,
        operatorName: body.operatorName,
        diagnosis: body.diagnosis,
        icd10: body.icd10,
        treatmentPlan: body.treatmentPlan,
        prescription: body.prescription
      }
    });
  } catch (err: any) {
    console.error("examination-report error", err);
    return json({ success: false, message: err?.message || "Không xuất được phiếu khám" }, 500);
  }
};

export const config = {
  path: "/api/examination-report"
};
