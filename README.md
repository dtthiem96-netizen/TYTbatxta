README.md - Tài liệu hệ thống Website Trạm Y tế Bát Xát
1. Thông tin đơn vị quản lý
Tên đơn vị: Trạm Y tế Bát Xát (trực thuộc Ủy ban nhân dân xã Bát Xát quản lý trực tiếp)
Địa chỉ: Thôn 08, Xã Bát Xát, tỉnh Lào Cai
Điện thoại: 0382103002
Email: tytbatxat@laocai.gov.vn
Fanpage: Trạm Y tế Bát Xát
2. Tổng quan kho lưu trữ (Repository Overview)
Kho lưu trữ này chứa mã nguồn, tài liệu hướng dẫn và các tệp cấu hình triển khai hệ thống thông tin, trang web chính thức của Trạm Y tế Bát Xát.
Thành phần
Tên tệp / Thư mục
Mô tả chi tiết
 
Cấu hình gốc
.gitignore, SECURITY.md
Các tệp cấu hình bảo mật và loại trừ tệp khi quản lý mã nguồn Git.
Tài liệu
README.md
Tài liệu mô tả tổng quan dự án, hướng dẫn cài đặt và vận hành hệ thống.
Tài nguyên đa phương tiện
assets/tram_music.mp3
Tệp âm thanh nhạc nền, tuyên truyền của Trạm Y tế.
GitHub Actions Workflows
google-cloudrun-docker.yml
google-cloudrun-source.yml
jekyll-gh-pages.yml
nextjs.yml
python-app.yml
static.yml
Các tệp cấu hình tự động hóa CI/CD, triển khai ứng dụng lên Google Cloud Run, GitHub Pages và các nền tảng khác.

3. Quy định pháp lý và Thể thức văn bản
Toàn bộ văn bản, biểu mẫu, kế hoạch chuyên môn và thông tin phát hành trên hệ thống website tuân thủ chặt chẽ các quy định hiện hành:
Thể thức văn bản: Thực hiện đúng theo Nghị định số 30/2020/NĐ-CP của Chính phủ về công tác văn thư.
Ứng dụng CNTT & Chữ ký số: Tích hợp bộ công cụ ký số theo Nghị định số 30/2020/NĐ-CP do Ban Cơ yếu Chính phủ cung cấp (VGCASignService) trong việc phát hành văn bản điện tử.
4. Hướng dẫn phát triển và đóng góp
Clone kho lưu trữ về môi trường làm việc cục bộ.
Cấu hình các biến môi trường cần thiết cho ứng dụng Web / Next.js / Python.
Kiểm tra tính toàn vẹn của mã nguồn và các tệp cấu hình workflow trước khi đẩy lên nhánh chính (main).
