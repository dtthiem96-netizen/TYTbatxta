import { authErrorResponse, requireAnyScope } from "../lib/auth.js";
import {
  describeGoogleAiError,
  getGoogleAiClient,
  normalizeModel,
  publicConnection,
  resolveGoogleAiConnection,
  SUPPORTED_GEMINI_MODELS
} from "../lib/google-ai.js";

/**
 * Kiểm tra tình trạng kết nối API Google (Gemini / Vertex AI).
 *
 *   - GET /api/ai-status              đường kết nối đang có hiệu lực (không cần đăng nhập)
 *   - GET /api/ai-status?ping=1       gọi thử mô hình để xác nhận giấy tờ còn dùng được
 *                                     (bắt buộc có phiếu phiên với quyền "station")
 *
 * Vì sao phần gọi thử phải đăng nhập: mỗi lần ping là một lượt gọi mô hình có
 * tính phí. Để ngỏ cho mọi người thì bất kỳ ai cũng đốt được tín dụng AI của
 * trạm chỉ bằng cách nạp lại URL.
 *
 * Endpoint này CỐ Ý chỉ trả về TÊN biến môi trường đã được đặt hay chưa, tuyệt
 * đối không trả giá trị. Người vận hành cần biết "khoá đã có mặt chưa", chứ
 * không cần đọc lại khoá qua trình duyệt.
 */

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers, status });

/** Các biến môi trường liên quan tới kết nối Google AI, chỉ báo có/không. */
const TRACKED_ENV_VARS = [
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS_JSON",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "NETLIFY_AI_GATEWAY_KEY",
  "NETLIFY_AI_GATEWAY_BASE_URL"
];

const envPresence = (): Record<string, boolean> =>
  Object.fromEntries(
    TRACKED_ENV_VARS.map((name) => [name, Boolean(process.env[name] && process.env[name]!.trim())])
  );

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }
  if (req.method !== "GET") {
    return json({ success: false, message: "Method not allowed" }, 405);
  }

  const connection = resolveGoogleAiConnection();
  const wantsPing = new URL(req.url).searchParams.get("ping") === "1";

  if (!wantsPing) {
    return json({
      success: true,
      connection: publicConnection(connection),
      supportedModels: SUPPORTED_GEMINI_MODELS,
      note: "Thêm ?ping=1 kèm phiếu phiên điểm trạm để gọi thử mô hình."
    });
  }

  try {
    await requireAnyScope(req, ["station", "doctor"]);
  } catch (err) {
    const authResponse = authErrorResponse(err, headers);
    if (authResponse) return authResponse;
    throw err;
  }

  if (!connection.configured) {
    return json(
      {
        success: false,
        connection: publicConnection(connection),
        env: envPresence(),
        ping: { attempted: false, ok: false, message: connection.hint }
      },
      503
    );
  }

  const model = normalizeModel(connection.model);
  const startedAt = Date.now();

  try {
    const ai = getGoogleAiClient(connection);
    const response = await ai.models.generateContent({
      model,
      contents: "Trả lời đúng một từ: SUCCESS",
      // Giới hạn đầu ra để lần gọi thử gần như không tốn hạn mức. Không đặt quá
      // thấp: gemini-2.5-flash tiêu tốn một phần ngân sách token cho bước suy
      // luận nội bộ, cắt sát quá thì phần văn bản trả về sẽ rỗng dù kết nối tốt.
      config: { responseMimeType: "text/plain", maxOutputTokens: 256 }
    });

    // Kết nối được coi là tốt khi lời gọi không ném lỗi. Nội dung câu trả lời
    // chỉ để người vận hành nhìn cho yên tâm, không dùng làm điều kiện đánh giá.
    const reply = (response.text || "").trim();
    return json({
      success: true,
      connection: publicConnection(connection),
      env: envPresence(),
      ping: {
        attempted: true,
        ok: true,
        model,
        latencyMs: Date.now() - startedAt,
        reply: reply.slice(0, 120)
      }
    });
  } catch (err: unknown) {
    const { status, message } = describeGoogleAiError(err, connection);
    console.error(`ai-status ping thất bại (${connection.source}):`, err instanceof Error ? err.message : err);
    return json(
      {
        success: false,
        connection: publicConnection(connection),
        env: envPresence(),
        ping: {
          attempted: true,
          ok: false,
          model,
          latencyMs: Date.now() - startedAt,
          message
        }
      },
      status
    );
  }
};

export const config = {
  path: "/api/ai-status"
};
