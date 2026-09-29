# Kiểm thử chống gian lận - Chấm công / Chấm trực điện tử

Tài liệu này liệt kê 18 tình huống bắt buộc kiểm thử trước khi đưa lớp chống gian lận vào sử dụng thật.

- **Kiểm thử tự động (không cần máy chủ):** chạy `node tools/anti-fraud-tests.mjs`. Lệnh này chạy các hàm thuần trong `netlify/lib/antifraud.ts` và kiểm tra các bảo đảm trong mã nguồn và migration. Các dòng có đánh dấu `[TC-xx]` trong kết quả ứng với mã ở bảng dưới.
- **Kiểm thử đầu-cuối:** chạy trên bản xem trước (Deploy Preview) hoặc `netlify dev`, sau khi đã áp dụng hai migration `20260929005017_add_attendance_antifraud` và `20260929005023_add_attendance_integrity_triggers`.
  - Dùng hai tài khoản cán bộ thử (A, B), một tài khoản Người phụ trách và một tài khoản Quản trị.
  - Vào mục **An toàn chấm công → Cấu hình** để đặt toạ độ Trạm trước khi thử.

Quy ước mức rủi ro:

- **XANH:** ghi nhận bình thường.
- **VÀNG:** vẫn ghi nhận, nhưng sinh cảnh báo để con người xem lại.
- **ĐỎ:** bị chặn. Lượt thử vẫn được lưu làm bằng chứng và cán bộ có thể gửi đề nghị điều chỉnh.

AI không bao giờ tự đưa ra mức ĐỎ. Chỉ người xử lý cảnh báo mới được kết luận "vi phạm".

