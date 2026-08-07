/**
 * Lớp kết nối Google AI (Gemini) dùng chung cho toàn bộ Netlify Functions.
 *
 * Vì sao cần lớp này: cùng một dòng mô hình Gemini có tới ba đường vào khác
 * nhau, mỗi đường một kiểu giấy tờ, và trước đây mã nguồn chỉ đọc cứng một biến
 * môi trường duy nhất (GEMINI_API_KEY). Chỉ cần đổi cách cấp khoá là hàm gọi AI
 * chết lặng với thông báo "missing API key" chẳng nói lên điều gì.
 *
 * Ba đường vào được hỗ trợ, xét theo đúng thứ tự dưới đây:
 *
 *   1. "vertex-adc" - Google Cloud Vertex AI, xác thực bằng Application Default
 *      Credentials (ADC). Đây là đường mà kịch bản setup_adc.sh của Google dựng
 *      lên. Bật bằng GOOGLE_GENAI_USE_VERTEXAI=true kèm GOOGLE_CLOUD_PROJECT.
 *      LƯU Ý QUAN TRỌNG: ADC do `gcloud auth application-default login` tạo ra
 *      nằm trong $HOME/.config/gcloud của MÁY CÁ NHÂN. Máy chủ serverless của
 *      Netlify không có thư mục đó. Muốn chạy Vertex AI trên bản triển khai thì
 *      phải nạp khoá tài khoản dịch vụ (service account) qua biến môi trường
 *      GOOGLE_APPLICATION_CREDENTIALS_JSON - xem materializeAdcCredentials().
 *
 *   2. "google-api-key" - khoá API do chính đơn vị cấp (Google AI Studio hoặc
 *      Generative Language API của dự án Google Cloud). Đặt GOOGLE_API_KEY.
 *      Đường này gọi thẳng tới Google, không qua Netlify.
 *
 *   3. "netlify-ai-gateway" - mặc định của dự án. Netlify tự tiêm GEMINI_API_KEY
 *      và GOOGLE_GEMINI_BASE_URL lúc chạy hàm, không cần khai báo gì. Netlify
 *      KHÔNG bao giờ ghi đè biến do người dùng tự đặt, nên hai đường trên luôn
 *      thắng khi được cấu hình.
 *
 * Nguyên tắc bảo mật của tệp này: giá trị khoá chỉ nằm trong trường `secret`
 * và không bao giờ được đưa vào phản hồi HTTP hay nhật ký. Mọi thứ trả ra
 * ngoài đều đi qua publicConnection().
 */
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";

/** Mô hình mặc định cho toàn hệ thống. Có mặt ở cả Vertex AI lẫn AI Gateway. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Các mô hình được phép gọi. Danh sách bám theo những gì Netlify AI Gateway
 * chuyển tiếp được - gọi mô hình ngoài danh sách sẽ lỗi lúc chạy chứ không lỗi
 * lúc dựng, nên chặn ngay tại cổng vào thay vì để cán bộ trạm nhận lỗi 500.
 */
export const SUPPORTED_GEMINI_MODELS: readonly string[] = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-flash-latest",
  "gemini-flash-lite-latest"
];

export type GoogleAiSource =
  | "vertex-adc"
  | "google-api-key"
  | "netlify-ai-gateway"
  | "none";

/** Phần mô tả kết nối an toàn để trả ra ngoài (không chứa khoá). */
export interface PublicGoogleAiConnection {
  source: GoogleAiSource;
  label: string;
  configured: boolean;
  model: string;
  project?: string;
  location?: string;
  endpointHost?: string;
  hint: string;
}

/** Mô tả kết nối đầy đủ, chỉ dùng trong tiến trình máy chủ. */
export interface GoogleAiConnection extends PublicGoogleAiConnection {
  secret?: { apiKey?: string; baseUrl?: string };
}

/** Lỗi cấu hình: chưa có đường nào dùng được. Tách riêng để trả HTTP 503. */
export class GoogleAiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAiConfigError";
  }
}

const truthy = (value: string | undefined | null): boolean => {
  if (!value) return false;
  return !["false", "0", "no", "off", ""].includes(value.trim().toLowerCase());
};

const firstNonEmpty = (...names: string[]): string | null => {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
};

const hostOf = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

/**
 * Nạp khoá tài khoản dịch vụ dạng JSON nội tuyến thành tệp trên đĩa.
 *
 * Thư viện google-auth-library chỉ biết đọc ADC từ ĐƯỜNG DẪN TỆP
 * (GOOGLE_APPLICATION_CREDENTIALS), trong khi Netlify chỉ cho đặt chuỗi. /tmp là
 * nơi duy nhất ghi được trong hàm serverless và bị xoá khi phiên bản hàm kết
 * thúc, nên khoá không tồn tại lâu hơn tiến trình đang chạy.
 */
