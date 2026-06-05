Lần cuối được bộ phận hỗ trợ của Netlify xem xét - tháng 7 năm 2025

Netlify cố gắng tìm kiếm một tệp dựa trên một số bộ lọc XOR, và khi tất cả các bộ lọc này đều thất bại, chúng ta sẽ trả về trang lỗi 404. Ví dụ, một yêu cầu được gửi đến /example/sẽ kiểm tra /example/index.html, /example.html, /example/home.htmlvà một số tổ hợp khác (không nhất thiết theo cùng một thứ tự) trước khi gặp lỗi 404. Tuy nhiên, trong trường hợp bạn không mong đợi lỗi 404 tại một URL cụ thể, bạn có thể muốn tìm hiểu lý do và có thể khắc phục nó. Hướng dẫn này nhằm mục đích đề cập đến các lý do phổ biến nhất (và giải pháp của chúng) trên Netlify. Hướng dẫn này giả định rằng các lý do phổ biến gây ra lỗi 404 (như URL không chính xác) không áp dụng.

Thư mục xuất bản không chính xác: Nếu ai đó đang cố gắng triển khai trang web của họ trực tiếp, mà không qua bất kỳ bước xây dựng nào, một trường hợp phổ biến mà chúng tôi nhận thấy là họ tải trang web của mình lên kho lưu trữ Git và đặt tất cả các tệp bên trong một thư mục con. Tuy nhiên, khi kết nối trang web với Netlify, do thiếu khung cấu hình, chúng tôi để người dùng tự chịu trách nhiệm cấu hình các thiết lập chính xác và một số người dùng không cấu hình thư mục xuất bản. Do đó, khi họ truy cập trang web của mình, họ thấy lỗi 404, vì các tệp thực sự nằm bên trong https://their-site.netlify.app/sub-folderthư mục con. Trong trường hợp này, hãy di chuyển tất cả các tệp của bạn ra ngoài thư mục con hoặc thay đổi thư mục xuất bản trong cài đặt Trang web Netlify.

Thiếu quy tắc chuyển hướng SPA: Nhiều công cụ, như Create React App, Vite, Angular, v.v., được sử dụng để tạo Ứng dụng một trang (SPA). Các ứng dụng này không có trang HTML cho mỗi đường dẫn mà thay vào đó dựa vào JavaScript để xử lý điều hướng. Đối với các ứng dụng như vậy, điều quan trọng là phải có các nội dung sau:

/* /index.html 200
như nội dung của _redirectstệp phải tồn tại trong publicthư mục (hoặc thư mục tương tự), để nó được sao chép vào thư mục xuất bản của bạn khi trang web được xây dựng.

Nội dung được render phía máy chủ (Server-Side Rendered Content - SSR): Hiện nay, rất nhiều framework như Next.js, Gatsby, Nuxt, Astro, Remix, SvelteKit, v.v. đều hỗ trợ Server-Side Rendering trên Netlify. Netlify chính thức duy trì các tích hợp riêng cho Next.js và Gatsby, trong khi các framework khác duy trì tích hợp của chúng cho Netlify. Ví dụ, với Next.js, Next.js Runtime có thể tạo ra nhiều chuyển hướng ngay cả đối với một trang web Next.js tối thiểu. Ngay cả với Gatsby, nếu bạn sử dụng SSR/DSG, chúng tôi cũng sẽ tạo ra một vài chuyển hướng. Đối với bất kỳ framework nào khác sử dụng SSR thông qua Netlify Functions, sẽ có ít nhất 1 chuyển hướng để xử lý định tuyến này. Vì vậy, nếu quá trình triển khai của bạn không hiển thị chuyển hướng nào (hoặc số lượng chuyển hướng ít hơn đáng kể trong trường hợp Next.js), bạn có thể chắc chắn rằng đã có lỗi trong quá trình tích hợp. Bạn nên tham khảo tài liệu của tích hợp tương ứng để đảm bảo rằng nó được cấu hình chính xác.

Một tình huống khác với SSR là bạn có thể gửi mã lỗi 404 cho một yêu cầu dựa trên một số logic điều kiện mà bạn đã thiết lập trong mã của mình.

Trong trường hợp lỗi 404 xuất phát từ URL được proxy, hãy đảm bảo rằng đích đến của proxy không trả về lỗi 404.

Trong trường hợp trang HTML của bạn tải bình thường nhưng các tài nguyên bị thiếu/gây lỗi 404, hãy đảm bảo đường dẫn của chúng là chính xác. Create React App kiểm tra điều này homepagetrong <build> package.json, và do đó, có thể cấu hình đường dẫn đến các tài nguyên khác với mong đợi.

Hãy kiểm tra xem bạn có đang chạy bất kỳ Edge Functions nào có thể gây cản trở yêu cầu hay không.

Nếu bạn sử dụng các quy tắc viết lại URL để chuyển hướng một trang web vào thư mục con của một trang web khác, hãy đảm bảo rằng các tài nguyên được xuất bản tại một URL khớp với cấu trúc thư mục của nguồn proxy. Bạn luôn có thể sử dụng <base>thẻ hoặc URL tuyệt đối để đảm bảo các tài nguyên được tải một cách đáng tin cậy.
