# GỌI KHÁM TỪ XA (Telehealth Room) — Tài liệu yêu cầu kỹ thuật, luồng vận hành và kiến trúc mã nguồn

Cổng thông tin Trạm Y tế Bát Xát — tytbatxat.org.vn

---

## 1. Phạm vi và bối cảnh

Tính năng cho phép người dân bấm một nút trên cổng thông tin để nói chuyện trực
tiếp bằng hình và tiếng với cán bộ y tế đang trực, đồng thời cho phép bác sĩ
tuyến trên tham gia cùng phòng khi ca bệnh vượt khả năng của điểm trạm.

Bốn nhóm người dùng:

| Vai (`role`) | Ai | Đăng nhập | Thiết bị điển hình |
|---|---|---|---|
| `patient` | Người dân | Không | Điện thoại Android đời thấp, 3G/4G |
| `station_staff` (mã nội bộ: `station`) | Cán bộ trực Trạm Y tế Bát Xát / điểm khám | Có (CMS) | Máy tính để bàn tại trạm |
| `doctor` | Bác sĩ tuyến trên (huyện/tỉnh) | Có (CMS) | Máy tính / máy tính bảng |
| `cms_admin` | Quản trị viên hệ thống | Có (CMS, quyền `admin`) | Máy tính |

Ràng buộc nền tảng quyết định toàn bộ kiến trúc: hệ thống chạy trên Netlify
Functions — **không có tiến trình thường trú, không giữ được WebSocket**. Vì vậy
tuyến tín hiệu (signaling) là HTTP long-poll, và mọi trạng thái phòng nằm trong
Netlify Database (Postgres qua Drizzle ORM).

---

## 2. Yêu cầu kỹ thuật

### 2.1. Mô hình phòng đa điểm cầu

| Mã | Yêu cầu | Trạng thái |
|---|---|---|
| R1.1 | Người dân bấm "GỌI CÁN BỘ Y TẾ NGAY" → hệ thống sinh phòng ảo `ROOM-XX` gắn với đúng điểm trạm | Đạt |
| R1.2 | Cán bộ trạm và bác sĩ tuyến trên (đăng nhập CMS) cùng tiếp nhận và cùng vào một `ROOM-XX` đang diễn ra | Đạt |
| R1.3 | Cả ba bên trao đổi Video + Audio + khung "Trao đổi & Đính kèm tệp" | Đạt |
| R1.4 | Định danh (họ tên, BHYT/CCCD) và Chỉ số sinh hiệu (HA, SpO2, nhịp tim, nhiệt độ, cân nặng) đồng bộ thời gian thực lên màn hình bác sĩ | Đạt |
| R1.5 | Kết luận / chẩn đoán / đơn thuốc bác sĩ tuyến trên viết tự đẩy về giao diện người dân, xuất và in được đơn khổ A5 | Đạt |

### 2.2. Giám sát ngầm cho Quản trị CMS (Silent Audit / Ghost Mode)

| Mã | Yêu cầu | Cưỡng chế ở đâu |
|---|---|---|
| R2.1 | Quản trị chọn `ROOM-XX` đang hoạt động trong CMS → bấm "Vào giám sát" | Máy khách (`index.html`) |
| R2.2 | Không có âm báo kết nối | Máy chủ không phát `peer-joined` ⇒ máy khách ba bên không có sự kiện nào để kêu |
| R2.3 | Không có dòng "Admin đã vào phòng" trong khung chat | Máy chủ chặn mọi bản tin `chat` phát ra từ vai `cms_admin` |
| R2.4 | Không xuất hiện trên Video Grid / Participant List / Avatar / Name Tag của cả ba bên | Máy chủ lọc vai `cms_admin` khỏi mảng `peers`; máy khách đánh dấu kết nối `hidden` và chặn mọi callback giao diện |
| R2.5 | Micro và Camera bị **khoá cứng** (Hard Mute), chỉ Subscribe, không bao giờ Publish | Máy chủ từ chối mọi SDP không phải `recvonly`/`inactive`; máy khách không gọi `getUserMedia` |