function materializeAdcCredentials(): void {
  const inline = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!inline || !inline.trim()) return;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;

  const target = "/tmp/google-adc.json";
  try {
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, inline, { mode: 0o600 });
    }
    process.env.GOOGLE_APPLICATION_CREDENTIALS = target;
  } catch (err) {
    // Không in nội dung khoá ra nhật ký trong bất kỳ tình huống nào.
    console.error("Không ghi được tệp ADC tạm thời:", (err as Error).message);
  }
}

/**
 * Chọn đường vào Google AI theo biến môi trường hiện có.
 * Không gọi mạng, không tạo client - chỉ đọc cấu hình.
 */
export function resolveGoogleAiConnection(): GoogleAiConnection {
  const vertexRequested =
    truthy(process.env.GOOGLE_GENAI_USE_VERTEXAI) || truthy(process.env.GOOGLE_GENAI_USE_VERTEX_AI);
  const project = firstNonEmpty("GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID");
  const location = firstNonEmpty("GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_REGION") || "global";

  // 1. Vertex AI + ADC (đường mà setup_adc.sh của Google dựng lên).
  if (vertexRequested && project) {
    return {
      source: "vertex-adc",
      label: `Google Cloud Vertex AI - dự án ${project} (${location})`,
      configured: true,
      model: DEFAULT_GEMINI_MODEL,
      project,
      location,
      endpointHost: "aiplatform.googleapis.com",
      hint:
        "Xác thực bằng Application Default Credentials. Trên máy cá nhân dùng " +
        "`gcloud auth application-default login`; trên Netlify phải đặt " +
        "GOOGLE_APPLICATION_CREDENTIALS_JSON bằng nội dung khoá tài khoản dịch vụ."
    };
  }

  if (vertexRequested && !project) {
    return {
      source: "none",
      label: "Vertex AI được bật nhưng thiếu mã dự án",
      configured: false,
      model: DEFAULT_GEMINI_MODEL,
      location,
      hint:
        "Đã đặt GOOGLE_GENAI_USE_VERTEXAI nhưng chưa đặt GOOGLE_CLOUD_PROJECT. " +
        "Bổ sung mã dự án Google Cloud rồi triển khai lại."
    };
  }

  // 2. Khoá API do đơn vị tự cấp - luôn thắng cổng AI của Netlify.
  const ownKey = firstNonEmpty("GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY");
  if (ownKey) {
    return {
      source: "google-api-key",
      label: "Google Generative Language API - khoá API riêng của đơn vị",
      configured: true,
      model: DEFAULT_GEMINI_MODEL,
      project: project || undefined,
      endpointHost: "generativelanguage.googleapis.com",
      hint: "Khoá lấy từ Google AI Studio hoặc từ Generative Language API của dự án Google Cloud.",
      secret: { apiKey: ownKey }
    };
  }

  // 3. Netlify AI Gateway. Netlify tiêm cặp GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL
  //    lúc chạy hàm; nếu vì lý do nào đó chỉ còn biến cổng chung thì vẫn dùng được.
  const geminiKey = firstNonEmpty("GEMINI_API_KEY");
  const geminiBase = firstNonEmpty("GOOGLE_GEMINI_BASE_URL");

  if (geminiKey && geminiBase) {
    return {
      source: "netlify-ai-gateway",
      label: "Netlify AI Gateway - Google Gemini",
      configured: true,
      model: DEFAULT_GEMINI_MODEL,
      endpointHost: hostOf(geminiBase),
      hint: "Netlify tự tiêm khoá lúc chạy hàm; chi phí tính vào tín dụng của tài khoản Netlify.",
      secret: { apiKey: geminiKey, baseUrl: geminiBase }
    };
  }

  if (geminiKey) {
    // Khoá GEMINI_API_KEY do người dùng tự đặt: Netlify không kèm base URL nên
    // đây là đường gọi thẳng tới Google.
    return {
      source: "google-api-key",
      label: "Google Generative Language API - khoá GEMINI_API_KEY tự đặt",
      configured: true,
      model: DEFAULT_GEMINI_MODEL,
      endpointHost: "generativelanguage.googleapis.com",
      hint: "Khoá do đơn vị tự đặt trong biến môi trường GEMINI_API_KEY.",
      secret: { apiKey: geminiKey }
    };
  }

  const gatewayKey = firstNonEmpty("NETLIFY_AI_GATEWAY_KEY");
  const gatewayBase = firstNonEmpty("NETLIFY_AI_GATEWAY_BASE_URL");
  if (gatewayKey && gatewayBase) {
    // Cổng AI định tuyến theo HÌNH DẠNG đường dẫn chứ không theo tiền tố nhà
    // cung cấp: SDK Gemini gọi "<base>/v1beta/models/<model>:generateContent" và
    // cổng nhận ra ngay đó là Gemini. Thêm "/gemini" vào giữa sẽ nhận 404 - đã
    // thử trực tiếp khi viết hàm này. Chỉ cắt dấu gạch chéo thừa ở cuối, vì
    // Netlify trả về base có sẵn dấu "/" cuối và SDK cũng tự thêm một dấu nữa.
    const baseUrl = gatewayBase.replace(/\/+$/, "");
    return {
      source: "netlify-ai-gateway",
      label: "Netlify AI Gateway - Google Gemini (qua biến cổng chung)",
      configured: true,
      model: DEFAULT_GEMINI_MODEL,
      endpointHost: hostOf(baseUrl),
      hint: "Dùng NETLIFY_AI_GATEWAY_KEY vì chưa thấy cặp biến riêng cho Gemini.",
      secret: { apiKey: gatewayKey, baseUrl }
    };
  }

  return {
    source: "none",
    label: "Chưa có kết nối Google AI nào",
    configured: false,
    model: DEFAULT_GEMINI_MODEL,
    hint:
      "Chọn một trong ba cách: (a) đặt GOOGLE_API_KEY, (b) đặt " +
      "GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT + " +
      "GOOGLE_APPLICATION_CREDENTIALS_JSON, hoặc (c) bật AI Gateway trong giao " +
      "diện Netlify và triển khai lại (biến chỉ được tiêm vào lúc chạy hàm)."
  };
}

