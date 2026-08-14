import { authErrorResponse, requireAnyScope } from "../lib/auth.js";
import {
  describeGoogleAiError,
  getGoogleAiClient,
  normalizeModel,
  resolveGoogleAiConnection
} from "../lib/google-ai.js";

/**
 * AI ĐIỀU PHỐI KHÁM BỆNH ĐA BÊN (Multi-Party AI Medical Coordinator).
 *
 *   - POST /api/ai-coordinator   { stage, patient, vitals, symptoms, notes, term, conclusion }
 *
 * Một phiên khám từ xa ở đây luôn có ba chủ thể ngồi ở ba đầu khác nhau: bệnh
 * nhân, cán bộ y tế tại điểm trạm, và bác sĩ chuyên khoa tuyến trên. Ba người
 * cần ba thứ ngôn ngữ khác nhau cho cùng một sự việc - bệnh nhân cần lời dặn
 * mộc mạc, hai bác sĩ cần bản tóm tắt SBAR đọc trong mười giây. Hàm này lo đúng
 * việc đó: nhận trạng thái buổi khám, trả về các thông điệp ĐÃ GẮN NHÃN người
 * nhận để giao diện phát đúng chỗ.
 *
 * Bốn giai đoạn theo đúng luồng của một buổi khám:
 *   1. intake  - Tiếp nhận: khai thác thêm gì ở bệnh nhân, đo thêm gì tại trạm.
 *   2. handoff - Bác sĩ tuyến trên vừa vào phòng: xuất tóm tắt SBAR DƯỚI 150 TỪ.
 *   3. explain - Trong lúc hội chẩn: dịch một thuật ngữ y khoa sang lời thường.
 *   4. wrapup  - Kết thúc: dự thảo toa thuốc & hướng dẫn để hai bác sĩ duyệt/ký.
 *
 * HAI LỚP, KHÔNG PHẢI MỘT
 * ------------------------------------------------------------------------
 * Lớp dưới là bộ luật tất định (assessVitals + các hàm compose*): cùng một bộ
 * sinh hiệu luôn cho ra cùng một cảnh báo, chạy được cả khi chưa cấu hình khoá
 * AI và cả khi Google trả lỗi. Lớp trên là Gemini, chỉ được giao phần diễn đạt.
 *
 * Vì sao chia như vậy: [CẢNH BÁO CẤP CỨU] là thứ không được phép phụ thuộc vào
 * việc một API bên ngoài có trả lời hay không. Ngưỡng sinh hiệu do bộ luật
 * quyết định; mô hình ngôn ngữ chỉ được THÊM cảnh báo chứ không bao giờ gỡ bỏ.
 *
 * RÀNG BUỘC AN TOÀN Y TẾ (bám theo quy tắc của phiên điều phối)
 * ------------------------------------------------------------------------
 *   - Không đưa ra chẩn đoán xác định, không kê đơn độc lập. Mọi kết quả đều là
 *     ĐỀ XUẤT/DỰ THẢO; quyết định cuối cùng thuộc về bác sĩ - nên mỗi phản hồi
 *     đều mang theo trường `disclaimer` và giao diện luôn hiển thị nó.
 *   - Toa thuốc dự thảo ở giai đoạn 4 đi ra từ KẾT LUẬN CỦA BÁC SĨ mà giao diện
 *     gửi lên, không phải từ suy đoán của mô hình.
 *
 * Quyền truy cập: phải có phiếu phiên còn hạn kèm quyền "station" hoặc "doctor".
 * Đây vừa là dữ liệu sức khoẻ của bệnh nhân (như /api/vitals), vừa là tuyến gọi
 * mô hình có tính phí - để ngỏ thì ai cũng đốt được tín dụng AI của trạm.
 */

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers, status });

/** Bốn giai đoạn của phiên điều phối. Giá trị lạ được quy về "intake". */
const STAGES = {
  intake: { phase: 1, label: "Giai đoạn 1 - Tiếp nhận & Chuẩn bị" },
  handoff: { phase: 2, label: "Giai đoạn 2 - Kết nối & Tóm tắt tuyến trên" },
  explain: { phase: 3, label: "Giai đoạn 3 - Hỗ trợ thảo luận" },
  wrapup: { phase: 4, label: "Giai đoạn 4 - Tổng hợp kết luận" }
} as const;

