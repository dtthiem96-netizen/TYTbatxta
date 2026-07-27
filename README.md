# HỆ THỐNG KHÁM CHỮA BỆNH TỪ XA (TELEHEALTH) CHO CÁN BỘ Y TẾ ĐIỂM TRẠM

Hệ thống ứng dụng CNTT y tế nâng cao hỗ trợ Cán bộ Y tế tại Điểm trạm Y tế xã trực tiếp thực hiện khám chữa bệnh từ xa, kết nối truyền nhận video/âm thanh thời gian thực với Bác sĩ tư vấn tuyến trên (hoặc Trợ lý AI y tế Co-Pilot).

---

## 🌟 TÍNH NĂNG NỔI BẬT

1. **Bảng Điều Khiển Cán Bộ Y Tế (Station Operator Panel)**
   - Đăng nhập linh hoạt theo Mã điểm trạm & Tên cán bộ trực.
   - Nhập nhanh và đồng bộ thời gian thực chỉ số Sinh hiệu Bệnh nhân (Vitals):
     - Huyết áp (mmHg) [Tâm thu / Tâm trương]
     - Nhịp tim (bpm)
     - Độ bão hòa Oxy SpO2 (%) với hệ thống cảnh báo màu khi SpO2 < 92%
     - Nhiệt độ (°C)
     - Cân nặng (kg)
   - Tự động phát âm thanh xác nhận và hiển thị cảnh báo đỏ khi phát hiện dấu hiệu sinh tồn bất thường.

2. **Màn Hình Khám Đa Chiều (Tele-Consultation Room)**
   - **Luồng Video Chính**: Hiển thị Bác sĩ tư vấn tuyến trên hoặc Avatar AI y tế.
   - **Chế Độ Camera Kép (Dual Camera Switcher)**: Cán bộ trạm dễ dàng chuyển đổi qua lại giữa:
     - *Camera 1*: Toàn cảnh phòng khám tại điểm trạm.
     - *Camera 2*: Cận cảnh soi tổn thương ngoài da, vòm họng, mắt hoặc tai (Otoscope/Dermatoscope).
   - **Âm Thanh Kép (Dual Audio)**: Thu nhận rõ lời thoại của cả cán bộ y tế và bệnh nhân gửi tới Bác sĩ tuyến trên.
   - **Tích Hợp HUD Trên Video**: Hiển thị trực tiếp Tên bệnh nhân, Tuổi, Huyết áp, SpO2, Nhịp tim góc trên màn hình cuộc gọi.

3. **Bảng Hỗ Trợ Lâm Sàng & Trợ Lý AI (Clinical Co-Pilot)**
   - **Chuyển Lời Nói Thành Văn Bản (Speech-to-Text)**: Cán bộ trạm chỉ cần nói, AI tự động chuyển lời thoại thành ghi chép diễn biến bệnh lâm sàng (Tiếng Việt vi-VN).
   - **Trợ Lý Lâm Sàng AI**:
     - Phân tích sinh hiệu & triệu chứng để đưa ra **Cảnh báo dấu hiệu sinh tồn nguy hiểm**.
     - Gợi ý **Chẩn đoán sơ bộ** kèm **Mã bệnh quốc tế ICD-10**.
     - Khuyến nghị **Chỉ định Cận lâm sàng** (Xét nghiệm, test nhanh, soi vòm họng, X-quang).
     - Gợi ý **Đơn thuốc & Hướng xử trí tham khảo** tối ưu theo phác đồ của Bộ Y tế.

4. **Hoàn Thành & Xuất Phiếu Khám Bệnh Từ Xa**
   - Tạo tự động **Phiếu Khám Bệnh Từ Xa & Tư Vấn Y Tế** tiêu chuẩn.
   - Tích hợp tính năng In ấn (`window.print()`) và xuất phiếu khám có chữ ký xác nhận của cán bộ điểm trạm và Bác sĩ tuyến trên.

---

## 🛠️ CÔNG NGHỆ SỬ DỤNG