### 2.3. Giao diện thân thiện người cao tuổi / vùng cao

| Mã | Yêu cầu | Cách làm |
|---|---|---|
| R3.1 | Tự động hoá và ẩn toàn bộ thiết lập kỹ thuật nâng cao | Bitrate, độ phân giải, lọc tạp âm, chống hú, né dội tiếng đều tự chỉnh; hai núm tay còn lại gập kín trong `<details>` "Cài đặt nâng cao" |
| R3.2 | Màn hình gọi chỉ còn 4 nút | Lưới `grid-cols-4`: Micro · Hình · Đổi camera · **Kết thúc** (đỏ, viền nổi, tách biệt). Mỗi nút cao 4.5rem, có nhãn chữ tiếng Việt dưới biểu tượng |
| R3.3 | Chuyển camera trước/sau bằng một chạm | `window.teleSwitchCamera()` xoay vòng danh sách thiết bị và `replaceTrack` trên mọi kết nối — không dựng lại cuộc gọi |
| R3.4 | Biểu mẫu đăng ký rút gọn: chỉ Họ tên + BHYT/CCCD (hoặc SĐT) | Hai ô bắt buộc; điểm trạm / SĐT / lý do khám nằm trong `<details id="quick-call-more">` đóng sẵn. Ô định danh nhận luôn số điện thoại (`/^0\d{8,10}$/`) |
| R3.5 | Bảng nhập sinh hiệu thu gọn thành Accordion | `<details id="tele-vitals-accordion">`, chỉ mở khi thật sự có máy đo |

---

## 3. Luồng vận hành (Use Case)

### UC-01 — Người dân gọi cán bộ y tế

1. Người dân mở cổng thông tin, bấm **Gọi khám từ xa**.
2. Điền **Họ và tên** và **Số BHYT / CCCD hoặc số điện thoại**. (Điểm trạm mặc
   định là Trạm Y tế Bát Xát; muốn đổi thì mở mục "Khai thêm".)
3. Bấm **GỌI CÁN BỘ Y TẾ NGAY**.
4. Hệ thống sinh `roomId` từ mã điểm trạm, ghi một lượt hẹn `PENDING` để CMS có
   hồ sơ kể cả khi chưa ai tiếp nhận, rồi `POST /api/signal {action:"join", role:"patient"}`.
5. Trình duyệt xin quyền Camera/Micro, mở màn hình chờ có đồng hồ đếm và dòng
   trạng thái "đang đổ chuông tới ai, còn bao nhiêu giây thì chuyển tiếp".
6. Nếu hết bậc leo thang mà chưa ai nhận: hiện lối thoát gọi điện thoại / Zalo trạm.

### UC-02 — Cán bộ trạm tiếp nhận

1. Cán bộ đăng nhập CMS, tab **Khám từ xa**; hàng đợi long-poll đổ chuông khi có
   cuộc gọi mới.
2. Bấm **Tiếp nhận cuộc gọi** → `POST {action:"accept"}`. Máy chủ trao quyền cho
   **đúng một người** bằng một lệnh `UPDATE ... WHERE routing_state IN (...) RETURNING`;
   người bấm sau nhận lại tên người đã nhận.
3. Cán bộ vào phòng, mở kết nối tới người dân. Nhập/hiệu chỉnh sinh hiệu, gửi định danh.

### UC-03 — Mời bác sĩ tuyến trên (phòng ba bên)

1. Cuộc gọi chưa được nhận trong thời hạn, hoặc cán bộ bấm **Chuyển tiếp**, thì
   bậc leo thang tự lan sang danh sách tiếp nhận tuyến trên.
2. Bác sĩ tuyến trên vào cùng `ROOM-XX`. Lưới kết nối tự dựng thêm một
   `RTCPeerConnection` cho mỗi cặp — cả ba bên đều thấy và nghe được nhau.
3. Sinh hiệu và định danh đã nhập hiện ngay trên màn hình bác sĩ (bản tin
   `patient-info` phát lại khi có người mới vào, cộng với `room.vitals` trong mỗi
   lượt long-poll).

