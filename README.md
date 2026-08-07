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
- **`auth/`**: Mô-đun Xác thực dùng cho CMS (Express + bcryptjs + jsonwebtoken) - đăng nhập, phiếu phiên JWT hạn 8 giờ, `authMiddleware` bảo vệ tuyến đường. Xem mục 6.
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

### Tài khoản Quản trị viên CMS (Mô-đun Xác thực)

- **Tên đăng nhập**: `tytbatxat@laocai.gov.vn`
- **Mật khẩu khởi tạo**: `Admin123@`, nạp sẵn dưới dạng **băm bcrypt (cost factor 10)**
  trong bản di trú `netlify/database/migrations/20260807010000_add_cms_admin_account`
  (bản sao đọc được: `db/sql/create-admin-account.sql`).
- **Vai trò**: `admin` - dùng cho các tuyến `/api/auth/*` và `/api/cms/*` của
  [Mô-đun Xác thực](#6-mô-đun-xác-thực-authentication-module).

> Đây cũng là mật khẩu khởi tạo, **bắt buộc đổi ngay sau lần đăng nhập đầu tiên**.

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


---

## 6. Mô-đun Xác Thực (Authentication Module)

Mô-đun độc lập trong thư mục `auth/`, dựng trên **Node.js + Express.js + bcryptjs +
jsonwebtoken**. Đây là nền xác thực dùng cho CMS: đăng nhập bằng mật khẩu băm bcrypt,
cấp phiếu phiên JWT hạn 8 giờ, và rào chắn các tuyến đường cần đăng nhập.

### Cấu trúc

| Tệp | Vai trò |
| --- | --- |
| `auth/authConfig.js` | Hằng số bảo mật: cost factor 10, thời hạn phiếu `8h`, thuật toán `HS256`, cách lấy bí mật ký |
| `auth/userStore.js` | Tra cứu tài khoản. Mặc định dùng bản gieo hạt khớp với bản di trú; đấu nối kho thật bằng `setUserProvider()` |
| `auth/authService.js` | `hashPassword`, `comparePassword` (bcrypt), `signAccessToken`, `verifyAccessToken` (JWT), `extractBearerToken` |
| `auth/authMiddleware.js` | Rào chắn tuyến đường + `requireRole()` phân quyền theo vai trò |
| `auth/authRoutes.js` | `POST /api/auth/login`, `GET /api/auth/session` |
| `auth/cmsRoutes.js` | Ví dụ tích hợp: `GET /api/cms/dashboard` |
| `auth/index.js` | `mountAuthModule(app)` - gắn toàn bộ tuyến đường vào ứng dụng Express |
| `auth/tools/generate-hash.mjs` | Sinh chuỗi băm bcrypt + câu lệnh SQL khi cần đổi mật khẩu |

Gắn vào một ứng dụng Express bất kỳ:

```js
import express from 'express';
import { mountAuthModule } from './auth/index.js';

const app = express();
app.use(express.json());
mountAuthModule(app);          // đăng ký /api/auth/* và /api/cms/*
```

`server.js` đã gọi sẵn `mountAuthModule(app)`, nên chạy `npm start` là dùng được ngay.

### Quy ước mã lỗi của `authMiddleware`

| Mã | Khi nào | Mã lỗi trả về |
| --- | --- | --- |
| **401** | Thiếu header `Authorization`, hoặc header không theo lược đồ `Bearer` | `MISSING_TOKEN` |
| **403** | Phiếu đã quá 8 giờ | `TOKEN_EXPIRED` |
| **403** | Chữ ký sai, nội dung bị sửa, sai `iss`/`aud`, không phải JWT | `INVALID_TOKEN` |
| **403** | Phiếu hợp lệ nhưng vai trò không nằm trong `requireRole(...)` | `FORBIDDEN` |

Đăng nhập trả về `400 MISSING_CREDENTIALS` khi thiếu trường, `401 INVALID_CREDENTIALS`
khi sai tên đăng nhập **hoặc** sai mật khẩu (cùng một thông báo, để không lộ tài khoản
nào có thật), và `403 ACCOUNT_DISABLED` khi tài khoản bị khoá.

### Thử nhanh

```bash
# 1. Đăng nhập, lấy phiếu phiên
TOKEN=$(curl -s -X POST http://localhost:8889/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"tytbatxat@laocai.gov.vn","password":"Admin123@"}' | jq -r .token)

# 2. Gọi tuyến được bảo vệ
curl -H "Authorization: Bearer $TOKEN" http://localhost:8889/api/cms/dashboard

# 3. Gọi mà không có phiếu -> 401
curl -i http://localhost:8889/api/cms/dashboard
```

### Bí mật ký phiếu

Đặt `STATION_JWT_SECRET` (hoặc `JWT_SECRET`) trước khi chạy thật - đúng hai biến mà
`netlify/lib/auth.ts` dùng, nên cả hai tầng ký bằng một khoá duy nhất. Nếu chưa đặt,
mô-đun sinh bí mật ngẫu nhiên theo tiến trình và ghi cảnh báo trong log; khi đó mọi
phiên sẽ mất hiệu lực sau mỗi lần khởi động lại máy chủ.

### Bản chạy thật trên Netlify

`server.js` chỉ chạy khi phát triển tại máy. Bản triển khai Netlify là tĩnh +
Functions, nên hai tuyến trên có thêm bản serverless tương ứng:

- `netlify/functions/auth-login.ts` → `POST /api/auth/login`
- `netlify/functions/cms-dashboard.ts` → `GET /api/cms/dashboard`

Hai tệp này đọc tài khoản thẳng từ bảng `users` trên Netlify Database và dùng
`netlify/lib/auth.ts` để ký/kiểm phiếu, nhờ đó phiếu phiên dùng chung được với
`/api/station-auth` và toàn bộ CMS hiện có. Quy tắc nghiệp vụ - đối chiếu bcrypt, hạn
8 giờ, mã lỗi 400/401/403 - giữ nguyên như bản Express.

---

## 7. Kết Nối API Google Cloud (Gemini / Vertex AI)

Trợ lý AI của trang (`POST /api/ai`) gọi mô hình Gemini của Google. Toàn bộ việc
chọn giấy tờ xác thực nằm trong `netlify/lib/google-ai.ts`, nên đổi cách kết nối
chỉ là đổi biến môi trường, không phải sửa mã.

### Ba đường kết nối, xét theo đúng thứ tự ưu tiên

| # | Nguồn | Biến môi trường cần đặt | Dùng khi nào |
| --- | --- | --- | --- |
| 1 | **Vertex AI + ADC** | `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, (tuỳ chọn `GOOGLE_CLOUD_LOCATION`) | Đơn vị đã có dự án Google Cloud và muốn hoá đơn, hạn mức, nhật ký nằm trong dự án đó |
| 2 | **Khoá API riêng** | `GOOGLE_API_KEY` | Có khoá từ Google AI Studio hoặc Generative Language API, muốn gọi thẳng Google |
| 3 | **Netlify AI Gateway** | *(không cần đặt gì)* | **Mặc định hiện tại.** Netlify tự tiêm khoá lúc chạy hàm, tính phí vào tín dụng Netlify |

Netlify không bao giờ ghi đè biến do đơn vị tự đặt, nên chỉ cần khai báo biến của
đường 1 hoặc 2 là hệ thống tự chuyển sang dùng đường đó.

### Về kịch bản `setup_adc.sh` của Google

```bash
bash <(curl -sSL https://storage.googleapis.com/cloud-samples-data/adc/setup_adc.sh)
```

Kịch bản này cài `gcloud`, hỏi mã dự án, chạy `gcloud auth application-default login`
rồi lưu Application Default Credentials vào `$HOME/.config/gcloud/application_default_credentials.json`.

**Nó chỉ có tác dụng trên máy cá nhân của người phát triển.** Hai lý do:

- Kịch bản cần thao tác tương tác (gõ mã dự án, đăng nhập Google bằng trình duyệt),
  không chạy được trong tiến trình dựng tự động.
- Tệp ADC nằm trong thư mục người dùng của máy đó. Netlify Functions chạy trên máy
  chủ serverless riêng, không hề nhìn thấy thư mục ấy - dù kịch bản chạy xong,
  bản triển khai vẫn không có giấy tờ nào.

Chạy nó khi muốn thử Vertex AI tại chỗ bằng `node server.js`; muốn Vertex AI hoạt
động trên bản triển khai thì dùng khoá tài khoản dịch vụ như bên dưới.

### Bật Vertex AI cho bản triển khai Netlify

1. Trong Google Cloud, bật dịch vụ `aiplatform.googleapis.com` cho dự án.
2. Tạo một **tài khoản dịch vụ** với vai trò *Vertex AI User*, tải khoá dạng JSON.
3. Vào **Netlify → Project configuration → Environment variables**, đặt:
   - `GOOGLE_GENAI_USE_VERTEXAI` = `true`
   - `GOOGLE_CLOUD_PROJECT` = mã dự án (Project ID, không phải tên hiển thị)
   - `GOOGLE_CLOUD_LOCATION` = `global` hoặc vùng mong muốn, ví dụ `asia-southeast1`
   - `GOOGLE_APPLICATION_CREDENTIALS_JSON` = dán **toàn bộ nội dung** tệp khoá JSON
4. Triển khai lại. Lúc chạy, hàm ghi nội dung khoá ra `/tmp/google-adc.json` (quyền
   `600`, mất theo phiên bản hàm) để thư viện xác thực của Google đọc được.

> Khoá tài khoản dịch vụ là bí mật: chỉ đặt qua giao diện biến môi trường của
> Netlify, tuyệt đối không đưa vào mã nguồn hay commit lên kho.

### Kiểm tra kết nối

```bash
# Xem đường kết nối nào đang có hiệu lực (không cần đăng nhập, không lộ khoá)
curl https://<tên-trang>.netlify.app/api/ai-status

# Gọi thử mô hình để xác nhận giấy tờ còn dùng được (cần phiếu phiên điểm trạm)
curl -H "Authorization: Bearer <token>" \
     "https://<tên-trang>.netlify.app/api/ai-status?ping=1"
```

`/api/ai-status` trả về nguồn kết nối, mô hình mặc định, danh sách mô hình được
phép và - với `?ping=1` - độ trễ cùng câu trả lời thử. Endpoint chỉ báo **tên biến
môi trường đã được đặt hay chưa**, không bao giờ trả về giá trị khoá. Phần gọi thử
bắt buộc đăng nhập vì mỗi lượt ping là một lần gọi mô hình có tính phí.

### Khi trợ lý AI báo lỗi

| Thông báo | Nguyên nhân thường gặp |
| --- | --- |
| *Chưa kết nối được dịch vụ AI* | Không có đường nào cấu hình xong. Với AI Gateway: trang phải có ít nhất một bản triển khai chính thức thì biến mới được tiêm |
| *Giấy tờ xác thực bị từ chối* | Khoá API sai, hết hạn, hoặc khoá tài khoản dịch vụ dán thiếu ký tự |
| *Không đủ quyền gọi mô hình* | Chưa bật `aiplatform.googleapis.com`, hoặc tài khoản dịch vụ thiếu vai trò *Vertex AI User* |
| *Quá tải hoặc hết hạn mức* | Chạm giới hạn số token mỗi phút; chờ ít phút hoặc đổi sang mô hình nhẹ hơn |