type StageKey = keyof typeof STAGES;

/** Trần độ dài bản tóm tắt bàn giao - bác sĩ tuyến trên phải đọc xong trong ~10 giây. */
const SBAR_WORD_LIMIT = 150;

const DISCLAIMER =
  "Nội dung do Trợ lý AI điều phối tổng hợp, chỉ mang tính ĐỀ XUẤT. " +
  "Chẩn đoán xác định và đơn thuốc chính thức thuộc thẩm quyền của Bác sĩ.";

type Vitals = {
  bp_sys: number;
  bp_dia: number;
  heart_rate: number;
  spo2: number;
  temperature: number;
  weight: number;
};

/**
 * Đánh giá mức nguy hiểm của sinh hiệu.
 *
 * Ngưỡng phải TRÙNG với evaluateVitalsLocally() trong app.js và evaluateVitals()
 * trong netlify/functions/vitals.ts. Nếu bản này nhẹ tay hơn hai bản kia thì
 * điểm trạm thấy biểu ngữ CẤP CỨU trong khi AI điều phối vẫn nói chuyện bình
 * thản với bệnh nhân - mâu thuẫn ngay trước mặt người bệnh, và tuyến trên nhận
 * bàn giao êm ả hơn thực tế. `tools/vitals-parity.mjs` khoá cả ba bản lại.
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
    critical(`CẢNH BÁO CẤP CỨU: Nhiệt độ ${v.temperature}°C. Nguy cơ sốt cao/hạ nhiệt độ.`);
  } else if (v.temperature >= 38.5) {
    warn(`Sốt cao (${v.temperature}°C). Cần chườm ấm & xem xét hạ sốt khẩn.`);
  }

  return { status, alerts };
}

/**
 * Triệu chứng nguy kịch mà bệnh nhân/cán bộ trạm mô tả bằng lời.
 *
 * Sinh hiệu không bắt được mọi thứ: đau ngực dữ dội, co giật hay mất ý thức có
 * thể xảy ra trên một bộ chỉ số còn trong ngưỡng. Đây là lưới an toàn thứ hai,
 * đọc trên phần mô tả tự do của cả hai đầu.
 */
const RED_FLAG_PHRASES: Array<{ match: string[]; msg: string }> = [
  {
    match: ["đau ngực", "đau thắt ngực", "tức ngực"],
    msg: "CẢNH BÁO CẤP CỨU: Bệnh nhân khai đau ngực - loại trừ hội chứng vành cấp, đo ECG ngay."
  },
  {
    match: ["khó thở", "hụt hơi", "thở rít"],
    msg: "CẢNH BÁO CẤP CỨU: Bệnh nhân khó thở - đánh giá đường thở, chuẩn bị Oxy."
  },
  {
    match: ["ngất", "mất ý thức", "lơ mơ", "hôn mê"],
    msg: "CẢNH BÁO CẤP CỨU: Rối loạn ý thức - kiểm tra đường huyết mao mạch và dấu hiệu thần kinh khu trú."
  },
  {
    match: ["co giật", "động kinh"],
    msg: "CẢNH BÁO CẤP CỨU: Cơn co giật - đặt bệnh nhân nằm nghiêng an toàn, hút đờm dãi, chống chấn thương."
  },
  {
    match: ["liệt", "méo miệng", "nói ngọng", "yếu nửa người"],
    msg: "CẢNH BÁO CẤP CỨU: Dấu hiệu đột quỵ (FAST) - tính giờ khởi phát, chuyển tuyến khẩn."
  },
  {
    match: ["chảy máu", "xuất huyết", "nôn ra máu", "ho ra máu"],
    msg: "CẢNH BÁO CẤP CỨU: Chảy máu đang tiến triển - đánh giá huyết động, lập đường truyền."
  },
  {
    match: ["đau bụng dữ dội", "bụng cứng"],
    msg: "CẢNH BÁO CẤP CỨU: Bụng ngoại khoa - nhịn ăn uống, hội chẩn ngoại khoa."
  }
];

