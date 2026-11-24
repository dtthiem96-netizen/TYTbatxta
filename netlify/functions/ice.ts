/**
 * Danh sách máy chủ ICE (STUN + TURN) cho cuộc gọi khám từ xa.
 *
 *   GET /api/ice   ->  { iceServers: [...], turn: true|false, source: "cloudflare"|"static"|"none" }
 *
 * Vì sao cần TURN: WebRTC mặc định nối thẳng hai máy (ngang hàng) nhờ STUN dò
 * địa chỉ công khai. Mạng 4G của các nhà mạng trong nước phần lớn đi qua NAT cấp
 * nhà mạng (CGNAT), nhiều mạng cơ quan chặn UDP - khi đó hai bên KHÔNG nối thẳng
 * được: chuông vẫn reo (tín hiệu đi qua /api/signal) nhưng không lên hình/tiếng.
 * Máy chủ TURN chuyển tiếp luồng hình trong những trường hợp đó.
 *
 * Cấu hình (biến môi trường Netlify, không cái nào bắt buộc - thiếu thì chỉ có STUN):
 *   - Cloudflare Realtime TURN (khuyến nghị, có hạn mức miễn phí):
 *       CF_TURN_KEY_ID, CF_TURN_API_TOKEN
 *     -> mỗi lần gọi sinh thông tin đăng nhập TURN ngắn hạn (mặc định 6 giờ).
 *   - Hoặc một máy chủ TURN bất kỳ, thông tin cố định:
 *       TURN_URLS (cách nhau bởi dấu phẩy, VD "turn:turn.example.vn:3478,turns:turn.example.vn:5349")
 *       TURN_USERNAME, TURN_CREDENTIAL
 *
 * Tuyến công khai vì người dân gọi tới (chưa đăng nhập) cũng cần TURN. Thông tin
 * đăng nhập Cloudflare có hạn dùng ngắn; có giới hạn tần suất theo IP để tránh
 * bị gọi dồn.
 */
import { clientIp, throttle } from "../lib/guard.js";

const STUN_SERVERS = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun1.l.google.com:19302", "stun:global.stun.twilio.com:3478"] }
];

const CF_TTL_SECONDS = 6 * 60 * 60;
const LIMIT_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60 * 1000;

type IceServer = { urls: string | string[]; username?: string; credential?: string };

const json = (body: unknown, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Thông tin đăng nhập TURN là riêng từng lượt: không để CDN dùng chung.
      "Cache-Control": cacheSeconds ? `private, max-age=${cacheSeconds}` : "no-store"
    }
  });

function env(name: string): string {
  const value = (globalThis as any).Netlify?.env?.get?.(name) ?? process.env[name];
  return String(value || "").trim();
}

/** Bỏ các URL TURN đi qua cổng 53: nhiều trình duyệt chặn cổng này, chỉ làm chậm bước dò. */
function dropPort53(server: IceServer): IceServer | null {
  const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u) => !/:53(\?|$)/.test(u));
  return urls.length ? { ...server, urls } : null;
}

async function cloudflareTurn(): Promise<IceServer[] | null> {
  const keyId = env("CF_TURN_KEY_ID");
  const token = env("CF_TURN_API_TOKEN");
  if (!keyId || !token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: CF_TTL_SECONDS }),
        signal: controller.signal
      }
    );
    if (!res.ok) {
      console.error("ice: cloudflare turn http", res.status);
      return null;
    }
    const data: any = await res.json();
    // Cloudflare trả { iceServers: [...] } (bản cũ: { iceServers: { urls, username, credential } }).
    const list: IceServer[] = Array.isArray(data?.iceServers) ? data.iceServers : data?.iceServers ? [data.iceServers] : [];
    const turn = list
      .filter((s) => s && s.urls && s.username && s.credential)
      .map(dropPort53)
      .filter(Boolean) as IceServer[];
    return turn.length ? turn : null;
  } catch (err: any) {
    console.error("ice: cloudflare turn error", err?.name || "Error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function staticTurn(): IceServer[] | null {
  const urls = env("TURN_URLS").split(",").map((u) => u.trim()).filter((u) => /^turns?:/.test(u));
  const username = env("TURN_USERNAME");
  const credential = env("TURN_CREDENTIAL");
  if (!urls.length || !username || !credential) return null;
  return [{ urls, username, credential }];
}

export default async (req: Request) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const wait = await throttle(`ice:${clientIp(req)}`, LIMIT_PER_WINDOW, WINDOW_MS).catch(() => 0);
  if (wait) return json({ iceServers: STUN_SERVERS, turn: false, source: "rate_limited" }, 429);

  const cf = await cloudflareTurn();
  if (cf) return json({ iceServers: [...STUN_SERVERS, ...cf], turn: true, source: "cloudflare" }, 200, 300);

  const st = staticTurn();
  if (st) return json({ iceServers: [...STUN_SERVERS, ...st], turn: true, source: "static" }, 200, 300);

  return json({ iceServers: STUN_SERVERS, turn: false, source: "none" }, 200, 300);
};

export const config = {
  path: "/api/ice"
};
