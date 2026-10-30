import {
  describeGoogleAiError,
  getGoogleAiClient,
  normalizeModel,
  resolveGoogleAiConnection
} from "../lib/google-ai.js";
import { clientIp, optionalAuth, redactPersonalData, throttle } from "../lib/guard.js";

/**
 * Cổng gọi mô hình ngôn ngữ Gemini của trang.
 *
 *   - POST /api/ai   { prompt, systemInstruction?, isJson?, image?, model? }
 *
 * Hàm này không tự quyết định giấy tờ xác thực: việc chọn giữa Vertex AI (ADC),
 * khoá API riêng của đơn vị, hay Netlify AI Gateway nằm hết trong
 * netlify/lib/google-ai.ts. Nhờ vậy đổi cách kết nối chỉ là đổi biến môi trường
 * chứ không phải sửa mã, và /api/ai-status luôn báo đúng đường đang dùng.
 *
 * Client được dựng bên trong lần gọi chứ không phải lúc nạp module: biến môi
 * trường của AI Gateway chỉ được Netlify tiêm vào lúc chạy hàm, dựng client ở
 * phạm vi module sẽ chộp phải giá trị rỗng của lúc đóng gói.
 */

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers, status });

const DEFAULT_SYSTEM_INSTRUCTION =
  "Bạn là Trợ lý Y tế AI mộc mạc, gần gũi, tận tình của Trạm Y tế Bát Xát, Lào Cai. " +
  "Giúp người dân tra cứu thủ tục hành chính, dịch vụ khám chữa bệnh, lịch tiêm chủng, " +
  "tư vấn thông tin y tế cơ bản cực kỳ ngắn gọn.";

/* Ranh giới y tế cho người dân dùng ẩn danh: luôn đứng TRƯỚC chỉ dẫn mà trình
   duyệt gửi lên, nên không ai đổi được vai của trợ lý thành "bác sĩ kê đơn". */
const PUBLIC_SAFETY_PREAMBLE =
  "Quy tắc bắt buộc: Bạn KHÔNG chẩn đoán xác định, KHÔNG kê đơn thuốc, KHÔNG thay thế cán bộ y tế. " +
  "Luôn khuyên người dân tới Trạm Y tế hoặc gọi 115 khi có dấu hiệu nguy hiểm. " +
  "Không yêu cầu người dùng cung cấp số CCCD, số thẻ BHYT, số điện thoại hay hồ sơ bệnh án.\n\n";

/** Người dân ẩn danh: 20 lượt / 10 phút / IP. Cán bộ đăng nhập: 120 lượt. */
const AI_WINDOW_MS = 10 * 60 * 1000;
const AI_LIMIT_PUBLIC = 20;
const AI_LIMIT_STAFF = 120;
const MAX_PROMPT_CHARS = 8000;
const MAX_SYSTEM_CHARS = 4000;
const MAX_IMAGE_BASE64 = 6 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const connection = resolveGoogleAiConnection();

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Nội dung yêu cầu không hợp lệ." }, 400);
    const { systemInstruction, sys, isJson, image, model } = body as Record<string, any>;
    if (!body.prompt || typeof body.prompt !== "string") {
      return json({ error: "Missing prompt" }, 400);
    }
    if (body.prompt.length > MAX_PROMPT_CHARS) {
      return json({ error: "Câu hỏi quá dài, vui lòng rút gọn." }, 413);
    }

    const staff = await optionalAuth(req);
    const wait = await throttle(
      staff ? `ai-user:${staff.user.id}` : `ai-ip:${clientIp(req)}`,
      staff ? AI_LIMIT_STAFF : AI_LIMIT_PUBLIC,
      AI_WINDOW_MS
    );
    if (wait) {
      return json({ error: `Bạn đã hỏi quá nhiều trong thời gian ngắn. Vui lòng thử lại sau ${Math.ceil(wait / 60)} phút.` }, 429);
    }

    // Không gửi số định danh của người dân ra dịch vụ AI bên ngoài.
    const prompt = redactPersonalData(body.prompt);
    const clientSystem = redactPersonalData(String(systemInstruction || sys || "").slice(0, MAX_SYSTEM_CHARS));
    const finalSystem = staff
      ? clientSystem || DEFAULT_SYSTEM_INSTRUCTION
      : PUBLIC_SAFETY_PREAMBLE + (clientSystem || DEFAULT_SYSTEM_INSTRUCTION);

    const ai = getGoogleAiClient(connection);
    const selectedModel = normalizeModel(model ?? connection.model);

    const contents: any[] = [];
    if (image && image.data && image.mimeType) {
      if (!IMAGE_MIME.test(String(image.mimeType)) || String(image.data).length > MAX_IMAGE_BASE64) {
        return json({ error: "Ảnh không hợp lệ hoặc quá lớn." }, 413);
      }
      contents.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data
        }
      });
    }
    contents.push(prompt);

    const response = await ai.models.generateContent({
      model: selectedModel,
      contents: contents,
      config: {
        systemInstruction: finalSystem,
        responseMimeType: isJson ? "application/json" : "text/plain"
      }
    });

    // Giữ nguyên trường "text" vì giao diện đang đọc đúng trường này; hai trường
    // còn lại chỉ để gỡ lỗi và không chứa thông tin nhạy cảm.
    return json({
      text: response.text || "",
      model: selectedModel,
      source: connection.source
    });
  } catch (err: unknown) {
    const { status, message } = describeGoogleAiError(err, connection);
    console.error(
      `Lỗi gọi Google AI (${connection.source}):`,
      err instanceof Error ? err.message : err
    );
    return json({ error: message, source: connection.source }, status);
  }
};

export const config = {
  path: "/api/ai"
};