const num = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const text = (value: unknown, max = 1500) => String(value ?? "").trim().slice(0, max);

/** Đếm từ theo khoảng trắng - đủ dùng cho tiếng Việt vì mỗi âm tiết là một "từ". */
const wordCount = (value: string) => (value.trim() ? value.trim().split(/\s+/).length : 0);

/**
 * Cắt bản tóm tắt về đúng trần 150 từ.
 *
 * Cắt từ cuối lên: Situation và Background là thứ bác sĩ tuyến trên cần trước
 * tiên, nên phần bị rút gọn phải là Recommendation rồi mới tới Assessment.
 */
function clampSbar(sbar: Record<string, string>, limit = SBAR_WORD_LIMIT) {
  const order = ["recommendation", "assessment", "background", "situation"];
  const out = { ...sbar };
  const total = () => order.reduce((sum, key) => sum + wordCount(out[key] || ""), 0);

  for (const key of order) {
    if (total() <= limit) break;
    const words = (out[key] || "").trim().split(/\s+/).filter(Boolean);
    const over = total() - limit;
    if (words.length <= 1) continue;
    const keep = Math.max(1, words.length - over);
    out[key] = words.slice(0, keep).join(" ") + (keep < words.length ? "…" : "");
  }
  return out;
}

/** Mô tả sinh hiệu một dòng, dùng lại ở cả tóm tắt SBAR lẫn lời nhắn cho bệnh nhân. */
const vitalsLine = (v: Vitals) =>
  `HA ${v.bp_sys}/${v.bp_dia} mmHg, Mạch ${v.heart_rate} l/p, SpO2 ${v.spo2}%, Nhiệt độ ${v.temperature}°C` +
  (v.weight ? `, Cân nặng ${v.weight} kg` : "");

/** "Nguyễn Văn A, 55 tuổi, Nam" - phần đầu của mọi bản bàn giao. */
function patientLine(p: Record<string, string>) {
  const parts = [p.name || "Bệnh nhân chưa rõ họ tên"];
  if (p.age) parts.push(`${p.age} tuổi`);
  if (p.gender) parts.push(p.gender);
  return parts.join(", ");
}

/**
 * Bộ luật tất định dựng sẵn toàn bộ phản hồi cho một giai đoạn.
 *
 * Đây cũng chính là phương án dự phòng khi không gọi được mô hình ngôn ngữ:
 * mọi trường trong kết quả trả về đều đã có nội dung dùng được ngay.
 */
