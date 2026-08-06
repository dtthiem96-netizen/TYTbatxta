# Hệ Thống Khám Chữa Bệnh Từ Xa (Telehealth) & Cổng Thông Tin Trạm Y Tế Bát Xát

Hệ thống hỗ trợ Cán bộ Y tế tại Điểm trạm trực tiếp khám, lắng nghe và trao đổi với Bác sĩ tư vấn tuyến trên (hoặc Trợ lý AI lâm sàng hỗ trợ), đồng thời truyền tải hình ảnh/âm thanh thăm khám thực tế từ bệnh nhân.

---

## 1. Cấu Trúc Dự Án & Các Tệp Chính

- **`server.js`**: Node.js (Express.js) server quản lý phòng khám, API sinh hiệu, trợ lý AI lâm sàng, xuất phiếu khám và kênh signaling WebRTC thời gian thực.runs:
  using: 'node24'
  main: 'main.js'
- **`public/index.html`**: Giao diện chuẩn Y tế (màu xanh navy/trắng), phân chia bố cục rõ ràng giữa Màn hình Video Call đa chiều, Bảng Sinh hiệu bệnh nhân và Bảng Ghi chú lâm sàng / AI Co-pilot.
- **`public/app.js` & `app.js`**: Logic xử lý chuyển đổi camera cận cảnh/toàn cảnh, bật/tắt mic, thu âm chuyển giọng nói thành văn bản (Speech-to-Text), đồng bộ chỉ số sinh hiệu và báo động cảnh báo cấp cứu thời gian thực.
- **`admin/index.html` & `public/admin/index.html`**: Bảng điều khiển Quản trị nội bộ dành cho Cán bộ Y tế (Quản lý bài viết tin tức, cập nhật lịch tiêm chủng, tiếp nhận lịch đăng ký khám).
- **`netlify/functions/`**: Bộ serverless functions triển khai trên Netlify (`vitals.ts`, `signal.ts`, `clinical-ai.ts`, `cms.ts`, `examination-report.ts`, `station-auth.ts`, `admin-users.ts`, `video.ts`, `ai.ts`).
- **`netlify/lib/auth.ts`**: Lớp xác thực dùng chung - băm mật khẩu bcrypt, ký/kiểm tra phiếu phiên JWT và middleware phân quyền `requireScope()`.
- **`db/`**: Schema và kết nối cơ sở dữ liệu Netlify Database (PostgreSQL / Drizzle ORM).

---

## 2. Các Phân Hệ Chức Năng

1. **Bảng điều khiển Cán bộ Y tế (Station Operator Panel)**
   - Module nằm ở **chân trang** (thay thế hoàn toàn lối vào Bảng điều khiển trạm cũ); thanh tiêu đề không còn lối vào này.
   - **Bắt buộc đăng nhập**: mọi lượt mở module đều qua popup xác thực, chỉ tài khoản được CMS Quản trị tích ô **"Quyền truy cập Mod Bảng điều khiển điểm trạm"** (`station_access`) mới vào được. Phiên làm việc dùng phiếu JWT và được kiểm tra lại ở cả trình duyệt lẫn máy chủ (xem mục 5).
   - Tên phòng khám hiển thị trên module là **biến động**, sửa trực tiếp trong CMS Quản trị (Cấu hình & Phân quyền → Tên phòng khám).
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

## 4. Tài Khoản Đăng Nhập

### Tài khoản Quản trị viên hệ thống (Admin)

- **Tên đăng nhập**: `tytbatxat@laocai.gov.vn`
- **Mật khẩu mặc định**: mật khẩu khởi tạo do đơn vị quy định (`Admin123@`), đã được
  nạp sẵn dưới dạng **băm bcrypt** trong bản di trú
  `netlify/database/migrations/20260806035628_set_default_admin_account`.
- **Quyền**: Quản trị viên (Admin) - vào được CMS Quản trị (`/admin`), Module Bảng
  điều khiển điểm trạm và nhận cuộc gọi Telehealth.

> **Bắt buộc đổi mật khẩu ngay sau lần đăng nhập đầu tiên** trong
> *CMS Quản trị → Quản trị hệ thống → Quản lý tài khoản & Phân quyền hệ thống*.
> Mật khẩu mặc định chỉ dùng để mở khoá hệ thống lần đầu; mật khẩu mới ghi đè giá
> trị cũ và bản di trú không bao giờ khôi phục lại mật khẩu mặc định.

