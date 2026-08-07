import {
  describeGoogleAiError,
  getGoogleAiClient,
  normalizeModel,
  resolveGoogleAiConnection
} from "../lib/google-ai.js";

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
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers, status });

const DEFAULT_SYSTEM_INSTRUCTION =
  "Bạn là Trợ lý Y tế AI mộc mạc, gần gũi, tận tình của Trạm Y tế Bát Xát, Lào Cai. " +
  "Giúp người dân tra cứu thủ tục hành chính, dịch vụ khám chữa bệnh, lịch tiêm chủng, " +
  "tư vấn thông tin y tế cơ bản cực kỳ ngắn gọn.";

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const connection = resolveGoogleAiConnection();

  try {
    const { prompt, systemInstruction, sys, isJson, image, model } = await req.json();

    if (!prompt) {
      return json({ error: "Missing prompt" }, 400);
    }

    const ai = getGoogleAiClient(connection);
    const selectedModel = normalizeModel(model ?? connection.model);

    const contents: any[] = [];
    if (image && image.data && image.mimeType) {
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
        systemInstruction: systemInstruction || sys || DEFAULT_SYSTEM_INSTRUCTION,
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