function composeByRules(input: {
  stage: StageKey;
  patient: Record<string, string>;
  vitals: Vitals;
  symptoms: string;
  notes: string;
  history: string;
  term: string;
  conclusion: { diagnosis: string; drugs: string; advice: string };
  doctorName: string;
  stationLabel: string;
  redFlags: string[];
  emergency: boolean;
}) {
  const { patient, vitals, symptoms, notes, history, conclusion, redFlags, emergency } = input;
  const complaint = symptoms || notes || "chưa ghi nhận lý do khám";

  const sbar = clampSbar({
    situation: `${patientLine(patient)}. Lý do khám: ${complaint}. Khám tại ${input.stationLabel}.`,
    background: `Tiền sử: ${history || "chưa ghi nhận"}. Ghi chép điểm trạm: ${notes || "chưa có"}.`,
    assessment:
      `Sinh hiệu: ${vitalsLine(vitals)}.` +
      (redFlags.length ? ` Dấu hiệu cần lưu ý: ${redFlags.join(" ")}` : " Chưa phát hiện dấu hiệu nguy kịch trên sinh hiệu."),
    recommendation: emergency
      ? "Đề nghị tuyến trên đánh giá khẩn, cân nhắc chuyển tuyến ngay trong phiên."
      : "Đề nghị tuyến trên xác nhận hướng chẩn đoán, chỉ định cận lâm sàng và chốt hướng điều trị."
  });

  const messages: Array<{ audience: string; label: string; text: string }> = [];

  if (emergency) {
    messages.push({
      audience: "clinician",
      label: "[CẢNH BÁO CẤP CỨU - Gửi Bác sĩ Trạm & Tuyến trên]",
      text: redFlags.join("\n")
    });
  }

  if (input.stage === "intake") {
    messages.push({
      audience: "all",
      label: "[Chung]",
      text: `Đang ở ${STAGES.intake.label}. Đã ghi nhận sinh hiệu: ${vitalsLine(vitals)}.`
    });
    messages.push({
      audience: "patient",
      label: "[Gửi Bệnh nhân]",
      text:
        "Anh/chị kể giúp em: khó chịu bắt đầu từ khi nào, đau hay mệt ở chỗ nào, có sốt hay nôn không ạ? " +
        "Anh/chị đang uống thuốc gì thường xuyên và từng dị ứng thuốc nào chưa? Cứ nói chậm thôi, em ghi lại giúp anh/chị."
    });
    messages.push({
      audience: "clinician",
      label: "[Gửi Bác sĩ Trạm & Tuyến trên - SOAP rút gọn]",
      text:
        `S: ${complaint}. Tiền sử: ${history || "chưa ghi nhận"}.\n` +
        `O: ${vitalsLine(vitals)}.\n` +
        `A: ${redFlags.length ? redFlags.join(" ") : "Chưa có dấu hiệu nguy kịch trên sinh hiệu."}\n` +
        "P: Hoàn thiện khai thác bệnh sử, chuẩn bị camera cận cảnh vùng tổn thương trước khi mời tuyến trên."
    });
  }

  if (input.stage === "handoff") {
    messages.push({
      audience: "all",
      label: "[Chung]",
      text: `${input.doctorName || "Bác sĩ Tuyến trên"} đã tham gia phòng khám.`
    });
    messages.push({
      audience: "clinician",
      label: "[Gửi Bác sĩ Tuyến trên - Tóm tắt nhanh]",
      text:
        `- Bệnh nhân: ${patientLine(patient)}.\n` +
        `- Lý do khám: ${complaint}.\n` +
        `- Sinh hiệu (điểm trạm cung cấp): ${vitalsLine(vitals)}.\n` +
        `- Tiền sử: ${history || "chưa ghi nhận"}.` +
        (redFlags.length ? `\n- Lưu ý: ${redFlags.join(" ")}` : "")
    });
    messages.push({
      audience: "patient",
      label: "[Gửi Bệnh nhân]",
      text:
        "Bác sĩ chuyên khoa đã vào phòng khám rồi ạ. Bác sĩ sẽ trao đổi trực tiếp với anh/chị và cán bộ y tế tại trạm ngay bây giờ. " +
        "Anh/chị cứ trả lời thật thoải mái, chỗ nào chưa hiểu thì nói để em giải thích lại."
    });
  }

  if (input.stage === "explain") {
    const term = input.term || "thuật ngữ vừa nêu";
    messages.push({
      audience: "patient",
      label: "[Gửi Bệnh nhân]",
      text:
        `Bác sĩ vừa nhắc tới "${term}". Nói cho dễ hiểu thì đây là một cách gọi trong ngành y của tình trạng bác sĩ đang khám cho anh/chị. ` +
        "Anh/chị chưa rõ chỗ nào cứ hỏi lại, bác sĩ và em sẽ giải thích chậm hơn ạ."
    });
    messages.push({
      audience: "clinician",
      label: "[Gửi Bác sĩ Trạm & Tuyến trên]",
      text: `Đã diễn giải thuật ngữ "${term}" sang lời thường cho bệnh nhân. Bác sĩ bổ sung nếu cần chính xác hơn.`
    });
  }

  if (input.stage === "wrapup") {
    const drugLines = conclusion.drugs
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
      .filter(Boolean);

    messages.push({
      audience: "all",
      label: "[Chung]",
      text: "Phiên khám kết thúc. Toa thuốc & hướng dẫn điều trị DỰ THẢO đã sẵn sàng, chờ Bác sĩ trạm và Bác sĩ tuyến trên duyệt/ký số."
    });
    messages.push({
      audience: "clinician",
      label: "[Gửi Bác sĩ Trạm & Tuyến trên - Dự thảo chờ ký]",
      text:
        `Chẩn đoán (theo kết luận của Bác sĩ): ${conclusion.diagnosis || "chưa nhập"}.\n` +
        `Thuốc: ${drugLines.length ? drugLines.join("; ") : "chưa nhập"}.\n` +
        `Lời dặn: ${conclusion.advice || "chưa nhập"}.`
    });
    messages.push({
      audience: "patient",
      label: "[Gửi Bệnh nhân]",
      text:
        `Bác sĩ đã có kết luận cho anh/chị. Anh/chị nhớ uống thuốc đúng theo tờ đơn cán bộ trạm in ra, ` +
        `${conclusion.advice || "ăn uống nghỉ ngơi điều độ"}. ` +
        "Nếu thấy mệt nhiều hơn, khó thở, đau ngực hay sốt cao không hạ thì quay lại trạm ngay nhé ạ."
    });

    return {
      messages,
      sbar,
      draft: {
        diagnosis: conclusion.diagnosis,
        prescription: drugLines.map((line) => ({ name: line, dosage: "", note: "" })),
        advice: conclusion.advice,
        followUp: emergency
          ? "Theo dõi sát tại trạm, sẵn sàng chuyển tuyến; tái khám ngay khi triệu chứng nặng lên."
          : "Tái khám sau 3-5 ngày hoặc ngay khi triệu chứng nặng lên."
      }
    };
  }

  return { messages, sbar, draft: null as null | Record<string, unknown> };
}