- **Bản triển khai trên Netlify (bản đang chạy trên trang web công khai)**:
  - Giao diện tĩnh `index.html` (HTML5 + Tailwind CSS + Vanilla JS) xuất bản từ thư mục gốc.
  - **Netlify Functions** đóng vai trò backend: `/api/signal` (signaling WebRTC), `/api/cms` (dữ liệu CMS),
    `/api/ai` (trợ lý AI), `/api/video`, `/api/attachment`.
  - **Netlify Database (Postgres + Drizzle ORM)** lưu phòng khám, thành viên đang trực tuyến, hộp thư
    signaling, chỉ số sinh hiệu và lịch đăng ký khám.
  - **WebRTC** truyền video/âm thanh ngang hàng trực tiếp giữa điểm trạm và bác sĩ tuyến trên (STUN công cộng).
- **Bản chạy nội bộ (LAN điểm trạm)**: Node.js (Express.js) + WebSocket (`ws`) trong `server.js`, SQLite `telehealth.db`.
- **Media / WebRTC**: HTML5 MediaDevices API (`getUserMedia`, `enumerateDevices`, `replaceTrack`), RTCPeerConnection.
- **AI & Speech**: Web Speech API (`webkitSpeechRecognition`), trợ lý lâm sàng qua Netlify AI Gateway.

---

## 🔌 CƠ CHẾ KẾT NỐI TRÊN MÔI TRƯỜNG XUẤT BẢN (NETLIFY)

Hạ tầng serverless không giữ được kết nối WebSocket lâu dài, vì vậy phần signaling WebRTC được thực hiện
qua HTTP long-poll tới `/api/signal`:

| Bước | Hành động |
|------|-----------|
| 1 | Điểm trạm mở phòng khám → `POST /api/signal { action: 'join' }` (ghi nhận presence vào Postgres) |
| 2 | Bác sĩ trực CMS thấy phòng đang gọi trong khung **"Cuộc gọi trực tuyến đang chờ tiếp nhận"** và bấm tiếp nhận |
| 3 | Bên vào sau tạo `offer`, hai bên trao đổi `offer` / `answer` / `ICE candidate` qua `/api/signal` |
| 4 | Video & âm thanh chạy **ngang hàng (peer-to-peer)** trực tiếp giữa hai máy, không qua máy chủ |
| 5 | Sinh hiệu, tin nhắn và kết luận của bác sĩ tiếp tục đồng bộ qua `/api/signal` |

Lưu ý vận hành:
- Trình duyệt chỉ cấp quyền camera/micro trên **HTTPS** (tên miền Netlify đã có HTTPS) hoặc `localhost`.
- Hệ thống dùng STUN công cộng. Với mạng doanh nghiệp/4G chặn P2P chặt, cần bổ sung TURN server riêng.

---

## 🚀 HƯỚNG DẪN CÀI ĐẶT VÀ CHẠY CHƯƠNG TRÌNH

### 1. Yêu cầu hệ thống
- Node.js version 18.x trở lên (khuyến nghị v22.x).
- Trình duyệt web hiện đại hỗ trợ WebRTC và Web Speech API (Google Chrome, Microsoft Edge, Brave...).

### 2. Chạy bản Netlify (đầy đủ tính năng, giống môi trường xuất bản)

```bash
npm install
netlify dev --port 8889
```

Truy cập `http://localhost:8889`. Netlify Dev mô phỏng đầy đủ Functions và Netlify Database, nên khung
signaling `/api/signal` hoạt động y như trên trang web đã xuất bản.

Khi thay đổi cấu trúc bảng dữ liệu, sinh migration mới (không bao giờ sửa migration đã áp dụng):

```bash
npx drizzle-kit generate --name <ten_migration>
```

### 3. Chạy bản Node.js/WebSocket nội bộ

Chạy máy chủ Node.js Telehealth:
```bash
node server.js
```

Khi máy chủ khởi chạy thành công, console sẽ hiển thị:
```text
===================================================
🏥 HỆ THỐNG KHÁM CHỮA BỆNH TỪ XA (TELEHEALTH)
🚀 Server đang chạy tại: http://localhost:8889
===================================================
```

