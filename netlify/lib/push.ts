/**
 * Thông báo đẩy (Web Push) cho cán bộ nhận cuộc gọi khám từ xa.
 *
 * KHÔNG GỬI KÈM NỘI DUNG
 * ----------------------
 * Bản tin đẩy ở đây cố ý không mang dữ liệu: chỉ là một cú "gõ cửa" rỗng. Service
 * Worker nhận được thì tự gọi ngược về máy chủ để lấy chi tiết cuộc gọi. Cách này
 * đổi lấy ba điều:
 *   - Tên người dân, triệu chứng và mã phòng gọi không bao giờ đi qua máy
 *     chủ đẩy của Google/Mozilla/Apple, kể cả dưới dạng đã mã hoá.
 *   - Không phải hiện thực mã hoá tải tin theo RFC 8291 (aes128gcm) - phần dễ sai
 *     nhất của Web Push - nên không có nguy cơ cài sai rồi tưởng là an toàn.
 *   - Nội dung hiển thị luôn là mới nhất: cuộc gọi đã có người nhận trong lúc
 *     bản tin đẩy còn trên đường thì thông báo hiện ra đã là trạng thái đúng.
 *
 * Chỉ ký VAPID (ES256) là bắt buộc, và làm được hoàn toàn bằng Web Crypto.
 */
import { db } from "../../db/index.js";
import { pushSubscriptions, stationReceivers } from "../../db/schema.js";
import { eq, inArray } from "drizzle-orm";

const encoder = new TextEncoder();

/** Hạn dùng của một bản tin đẩy: quá thời gian này thì cuộc gọi cũng hết ý nghĩa. */
const PUSH_TTL_SEC = 120;
/** Vé VAPID sống 6 giờ - đủ dài để dùng lại, đủ ngắn nếu lộ ra ngoài. */
const VAPID_JWT_TTL_SEC = 6 * 60 * 60;

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToB64url(value: string): string {
  return bytesToB64url(encoder.encode(value));
}

/** Đôi khoá VAPID nằm ở biến môi trường; thiếu thì tính năng tự tắt chứ không hỏng. */
function vapidKeys() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
  return { publicKey, privateKey };
}

export function vapidConfigured(): boolean {
  const { publicKey, privateKey } = vapidKeys();
  return Boolean(publicKey && privateKey);
}

/** Khoá công khai đưa ra trình duyệt để đăng ký - đây là dữ liệu công khai theo thiết kế. */
export function vapidPublicKey(): string {
  return vapidKeys().publicKey;
}

function vapidSubject(): string {
  const configured = String(process.env.VAPID_SUBJECT || "").trim();
  if (configured) return configured;
  return "mailto:tytbatxat@laocai.gov.vn";
}

/**
 * Dựng CryptoKey ký từ cặp khoá thô.
 *
 * Khoá riêng VAPID là 32 byte "d", khoá công khai là điểm đường cong 65 byte
 * (0x04 || x || y). Web Crypto không nhận dạng thô nên phải ghép lại thành JWK.
 */
async function signingKey(): Promise<CryptoKey | null> {
  const { publicKey, privateKey } = vapidKeys();
  if (!publicKey || !privateKey) return null;

  const pub = b64urlToBytes(publicKey);
  const priv = b64urlToBytes(privateKey);
  if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return null;

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: bytesToB64url(priv),
    ext: true
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Một vé VAPID chỉ dùng được cho đúng một máy chủ đẩy (trường `aud`). */
async function vapidHeader(audience: string, now: number): Promise<string | null> {
  const key = await signingKey();
  if (!key) return null;

  const header = textToB64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = textToB64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(now / 1000) + VAPID_JWT_TTL_SEC,
      sub: vapidSubject()
    })
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(`${header}.${payload}`)
  );
  return `vapid t=${header}.${payload}.${bytesToB64url(new Uint8Array(signature))}, k=${vapidPublicKey()}`;
}

export type PushOutcome = { sent: number; failed: number; pruned: number; skipped: string };

/**
 * Gõ cửa toàn bộ thiết bị của một nhóm tài khoản.
 *
 * Đăng ký trả về 404/410 nghĩa là trình duyệt đã huỷ đăng ký ở phía người dùng -
 * xoá luôn khỏi cơ sở dữ liệu, nếu không danh sách sẽ phình ra vì rác và mỗi
 * cuộc gọi lại tốn thêm một lượt gọi mạng vô ích.
 */
export async function pushToUsers(userIds: string[], now: number): Promise<PushOutcome> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (!unique.length) return { sent: 0, failed: 0, pruned: 0, skipped: "no-recipient" };
  if (!vapidConfigured()) return { sent: 0, failed: 0, pruned: 0, skipped: "vapid-not-configured" };

  const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, unique));
  if (!subs.length) return { sent: 0, failed: 0, pruned: 0, skipped: "no-subscription" };

  let sent = 0;
  let failed = 0;
  const stale: string[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        const endpoint = new URL(sub.endpoint);
        const auth = await vapidHeader(endpoint.origin, now);
        if (!auth) {
          failed += 1;
          return;
        }
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            Authorization: auth,
            TTL: String(PUSH_TTL_SEC),
            // Cuộc gọi đang đổ chuông: yêu cầu máy chủ đẩy đánh thức thiết bị ngay.
            Urgency: "high",
            "Content-Length": "0"
          }
        });
        if (res.status === 404 || res.status === 410) {
          stale.push(sub.id);
          return;
        }
        if (!res.ok) {
          failed += 1;
          return;
        }
        sent += 1;
      } catch {
        failed += 1;
      }
    })
  );

  if (stale.length) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, stale));
  if (sent) {
    await db
      .update(pushSubscriptions)
      .set({ lastUsedAt: now })
      .where(inArray(pushSubscriptions.userId, unique));
  }

  return { sent, failed, pruned: stale.length, skipped: "" };
}

/**
 * Gõ cửa những người trực của một điểm trạm, giới hạn theo mức ưu tiên đang gọi.
 *
 * `maxPriority` đến từ ringPlan: vòng đầu chỉ trực chính, các vòng sau mới lan
 * rộng ra. Nhờ vậy thông báo đẩy đi đúng theo bậc thang leo thang chứ không réo
 * cả trạm ngay từ giây đầu tiên.
 */
export async function pushToStation(stationCode: string, maxPriority: number, now: number): Promise<PushOutcome> {
  if (!stationCode) return { sent: 0, failed: 0, pruned: 0, skipped: "no-station" };

  const rows = await db.select().from(stationReceivers).where(eq(stationReceivers.stationCode, stationCode));
  const targets = rows
    .filter((r) => String(r.isActive || "true") === "true")
    .filter((r) => Number(r.priority || 1) <= maxPriority)
    .filter((r) => String(r.notifyChannels || "").toUpperCase().includes("PUSH"))
    .map((r) => r.userId);

  return pushToUsers(targets, now);
}