/** Bỏ phần bí mật trước khi đưa mô tả kết nối ra ngoài. */
export function publicConnection(conn: GoogleAiConnection): PublicGoogleAiConnection {
  const { secret: _secret, ...rest } = conn;
  return rest;
}

/** Bộ nhớ đệm client theo cấu hình, tránh dựng lại ở mỗi lần gọi hàm nóng. */
let cached: { key: string; client: GoogleGenAI } | null = null;

/**
 * Tạo (hoặc lấy lại từ bộ đệm) client Gemini cho kết nối đã chọn.
 * Ném GoogleAiConfigError nếu chưa cấu hình được đường nào.
 */
export function getGoogleAiClient(conn: GoogleAiConnection): GoogleGenAI {
  if (!conn.configured) {
    throw new GoogleAiConfigError(conn.hint);
  }

  const key = [conn.source, conn.project, conn.location, conn.secret?.baseUrl, conn.secret?.apiKey].join("|");
  if (cached && cached.key === key) return cached.client;

  let client: GoogleGenAI;
  if (conn.source === "vertex-adc") {
    materializeAdcCredentials();
    client = new GoogleGenAI({
      vertexai: true,
      project: conn.project,
      location: conn.location
    });
  } else {
    client = new GoogleGenAI({
      apiKey: conn.secret?.apiKey,
      ...(conn.secret?.baseUrl ? { httpOptions: { baseUrl: conn.secret.baseUrl } } : {})
    });
  }

  cached = { key, client };
  return client;
}

/** Chuẩn hoá tên mô hình do phía gọi gửi lên; giá trị lạ sẽ về mặc định. */
export function normalizeModel(requested: unknown): string {
  if (typeof requested !== "string") return DEFAULT_GEMINI_MODEL;
  const name = requested.trim();
  return SUPPORTED_GEMINI_MODELS.includes(name) ? name : DEFAULT_GEMINI_MODEL;
}

/**
 * Dịch lỗi thô của nhà cung cấp thành thông báo tiếng Việt cho cán bộ trạm,
 * đồng thời chọn mã HTTP phù hợp. Không bao giờ đưa nội dung khoá vào thông báo.
 */
export function describeGoogleAiError(err: unknown, conn: GoogleAiConnection): {
  status: number;
  message: string;
} {
  if (err instanceof GoogleAiConfigError) {
    return { status: 503, message: `Chưa kết nối được dịch vụ AI. ${err.message}` };
  }

  const raw = err instanceof Error ? err.message : String(err ?? "");
  const text = raw.toLowerCase();

  if (text.includes("401") || text.includes("unauthenticated") || text.includes("api key not valid")) {
    return {
      status: 502,
      message:
        `Giấy tờ xác thực của "${conn.label}" bị từ chối. ` +
        "Kiểm tra lại khoá API hoặc khoá tài khoản dịch vụ trong biến môi trường."
    };
  }
  if (text.includes("403") || text.includes("permission") || text.includes("has not been used")) {
    return {
      status: 502,
      message:
        `Tài khoản kết nối không đủ quyền gọi mô hình. Với Vertex AI, cần bật dịch vụ ` +
        "aiplatform.googleapis.com cho dự án và cấp vai trò Vertex AI User."
    };
  }
  if (text.includes("429") || text.includes("rate limit") || text.includes("quota")) {
    return { status: 429, message: "Dịch vụ AI đang quá tải hoặc hết hạn mức. Vui lòng thử lại sau ít phút." };
  }
  if (text.includes("404") || text.includes("not found")) {
    return { status: 502, message: "Không tìm thấy mô hình được yêu cầu trên kết nối hiện tại." };
  }

  return { status: 502, message: "Dịch vụ AI trả về lỗi. Vui lòng thử lại." };
}
