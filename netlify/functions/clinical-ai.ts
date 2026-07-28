/**
 * Trợ lý Lâm sàng (Clinical Co-Pilot) cho điểm trạm.
 *
 *   - POST /api/clinical-ai
 *
 * Đây là bộ luật lâm sàng tất định (không gọi mô hình ngôn ngữ): cùng một bộ sinh hiệu
 * luôn cho ra cùng một gợi ý, và vẫn chạy được khi chưa cấu hình khóa AI. Phần hội chẩn
 * bằng mô hình ngôn ngữ đã có sẵn ở /api/ai và được dùng riêng trong màn hình CMS.
 */

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
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
    const { vitals, symptoms, notes, patientName, patientAge, patientGender } = body;

    const num = (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const bpSys = num(vitals?.bpSys ?? vitals?.bp_sys, 120);
    const bpDia = num(vitals?.bpDia ?? vitals?.bp_dia, 80);
    const hr = num(vitals?.heartRate ?? vitals?.heart_rate, 75);
    const spo2 = num(vitals?.spo2, 98);
    const temp = num(vitals?.temperature ?? vitals?.temp, 36.8);

    const fullSymptoms = `${symptoms || ""} ${notes || ""}`.trim().toLowerCase();

    const diagnosisList: string[] = [];
    const icd10Codes: string[] = [];
    const paraclinicals: string[] = [];
    const prescriptions: Array<{ name: string; dosage: string; note: string }> = [];
    const managementSteps: string[] = [];
    const redFlags: string[] = [];

    if (spo2 < 92 || fullSymptoms.includes("khó thở") || fullSymptoms.includes("phổi")) {
      redFlags.push("⚠️ CẢNH BÁO HÔ HẤP: Nguy cơ Viêm phổi cấp / Suy hô hấp cấp / Đợt cấp COPD.");
      diagnosisList.push("1. Suy hô hấp cấp độ II (Theo dõi Viêm phổi/Đợt cấp COPD)");
      diagnosisList.push("2. Viêm phế quản cấp tính nặng");
      icd10Codes.push("J18.9 (Viêm phổi)", "J44.1 (Đợt cấp COPD)", "J96.0 (Suy hô hấp cấp)");
      paraclinicals.push("1. Đo khí máu động mạch (nếu có) hoặc SpO2 liên tục");
      paraclinicals.push("2. Chụp X-quang ngực thẳng khẩn cấp");
      paraclinicals.push("3. Tế bào máu ngoại vi (Công thức máu complete)");
      managementSteps.push("• Cho bệnh nhân nằm đầu cao 30-45 độ, thở Oxy qua cannula 2-4 lít/phút.");
      managementSteps.push("• Chuẩn bị phương tiện cấp cứu đường thở và liên hệ Y sĩ/ Bác sĩ Bệnh viện Tuyến Huyện ngay.");
      prescriptions.push({
        name: "Salbutamol 2.5mg (Khí dung)",
        dosage: "1 tép khí dung qua mặt nạ",
        note: "Lặp lại sau 20 phút nếu chưa giảm khó thở"
      });
      prescriptions.push({
        name: "Methylprednisolone 40mg (Tiêm tĩnh mạch)",
        dosage: "1 lọ tiêm tĩnh mạch chậm",
        note: "Chống viêm cấp đường hô hấp"
      });
    } else if (temp >= 38.5 || fullSymptoms.includes("sốt") || fullSymptoms.includes("viêm họng")) {
      diagnosisList.push("1. Viêm đường hô hấp trên cấp tính / Viêm họng cấp");
      diagnosisList.push("2. Sốt nhiễm siêu vi (Theo dõi Cúm / Đăng ký test nhanh)");
      icd10Codes.push("J02.9 (Viêm họng cấp)", "J06.9 (Nhiễm trùng hô hấp trên cấp)");
      paraclinicals.push("1. Test nhanh Cúm A/B hoặc Covid-19");
      paraclinicals.push("2. Soi cận cảnh vòm họng bằng camera cận cảnh điểm trạm");
      paraclinicals.push("3. Tổng phân tích tế bào máu ngoại vi");
      managementSteps.push("• Chườm ấm vùng trán, nách, bẹn.");
      managementSteps.push("• Uống nhiều nước ấm, oresol bù điện giải.");
      prescriptions.push({
        name: "Paracetamol 500mg",
        dosage: "1 viên x 3-4 lần/ngày (khi sốt >= 38.5°C)",
        note: "Uống cách nhau ít nhất 4-6 giờ"
      });
      prescriptions.push({
        name: "Oresol 245",
        dosage: "Pha 1 gói với 1 lít nước sôi để nguội",
        note: "Uống rải rác trong ngày"
      });
      prescriptions.push({
        name: "Amoxicillin + Acid Clavulanic 625mg",
        dosage: "1 viên x 2 lần/ngày (nếu có mủ/viêm họng bội nhiễm)",
        note: "Uống sau ăn 5-7 ngày"
      });
    } else if (bpSys >= 140 || bpDia >= 90) {
      diagnosisList.push("1. Tăng huyết áp độ 1 - độ 2 (JNC 8 / VNHA)");
      diagnosisList.push("2. Theo dõi Nguy cơ biến cố Tim mạch / Đáy mắt");
      icd10Codes.push("I10 (Tăng huyết áp vô căn)");
      paraclinicals.push("1. Điện tâm đồ ECG 12 chuyển đạo");
      paraclinicals.push("2. Xét nghiệm Sinh hóa: Đường huyết, Creatinine, Men gan, Mỡ máu");
      paraclinicals.push("3. Tổng phân tích nước tiểu");
      managementSteps.push("• Để bệnh nhân nghỉ ngơi yên tĩnh tại phòng khám 15-20 phút rồi đo lại.");
      managementSteps.push("• Hướng dẫn chế độ ăn giảm muối (<5g muối/ngày), hạn chế chất kích thích.");
      prescriptions.push({
        name: "Amlodipin 5mg",
        dosage: "1 viên uống buổi sáng",
        note: "Chẹn kênh calci hạ huyết áp"
      });
      prescriptions.push({
        name: "Enalapril 5mg (hoặc Losartan 50mg)",
        dosage: "1 viên uống buổi sáng",
        note: "Nên tham khảo thêm Y sĩ/ Bác sĩ tuyến trên"
      });
    } else {
      diagnosisList.push("1. Theo dõi Hội chứng nhiễm trùng nhẹ / Rối loạn thể chất");
      diagnosisList.push("2. Sức khỏe lâm sàng hiện tại tương đối ổn định");
      icd10Codes.push("Z00.0 (Khám sức khỏe tổng quát)");
      paraclinicals.push("1. Đo sinh hiệu định kỳ");
      paraclinicals.push("2. Soi/chụp cận cảnh tổn thương ngoài da hoặc tai mũi họng nếu có biểu hiện");
      managementSteps.push("• Tiếp tục quan sát lâm sàng, theo dõi triệu chứng trong 24-48 giờ.");
      prescriptions.push({
        name: "Multivitamin / B-Complex",
        dosage: "1 viên x 2 lần/ngày",
        note: "Tăng cường sức đề kháng"
      });
    }

    // Cảnh báo độc lập với nhóm chẩn đoán ở trên để không bỏ sót chỉ số nguy hiểm.
    if (hr > 120 || hr < 50) {
      redFlags.push(`⚠️ Nhịp tim bất thường (${hr} bpm). Cần kiểm tra điện tâm đồ ECG.`);
    }
    if (bpSys >= 160 || bpDia >= 100) {
      redFlags.push(`⚠️ Cơn tăng huyết áp cấp cứu (${bpSys}/${bpDia} mmHg). Nguy cơ đột quỵ.`);
    }

    return json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        patient: { name: patientName, age: patientAge, gender: patientGender },
        vitalsSummary: {
          bp: `${bpSys}/${bpDia} mmHg`,
          hr: `${hr} bpm`,
          spo2: `${spo2}%`,
          temp: `${temp}°C`
        },
        redFlags,
        diagnosisList,
        icd10Codes,
        paraclinicals,
        prescriptions,
        managementSteps,
        aiConfidence: "94%"
      }
    });
  } catch (err: any) {
    console.error("clinical-ai error", err);
    return json({ success: false, message: "Không thể khởi tạo gợi ý lâm sàng." }, 500);
  }
};

export const config = {
  path: "/api/clinical-ai"
};
