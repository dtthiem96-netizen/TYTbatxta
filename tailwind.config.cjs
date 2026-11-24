/**
 * Cấu hình Tailwind dùng để BIÊN DỊCH SẴN assets/tailwind.css (npm run build:css).
 * Trước đây các trang nạp Tailwind Play CDN (cdn.tailwindcss.com) và để trình duyệt
 * tự sinh CSS lúc chạy: trang hiện ra trước khi CSS kịp sinh, nút bấm/khung còn viền
 * đen mặc định của trình duyệt trong vài giây đầu. CSS biên dịch sẵn có ngay từ đầu.
 *
 * Sau khi đổi class trong HTML/JS, chạy lại: npm run build:css (tự chép sang public/),
 * rồi tăng ?v=... ở thẻ <link> trong các trang - /assets/* được cache 1 năm (immutable).
 */
const shades = '50|100|200|300|500|600|700';
const newsColors = 'medical|red|orange|amber|green|blue|purple';
module.exports = {
  content: [
    './index.html', './bacsi.html', './chamcong.html', './401.html',
    './admin/*.html', './app.js', './doctor.js', './chamcong.js', './assets/*.js'
  ],
  /* Màu tin tức ghép chuỗi lúc chạy (bg-${n.color}-100...) và nội dung CMS lưu trong
     CSDL (tiêu đề, ghi chú có class Tailwind) không nằm trong tệp nguồn nên phải
     giữ lại tường minh. */
  safelist: [
    { pattern: new RegExp(`^(bg|text|border)-(${newsColors})-(${shades})$`), variants: ['hover'] },
    'bg-gradient-to-r', 'bg-gradient-to-br', 'bg-clip-text', 'text-transparent', 'from-medical-600', 'to-blue-500'
  ],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] },
      colors: {
        medical: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' }
      }
    }
  }
};