| # | Tình huống | Cách thử | Kết quả mong đợi |
|---|---|---|---|
| 1 | Chấm đúng giờ | A đứng trong Trạm, dùng thiết bị đã duyệt, chụp selfie trực tiếp và làm đúng động tác được yêu cầu, rồi chấm VÀO trong giờ. | Mức XANH. Lượt chấm ghi giờ máy chủ, có bản ghi bằng chứng (`att_attempts`) kèm toạ độ, sai số, khoảng cách tới Trạm, mã thiết bị và chữ ký hợp lệ. |
| 2 | Chấm sai giờ | Chấm VÀO ngoài khung giờ hành chính, hoặc vào ngày nghỉ không cho phép chấm. | Chấm muộn hoặc về sớm: ghi nhận với trạng thái LATE/EARLY_LEAVE. Chấm ngoài khung cho phép: ĐỎ `OUTSIDE_SHIFT`, bị chặn, có nút "Gửi đề nghị điều chỉnh". |
| 3 | Chấm ngoài Trạm | Chấm từ nơi cách Trạm hơn 2 km (TC-02), hoặc bật GPS kém chính xác, sai số lớn hơn `maxAccuracyM`. | ĐỎ `OUTSIDE_GEOFENCE` / `LOW_ACCURACY`. Máy chủ tự tính khoảng cách. Sai số lớn không "kéo" được vị trí xa vào trong vùng. |
| 4 | Fake GPS | Dùng ứng dụng giả lập vị trí, hoặc DevTools → Sensors → Location, đặt toạ độ tròn hoặc sai số bằng 1 (TC-03). Sau đó chấm tiếp ở toạ độ cách lần trước 300 km chỉ sau vài phút (TC-04). | VÀNG `MOCK_ACCURACY` / `MOCK_ROUNDED` / `MOCK_IDENTICAL`. ĐỎ `GPS_JUMP` khi di chuyển bất khả thi. `AUTOMATION` khi trình duyệt bị điều khiển tự động. Cảnh báo xuất hiện trong mục An toàn chấm công. |
| 5 | Đổi thiết bị | A đăng nhập trên máy mới và bấm chấm công. | Bị chặn với `DEVICE_UNREGISTERED`, giao diện mở đăng ký thiết bị kèm selfie. Thiết bị ở trạng thái "Chờ duyệt" (`DEVICE_PENDING`) cho tới khi Người phụ trách/Quản trị duyệt ở tab Thiết bị. Thiết bị đã thu hồi bị ĐỎ `DEVICE_REVOKED`. |
| 6 | Chấm hộ | B đăng nhập tài khoản B trên điện thoại của A (thiết bị đã gắn với A), hoặc B chụp mặt mình khi đăng nhập tài khoản A. | Trường hợp B dùng điện thoại của A: ĐỎ `SHARED_DEVICE`, đồng thời sinh cảnh báo "Thiết bị dùng chung". Trường hợp B chụp mặt mình trên tài khoản A: vector khuôn mặt lệch ảnh mẫu, VÀNG `FACE_MISMATCH` (AI tham khảo cũng chỉ ra VÀNG). Người xử lý xem hai khung ảnh để kết luận. |
| 7 | Dùng ảnh có sẵn | Gửi thẳng ảnh PNG, ảnh JPEG có EXIF, hoặc hai khung ảnh giống hệt nhau qua API (TC-09, TC-10, TC-11). | Không phải JPEG, hoặc có EXIF: bị từ chối hoặc VÀNG. Hai khung ảnh giống hệt nhau (ảnh tĩnh, không làm động tác): VÀNG `LIVENESS_FAIL`. Giao diện chỉ mở camera trực tiếp, không có nút chọn ảnh từ thư viện. |
| 8 | Chấm trùng | Bấm "Chấm vào" hai lần liên tiếp, hoặc gửi hai yêu cầu song song (TC-14). | Lần hai bị ĐỎ `DUPLICATE`. Nếu hai yêu cầu đến cùng lúc, khoá chống trùng trong CSDL chỉ cho một lượt thắng. Chấm RA khi chưa có lượt VÀO nào đang mở: ĐỎ `NO_OPEN_IN`. |
| 9 | Chấm sai ca | Nhận một ca trực không có trong lịch của mình, qua API với `assignmentId` của người khác, hoặc nhận ca sớm hơn 3 giờ. | ĐỎ `NO_ROSTER` / `OUTSIDE_SHIFT`. Ca tự nhận qua nút "Nhận ca ngoài lịch" được ghi với trạng thái CHỜ DUYỆT (VÀNG `SELF_DUTY_PENDING`). Ca này chưa được tính giờ cho tới khi được xác nhận ở tab "Ca tự nhận". |
| 10 | Chấm ca qua đêm | Ca 17:00 → 07:00: nhận ca lúc 16:45, kết ca lúc 06:50 sáng hôm sau (TC-06). | Cả hai lượt thuộc cùng một ngày trực (ngày bắt đầu ca). Kết ca trước 06:30 bị VÀNG `EARLY_CHECKOUT`. Kết ca sau 11:00 sáng hôm sau quá hạn và phải đi luồng điều chỉnh. |
| 11 | Sửa giờ | Chỉnh đồng hồ điện thoại lùi 1 giờ rồi chấm (TC-05). Hoặc sửa `clientTs`/`punchAt` trong yêu cầu (TC-15). | Giờ chấm luôn là giờ máy chủ. Máy chủ không đọc giờ từ yêu cầu gửi lên. Đồng hồ thiết bị lệch: VÀNG `CLOCK_SKEW`. Muốn sửa giờ công phải gửi đề nghị điều chỉnh. Điều chỉnh lưu cả giá trị trước và sau, người đề nghị và người duyệt. Có nguyên tắc bốn mắt với Quản trị. |
| 12 | Xoá bản ghi | Quản trị bấm "Huỷ hiệu lực" một lượt chấm, hoặc chạy trực tiếp trong CSDL `DELETE FROM att_punches ...`, `UPDATE att_punches SET punch_at = ...`, `TRUNCATE att_audits` (TC-12, TC-13). | Trên giao diện: bản gốc chuyển sang VOIDED và sinh một dòng `att_adjustments`, bắt buộc có lý do. Trong CSDL: trigger báo lỗi `ATT_IMMUTABLE`. Bằng chứng, điều chỉnh và nhật ký kiểm toán chỉ được ghi thêm. Nút "Kiểm tra chuỗi băm" ở tab Kiểm toán phát hiện dòng nhật ký bị can thiệp. |
| 13 | Gọi API trực tiếp | Dùng `curl` gọi `POST /api/attendance {action:'punch'}` mà không có nonce, không có chữ ký, dùng lại nonce cũ, hoặc gửi dồn dập hơn 30 lần/phút. | ĐỎ `NONCE_INVALID` / `DEVICE_SIGNATURE`. Lượt thử vẫn được lưu làm bằng chứng. Gửi dồn dập bị trả 429 và sinh cảnh báo `RATE_LIMIT`. Thiếu phiếu đăng nhập: 401. Không đủ quyền: 403. Gửi từ Origin lạ bị chặn (CSRF). |
| 14 | Thay đổi dữ liệu từ DevTools | Sửa toạ độ, thời gian, `distanceM` hoặc `riskLevel` trong yêu cầu, sau khi đã ký (TC-07). Hoặc sửa biến JS để hiện nút ẩn. | Chữ ký ECDSA được tính trên chuỗi `nonce, thao tác, loại, vĩ độ, kinh độ, sha ảnh`, nên chỉ cần sửa một trường là chữ ký không còn khớp: ĐỎ `DEVICE_SIGNATURE`. Máy chủ bỏ qua `distanceM`/`riskLevel` do trình duyệt gửi. Mọi nút quản trị vẫn phải qua kiểm tra quyền ở máy chủ. |
| 15 | Đăng nhập đồng thời | A đăng nhập trên máy thứ hai trong khi bật `singleSession`. Hoặc lấy phiếu đăng nhập của A đem dùng ở một trình duyệt khác. | Phiên cũ bị đóng với lý do "SUPERSEDED". Máy cũ nhận thông báo "đăng nhập trên thiết bị khác". Phiếu bị dùng ở trình duyệt khác bị đóng ngay (`SESSION_HIJACK`) và sinh cảnh báo. Quản trị xem và đóng phiên ở tab "Phiên đăng nhập". |
| 16 | Token hết hạn | Chờ phiên hết hạn, hoặc đăng xuất rồi gửi lại phiếu cũ. | 401 `SESSION_EXPIRED` / `SESSION_REVOKED`. Giao diện quay về màn đăng nhập. Phiếu cũ không dùng lại được vì máy chủ đối chiếu với `auth_sessions`, không chỉ kiểm tra hạn của JWT. |
| 17 | QR cũ | Chụp ảnh mã QR trên màn hình Trạm, chờ quá `qrTtlSec` rồi dùng. Hoặc dùng lại một mã đã có người quét. Hoặc chỉ gửi QR mà không có GPS/selfie. | ĐỎ `QR_INVALID`, vì mỗi mã chỉ dùng được một lần và có hạn dùng. Khi `qrMode = REQUIRED` mà thiếu QR: ĐỎ `QR_MISSING`. QR không bao giờ là yếu tố duy nhất, các kiểm tra GPS, thiết bị và selfie vẫn áp dụng. |
| 18 | Mất mạng và đồng bộ lại | Tắt mạng, bấm "Chấm vào", sau đó bật mạng lại (TC-17). | Giao diện lưu thời điểm bấm vào hàng đợi trên máy. Khi có mạng, hàng đợi được gửi thành đề nghị điều chỉnh (`offline_sync`), không tạo lượt chấm trực tiếp. Người duyệt thấy rõ đây là lượt chấm "ngoại tuyến" và quyết định có ghi nhận hay không. |

## Kiểm tra bổ sung sau khi triển khai

- **Tối thiểu hoá dữ liệu vị trí:** DevTools → Sensors cho thấy vị trí chỉ được đọc tại lúc bấm chấm. Không có `watchPosition` và không có yêu cầu vị trí nào chạy nền.
- **Quyền xem ảnh:** Người phụ trách không có quyền `security.review` thì không xem được ảnh selfie. Mỗi lần xem ảnh sinh một dòng `SELFIE_VIEW` trong nhật ký kiểm toán. Ảnh nằm trong kho Netlify Blobs riêng, không có đường dẫn công khai.
- **Hạn lưu ảnh:** ảnh quá `selfieRetentionDays` được xoá tự động hằng ngày, hoặc ngay lập tức khi bấm "Xoá ảnh quá hạn". Ảnh mẫu khuôn mặt được giữ riêng.
- **Bảng điều khiển:** mở "An toàn chấm công" và đối chiếu số lượt xanh/vàng/đỏ, số cảnh báo với các lượt vừa thử.