### Các tài khoản mẫu khác

- **Bác sĩ Tư vấn Telehealth**: `bacsituvan@laocai.gov.vn` (mặc định KHÔNG có quyền vào Bảng điều khiển trạm)
- **Cán bộ Trực điểm trạm**: `canbotram@laocai.gov.vn` (được cấp quyền vào Bảng điều khiển trạm)
- **Cán bộ Biên tập**: `bientapvien@laocai.gov.vn` (chỉ biên tập nội dung)

Mật khẩu của từng tài khoản do Quản trị đặt trong CMS và được lưu dưới dạng **băm
bcrypt** (10 vòng) - không nơi nào trong hệ thống giữ mật khẩu dạng rõ.

Với các tài khoản có từ trước (chưa có mật khẩu riêng), hệ thống tạm chấp nhận mật
khẩu dùng chung lấy từ biến môi trường `STATION_PASSWORD` (hoặc
`STATION_DEFAULT_PASSWORD`) để Quản trị đăng nhập lần đầu mà thiết lập. **Bắt buộc
đặt `STATION_PASSWORD` trước khi chạy thật**, và ngay khi Quản trị đặt mật khẩu riêng
cho một tài khoản thì lối tạm này đóng vĩnh viễn với tài khoản đó. Tài khoản Quản trị
ở trên đã có mật khẩu riêng nên không còn đi qua lối tạm này.

---

## 5. Quản Lý Tài Khoản & Phân Quyền Module Bảng Điều Khiển Điểm Trạm

Vào **CMS Quản trị → Quản trị hệ thống → Quản lý tài khoản & Phân quyền hệ thống**.

**Tạo tài khoản** - các trường bắt buộc: Họ và tên, Tên đăng nhập, Mật khẩu (tối
thiểu 8 ký tự gồm cả chữ và số), Email hoặc Số điện thoại, và Điểm trạm trực thuộc.

**Cấp quyền** - ô đánh dấu **"Quyền truy cập Mod Bảng điều khiển điểm trạm"**. Chỉ
tài khoản được tích ô này mới đăng nhập và thao tác được trong module. Quyền có thể
cấp/thu hồi bất kỳ lúc nào (bấm huy hiệu ở cột *Quyền Mod Bảng điều khiển* trong
bảng danh sách) và có hiệu lực ngay ở yêu cầu kế tiếp, không phải chờ phiên hết hạn.

**Vòng đời tài khoản** - mỗi dòng có sẵn: Sửa thông tin, Đặt lại mật khẩu (máy chủ
sinh mật khẩu tạm và hiển thị **đúng một lần**, hãy sao chép ngay), Khoá/Mở tài khoản,
và Xoá. Tài khoản bị khoá không đăng nhập được vào bất kỳ cổng nào.

### Cơ chế bảo mật

| Lớp | Thực hiện |
| --- | --- |
| Mật khẩu | Băm bcrypt 10 vòng (`bcryptjs`), không lưu bản rõ, không trả về qua API |
| Phiên đăng nhập | JWT HS256 ký bằng Web Crypto, hạn 8 giờ, giữ trong `sessionStorage` |
| Khoá ký | `STATION_JWT_SECRET` / `JWT_SECRET`; nếu chưa đặt, hệ thống tự sinh và lưu kín trong `site_configs` (tuyến công khai `/api/cms` đã lọc bỏ) |
| Middleware Backend | `requireScope()` trong `netlify/lib/auth.ts`, áp cho `/api/vitals`, `/api/examination-report`, `/api/admin-users`; **đọc lại quyền từ cơ sở dữ liệu ở mỗi yêu cầu** |
| Middleware Frontend | `window.verifyStationSession()` hỏi lại `/api/station-auth` trước khi mở thân module, nên tự dựng phiên trong `sessionStorage` hay gõ thẳng `/tram` đều không vào được |
| Chống giả mạo hồ sơ | Tên cán bộ trên phiếu sinh hiệu và phiếu khám lấy từ phiên đã xác thực, không lấy theo thân yêu cầu |

Ghi tài khoản qua tuyến công khai `/api/cms` đã bị chặn (403): mọi thao tác tài khoản
phải đi qua `/api/admin-users` với phiếu phiên có quyền Quản trị.