### UC-04 — Chốt kết luận và in đơn A5

1. Bác sĩ nhập chẩn đoán, hướng xử trí, thuốc, lời dặn → `teleSendSignal('doctor_dx', …)`
   và `POST {action:"notes"}`.
2. Màn hình người dân cập nhật khối "Kết luận của Bác sĩ tư vấn" ngay lập tức.
3. Người dân (hoặc cán bộ trạm) bấm in → phiếu khám & đơn thuốc khổ A5.
4. `POST {action:"complete"}` đóng phòng, lượt hẹn chuyển `COMPLETED`.

### UC-05 — Quản trị giám sát ngầm

1. Quản trị đăng nhập CMS. Nút **Vào giám sát** chỉ hiện với tài khoản có quyền
   quản trị (`window.isCmsAdminAccount()`).
2. Bấm nút → `POST {action:"join", role:"cms_admin"}` kèm phiếu phiên.
3. Máy chủ kiểm quyền `admin`; nếu đạt thì ghi bản ghi thành viên với vai
   `cms_admin` và trả về `{ok:true, silent:true, peers, room}` — **không** chạm
   nhịp phòng, **không** khởi động đổ chuông, **không** đẩy thông báo, **không**
   phát `peer-joined`.
4. Cửa sổ giám sát mở lưới kết nối với luồng gửi **rỗng**, chủ động gửi offer
   `recvonly` tới từng bên. Ba bên trả lời và bắt đầu phát hình/tiếng về — nhưng
   kết nối ấy được đánh dấu `hidden` trên máy họ nên không hiện ở bất cứ đâu.
5. Quản trị xem hình, nghe tiếng, đọc chat, đọc sinh hiệu và kết luận. Không có
   nút bật micro, không có nút bật camera, không có ô nhập tin nhắn.
6. Bấm **Thoát giám sát** (hoặc phòng đóng lại) → `POST {action:"leave"}`; máy chủ
   xoá bản ghi và trả `{ok:true, silent:true}`, cũng không phát `peer-left`.

**Trường hợp phụ:** tài khoản không có quyền `admin` gọi thẳng API với
`role:"cms_admin"` → `403 FORBIDDEN`. Phòng đã đóng → `404 GONE`.

---

## 4. Kiến trúc mã nguồn

```
index.html                     Cổng thông tin + CMS + cửa sổ khám của người dân + cửa sổ giám sát
  ├─ TELE.*                    Phiên khám của người dân
  ├─ GHOST.*                   Phiên giám sát ngầm của Quản trị
  └─ cmsRoomCardHtml()         Thẻ cuộc gọi trong CMS (nút Tiếp nhận / Chuyển tiếp / Vào giám sát)
app.js
  └─ window.TeleMesh()         Lưới WebRTC dùng chung (mesh, perfect negotiation, kết nối ẩn)
bacsi.html + doctor.js         Màn hình bác sĩ tuyến trên
netlify/functions/signal.ts    Toàn bộ tuyến tín hiệu, định tuyến, leo thang, và cưỡng chế chế độ giám sát
netlify/lib/auth.ts            Phiếu phiên và phạm vi quyền (station / doctor / admin / video)
db/schema.ts                   telehealth_rooms · telehealth_peers · telehealth_messages
public/                        Bản sao đối chiếu của các tệp gốc (main.js kiểm tra khớp từng byte)
```

### 4.1. Vì sao là mesh chứ không phải SFU

Ba đến bốn điểm cầu là ngưỡng mesh vẫn rẻ hơn hẳn một máy chủ trộn luồng: mỗi bên
giữ `n−1` kết nối, không tốn hạ tầng, và không có điểm hỏng tập trung. Đổi lại,
băng thông tải lên nhân theo số bên — chấp nhận được ở quy mô một điểm trạm.

### 4.2. Tín hiệu trên nền serverless