/** Chỉ dẫn hệ thống cho Gemini - đúng vai trò và ràng buộc của phiên điều phối. */
const SYSTEM_INSTRUCTION = [
  "Bạn là Trợ lý AI Điều phối Y tế trong một phiên khám từ xa có ba bên: Bệnh nhân, Cán bộ y tế tại điểm trạm, và Bác sĩ chuyên khoa tuyến trên.",
  "Nhiệm vụ: thu thập thông tin, tóm tắt diễn biến, đề xuất định hướng chuyên môn và làm cầu nối ngôn ngữ giữa ba bên.",
  "Với bệnh nhân: dùng lời bình dân, ngắn, ấm áp, xưng em - gọi anh/chị, tuyệt đối không dùng thuật ngữ khó.",
  "Với hai bác sĩ: dùng ngôn ngữ y khoa chuẩn xác, tóm tắt theo SBAR hoặc SOAP, không vòng vo.",
  `Bản tóm tắt SBAR phải DƯỚI ${SBAR_WORD_LIMIT} từ tính cả bốn mục.`,
  "TUYỆT ĐỐI KHÔNG đưa ra chẩn đoán xác định và KHÔNG kê đơn độc lập. Mọi nội dung chuyên môn chỉ là đề xuất; quyết định cuối cùng thuộc về Bác sĩ.",
  "Nếu thấy dấu hiệu nguy kịch, đưa vào extraRedFlags bằng câu bắt đầu bằng 'CẢNH BÁO CẤP CỨU:'.",
  "Chỉ trả về JSON theo đúng lược đồ được yêu cầu, viết hoàn toàn bằng tiếng Việt."
].join(" ");

/** Lược đồ JSON mà mô hình phải trả về - giữ hẹp để phần ghép nối không phải đoán. */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    patientMessage: { type: "string" },
    clinicianMessage: { type: "string" },
    sbar: {
      type: "object",
      properties: {
        situation: { type: "string" },
        background: { type: "string" },
        assessment: { type: "string" },
        recommendation: { type: "string" }
      },
      required: ["situation", "background", "assessment", "recommendation"]
    },
    extraRedFlags: { type: "array", items: { type: "string" } }
  },
  required: ["patientMessage", "clinicianMessage"]
};