Mở trình duyệt web và truy cập địa chỉ:
```text
http://localhost:8889
```

---

## 📁 CẤU TRÚC THƯ MỤC NGUỒN

```text
/
├── index.html                    # Trang web xuất bản trên Netlify: cổng thông tin + CMS + phòng khám Telehealth
├── netlify/functions/
│   ├── signal.ts                 # Signaling WebRTC, presence, đồng bộ sinh hiệu & ghi chép (HTTP long-poll)
│   ├── cms.ts                    # API dữ liệu CMS (tin tức, lịch tiêm, tài khoản, lịch khám)
│   ├── ai.ts                     # Trợ lý AI lâm sàng qua Netlify AI Gateway
│   ├── video.ts                  # Phát video đã tải lên từ Netlify Blobs
│   └── attachment.ts             # Tải tệp đính kèm từ Netlify Blobs
├── netlify/database/migrations/   # Migration Postgres (Netlify Database)
├── db/
│   ├── schema.ts                 # Định nghĩa bảng Drizzle ORM
│   └── index.ts                  # Kết nối Netlify Database
├── server.js                     # Bản chạy nội bộ: Express + WebSocket signaling + SQLite
├── public/
│   ├── index.html                # Giao diện bản nội bộ (Navy Blue & White)
│   └── app.js                    # Logic camera kép, mic, WebSocket WebRTC, Speech-to-Text
├── telehealth.db                 # SQLite của bản chạy nội bộ
├── netlify.toml                  # Cấu hình xuất bản & thư mục Functions
├── package.json                  # Cấu hình dự án & dependencies
└── README.md                     # Tài liệu hướng dẫn sử dụng
```

---

## 🔬 HƯỚNG DẪN SỬ DỤNG KHI THỰC HIỆN KHÁM (BẢN XUẤT BẢN)

**Phía Cán bộ Y tế điểm trạm (trang chủ):**
1. Bấm **"Gọi Bác Sĩ Telehealth"** trên thanh điều hướng (hoặc đặt lịch và chọn *Khám Video Từ Xa*).
2. Điền thông tin bệnh nhân rồi bấm **"VÀO PHÒNG KHÁM VIDEO TỪ XA NGAY"**, cho phép trình duyệt dùng Camera và Micro.
3. Nhập **Sinh hiệu** (huyết áp, nhịp tim, SpO2, nhiệt độ, cân nặng) — chỉ số tự động đồng bộ sang màn hình
   bác sĩ, hoặc bấm **"Gửi chỉ số sinh hiệu tới tuyến trên"** để gửi ngay.
4. Dùng **"Chuyển Camera (Góc rộng / Cận cảnh)"** để đổi giữa camera toàn cảnh phòng khám và camera soi
   cận cảnh tổn thương/họng/da; **Micro** bật/tắt bằng nút biểu tượng micro.
5. Bấm **"Hoàn thành & Xuất Phiếu khám"** để kết xuất và in Phiếu khám bệnh từ xa.

**Phía Bác sĩ tuyến trên (CMS):**
1. Đăng nhập CMS → tab **"Khám từ xa (Telehealth)"**.
2. Khung **"Cuộc gọi trực tuyến đang chờ tiếp nhận"** tự làm mới mỗi 5 giây; bấm **"Tiếp nhận cuộc gọi"**.
3. Theo dõi sinh hiệu điểm trạm gửi lên, trao đổi hình ảnh/âm thanh và tin nhắn hai chiều.
4. Bấm **"AI Co-Pilot Chẩn đoán"** để nhận gợi ý chẩn đoán ICD-10, cận lâm sàng và đơn thuốc tham khảo.
5. Bấm **"Lưu & gửi kết luận về điểm trạm"** để đẩy kết luận về màn hình cán bộ trạm, sau đó
   **"Hoàn thành & Xuất Phiếu khám"**.

> Tài khoản CMS phải được bật quyền `canReceiveVideo` trong mục **Phân quyền Hệ thống** mới tiếp nhận được
> cuộc gọi video.