`POST /api/signal` đặt bản tin vào bảng; `GET /api/signal?roomId=&peerId=&cursor=`
chờ tối đa 7 giây rồi trả về mọi bản tin có `seq > cursor`. Nhịp hỏi lại thích
ứng: 80 ms trong 1,2 giây đầu (giai đoạn bắt tay) rồi giãn ra 300 ms. Ứng viên ICE
được gom lô ~40 ms để cắt số chặng HTTP. Cách này đạt tốc độ lên hình gần bằng
WebSocket mà vẫn chạy trên hàm không trạng thái.

---

## 5. Ma trận Publish / Subscribe theo vai

| Vai | Publish Video | Publish Audio | Publish Chat | Subscribe A/V | Đọc Chat | Ghi hồ sơ (vitals/notes) | Hiện trong danh sách thành viên |
|---|---|---|---|---|---|---|---|
| `patient` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ sinh hiệu | ✅ |
| `station_staff` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `doctor` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ chẩn đoán, đơn thuốc | ✅ |
| `cms_admin` | ⛔ **khoá cứng** | ⛔ **khoá cứng** | ⛔ | ✅ | ✅ | ⛔ | ⛔ **ẩn tuyệt đối** |

Định tuyến này được thực thi ở **hai lớp độc lập**. Lớp giao diện chỉ để cửa sổ
giám sát không có nút nào mà bấm; lớp máy chủ mới là lớp cưỡng chế, vì một trang
đã bị sửa mã trong trình duyệt sẽ vượt qua lớp giao diện dễ dàng.

### 5.1. Cưỡng chế phía máy chủ — `netlify/functions/signal.ts`

```ts
const GHOST_ROLE = "cms_admin";

/** Bản tin WebRTC thuần tuý - vai giám sát chỉ được gửi đúng ba loại này. */
const RTC_SIGNAL_TYPES = ["offer", "answer", "ice"];

function sdpPublishesMedia(sdp: unknown): boolean {
  const sections = String(sdp || "").split(/^m=/m).slice(1);
  if (!sections.length) return false;
  return sections.some((section) => !/^a=(recvonly|inactive)\s*$/m.test(section));
}

async function ghostDenial(peerId, action, type, payload) {
  const sender = await getPeer(peerId);
  if (!sender || !isGhostRole(sender.role)) return null;   // vai thường: không đụng tới

  // 1) Chỉ ba loại bản tin bắt tay được đi qua. Chat, sinh hiệu, kết luận,
  //    tiếp nhận, chuyển tiếp, chốt hồ sơ đều bị chặn.
  if (action !== "signal" || !RTC_SIGNAL_TYPES.includes(type)) {
    return json({ ok: false, code: "SILENT_AUDIT_READ_ONLY", … }, 403);
  }

  // 2) KHOÁ CỨNG MICRO/CAMERA: mô tả phiên phải chỉ-nhận. Người dùng có bật
  //    thiết bị bằng bảng điều khiển của trình duyệt thì bản tin cũng không lọt.
  if ((type === "offer" || type === "answer") && sdpPublishesMedia(payload?.sdp)) {
    return json({ ok: false, code: "SILENT_AUDIT_HARD_MUTE", … }, 403);
  }
  return null;
}
```

Bốn điểm chặn còn lại:

| Nơi | Việc |
|---|---|
| `handleGhostJoin()` | Kiểm quyền `admin`; ghi bản ghi thành viên; **không** `touchRoom`, **không** đổ chuông, **không** thông báo đẩy, **không** `peer-joined` |
| `handleGet()` | `peers.filter(p => p.id !== peerId && (iAmGhost || !isGhostRole(p.role)))` — chỉ chính Quản trị thấy đủ ba bên |
| `fetchMessages()` | Đóng cờ `ghost: true` vào bản tin do vai giám sát gửi, **từ dữ liệu máy chủ** chứ không từ lời khai người gửi |
| nhánh `leave` | Xoá bản ghi rồi trả `{ok:true, silent:true}`, không phát `peer-left` |
| `listRooms()` | Bỏ qua vai giám sát khi đếm số bên trong phòng |

