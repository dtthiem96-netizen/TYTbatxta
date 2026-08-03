# Hệ Thống Khám Chữa Bệnh Từ Xa (Telehealth) & Cổng Thông Tin Trạm Y Tế Bát Xát

Hệ thống hỗ trợ Cán bộ Y tế tại Điểm trạm trực tiếp khám, lắng nghe và trao đổi với Bác sĩ tư vấn tuyến trên (hoặc Trợ lý AI lâm sàng hỗ trợ), đồng thời truyền tải hình ảnh/âm thanh thăm khám thực tế từ bệnh nhân.

---

## 1. Cấu Trúc Dự Án & Các Tệp Chính

- **`server.js`**: Node.js (Express.js) server quản lý phòng khám, API sinh hiệu, trợ lý AI lâm sàng, xuất phiếu khám và kênh signaling WebRTC thời gian thực.
- **`public/index.html`**: Giao diện chuẩn Y tế (màu xanh navy/trắng), phân chia bố cục rõ ràng giữa Màn hình Video Call đa chiều, Bảng Sinh hiệu bệnh nhân và Bảng Ghi chú lâm sàng / AI Co-pilot.
- **`public/app.js` & `app.js`**: Logic xử lý chuyển đổi camera cận cảnh/toàn cảnh, bật/tắt mic, thu âm chuyển giọng nói thành văn bản (Speech-to-Text), đồng bộ chỉ số sinh hiệu và báo động cảnh báo cấp cứu thời gian thực.
- **`admin/index.html` & `public/admin/index.html`**: Bảng điều khiển Quản trị nội bộ dành cho Cán bộ Y tế (Quản lý bài viết tin tức, cập nhật lịch tiêm chủng, tiếp nhận lịch đăng ký khám).
- **`netlify/functions/`**: Bộ serverless functions triển khai trên Netlify (`vitals.ts`, `signal.ts`, `clinical-ai.ts`, `cms.ts`, `examination-report.ts`, `station-auth.ts`, `video.ts`, `ai.ts`).
- **`db/`**: Schema và kết nối cơ sở dữ liệu Netlify Database (PostgreSQL / Drizzle ORM).

---

## 2. Các Phân Hệ Chức Năng

1. **Bảng điều khiển Cán bộ Y tế (Station Operator Panel)**
   - Đăng nhập theo Mã điểm trạm (`TYT-BATXAT-01`) & Tên cán bộ trực.
   - Bảng nhập nhanh Sinh hiệu Bệnh nhân (Vitals): Huyết áp (mmHg), Nhịp tim (bpm), SpO2 (%), Nhiệt độ (°C), Cân nặng (kg). Đồng bộ tức thì lên màn hình khám tuyến trên.

2. **Màn hình Video Call Khám Đa Chiều (Tele-Consultation Room)**
   - **Luồng Video chính**: Hiển thị Bác sĩ tư vấn tuyến trên / Bác sĩ chuyên khoa tiếp nhận cuộc gọi.
   - **Luồng Video cận cảnh**: Cán bộ trạm chủ động chuyển đổi giữa Camera 1 (Toàn cảnh phòng khám) và Camera 2 (Cận cảnh soi tổn thương/họng/da của bệnh nhân).
   - **Luồng Âm thanh kép (Dual Audio)**: Cán bộ y tế và bệnh nhân cùng nghe được Bác sĩ qua loa ngoài; Micro thu âm rõ ràng lời thoại.

3. **Trợ lý Lâm sàng AI (Clinical Co-Pilot)**
   - Khung "Ghi chép lâm sàng" hỗ trợ công nghệ Speech-to-Text (chuyển lời nói Y sĩ/ Bác sĩ thành văn bản).
   - Khung "Gợi ý chẩn đoán & Đơn thuốc tham khảo": AI tự động phân tích chỉ số sinh hiệu & triệu chứng để đưa ra cảnh báo cờ đỏ (Red Flags), mã ICD-10 và hướng xử trí tham khảo.

4. **Thanh Điều Khiển Cuộc Gọi**
   - Nút Chuyển đổi Camera (Góc rộng / Cận cảnh tổn thương).
   - Nút Bật/Tắt Mic điểm trạm.
   - Nút "Gửi chỉ số sinh hiệu" tới bác sĩ tuyến trên.
   - Nút "Hoàn thành & Xuất Phiếu khám".

---

## 3. Hướng Dẫn Chạy Chương Trình

### Môi trường Cục bộ (Local Node.js Server)

1. **Cài đặt các gói phụ thuộc (nếu cần)**:
   ```bash
   npm install
   ```

2. **Khởi chạy Server**:
   ```bash
   npm start
   # Hoặc: node server.js
   ```

3. **Truy cập ứng dụng**:
   - **Bảng điều khiển Cán bộ Y tế Điểm trạm**: `http://localhost:3000/tram` (hoặc `http://localhost:3000/public/index.html`)
   - **Trang Cổng thông tin & Khám bệnh cho người dân**: `http://localhost:3000/`
   - **Cổng Quản trị Nội bộ (Admin CMS)**: `http://localhost:3000/admin`

---

### Môi trường Mô Phỏng Netlify (Netlify CLI / Dev)

1. **Khởi chạy Netlify Dev Server**:
   ```bash
   npm run dev
   # Hoặc: netlify dev --port 8889
   ```

2. **Truy cập qua Netlify Local Port 8889**:
   - **Bảng điều khiển Cán bộ Y tế Điểm trạm**: `http://localhost:8889/tram`
   - **Cổng Quản trị Nội bộ**: `http://localhost:8889/admin`

---

## 4. Tài Khoản Đăng Nhập Thử Nghiệm (Mẫu)

- **Trạm trưởng**: `tytbatxat@laocai.gov.vn` / Mật khẩu: `admin123`
- **Bác sĩ Tư vấn Telehealth**: `bacsituvan@laocai.gov.vn`
- **Cán bộ Trực điểm trạm**: `canbotram@laocai.gov.vn`