async function handle(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;

  const stage: StageKey = (Object.keys(STAGES) as StageKey[]).includes(body.stage) ? body.stage : "intake";
  const patient = {
    name: text(body.patient?.name, 120),
    age: text(body.patient?.age, 8),
    gender: text(body.patient?.gender, 16)
  };
  const rawVitals = body.vitals || {};
  const vitals: Vitals = {
    bp_sys: num(rawVitals.bpSys ?? rawVitals.bp_sys, 120),
    bp_dia: num(rawVitals.bpDia ?? rawVitals.bp_dia, 80),
    heart_rate: num(rawVitals.heartRate ?? rawVitals.heart_rate, 75),
    spo2: num(rawVitals.spo2, 98),
    temperature: num(rawVitals.temperature ?? rawVitals.temp, 36.8),
    weight: num(rawVitals.weight, 0)
  };
  const symptoms = text(body.symptoms);
  const notes = text(body.notes);
  const history = text(body.history, 600);
  const term = text(body.term, 200);
  const conclusion = {
    diagnosis: text(body.conclusion?.diagnosis, 400),
    drugs: text(body.conclusion?.drugs, 1500),
    advice: text(body.conclusion?.advice, 600)
  };
  const doctorName = text(body.doctorName, 120);
  const stationLabel = text(body.stationLabel, 160) || "điểm trạm";

  // --- Lớp tất định: cảnh báo đỏ không bao giờ phụ thuộc vào mô hình ngôn ngữ ---
  const assessment = evaluateVitals(vitals);
  const narrative = `${symptoms} ${notes} ${history}`.toLowerCase();
  const redFlags = assessment.alerts.filter((a) => a.level === "CRITICAL").map((a) => a.msg);
  for (const rule of RED_FLAG_PHRASES) {
    if (rule.match.some((phrase) => narrative.includes(phrase)) && !redFlags.includes(rule.msg)) {
      redFlags.push(rule.msg);
    }
  }
  const warnings = assessment.alerts.filter((a) => a.level === "WARNING").map((a) => a.msg);
  const emergency = redFlags.length > 0;

  const base = composeByRules({
    stage,
    patient,
    vitals,
    symptoms,
    notes,
    history,
    term,
    conclusion,
    doctorName,
    stationLabel,
    redFlags,
    emergency
  });

  let source = "rules";
  let model = "";

  // --- Lớp diễn đạt: Gemini viết lại lời cho hai nhóm người nghe ---
  const connection = resolveGoogleAiConnection();
  if (connection.configured) {
    try {
      const ai = getGoogleAiClient(connection);
      model = normalizeModel(connection.model);

      const prompt = [
        `GIAI ĐOẠN: ${STAGES[stage].label}.`,
        `BỆNH NHÂN: ${patientLine(patient)}.`,
        `LÝ DO KHÁM / TRIỆU CHỨNG: ${symptoms || "chưa ghi nhận"}.`,
        `TIỀN SỬ: ${history || "chưa ghi nhận"}.`,
        `GHI CHÉP LÂM SÀNG TẠI TRẠM: ${notes || "chưa có"}.`,
        `SINH HIỆU: ${vitalsLine(vitals)}.`,
        `CẢNH BÁO ĐÃ XÁC ĐỊNH BỞI BỘ LUẬT (không được bỏ đi): ${redFlags.length ? redFlags.join(" | ") : "không có"}.`,
        warnings.length ? `CHỈ SỐ CẦN THEO DÕI: ${warnings.join(" | ")}.` : "",
        stage === "explain" ? `THUẬT NGỮ CẦN GIẢI THÍCH CHO BỆNH NHÂN: "${term}".` : "",
        stage === "wrapup"
          ? `KẾT LUẬN CỦA BÁC SĨ (nguồn duy nhất cho dự thảo, không được tự thêm thuốc): ` +
            `chẩn đoán "${conclusion.diagnosis}", thuốc "${conclusion.drugs}", lời dặn "${conclusion.advice}".`
          : "",
        "",
        "Hãy trả về JSON gồm:",
        "- patientMessage: lời nhắn cho BỆNH NHÂN, tối đa 4 câu, mộc mạc dễ hiểu.",
        "- clinicianMessage: nội dung cho HAI BÁC SĨ theo SBAR (giai đoạn 2) hoặc SOAP (các giai đoạn còn lại), gạch đầu dòng.",
        `- sbar: bốn mục situation/background/assessment/recommendation, tổng cộng dưới ${SBAR_WORD_LIMIT} từ.`,
        "- extraRedFlags: các dấu hiệu nguy kịch khác mà bộ luật có thể bỏ sót (để mảng rỗng nếu không có)."
      ]
        .filter(Boolean)
        .join("\n");

      const response = await ai.models.generateContent({
        model,
        contents: [prompt],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA as never
        }
      });

      const parsed = JSON.parse(response.text || "{}");

      const patientMessage = text(parsed.patientMessage, 1200);
      const clinicianMessage = text(parsed.clinicianMessage, 2500);
      if (patientMessage) {
        const slot = base.messages.find((m) => m.audience === "patient");
        if (slot) slot.text = patientMessage;
        else base.messages.push({ audience: "patient", label: "[Gửi Bệnh nhân]", text: patientMessage });
      }
      if (clinicianMessage) {
        // Không đụng vào ô [CẢNH BÁO CẤP CỨU]: đó là câu chữ của bộ luật.
        const slot = base.messages.find((m) => m.audience === "clinician" && !m.label.includes("CẤP CỨU"));
        if (slot) slot.text = clinicianMessage;
        else
          base.messages.push({
            audience: "clinician",
            label: "[Gửi Bác sĩ Trạm & Tuyến trên]",
            text: clinicianMessage
          });
      }
      if (parsed.sbar && typeof parsed.sbar === "object") {
        base.sbar = clampSbar({
          situation: text(parsed.sbar.situation, 600) || base.sbar.situation,
          background: text(parsed.sbar.background, 600) || base.sbar.background,
          assessment: text(parsed.sbar.assessment, 600) || base.sbar.assessment,
          recommendation: text(parsed.sbar.recommendation, 600) || base.sbar.recommendation
        });
      }
      if (Array.isArray(parsed.extraRedFlags)) {
        for (const flag of parsed.extraRedFlags) {
          const line = text(flag, 300);
          // Mô hình chỉ được THÊM cảnh báo, không được gỡ cảnh báo của bộ luật.
          if (line && !redFlags.includes(line)) redFlags.push(line);
        }
      }
      source = connection.source;
    } catch (err: unknown) {
      // Mất mạng hay hết hạn ngạch AI không được phép làm treo buổi khám:
      // phần dựng bằng bộ luật ở trên đã đủ dùng, chỉ ghi lại nguyên nhân.
      const { message } = describeGoogleAiError(err, connection);
      console.warn("ai-coordinator: dùng bộ luật dự phòng vì lỗi mô hình:", message);
      source = "rules-fallback";
      model = "";
    }
  }

  const emergencyAfterModel = redFlags.length > 0;
  if (emergencyAfterModel && !base.messages.some((m) => m.label.includes("CẤP CỨU"))) {
    base.messages.unshift({
      audience: "clinician",
      label: "[CẢNH BÁO CẤP CỨU - Gửi Bác sĩ Trạm & Tuyến trên]",
      text: redFlags.join("\n")
    });
  }

  return json({
    success: true,
    data: {
      stage,
      phase: STAGES[stage].phase,
      stageLabel: STAGES[stage].label,
      messages: base.messages,
      sbar: base.sbar,
      sbarWordCount: Object.values(base.sbar).reduce((sum, v) => sum + wordCount(v), 0),
      redFlags,
      warnings,
      status: assessment.status,
      emergency: emergencyAfterModel,
      draft: base.draft,
      disclaimer: DISCLAIMER,
      source,
      model,
      generatedAt: new Date().toISOString()
    }
  });
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }
  if (req.method !== "POST") {
    return json({ success: false, message: "Method not allowed" }, 405);
  }

  try {
    await requireAnyScope(req, ["station", "doctor"]);
    return await handle(req);
  } catch (err) {
    // Lỗi phân quyền có phản hồi riêng (401/403); còn lại là sự cố máy chủ.
    const denied = authErrorResponse(err, headers);
    if (denied) return denied;
    console.error("ai-coordinator error", err);
    return json({ success: false, message: "Không dựng được nội dung điều phối." }, 500);
  }
};

export const config = {
  path: "/api/ai-coordinator"
};