### 5.2. Cấu hình sự kiện Signaling

`—` nghĩa là **không sinh ra sự kiện nào**, không phải "sự kiện bị ẩn ở giao diện".

| Hành động | `patient` nhận | `station_staff` nhận | `doctor` nhận | `cms_admin` nhận |
|---|---|---|---|---|
| `patient` vào phòng | — | `peer-joined` | `peer-joined` | `peer-joined` |
| `station_staff` vào phòng | `peer-joined` | — | `peer-joined` | `peer-joined` |
| `doctor` vào phòng | `peer-joined` | `peer-joined` | — | `peer-joined` |
| **`cms_admin` vào phòng** | **—** | **—** | **—** | — |
| `cms_admin` rời phòng | **—** | **—** | **—** | — |
| `offer`/`answer`/`ice` của `cms_admin` | chỉ đúng bên nhận, có cờ `ghost:true` | nt. | nt. | — |
| `chat` của bất kỳ vai thường nào | ✅ | ✅ | ✅ | ✅ (chỉ đọc) |
| `chat` của `cms_admin` | **403 — không bao giờ tồn tại** | | | |
| Danh sách `peers` trong mỗi lượt long-poll | không có `cms_admin` | không có `cms_admin` | không có `cms_admin` | **có đủ ba bên** |

Cờ `ghost` là mắt xích duy nhất cho ba bên biết phải mở kết nối ở dạng ẩn. Nó do
máy chủ đóng dấu; máy khách không có đường nào tự khai.

### 5.3. Lưới WebRTC — `app.js`, `window.TeleMesh`

Quản trị viên vẫn phải mở một kết nối ngang hàng thật thì mới nhận được hình và
tiếng — không có cách nào nhận luồng mà không bắt tay. Nên thay vì giấu kết nối,
ta giấu **sự tồn tại** của nó:

```js
function all()  { return Array.from(links.values()); }
function list() { return all().filter(link => !link.hidden); }
function notify(link, fn) { if (link && link.hidden) return; fn(); }
```

- `list()` không trả về kết nối ẩn ⇒ Video Grid, Participant List, Name Tag và số
  đếm "N bên trong phòng khám" đều không thấy.
- `onStream` / `onStateChange` / `onPeersChanged` chạy qua `notify()` ⇒ không có
  âm báo, không có dòng trạng thái, không có gì nhấp nháy.
- `connectedCount()` không tính nó ⇒ cuộc gọi chưa ai nghe không bị hiểu nhầm là
  "đã kết nối" chỉ vì Quản trị đang xem.
- Vòng đối chiếu trong `sync()` **miễn trừ** kết nối ẩn: máy chủ cố tình không kê
  vai giám sát trong `peers`, nếu đối chiếu máy móc thì mỗi lượt quét sẽ cắt đúng
  kết nối ấy.

Lối vào duy nhất của kết nối ẩn — vì không hề có `peer-joined` để báo trước:

```js
const link = links.get(msg.from)
  || (type === 'offer' ? ensure(msg.from, { hidden: msg.ghost === true }) : null);
```

### 5.4. Đầu Subscribe của Quản trị — `index.html`, `GHOST`

```js
GHOST.mesh = window.TeleMesh({
  selfId: GHOST.peerId,
  iceConfig: TELE_ICE,
  // Luồng gửi RỖNG - TeleMesh tự dựng transceiver recvonly.
  // Không một nhánh nào trong cửa sổ này gọi getUserMedia:
  // đèn camera trên máy Quản trị không sáng lên một nhịp.
  getSendStream: () => null,
  send: (type, payload, to) => ghostSend(type, payload, to),
  onStream:      () => ghostRenderTiles(),
  onPeersChanged:() => ghostRenderTiles(),
  onStateChange: () => ghostRenderTiles()
});
```

Vì ba bên không nhận được `peer-joined`, họ không bao giờ chủ động chào mời — nên
Quản trị luôn là bên gửi offer trước, và offer ấy luôn là `recvonly`.

---

## 6. Mô hình dữ liệu

