# Security Policy

## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 5.1.x   | :white_check_mark: |
| 5.0.x   | :x:                |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

Use this section to tell people how to report a vulnerability.

Tell them where to go, how often they can expect to get an update on a
reported vulnerability, what to expect if the vulnerability is accepted or
declined, etc.

## Tài khoản mặc định và khởi tạo Quản trị viên

- Hệ thống **không** tự tạo tài khoản khi bảng `users` trống (đã bỏ bộ gieo hạt trong `netlify/functions/cms.ts`).
- Các mật khẩu từng xuất hiện trong mã nguồn hoặc lịch sử Git (danh sách `BLOCKED_PASSWORDS` trong `netlify/lib/auth.ts`) luôn bị từ chối khi đăng nhập và khi đổi mật khẩu, kể cả khi khớp chuỗi băm đã lưu.
- Khởi tạo Quản trị viên đầu tiên cho một cơ sở dữ liệu mới: người vận hành sinh chuỗi băm bằng `node auth/tools/generate-hash.mjs '<mật khẩu riêng>'` trên máy của mình, rồi chèn tài khoản bằng một bản di trú mới hoặc lệnh SQL chạy trực tiếp, với `must_change_password = 'true'`. Không ghi mật khẩu dạng rõ vào kho mã. Bản di trú đã áp dụng không được sửa.
