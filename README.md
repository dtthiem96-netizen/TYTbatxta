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

- **Backend**: Node.js (Express.js), WebSocket (`ws`) hỗ trợ signaling WebRTC & đồng bộ dữ liệu thời gian thực.
- **Database**: SQLite (`node:sqlite` tích hợp sẵn trong Node v22) lưu trữ lịch sử sinh hiệu và phiếu khám bệnh.
- **Frontend**: HTML5, Tailwind CSS, Vanilla JS, Font Awesome.
- **Media / WebRTC**: HTML5 MediaDevices API (`getUserMedia`, `enumerateDevices`, track replacement), WebRTC RTCPeerConnection.
- **AI & Speech**: Web Speech API (`webkitSpeechRecognition`), Clinical AI Reasoning Engine.

---

## 🚀 HƯỚNG DẪN CÀI ĐẶT VÀ CHẠY CHƯƠNG TRÌNH

### 1. Yêu cầu hệ thống
- Node.js version 18.x trở lên (khuyến nghị v22.x).
- Trình duyệt web hiện đại hỗ trợ WebRTC và Web Speech API (Google Chrome, Microsoft Edge, Brave...).

### 2. Các bước khởi chạy

Cài đặt các gói phụ thuộc (nếu chưa có):
```bash
npm install
```

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
├── server.js            # Node.js Express server, WebSocket WebRTC signaling, REST API Sinh hiệu & AI
├── public/
│   ├── index.html       # Giao diện chuẩn Y tế (Navy Blue & White), chia 3 phân hệ chính + Thanh điều khiển
│   └── app.js           # Logic xử lý Camera kép, Mic, WebSocket WebRTC, Speech-to-Text & In phiếu khám
├── telehealth.db        # Cơ sở dữ liệu SQLite lưu trữ bản ghi sinh hiệu và phiếu khám
├── package.json         # Cấu hình dự án & dependencies
└── README.md            # Tài liệu hướng dẫn sử dụng
```

---

## 🔬 HƯỚNG DẪN SỬ DỤNG KHI THỰC HIỆN KHÁM

1. **Đăng nhập Điểm trạm**: Bấm biểu tượng bánh răng ở góc trên bên phải để thay đổi Mã điểm trạm và Tên cán bộ trực.
2. **Nhập Sinh hiệu Bệnh nhân**: Nhập tên bệnh nhân, tuổi, huyết áp, nhịp tim, SpO2, nhiệt độ và bấm nút **"Gửi & Đồng Bộ Sinh Hiệu Đến Bác Sĩ"**.
3. **Sử dụng Camera Soi Tổn Thương**: Bấm nút **"Chuyển Camera (Góc Rộng / Cận Cảnh)"** ở thanh điều khiển dưới cùng để chuyển sang camera soi tổn thương/da/họng.
4. **Sử dụng Chuyển giọng nói thành văn bản**: Bấm nút **"Giọng nói (STT)"** ở góc trên khung Ghi chép lâm sàng và nói trực tiếp lời thăm khám.
5. **Xem Gợi ý AI**: Bấm nút **"Phân Tích Lâm Sàng & Gợi Ý AI"** để nhận chẩn đoán ICD-10 và đơn thuốc tham khảo.
6. **In Phiếu Khám**: Bấm nút **"Hoàn Thành & Xuất Phiếu Khám"** để xem trước và in Phiếu khám bệnh từ xa.