| Bảng | Vai trò |
|---|---|
| `telehealth_rooms` | Trạng thái phòng, định danh người bệnh, sinh hiệu (JSON), kết luận, bậc định tuyến (`routing_state`, `ringing_since`, `ringing_station`) |
| `telehealth_peers` | Thành viên đang có mặt: `id`, `room_id`, `role` (chuỗi tự do — `cms_admin` không cần thêm migration), `name`, `last_seen` |
| `telehealth_messages` | Bản tin có số thứ tự `seq` cho long-poll theo con trỏ |

Không có tiến trình nền trên serverless, nên bậc leo thang được **suy ra tại chỗ**
từ mốc `ringing_since` trong mỗi lượt hỏi, thay vì do một bộ hẹn giờ đẩy đi. Nhờ
vậy màn hình người dân và hàng đợi của cán bộ luôn nói cùng một câu mà không cần
đồng bộ thêm trạng thái nào.

---

## 7. Mô hình mối đe doạ của chế độ giám sát

| Kịch bản tấn công | Vì sao không thành |
|---|---|
| Quản trị mở bảng điều khiển trình duyệt, gọi `getUserMedia` rồi `addTrack` | Offer thành `sendrecv`; `sdpPublishesMedia()` bắt được và trả 403 |
| Sửa mã trang để gửi bản tin `chat` | `ghostDenial()` chặn mọi `action` ngoài `signal`, và mọi `type` ngoài offer/answer/ice |
| Một máy khách tự khai `ghost: true` để tàng hình | Cờ `ghost` do `fetchMessages()` đóng từ bảng `telehealth_peers`, bỏ qua hoàn toàn nội dung người gửi |
| Tài khoản cán bộ thường gọi API với `role:"cms_admin"` | `handleGhostJoin()` yêu cầu phạm vi quyền `admin`, nếu không thì 403 |
| Quản trị "vào giám sát" một phòng đã đóng để dò dữ liệu | 404 `GONE` |

---

## 8. Danh mục kiểm thử chấp nhận

**Phòng ba bên**
1. Người dân bấm gọi bằng đúng hai ô → phòng mở, đổ chuông về Trạm Y tế Bát Xát.
2. Cán bộ trạm tiếp nhận → hai bên thấy và nghe nhau.
3. Bác sĩ tuyến trên vào cùng phòng → cả ba khung hình cùng hiện, huy hiệu ghi "3 bên".
4. Người dân nhập sinh hiệu → số hiện trên màn hình bác sĩ mà không cần tải lại.
5. Bác sĩ chốt chẩn đoán → khối kết luận trên máy người dân đổi ngay; in thử đơn A5.

**Giám sát ngầm**
6. Quản trị bấm "Vào giám sát" → thấy đủ ba khung hình, nghe được cả ba.
7. Trên máy người dân, máy cán bộ, máy bác sĩ: khung hình vẫn đúng ba ô, danh sách
   thành viên vẫn ba người, khung chat không có dòng nào mới, không có tiếng báo nào.
8. Bảng điều khiển trình duyệt của Quản trị: `pc.getSenders()` không có track nào;
   mọi kết nối đều `recvonly`.
9. Cố ép gửi `chat` từ phiên Quản trị → 403 `SILENT_AUDIT_READ_ONLY`.
10. Cố gắn track hình rồi đàm phán lại → 403 `SILENT_AUDIT_HARD_MUTE`.
11. Quản trị thoát → ba bên không nhận được thông báo rời phòng nào.

**Giao diện người cao tuổi**
12. Màn hình gọi đếm đúng **bốn** nút; nút Kết thúc màu đỏ, tách biệt, cao 4.5rem.
13. Chạm "Đổi camera" một lần trên điện thoại → đổi mặt camera, cuộc gọi không đứt.
14. Biểu mẫu gọi hiện đúng hai ô; nhập số điện thoại vào ô định danh vẫn gọi được.
15. Bảng sinh hiệu đóng sẵn; không có núm bitrate hay cấu hình âm thanh nào lộ ra.
