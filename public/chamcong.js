/* ===========================================================================
   PHÂN HỆ CHẤM CÔNG - CHẤM TRỰC ĐIỆN TỬ NỘI BỘ
   Trạm Y tế Bát Xát - giao diện người dùng (chamcong.html)

   Tệp này CHỈ lo phần nhìn và phần gọi API. Mọi quy tắc nghiệp vụ đều do máy
   chủ quyết định và quyết định lại từ đầu ở mỗi lượt gọi:

     /api/attendance           cán bộ tự chấm công, chấm trực, gửi đơn
     /api/attendance/admin     danh mục, lịch trực, duyệt, khoá kỳ
     /api/attendance/reports   bảng công tháng, bảng trực tháng, tổng hợp

   Vì vậy giao diện ẩn/hiện chức năng theo vai trò là để cho gọn mắt, KHÔNG
   phải là lớp bảo vệ: người dùng có sửa HTML hay gọi thẳng API cũng không vượt
   được phạm vi của mình, cũng không ghi được vào kỳ đã khoá.

   Hai điểm đáng lưu ý khi đọc tiếp:
     - Không có thuộc tính onclick nào trong chamcong.html. Nút tĩnh gắn bằng
       addEventListener, danh sách sinh động dùng một bộ nghe uỷ nhiệm đọc
       data-cc-act. Nhờ vậy nội dung do máy chủ trả về không bao giờ trở thành
       mã chạy được, và đổi tên hàm cũng không làm nút chết lặng.
     - Mọi chuỗi từ máy chủ đi qua esc() trước khi ghép vào HTML.
   =========================================================================== */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  //  Trạng thái của trang
  // -------------------------------------------------------------------------

  /* Phiếu phiên giữ trong localStorage, không phải sessionStorage như Module
     Bác sĩ tuyến trên: phân hệ này được cài về màn hình chính điện thoại riêng
     của từng cán bộ và mở lại nhiều lần trong ngày, bắt đăng nhập lại mỗi lần
     mở là không dùng được. Rủi ro được chặn hai đầu: phiếu chỉ sống 8 giờ do
     máy chủ cấp, và nút Đăng xuất xoá ngay lập tức. */
  var SESSION_KEY = 'tyt-chamcong-session';

  var S = {
    session: null,
    me: null,
    role: 'STAFF',
    settings: null,
    shifts: [],
    holidays: [],
    today: null,
    departments: [],
    employees: [],
    counters: { unreadNotifications: 0, pendingRequests: 0 },
    view: 'home',
    adminTab: 'employees',
    clockOffset: 0,      // lệch giữa đồng hồ máy chủ và đồng hồ thiết bị
    report: null,        // dữ liệu báo cáo đang xem, dùng cho Excel và bản in
    rosterData: null,
    detail: null,        // ngữ cảnh hộp thoại chi tiết đang mở
    installEvent: null
  };

  var WEEKDAY_NAMES = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
  var WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  var MONTH_NAMES = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
    'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];

  var DAY_TYPE_LABEL = { WEEKDAY: 'Ngày thường', WEEKEND: 'Cuối tuần', HOLIDAY: 'Ngày lễ' };
  var DAY_TYPE_CLASS = { WEEKDAY: 'cc-day-weekday', WEEKEND: 'cc-day-weekend', HOLIDAY: 'cc-day-holiday' };
  var STATUS_LABEL = {
    PENDING: 'Đang chờ duyệt', APPROVED: 'Đã duyệt', REJECTED: 'Đã từ chối', CANCELLED: 'Đã thu hồi'
  };
  var STATUS_CLASS = {
    PENDING: 'bg-amber-100 text-amber-800', APPROVED: 'bg-emerald-100 text-emerald-800',
    REJECTED: 'bg-red-100 text-red-800', CANCELLED: 'bg-slate-100 text-slate-600'
  };
  var KIND_LABEL = { ADJUST_PUNCH: 'Điều chỉnh chấm công', SWAP_DUTY: 'Đổi ca trực' };
  var ROLE_LABEL = { STAFF: 'Cán bộ / nhân viên', LEADER: 'Phụ trách khoa/phòng', DEPUTY_DIRECTOR: 'Phó giám đốc', MANAGER: 'Giám đốc', ADMIN: 'Quản trị hệ thống' };

  // -------------------------------------------------------------------------
  //  Tiện ích chung
  // -------------------------------------------------------------------------

  function el(id) { return document.getElementById(id); }
  function qs(selector, root) { return (root || document).querySelector(selector); }
  function qsa(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }

  /** Chặn HTML lọt vào trang qua dữ liệu: dùng cho MỌI chuỗi đưa vào innerHTML. */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : (fallback || 0);
  }

  /** Số hiển thị trên bảng công: bỏ phần thập phân vô nghĩa (8.00 -> 8). */
  function fmtNum(value) {
    var n = Math.round(num(value, 0) * 100) / 100;
    if (!n) return '0';
    return String(n).replace('.', ',');
  }

  function fmtDateVN(iso) {
    if (!iso || String(iso).length < 10) return '';
    var p = String(iso).slice(0, 10).split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  function fmtTimestamp(ms) {
    if (!ms) return '';
    var d = new Date(Number(ms));
    try {
      return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
    } catch (err) {
      return d.toISOString();
    }
  }

  /** Ngày theo giờ Việt Nam, lấy từ đồng hồ máy chủ để không lệch múi giờ thiết bị. */
  function vnNow() {
    return new Date(Date.now() + S.clockOffset);
  }

  function vnParts() {
    var fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    var out = {};
    fmt.formatToParts(vnNow()).forEach(function (part) { out[part.type] = part.value; });
    return out;
  }

  function currentPeriod() {
    var p = vnParts();
    return p.year + '-' + p.month;
  }

  function periodLabel(period) {
    if (!period || period.length < 7) return '';
    return 'Tháng ' + Number(period.slice(5, 7)) + ' năm ' + period.slice(0, 4);
  }

  function daysInPeriod(period) {
    var y = Number(period.slice(0, 4));
    var m = Number(period.slice(5, 7));
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function periodOfDate(iso) { return String(iso || '').slice(0, 7); }

  function shiftPeriod(period, delta) {
    var y = Number(period.slice(0, 4));
    var m = Number(period.slice(5, 7)) + delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    return y + '-' + String(m).padStart(2, '0');
  }

  function badge(text, classes) {
    return '<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold ' + classes + '">' + esc(text) + '</span>';
  }

  function statusBadge(status) {
    var key = String(status || 'PENDING').toUpperCase();
    return badge(STATUS_LABEL[key] || key, STATUS_CLASS[key] || 'bg-slate-100 text-slate-600');
  }

  function emptyBox(text) {
    return '<p class="text-sm text-slate-400 italic py-3 text-center">' + esc(text) + '</p>';
  }

  function spinner(text) {
    return '<p class="text-sm text-slate-500 py-6 text-center"><i class="fas fa-circle-notch fa-spin mr-2"></i>' +
      esc(text || 'Đang tải dữ liệu...') + '</p>';
  }

  // -------------------------------------------------------------------------
  //  Thông báo ngắn
  // -------------------------------------------------------------------------

  function toast(message, kind, durationMs) {
    var host = el('ccToast');
    if (!host) return;
    var palette = {
      success: 'bg-emerald-600', error: 'bg-red-600', warn: 'bg-amber-600', info: 'bg-slate-800'
    };
    var icon = { success: 'fa-circle-check', error: 'fa-circle-exclamation', warn: 'fa-triangle-exclamation', info: 'fa-circle-info' };
    var box = document.createElement('div');
    box.className = 'text-white px-4 py-3 rounded-xl shadow-2xl text-sm flex items-start gap-2 ' +
      (palette[kind] || palette.info);
    box.innerHTML = '<i class="fas ' + (icon[kind] || icon.info) + ' mt-0.5"></i><span class="flex-1">' + esc(message) + '</span>';
    host.appendChild(box);
    setTimeout(function () {
      box.style.transition = 'opacity .3s';
      box.style.opacity = '0';
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 300);
    }, durationMs || (kind === 'error' ? 6000 : 3500));
  }

  // -------------------------------------------------------------------------
  //  Hộp thoại
  // -------------------------------------------------------------------------

  var modalSubmit = null;

  function openModal(title, bodyHtml, onSubmit) {
    el('ccModalTitle').textContent = title;
    el('ccModalBody').innerHTML = bodyHtml;
    modalSubmit = onSubmit || null;
    el('ccModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    var first = qs('input:not([type=hidden]), select, textarea', el('ccModalBody'));
    if (first && window.innerWidth >= 768) first.focus();
  }

  function closeModal() {
    el('ccModal').classList.add('hidden');
    el('ccModalBody').innerHTML = '';
    modalSubmit = null;
    document.body.style.overflow = '';
  }

  /** Đọc giá trị các trường trong hộp thoại theo thuộc tính name. */
  function modalValues() {
    var out = {};
    qsa('[name]', el('ccModalBody')).forEach(function (field) {
      var name = field.getAttribute('name');
      if (field.type === 'checkbox') out[name] = field.checked;
      else if (field.type === 'radio') { if (field.checked) out[name] = field.value; }
      else out[name] = field.value;
    });
    return out;
  }

  /** Khối biểu mẫu dùng lại: nhãn + trường. */
  function field(label, inputHtml, hint) {
    return '<div class="mb-3">' +
      '<label class="block text-xs font-semibold text-slate-600 mb-1">' + esc(label) + '</label>' +
      inputHtml +
      (hint ? '<p class="text-[11px] text-slate-500 mt-1">' + esc(hint) + '</p>' : '') +
      '</div>';
  }

  var INPUT_CLASS = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-medical-500 focus:border-medical-500 outline-none';

  function input(name, value, type, attrs) {
    return '<input name="' + esc(name) + '" type="' + (type || 'text') + '" value="' + esc(value == null ? '' : value) +
      '" class="' + INPUT_CLASS + '" ' + (attrs || '') + '>';
  }

  function textarea(name, value, rows) {
    return '<textarea name="' + esc(name) + '" rows="' + (rows || 3) + '" class="' + INPUT_CLASS + '">' +
      esc(value == null ? '' : value) + '</textarea>';
  }

  function select(name, options, value, attrs) {
    var html = '<select name="' + esc(name) + '" class="' + INPUT_CLASS + '" ' + (attrs || '') + '>';
    options.forEach(function (opt) {
      var v = opt.value == null ? '' : String(opt.value);
      html += '<option value="' + esc(v) + '"' + (String(value == null ? '' : value) === v ? ' selected' : '') + '>' +
        esc(opt.label) + '</option>';
    });
    return html + '</select>';
  }

  function checkbox(name, label, checked) {
    return '<label class="flex items-center gap-2 mb-2 text-sm text-slate-700">' +
      '<input name="' + esc(name) + '" type="checkbox" class="w-4 h-4 rounded border-slate-300 text-medical-600"' +
      (checked ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
  }

  function submitRow(label, extraHtml) {
    return '<div class="flex flex-wrap gap-2 pt-2 border-t border-slate-200 mt-4">' +
      '<button type="button" data-cc-act="modal-submit" class="px-4 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-sm font-semibold">' +
      '<i class="fas fa-floppy-disk mr-1"></i>' + esc(label || 'Lưu lại') + '</button>' +
      '<button type="button" data-cc-act="modal-cancel" class="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm">Đóng</button>' +
      (extraHtml || '') + '</div>';
  }

  function confirmBox(message, onYes, yesLabel) {
    openModal('Xác nhận', '<p class="text-sm text-slate-700 mb-2">' + esc(message) + '</p>' +
      '<div class="flex gap-2 pt-3 border-t border-slate-200 mt-3">' +
      '<button type="button" data-cc-act="modal-submit" class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold">' +
      esc(yesLabel || 'Đồng ý') + '</button>' +
      '<button type="button" data-cc-act="modal-cancel" class="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm">Huỷ</button></div>',
      onYes);
  }

  // -------------------------------------------------------------------------
  //  Gọi API
  // -------------------------------------------------------------------------

  function readSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.token) return null;
      if (parsed.expiresAt && Date.now() >= Number(parsed.expiresAt)) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function writeSession(value) {
    try {
      if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else localStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* Trình duyệt chặn lưu trữ: phiên chỉ còn sống trong bộ nhớ của trang. */
    }
  }

  /**
   * Một cửa duy nhất để nói chuyện với máy chủ.
   * base: 'staff' | 'admin' | 'reports'
   */
  function api(base, options) {
    var opts = options || {};
    var url = base === 'admin' ? '/api/attendance/admin'
      : base === 'reports' ? '/api/attendance/reports' : '/api/attendance';
    var query = opts.query || null;
    if (query) {
      var parts = [];
      Object.keys(query).forEach(function (key) {
        if (query[key] === undefined || query[key] === null || query[key] === '') return;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(query[key]));
      });
      if (parts.length) url += '?' + parts.join('&');
    }
    var init = {
      method: opts.body ? 'POST' : (opts.method || 'GET'),
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store'
    };
    if (S.session && S.session.token) init.headers.Authorization = 'Bearer ' + S.session.token;
    if (opts.body) init.body = JSON.stringify(opts.body);

    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) {
          forceLogin('Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.');
          throw new Error('UNAUTHORIZED');
        }
        if (!res.ok || data.success === false) {
          var message = data.error || data.message || 'Không thực hiện được yêu cầu.';
          var err = new Error(message);
          err.data = data;
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /** Báo lỗi một lần, gọn: dùng cho mọi .catch() của giao diện. */
  function fail(err) {
    if (!err || err.message === 'UNAUTHORIZED') return;
    toast(err.message || 'Có lỗi xảy ra.', 'error');
  }

  // -------------------------------------------------------------------------
  //  Đăng nhập / đăng xuất
  // -------------------------------------------------------------------------

  function forceLogin(message) {
    S.session = null;
    writeSession(null);
    el('ccApp').classList.add('hidden');
    el('ccLogin').classList.remove('hidden');
    if (message) {
      var box = el('ccLoginError');
      box.textContent = message;
      box.classList.remove('hidden');
    }
  }

  function doLogin(event) {
    if (event) event.preventDefault();
    var username = el('ccLoginUsername').value.trim();
    var password = el('ccLoginPassword').value;
    var errorBox = el('ccLoginError');
    var button = el('ccLoginSubmit');
    errorBox.classList.add('hidden');
    if (!username || !password) {
      errorBox.textContent = 'Vui lòng nhập đủ tên đăng nhập và mật khẩu.';
      errorBox.classList.remove('hidden');
      return;
    }
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>Đang kiểm tra...';

    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || !data.success) throw new Error(data.message || 'Đăng nhập không thành công.');
        return data;
      });
    }).then(function (data) {
      /* Phạm vi "attendance" do máy chủ cấp theo cột attendanceAccess. Không có
         phạm vi đó thì dừng ngay tại đây cho người dùng hiểu lý do, thay vì để
         họ vào trong rồi gặp lỗi 403 ở từng chức năng. */
      var scopes = Array.isArray(data.scopes) ? data.scopes : [];
      if (scopes.indexOf('attendance') === -1) {
        throw new Error('Tài khoản này chưa được cấp quyền vào phân hệ Chấm công - Chấm trực. Vui lòng liên hệ Quản trị hệ thống của Trạm.');
      }
      S.session = {
        token: data.token,
        expiresAt: data.expiresAt || (Date.now() + 8 * 3600 * 1000),
        username: (data.user && data.user.username) || username,
        name: (data.user && data.user.name) || username
      };
      writeSession(S.session);
      el('ccLoginPassword').value = '';
      return boot();
    }).catch(function (err) {
      errorBox.textContent = err.message || 'Đăng nhập không thành công.';
      errorBox.classList.remove('hidden');
    }).then(function () {
      button.disabled = false;
      button.innerHTML = '<i class="fas fa-right-to-bracket mr-2"></i>ĐĂNG NHẬP';
    });
  }

  function doLogout() {
    confirmBox('Đăng xuất khỏi phân hệ Chấm công trên thiết bị này?', function () {
      closeModal();
      forceLogin('');
      el('ccLoginError').classList.add('hidden');
      toast('Đã đăng xuất.', 'info');
    }, 'Đăng xuất');
  }

  /** Đổi mật khẩu: dùng lại cổng /api/station-auth của CMS, không mở thêm tuyến. */
  function openChangePassword(forced) {
    var html = (forced
      ? '<p class="text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 mb-3">' +
        'Tài khoản đang dùng mật khẩu tạm do Quản trị cấp. Vui lòng đổi mật khẩu trước khi sử dụng.</p>'
      : '') +
      field('Mật khẩu hiện tại', input('currentPassword', '', 'password', 'autocomplete="current-password"')) +
      field('Mật khẩu mới', input('newPassword', '', 'password', 'autocomplete="new-password"'),
        'Tối thiểu 8 ký tự, nên có cả chữ và số.') +
      field('Nhập lại mật khẩu mới', input('confirmPassword', '', 'password', 'autocomplete="new-password"')) +
      submitRow('Đổi mật khẩu');

    openModal('Đổi mật khẩu', html, function () {
      var v = modalValues();
      if (!v.currentPassword || !v.newPassword) return toast('Vui lòng nhập đủ mật khẩu.', 'warn');
      if (v.newPassword !== v.confirmPassword) return toast('Hai lần nhập mật khẩu mới không giống nhau.', 'warn');
      fetch('/api/station-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'change_password',
          username: S.session ? S.session.username : '',
          currentPassword: v.currentPassword,
          newPassword: v.newPassword
        })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || data.success === false) throw new Error(data.message || data.error || 'Không đổi được mật khẩu.');
          return data;
        });
      }).then(function () {
        closeModal();
        toast('Đã đổi mật khẩu. Lần đăng nhập sau dùng mật khẩu mới.', 'success');
        if (S.me) S.me.mustChangePassword = false;
      }).catch(fail);
    });
  }

  // -------------------------------------------------------------------------
  //  Điều hướng
  // -------------------------------------------------------------------------

  var VIEWS = [
    { key: 'home', label: 'Chấm công', short: 'Chấm công', icon: 'fa-fingerprint', panel: 'ccViewHome', title: 'Chấm công hôm nay', roles: 'all' },
    { key: 'duty', label: 'Lịch trực tháng', short: 'Lịch trực', icon: 'fa-calendar-days', panel: 'ccViewDuty', title: 'Lịch trực tháng', roles: 'all' },
    { key: 'sheet', label: 'Bảng công của tôi', short: 'Bảng công', icon: 'fa-table-list', panel: 'ccViewSheet', title: 'Bảng công của tôi', roles: 'all' },
    { key: 'requests', label: 'Yêu cầu & nghỉ phép', short: 'Yêu cầu', icon: 'fa-file-signature', panel: 'ccViewRequests', title: 'Yêu cầu và đơn nghỉ phép', roles: 'all' },
    { key: 'manage', label: 'Điều hành bộ phận', short: 'Điều hành', icon: 'fa-users-gear', panel: 'ccViewManage', title: 'Điều hành bộ phận', roles: 'manager' },
    { key: 'reports', label: 'Báo cáo tháng', short: 'Báo cáo', icon: 'fa-file-excel', panel: 'ccViewReports', title: 'Báo cáo tháng', roles: 'all' },
    { key: 'admin', label: 'Quản trị hệ thống', short: 'Quản trị', icon: 'fa-sliders', panel: 'ccViewAdmin', title: 'Quản trị hệ thống', roles: 'admin' },
    { key: 'notifications', label: 'Thông báo', short: 'Thông báo', icon: 'fa-bell', panel: 'ccViewNotifications', title: 'Thông báo', roles: 'all' }
  ];

  function allowedViews() {
    return VIEWS.filter(function (v) {
      if (v.roles === 'all') return true;
      if (v.roles === 'manager') return S.role === 'MANAGER' || S.role === 'ADMIN';
      if (v.roles === 'admin') return S.role === 'ADMIN';
      return true;
    });
  }

  function renderNav() {
    var views = allowedViews();
    var side = el('ccSideNav');
    side.innerHTML = views.map(function (v) {
      return '<button type="button" data-cc-view="' + v.key + '" class="cc-nav-side w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition flex items-center gap-2 ' +
        (S.view === v.key ? 'bg-white text-medical-800 shadow' : 'text-medical-100 hover:bg-medical-800') + '">' +
        '<i class="fas ' + v.icon + ' w-5"></i><span class="flex-1">' + esc(v.label) + '</span>' +
        (v.key === 'notifications' && S.counters.unreadNotifications
          ? '<span class="px-1.5 rounded-full bg-red-500 text-white text-[10px] font-bold">' + S.counters.unreadNotifications + '</span>' : '') +
        '</button>';
    }).join('');

    /* Thanh dưới của điện thoại chỉ chứa 5 mục hay dùng nhất, mục còn lại vào
       nút "Thêm" - nhồi 8 mục vào một hàng thì không bấm nổi bằng ngón tay. */
    var primary = views.filter(function (v) { return v.key !== 'notifications'; }).slice(0, 4);
    var bottom = el('ccBottomNav');
    bottom.style.gridTemplateColumns = 'repeat(' + (primary.length + 1) + ', minmax(0, 1fr))';
    bottom.innerHTML = primary.map(function (v) {
      return '<button type="button" data-cc-view="' + v.key + '" class="py-2 flex flex-col items-center gap-1 text-[11px] font-medium ' +
        (S.view === v.key ? 'text-medical-700' : 'text-slate-500') + '">' +
        '<i class="fas ' + v.icon + ' text-lg"></i><span>' + esc(v.short) + '</span></button>';
    }).join('') +
      '<button type="button" data-cc-act="more-menu" class="py-2 flex flex-col items-center gap-1 text-[11px] font-medium text-slate-500">' +
      '<i class="fas fa-ellipsis text-lg"></i><span>Thêm</span></button>';
  }

  function openMoreMenu() {
    var views = allowedViews();
    var html = '<div class="space-y-2">' + views.map(function (v) {
      return '<button type="button" data-cc-act="go-view" data-view="' + v.key + '" class="w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-medium flex items-center gap-3">' +
        '<i class="fas ' + v.icon + ' text-medical-600 w-5"></i>' + esc(v.label) + '</button>';
    }).join('') +
      '<button type="button" data-cc-act="go-change-password" class="w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-medium flex items-center gap-3">' +
      '<i class="fas fa-key text-medical-600 w-5"></i>Đổi mật khẩu</button>' +
      '<button type="button" data-cc-act="go-logout" class="w-full text-left px-4 py-3 rounded-xl border border-red-200 text-red-700 hover:bg-red-50 text-sm font-medium flex items-center gap-3">' +
      '<i class="fas fa-power-off w-5"></i>Đăng xuất</button></div>';
    openModal('Chức năng', html, null);
  }

  var VIEW_LOADERS = {
    home: function () { renderHome(); },
    duty: function () { loadDutySchedule(); },
    sheet: function () { loadMyTimesheet(); },
    requests: function () { loadMyRequests(); },
    manage: function () { loadOverview(); loadApprovals(); },
    reports: function () { loadReports(); },
    admin: function () { renderAdmin(); },
    notifications: function () { loadNotifications(); }
  };

  function go(viewKey) {
    var view = VIEWS.filter(function (v) { return v.key === viewKey; })[0];
    if (!view) return;
    if (allowedViews().indexOf(view) === -1) return;
    S.view = viewKey;
    VIEWS.forEach(function (v) {
      var panel = el(v.panel);
      if (panel) panel.classList.toggle('hidden', v.key !== viewKey);
    });
    el('ccViewTitle').textContent = view.title;
    el('ccViewSubtitle').textContent = subtitleFor(view.key);
    renderNav();
    window.scrollTo(0, 0);
    if (VIEW_LOADERS[viewKey]) VIEW_LOADERS[viewKey]();
  }

  function subtitleFor(viewKey) {
    var emp = S.me && S.me.employee;
    if (viewKey === 'home') {
      return emp ? (emp.fullName + (emp.departmentName ? ' - ' + emp.departmentName : '')) : (S.me ? S.me.name : '');
    }
    if (viewKey === 'manage') return 'Vai trò: ' + (ROLE_LABEL[S.role] || S.role);
    if (viewKey === 'admin') return 'Cấu hình và danh mục của phân hệ';
    if (viewKey === 'reports') return 'Bảng chấm công, bảng chấm trực và tổng hợp';
    return periodLabel(currentPeriod());
  }

  // -------------------------------------------------------------------------
  //  Khởi động
  // -------------------------------------------------------------------------

  function boot() {
    return api('staff', { query: { view: 'bootstrap' } }).then(function (data) {
      S.me = data.me;
      S.role = data.me.role;
      S.settings = data.settings;
      S.shifts = data.shifts || [];
      S.holidays = data.holidays || [];
      S.today = data.today;
      S.counters = data.counters || S.counters;
      S.clockOffset = Number(data.serverTime || Date.now()) - Date.now();

      el('ccLogin').classList.add('hidden');
      el('ccApp').classList.remove('hidden');
      el('ccInstallBar').classList.add('hidden');

      var orgName = (S.settings && S.settings.org && S.settings.org.name) || 'TRẠM Y TẾ BÁT XÁT';
      el('ccSidebarOrg').textContent = orgName;
      el('ccLoginOrg').textContent = orgName;
      el('ccSidebarName').textContent = (S.me.employee && S.me.employee.fullName) || S.me.name;
      el('ccSidebarRole').textContent = (ROLE_LABEL[S.role] || S.role) +
        (S.me.employee && S.me.employee.code ? ' - ' + S.me.employee.code : '');

      renderNav();
      renderNotifyBadge();
      renderLockedBanner();
      go(S.view || 'home');
      startClock();

      if (!S.me.employee) {
        /* Có quyền vào phân hệ nhưng chưa được gắn hồ sơ cán bộ: chấm công cần
           hồ sơ mới ghi được, nên nói rõ ngay thay vì để nút báo lỗi. */
        toast('Tài khoản chưa được gắn hồ sơ cán bộ nên chưa chấm công được. Quản trị cần gán hồ sơ trong mục Quản trị.', 'warn');
      }
      if (S.me.mustChangePassword) openChangePassword(true);

      /* Người vừa mở lại ứng dụng thường quan tâm số liệu hôm nay: làm mới nhẹ
         khi trang trở lại tiền cảnh, không dựng vòng lặp hỏi liên tục. */
      return data;
    }).catch(function (err) {
      if (err && err.status === 403) {
        forceLogin(err.message);
        return;
      }
      fail(err);
    });
  }

  function renderNotifyBadge() {
    var badgeEl = el('ccNotifyBadge');
    var count = num(S.counters.unreadNotifications, 0);
    badgeEl.textContent = count > 99 ? '99+' : String(count);
    badgeEl.classList.toggle('hidden', count === 0);
  }

  function renderLockedBanner() {
    var locked = S.today && S.today.locked;
    var banner = el('ccLockedBanner');
    banner.classList.toggle('hidden', !locked);
    if (locked) {
      el('ccLockedText').textContent = 'Bảng công ' + periodLabel(S.today.period) +
        ' đã được khoá. Mọi thao tác chấm công, chấm trực và điều chỉnh trong kỳ này đều bị từ chối.';
    }
  }

  var clockTimer = null;

  function startClock() {
    if (clockTimer) clearInterval(clockTimer);
    tickClock();
    clockTimer = setInterval(tickClock, 1000);
  }

  function tickClock() {
    var p = vnParts();
    var clockEl = el('ccClock');
    if (clockEl) clockEl.textContent = p.hour + ':' + p.minute + ':' + p.second;
    var dateEl = el('ccTodayDate');
    if (dateEl) dateEl.textContent = 'Ngày ' + p.day + ' tháng ' + Number(p.month) + ' năm ' + p.year;
    var weekdayEl = el('ccTodayWeekday');
    if (weekdayEl && S.today) weekdayEl.textContent = WEEKDAY_NAMES[num(S.today.weekday, 0)];
  }

  function refreshAll() {
    var btn = el('ccRefreshBtn');
    btn.classList.add('fa-spin');
    api('staff', { query: { view: 'bootstrap' } }).then(function (data) {
      S.me = data.me;
      S.role = data.me.role;
      S.settings = data.settings;
      S.shifts = data.shifts || [];
      S.holidays = data.holidays || [];
      S.today = data.today;
      S.counters = data.counters || S.counters;
      S.clockOffset = Number(data.serverTime || Date.now()) - Date.now();
      renderNotifyBadge();
      renderLockedBanner();
      renderNav();
      if (VIEW_LOADERS[S.view]) VIEW_LOADERS[S.view]();
      toast('Đã tải lại số liệu.', 'success');
    }).catch(fail).then(function () {
      btn.classList.remove('fa-spin');
    });
  }

  /**
   * Làm mới riêng số liệu của hôm nay, không có thông báo và không đụng tới
   * khung đang xem. Dùng khi người dùng mở lại phân hệ sau lúc khoá màn hình.
   */
  function refreshToday() {
    api('staff', { query: { view: 'today' } }).then(function (data) {
      S.today = data.today || data;
      renderLockedBanner();
      if (S.view === 'home') renderHome();
    }).catch(function () { /* mất mạng tạm thời thì giữ nguyên số liệu đang có */ });
  }

  // =========================================================================
  //  MÀN HÌNH CHẤM CÔNG (mục IV)
  // =========================================================================

  function renderHome() {
    var t = S.today;
    var badges = el('ccTodayBadges');
    if (!t) {
      badges.innerHTML = '';
      el('ccTodayPunches').innerHTML = emptyBox('Chưa có hồ sơ cán bộ nên chưa có dữ liệu chấm công.');
      el('ccTodayDuties').innerHTML = emptyBox('Không có ca trực.');
      renderWorkHoursInfo();
      setPunchButtons(true, true, 'Chưa gắn hồ sơ', 'Chưa gắn hồ sơ');
      return;
    }

    var dayClass = {
      WEEKDAY: 'bg-medical-100 text-medical-800',
      WEEKEND: 'bg-amber-100 text-amber-800',
      HOLIDAY: 'bg-red-100 text-red-800'
    };
    var html = badge(DAY_TYPE_LABEL[t.dayType] || t.dayType, dayClass[t.dayType] || 'bg-slate-100 text-slate-700');
    if (t.holidayName) html += ' ' + badge(t.holidayName, 'bg-red-100 text-red-800');
    if (!t.isWorkDay) html += ' ' + badge('Không phải ngày làm việc hành chính', 'bg-slate-100 text-slate-600');
    if (t.locked) html += ' ' + badge('Kỳ đã khoá', 'bg-slate-800 text-white');
    if (t.openSession) html += ' ' + badge('Đang trong giờ làm', 'bg-emerald-100 text-emerald-800');
    badges.innerHTML = html;

    // Lượt chấm công hôm nay
    var list = t.punches || [];
    el('ccTodayPunches').innerHTML = list.length ? list.map(function (p) {
      var typeLabel = p.punchType === 'IN' ? 'Chấm vào' : 'Chấm ra';
      var statusText = {
        ON_TIME: 'Đúng giờ', LATE: 'Đi muộn ' + Math.abs(p.minutesDelta) + ' phút',
        EARLY_LEAVE: 'Về sớm ' + Math.abs(p.minutesDelta) + ' phút', OUTSIDE: 'Ngoài giờ'
      }[p.status] || p.status;
      var statusClass = {
        ON_TIME: 'bg-emerald-100 text-emerald-800', LATE: 'bg-amber-100 text-amber-800',
        EARLY_LEAVE: 'bg-amber-100 text-amber-800', OUTSIDE: 'bg-slate-100 text-slate-600'
      }[p.status] || 'bg-slate-100 text-slate-600';
      return '<div class="flex items-center gap-3 p-3 rounded-xl bg-slate-50">' +
        '<i class="fas ' + (p.punchType === 'IN' ? 'fa-right-to-bracket text-emerald-600' : 'fa-right-from-bracket text-red-600') + '"></i>' +
        '<div class="flex-1 min-w-0">' +
        '<p class="text-sm font-semibold text-slate-800">' + esc(typeLabel) + ' ' + esc(p.time) +
        ' <span class="font-normal text-slate-500">(' + esc(p.session === 'MORNING' ? 'buổi sáng' : 'buổi chiều') + ')</span></p>' +
        (p.source !== 'SELF' ? '<p class="text-[11px] text-slate-500">Nguồn: ' +
          esc(p.source === 'REQUEST' ? 'do duyệt yêu cầu điều chỉnh' : 'do Quản trị nhập') + '</p>' : '') +
        (p.note ? '<p class="text-[11px] text-slate-500">' + esc(p.note) + '</p>' : '') +
        '</div>' + badge(statusText, statusClass) + '</div>';
    }).join('') : emptyBox('Hôm nay chưa có lượt chấm công nào.');

    // Ca trực hôm nay
    var duties = t.duties || [];
    el('ccTodayDuties').innerHTML = duties.length ? duties.map(dutyCardHtml).join('') :
      emptyBox('Hôm nay bạn không có ca trực theo lịch.');

    renderWorkHoursInfo();

    // Hai nút lớn
    var disableIn = t.locked || !!t.openSession;
    var disableOut = t.locked || !t.openSession;
    var hintIn = t.locked ? 'Kỳ đã khoá' : (t.openSession ? 'Đã chấm vào, chờ chấm ra' : 'Bấm khi bắt đầu làm việc');
    var hintOut = t.locked ? 'Kỳ đã khoá' : (t.openSession ? 'Bấm khi kết thúc buổi làm' : 'Chưa có lượt chấm vào');
    if (!S.me || !S.me.employee) { disableIn = true; disableOut = true; hintIn = hintOut = 'Chưa gắn hồ sơ cán bộ'; }
    setPunchButtons(disableIn, disableOut, hintIn, hintOut);
  }

  function setPunchButtons(disableIn, disableOut, hintIn, hintOut) {
    el('ccPunchInBtn').disabled = !!disableIn;
    el('ccPunchOutBtn').disabled = !!disableOut;
    el('ccPunchInHint').textContent = hintIn || '';
    el('ccPunchOutHint').textContent = hintOut || '';
  }

  function dutyCardHtml(d) {
    var stateText, stateClass, actions = '';
    if (d.checkOutAt) {
      stateText = 'Đã kết ca ' + hhmm(d.checkOutAt);
      stateClass = 'bg-slate-100 text-slate-700';
    } else if (d.checkInAt) {
      stateText = 'Đang trực, nhận ca ' + hhmm(d.checkInAt);
      stateClass = 'bg-emerald-100 text-emerald-800';
      if (d.actionable) {
        actions = '<button type="button" data-cc-act="duty-out" data-id="' + esc(d.assignmentId) + '" ' +
          'class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-bold w-full md:w-auto">' +
          '<i class="fas fa-flag-checkered mr-1"></i>KẾT CA TRỰC</button>';
      }
    } else {
      stateText = 'Chưa nhận ca';
      stateClass = 'bg-amber-100 text-amber-800';
      if (d.actionable) {
        actions = '<button type="button" data-cc-act="duty-in" data-id="' + esc(d.assignmentId) + '" ' +
          'class="px-4 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-sm font-bold w-full md:w-auto">' +
          '<i class="fas fa-user-check mr-1"></i>NHẬN CA TRỰC</button>';
      }
    }
    return '<div class="border border-slate-200 rounded-xl p-3" style="border-left:4px solid ' + esc(d.color) + '">' +
      '<div class="flex flex-wrap items-center gap-2 mb-1">' +
      '<span class="font-bold text-slate-800 text-sm">' + esc(d.shiftName) + '</span>' +
      '<span class="text-xs text-slate-500">' + esc(d.startTime) + ' - ' + esc(d.endTime) +
      (d.crossesMidnight ? ' (hôm sau)' : '') + '</span>' +
      badge(DAY_TYPE_LABEL[d.dayType] || d.dayType, 'bg-slate-100 text-slate-700') +
      '</div>' +
      '<p class="text-xs text-slate-500 mb-2">Ngày trực ' + esc(fmtDateVN(d.dutyDate)) +
      ' - định mức ' + esc(fmtNum(d.hours)) + ' giờ</p>' +
      '<div class="flex flex-wrap items-center gap-2">' + badge(stateText, stateClass) + '</div>' +
      (actions ? '<div class="mt-3">' + actions + '</div>' : '') +
      '</div>';
  }

  function hhmm(ms) {
    if (!ms) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(new Date(Number(ms)));
    } catch (err) {
      return '';
    }
  }

  function renderWorkHoursInfo() {
    var wh = S.settings && S.settings.workHours;
    var box = el('ccWorkHoursInfo');
    if (!wh) { box.innerHTML = ''; return; }
    var days = (wh.workDays || []).slice().sort(function (a, b) { return a - b; })
      .map(function (d) { return WEEKDAY_NAMES[d]; }).join(', ');
    var rows = [];
    if (wh.morning && wh.morning.enabled !== false) rows.push('Buổi sáng: <strong>' + esc(wh.morning.start) + ' - ' + esc(wh.morning.end) + '</strong>');
    if (wh.afternoon && wh.afternoon.enabled !== false) rows.push('Buổi chiều: <strong>' + esc(wh.afternoon.start) + ' - ' + esc(wh.afternoon.end) + '</strong>');
    rows.push('Ngày làm việc: <strong>' + esc(days || 'chưa đặt') + '</strong>');
    rows.push('Cho phép muộn ' + num(wh.lateGraceMin, 0) + ' phút, về sớm ' + num(wh.earlyGraceMin, 0) + ' phút.');
    box.innerHTML = rows.map(function (r) { return '<p>' + r + '</p>'; }).join('') +
      '<p class="text-[11px] text-slate-400 mt-2">Giờ hành chính do Quản trị đặt trong Quản trị → Thời gian làm việc, không cố định trong mã nguồn.</p>';
  }

  function doPunch(type) {
    var button = el(type === 'IN' ? 'ccPunchInBtn' : 'ccPunchOutBtn');
    button.disabled = true;
    api('staff', {
      body: {
        action: 'punch',
        type: type,
        /* Ghi lại loại thiết bị để đối chiếu khi có khiếu nại; địa chỉ IP do
           máy chủ tự lấy, giao diện không gửi lên. */
        device: navigator.platform || (navigator.userAgentData && navigator.userAgentData.platform) || 'web'
      }
    }).then(function (data) {
      S.today = data.today;
      renderHome();
      renderLockedBanner();
      toast(data.message, 'success');
    }).catch(function (err) {
      button.disabled = false;
      if (err && err.data && err.data.canRequestAdjust) {
        /* Chấm ngoài giờ: mở luôn đơn điều chỉnh, đó là đường đi đúng thay vì
           để cán bộ loay hoay tìm chức năng. */
        toast(err.message, 'warn');
        setTimeout(function () { openAdjustForm(); }, 400);
        return;
      }
      fail(err);
    });
  }

  function doDutyCheck(assignmentId, direction) {
    api('staff', {
      body: { action: direction === 'in' ? 'duty_check_in' : 'duty_check_out', assignmentId: assignmentId }
    }).then(function (data) {
      S.today = data.today;
      renderHome();
      toast(data.message, 'success');
    }).catch(fail);
  }

  // =========================================================================
  //  LỊCH TRỰC THÁNG (mục VI - phần xem)
  // =========================================================================

  function loadDutySchedule() {
    var periodInput = el('ccDutyPeriod');
    if (!periodInput.value) periodInput.value = currentPeriod();
    var period = periodInput.value;
    var onlyMine = el('ccDutyScope').value === 'me';
    var host = el('ccDutyCalendar');
    host.innerHTML = spinner('Đang tải lịch trực...');

    api('staff', { query: { view: 'duty_schedule', period: period } }).then(function (data) {
      var myId = S.me && S.me.employee ? S.me.employee.id : '';
      var days = data.days || [];
      var total = 0;
      var mine = 0;
      days.forEach(function (day) {
        total += day.entries.length;
        mine += day.entries.filter(function (e) { return e.employeeId === myId; }).length;
      });

      var header = '<div class="bg-white rounded-2xl shadow-sm p-4 flex flex-wrap gap-4 text-sm">' +
        '<p><span class="text-slate-500">Kỳ:</span> <strong>' + esc(periodLabel(period)) + '</strong></p>' +
        '<p><span class="text-slate-500">Tổng suất trực:</span> <strong>' + total + '</strong></p>' +
        '<p><span class="text-slate-500">Ca trực của tôi:</span> <strong class="text-medical-700">' + mine + '</strong></p>' +
        '</div>';

      var rows = days.map(function (day) {
        var entries = onlyMine ? day.entries.filter(function (e) { return e.employeeId === myId; }) : day.entries;
        if (onlyMine && !entries.length) return '';
        var isToday = S.today && day.date === S.today.today;
        return '<div class="rounded-xl border border-slate-200 p-3 ' + (DAY_TYPE_CLASS[day.dayType] || '') +
          (isToday ? ' cc-day-today' : '') + '">' +
          '<div class="flex flex-wrap items-center gap-2 mb-2">' +
          '<span class="font-bold text-slate-800 text-sm">Ngày ' + esc(fmtDateVN(day.date)) + '</span>' +
          '<span class="text-xs text-slate-600">' + esc(WEEKDAY_NAMES[num(day.weekday, 0)]) + '</span>' +
          (day.dayType !== 'WEEKDAY' ? badge(day.holidayName || DAY_TYPE_LABEL[day.dayType], 'bg-white/70 text-slate-700') : '') +
          (isToday ? badge('Hôm nay', 'bg-medical-600 text-white') : '') +
          '</div>' +
          (entries.length ? '<div class="flex flex-wrap gap-2">' + entries.map(function (e) {
            var isMe = e.employeeId === myId;
            return '<span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs bg-white border ' +
              (isMe ? 'border-medical-500 font-bold text-medical-800' : 'border-slate-200 text-slate-700') + '">' +
              '<span class="w-2 h-2 rounded-full" style="background:' + esc(e.color) + '"></span>' +
              esc(e.shiftName) + ' ' + esc(e.startTime) + '-' + esc(e.endTime) + ': ' + esc(e.employeeName) +
              (e.swapped ? ' <i class="fas fa-right-left text-indigo-500" title="Ca đã đổi"></i>' : '') +
              '</span>';
          }).join('') + '</div>' : '<p class="text-xs text-slate-500 italic">Chưa phân người trực.</p>') +
          '</div>';
      }).join('');

      host.innerHTML = header + '<div class="space-y-2">' + (rows || emptyBox('Không có ca trực nào trong kỳ này.')) + '</div>';
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được lịch trực.');
      fail(err);
    });
  }

  // =========================================================================
  //  BẢNG CÔNG CÁ NHÂN (mục VII, nhìn từ phía cán bộ)
  // =========================================================================

  function loadMyTimesheet() {
    var periodInput = el('ccSheetPeriod');
    if (!periodInput.value) periodInput.value = currentPeriod();
    var period = periodInput.value;
    el('ccSheetDays').innerHTML = spinner();
    el('ccSheetTotals').innerHTML = '';

    api('staff', { query: { view: 'my_timesheet', period: period } }).then(function (data) {
      var sheet = data.timesheet;
      var row = (sheet.rows || [])[0];
      if (!row) {
        el('ccSheetDays').innerHTML = emptyBox('Không có dữ liệu bảng công trong kỳ này.');
        return;
      }
      var t = row.totals;

      /* Công hành chính và công trực đứng ở hai thẻ riêng. Đây là quy tắc bắt
         buộc của mục VIII: một ca trực không tự trở thành ngày công hành chính. */
      var cards = [
        { label: 'Ngày công hành chính', value: fmtNum(t.adminDays), sub: fmtNum(t.adminHours) + ' giờ', tone: 'text-medical-700' },
        { label: 'Số ca trực', value: fmtNum(t.dutyShifts), sub: fmtNum(t.dutyHours) + ' giờ trực', tone: 'text-indigo-700' },
        { label: 'Ngày nghỉ phép', value: fmtNum(t.annualLeaveDays + t.otherLeaveDays), sub: 'Phép ' + fmtNum(t.annualLeaveDays) + ' / khác ' + fmtNum(t.otherLeaveDays), tone: 'text-amber-700' },
        { label: 'Đi muộn / về sớm', value: t.lateCount + ' / ' + t.earlyLeaveCount, sub: 'Thiếu lượt chấm: ' + t.missingCount + ' ngày', tone: 'text-slate-700' },
        { label: 'Ca trực ngày thường', value: fmtNum(t.dutyWeekday), sub: '', tone: 'text-slate-700' },
        { label: 'Ca trực cuối tuần', value: fmtNum(t.dutyWeekend), sub: '', tone: 'text-amber-700' },
        { label: 'Ca trực ngày lễ', value: fmtNum(t.dutyHoliday), sub: '', tone: 'text-red-700' },
        { label: 'Đã bấm nhận ca', value: fmtNum(t.dutyCheckedIn) + '/' + fmtNum(t.dutyShifts), sub: '', tone: 'text-emerald-700' }
      ];
      if (t.convertedAdminDays) {
        cards.push({
          label: 'Quy đổi từ ca trực', value: fmtNum(t.convertedAdminDays),
          sub: 'ngày công, theo quy định của Quản trị', tone: 'text-purple-700'
        });
      }
      el('ccSheetTotals').innerHTML = cards.map(function (c) {
        return '<div class="bg-white rounded-xl shadow-sm p-3">' +
          '<p class="text-[11px] text-slate-500 leading-tight">' + esc(c.label) + '</p>' +
          '<p class="text-xl font-black ' + c.tone + '">' + esc(c.value) + '</p>' +
          (c.sub ? '<p class="text-[11px] text-slate-500">' + esc(c.sub) + '</p>' : '') +
          '</div>';
      }).join('');

      el('ccSheetDays').innerHTML =
        '<div class="flex flex-wrap gap-3 text-[11px] text-slate-500 mb-2">' +
        '<span>Ký hiệu: <strong>' + esc(sheet.settings.symbols.present) + '</strong> có mặt, <strong>' +
        esc(sheet.settings.symbols.duty) + '</strong> trực, <strong>' + esc(sheet.settings.symbols.leave) + '</strong> nghỉ phép</span>' +
        (sheet.locked ? '<span class="text-amber-700 font-semibold">Kỳ đã khoá</span>' : '') +
        '</div>' +
        row.days.map(function (d) {
          return '<div class="flex items-center gap-3 px-3 py-2 rounded-lg ' + (DAY_TYPE_CLASS[d.dayType] || '') +
            ' border border-slate-200">' +
            '<span class="w-16 text-xs font-bold text-slate-700">' + esc(WEEKDAY_SHORT[num(d.weekday, 0)]) + ' ' + d.day + '</span>' +
            '<span class="w-14 text-center text-sm font-black text-medical-800">' + esc(d.symbol || '-') + '</span>' +
            '<span class="flex-1 text-xs text-slate-600">' +
            (d.firstIn ? 'Vào ' + esc(d.firstIn) : '') + (d.lastOut ? ' - Ra ' + esc(d.lastOut) : '') +
            (d.dutyNames && d.dutyNames.length ? ' <span class="text-indigo-700">| Trực: ' + esc(d.dutyNames.join(', ')) +
              (d.dutyCheckedIn ? '' : ' (chưa bấm nhận ca)') + '</span>' : '') +
            (d.leaveType ? ' <span class="text-amber-700">| Nghỉ: ' + esc(d.leaveType) + '</span>' : '') +
            (d.note ? ' <span class="text-slate-500">| ' + esc(d.note) + '</span>' : '') +
            '</span>' +
            '<span class="text-[11px] text-slate-500 text-right w-24">' +
            (d.adminHours ? fmtNum(d.adminHours) + ' giờ HC' : '') +
            (d.dutyHours ? '<br>' + fmtNum(d.dutyHours) + ' giờ trực' : '') +
            '</span></div>';
        }).join('');
    }).catch(function (err) {
      el('ccSheetDays').innerHTML = emptyBox(err.message || 'Không tải được bảng công.');
      fail(err);
    });
  }

  // =========================================================================
  //  YÊU CẦU VÀ ĐƠN NGHỈ PHÉP (mục XIV)
  // =========================================================================

  function loadMyRequests() {
    el('ccMyRequests').innerHTML = spinner();
    el('ccMyLeaves').innerHTML = '';
    api('staff', { query: { view: 'requests' } }).then(function (data) {
      var requests = data.requests || [];
      el('ccMyRequests').innerHTML = requests.length ? requests.map(function (r) {
        var detail = '';
        if (r.kind === 'ADJUST_PUNCH') {
          var punches = (r.payload && r.payload.punches) || [];
          detail = 'Ngày ' + fmtDateVN(r.targetDate) + ': ' + punches.map(function (p) {
            return (p.type === 'IN' ? 'vào ' : 'ra ') + p.time;
          }).join(', ');
        } else {
          detail = 'Ca ' + (r.shiftName || '') + ' ngày ' + fmtDateVN(r.targetDate) + ' → ' + (r.toEmployeeName || '');
        }
        return '<div class="border border-slate-200 rounded-xl p-3">' +
          '<div class="flex flex-wrap items-center gap-2 mb-1">' +
          '<span class="font-semibold text-sm text-slate-800">' + esc(KIND_LABEL[r.kind] || r.kind) + '</span>' +
          statusBadge(r.status) +
          '<span class="text-[11px] text-slate-400 ml-auto">' + esc(fmtTimestamp(r.createdAt)) + '</span></div>' +
          '<p class="text-xs text-slate-600">' + esc(detail) + '</p>' +
          '<p class="text-xs text-slate-500 mt-1">Lý do: ' + esc(r.reason) + '</p>' +
          (r.decidedByName ? '<p class="text-xs text-slate-500 mt-1">Người xử lý: ' + esc(r.decidedByName) +
            (r.decisionNote ? ' - ' + esc(r.decisionNote) : '') + '</p>' : '') +
          (r.status === 'PENDING' ? '<button type="button" data-cc-act="cancel-request" data-id="' + esc(r.id) +
            '" class="mt-2 text-xs text-red-600 hover:underline"><i class="fas fa-rotate-left mr-1"></i>Thu hồi yêu cầu</button>' : '') +
          '</div>';
      }).join('') : emptyBox('Bạn chưa gửi yêu cầu nào.');

      var leaves = data.leaves || [];
      el('ccMyLeaves').innerHTML = leaves.length ? leaves.map(function (l) {
        var typeName = leaveTypeName(l.leaveType);
        return '<div class="border border-slate-200 rounded-xl p-3">' +
          '<div class="flex flex-wrap items-center gap-2 mb-1">' +
          '<span class="font-semibold text-sm text-slate-800">' + esc(typeName) + '</span>' +
          statusBadge(l.status) +
          '<span class="text-[11px] text-slate-400 ml-auto">' + esc(fmtTimestamp(l.createdAt)) + '</span></div>' +
          '<p class="text-xs text-slate-600">Từ ' + esc(fmtDateVN(l.fromDate)) + ' đến ' + esc(fmtDateVN(l.toDate)) +
          ' - ' + esc(fmtNum(l.days)) + ' ngày' +
          (l.session !== 'FULL' ? ' (' + esc(l.session === 'MORNING' ? 'buổi sáng' : 'buổi chiều') + ')' : '') + '</p>' +
          '<p class="text-xs text-slate-500 mt-1">Lý do: ' + esc(l.reason) + '</p>' +
          (l.decidedByName ? '<p class="text-xs text-slate-500 mt-1">Người xử lý: ' + esc(l.decidedByName) +
            (l.decisionNote ? ' - ' + esc(l.decisionNote) : '') + '</p>' : '') +
          (l.status === 'PENDING' ? '<button type="button" data-cc-act="cancel-leave" data-id="' + esc(l.id) +
            '" class="mt-2 text-xs text-red-600 hover:underline"><i class="fas fa-rotate-left mr-1"></i>Thu hồi đơn</button>' : '') +
          '</div>';
      }).join('') : emptyBox('Bạn chưa gửi đơn nghỉ phép nào.');
    }).catch(function (err) {
      el('ccMyRequests').innerHTML = emptyBox(err.message || 'Không tải được danh sách yêu cầu.');
      fail(err);
    });
  }

  function cancelRequest(id) {
    confirmBox('Thu hồi yêu cầu này? Yêu cầu đã được duyệt thì không thu hồi được nữa.', function () {
      api('staff', { body: { action: 'cancel_request', id: id } }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        loadMyRequests();
      }).catch(fail);
    }, 'Thu hồi');
  }

  function cancelLeave(id) {
    confirmBox('Thu hồi đơn nghỉ này?', function () {
      api('staff', { body: { action: 'cancel_leave', id: id } }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        loadMyRequests();
      }).catch(fail);
    }, 'Thu hồi');
  }

  function leaveTypeName(code) {
    var types = (S.settings && S.settings.leaveTypes) || [];
    for (var i = 0; i < types.length; i += 1) {
      if (String(types[i].code).toUpperCase() === String(code).toUpperCase()) return types[i].name;
    }
    return code;
  }

  function openAdjustForm() {
    var today = S.today ? S.today.today : '';
    var html =
      '<p class="text-xs text-slate-500 mb-3">Dùng khi quên chấm công, chấm ngoài giờ hoặc thiết bị lỗi. Yêu cầu chỉ có hiệu lực sau khi Phụ trách bộ phận hoặc Quản trị duyệt; lượt chấm được ghi mới và giữ dấu vết của yêu cầu này.</p>' +
      field('Ngày cần điều chỉnh', input('targetDate', today, 'date', 'max="' + esc(today) + '"')) +
      '<div class="grid grid-cols-2 gap-3">' +
      field('Giờ vào buổi sáng', input('inMorning', '', 'time')) +
      field('Giờ ra buổi sáng', input('outMorning', '', 'time')) +
      field('Giờ vào buổi chiều', input('inAfternoon', '', 'time')) +
      field('Giờ ra buổi chiều', input('outAfternoon', '', 'time')) +
      '</div>' +
      field('Lý do', textarea('reason', '', 3), 'Tối thiểu 5 ký tự.') +
      submitRow('Gửi yêu cầu');

    openModal('Xin điều chỉnh chấm công', html, function () {
      var v = modalValues();
      var punches = [];
      if (v.inMorning) punches.push({ type: 'IN', time: v.inMorning });
      if (v.outMorning) punches.push({ type: 'OUT', time: v.outMorning });
      if (v.inAfternoon) punches.push({ type: 'IN', time: v.inAfternoon });
      if (v.outAfternoon) punches.push({ type: 'OUT', time: v.outAfternoon });
      if (!punches.length) return toast('Vui lòng nhập ít nhất một mốc giờ.', 'warn');
      api('staff', { body: { action: 'request_adjust', targetDate: v.targetDate, punches: punches, reason: v.reason } })
        .then(function (data) {
          closeModal();
          toast(data.message, 'success');
          if (S.view === 'requests') loadMyRequests();
        }).catch(fail);
    });
  }

  function openSwapForm() {
    var period = currentPeriod();
    openModal('Xin đổi ca trực', spinner('Đang tải ca trực của bạn...'), null);
    Promise.all([
      api('staff', { query: { view: 'duty_schedule', period: period } }),
      api('staff', { query: { view: 'duty_schedule', period: shiftPeriod(period, 1) } })
    ]).then(function (results) {
      var myId = S.me && S.me.employee ? S.me.employee.id : '';
      var today = S.today ? S.today.today : '';
      var mine = [];
      var peers = {};
      results.forEach(function (data) {
        (data.days || []).forEach(function (day) {
          (day.entries || []).forEach(function (e) {
            if (e.employeeId === myId) {
              if (day.date >= today) {
                mine.push({
                  value: e.assignmentId,
                  label: fmtDateVN(day.date) + ' - ' + e.shiftName + ' (' + e.startTime + '-' + e.endTime + ')'
                });
              }
            } else {
              peers[e.employeeId] = e.employeeName;
            }
          });
        });
      });
      if (!mine.length) {
        el('ccModalBody').innerHTML = emptyBox('Bạn không có ca trực nào từ hôm nay trở đi để đổi.') +
          submitRow('Đóng').replace('data-cc-act="modal-submit"', 'data-cc-act="modal-cancel"');
        return;
      }
      /* Danh sách người nhận ca lấy từ cán bộ đang có mặt trên lịch trực - đó
         là những người quen việc trực, và giao diện không cần quyền đọc toàn bộ
         danh sách nhân sự. */
      var peerOptions = [{ value: '', label: '-- Chọn người nhận ca --' }].concat(
        Object.keys(peers).map(function (id) { return { value: id, label: peers[id] }; })
          .sort(function (a, b) { return a.label.localeCompare(b.label, 'vi'); })
      );

      el('ccModalBody').innerHTML =
        '<p class="text-xs text-slate-500 mb-3">Sau khi được duyệt, suất trực sẽ chuyển sang người nhận ca và lịch trực tháng cập nhật ngay.</p>' +
        field('Ca trực của bạn', select('assignmentId', mine, mine[0].value)) +
        field('Người nhận ca', select('toEmployeeId', peerOptions, '')) +
        field('Lý do đổi ca', textarea('reason', '', 3), 'Tối thiểu 5 ký tự.') +
        submitRow('Gửi yêu cầu');

      modalSubmit = function () {
        var v = modalValues();
        if (!v.toEmployeeId) return toast('Vui lòng chọn người nhận ca.', 'warn');
        api('staff', {
          body: {
            action: 'request_swap', assignmentId: v.assignmentId,
            toEmployeeId: v.toEmployeeId, reason: v.reason
          }
        }).then(function (data) {
          closeModal();
          toast(data.message, 'success');
          if (S.view === 'requests') loadMyRequests();
        }).catch(fail);
      };
    }).catch(function (err) {
      el('ccModalBody').innerHTML = emptyBox(err.message || 'Không tải được ca trực.');
    });
  }

  function openLeaveForm() {
    var types = (S.settings && S.settings.leaveTypes) || [];
    if (!types.length) {
      return toast('Trạm chưa khai báo loại nghỉ phép nào. Quản trị cần thêm trong mục Quản trị → Loại nghỉ phép.', 'warn');
    }
    var today = S.today ? S.today.today : '';
    var html =
      field('Loại nghỉ', select('leaveType', types.map(function (t) {
        return { value: t.code, label: t.name + ' (' + t.symbol + ')' };
      }), types[0].code)) +
      '<div class="grid grid-cols-2 gap-3">' +
      field('Từ ngày', input('fromDate', today, 'date')) +
      field('Đến ngày', input('toDate', today, 'date')) +
      '</div>' +
      field('Thời lượng', select('session', [
        { value: 'FULL', label: 'Cả ngày' },
        { value: 'MORNING', label: 'Nửa ngày - buổi sáng' },
        { value: 'AFTERNOON', label: 'Nửa ngày - buổi chiều' }
      ], 'FULL'), 'Nghỉ nửa ngày chỉ áp dụng cho một ngày duy nhất.') +
      field('Lý do', textarea('reason', '', 3), 'Tối thiểu 5 ký tự.') +
      submitRow('Gửi đơn');

    openModal('Gửi đơn nghỉ phép', html, function () {
      var v = modalValues();
      api('staff', {
        body: {
          action: 'submit_leave', leaveType: v.leaveType, fromDate: v.fromDate,
          toDate: v.toDate, session: v.session, reason: v.reason
        }
      }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        if (S.view === 'requests') loadMyRequests();
      }).catch(fail);
    });
  }

  // =========================================================================
  //  THÔNG BÁO
  // =========================================================================

  function loadNotifications() {
    el('ccNotifyList').innerHTML = spinner();
    api('staff', { query: { view: 'notifications' } }).then(function (data) {
      var rows = data.notifications || [];
      el('ccNotifyList').innerHTML = rows.length ? rows.map(function (n) {
        var tone = { INFO: 'fa-circle-info text-medical-600', APPROVAL: 'fa-clipboard-check text-amber-600', ALERT: 'fa-triangle-exclamation text-red-600' };
        return '<div class="bg-white rounded-xl shadow-sm p-4 flex gap-3 ' + (n.read ? 'opacity-70' : '') + '">' +
          '<i class="fas ' + (tone[n.kind] || tone.INFO) + ' mt-1"></i>' +
          '<div class="flex-1 min-w-0">' +
          '<p class="font-semibold text-sm text-slate-800">' + esc(n.title) + '</p>' +
          '<p class="text-xs text-slate-600 mt-0.5">' + esc(n.body) + '</p>' +
          '<p class="text-[11px] text-slate-400 mt-1">' + esc(fmtTimestamp(n.ts)) + '</p></div>' +
          (n.read ? '' : '<span class="w-2 h-2 rounded-full bg-red-500 mt-2"></span>') +
          '</div>';
      }).join('') : emptyBox('Chưa có thông báo nào.');
    }).catch(function (err) {
      el('ccNotifyList').innerHTML = emptyBox(err.message || 'Không tải được thông báo.');
      fail(err);
    });
  }

  function markNotificationsRead() {
    api('staff', { body: { action: 'read_notifications' } }).then(function () {
      S.counters.unreadNotifications = 0;
      renderNotifyBadge();
      renderNav();
      loadNotifications();
      toast('Đã đánh dấu đã đọc.', 'success');
    }).catch(fail);
  }

  // =========================================================================
  //  ĐIỀU HÀNH BỘ PHẬN (nhóm người dùng thứ hai)
  // =========================================================================

  function loadOverview() {
    el('ccManageTable').innerHTML = spinner();
    api('admin', { query: { view: 'overview' } }).then(function (data) {
      var s = data.summary;
      var cards = [
        { label: 'Tổng cán bộ trong tầm quản lý', value: s.total, tone: 'text-slate-800' },
        { label: 'Đã chấm công hôm nay', value: s.punched, tone: 'text-emerald-700' },
        { label: 'Chưa chấm công', value: s.notPunched, tone: 'text-red-700' },
        { label: 'Đi muộn', value: s.late, tone: 'text-amber-700' },
        { label: 'Đang nghỉ phép', value: s.onLeave, tone: 'text-amber-700' },
        { label: 'Có ca trực hôm nay', value: s.onDuty, tone: 'text-indigo-700' },
        { label: 'Đã bấm nhận ca', value: s.dutyCheckedIn, tone: 'text-indigo-700' },
        { label: 'Việc chờ duyệt', value: s.pendingRequests + s.pendingLeaves, tone: 'text-medical-700' }
      ];
      el('ccManageSummary').innerHTML =
        '<div class="col-span-2 md:col-span-4 bg-white rounded-xl shadow-sm p-4 flex flex-wrap items-center gap-3">' +
        '<span class="font-bold text-slate-800">Hôm nay ' + esc(fmtDateVN(data.today)) + '</span>' +
        badge(WEEKDAY_NAMES[num(data.weekday, 0)], 'bg-slate-100 text-slate-700') +
        badge(DAY_TYPE_LABEL[data.dayType] || data.dayType, data.dayType === 'WEEKDAY' ? 'bg-medical-100 text-medical-800' : 'bg-amber-100 text-amber-800') +
        (data.holidayName ? badge(data.holidayName, 'bg-red-100 text-red-800') : '') +
        (data.expectAdminWork ? '' : badge('Không tính công hành chính', 'bg-slate-100 text-slate-600')) +
        (data.locked ? badge('Kỳ đã khoá', 'bg-slate-800 text-white') : '') +
        '</div>' +
        cards.map(function (c) {
          return '<div class="bg-white rounded-xl shadow-sm p-3">' +
            '<p class="text-[11px] text-slate-500 leading-tight">' + esc(c.label) + '</p>' +
            '<p class="text-2xl font-black ' + c.tone + '">' + esc(String(c.value)) + '</p></div>';
        }).join('');

      var rows = data.rows || [];
      var notPunched = data.notPunched || [];
      var notPunchedHtml = notPunched.length
        ? '<div class="mb-4 p-3 rounded-xl bg-red-50 border border-red-200">' +
          '<p class="text-sm font-bold text-red-800 mb-1"><i class="fas fa-user-clock mr-1"></i>Chưa chấm công hôm nay (' + notPunched.length + ' người)</p>' +
          '<p class="text-xs text-red-700">' + notPunched.map(function (r) {
            return esc(r.fullName) + (r.onDuty ? ' (có ca trực)' : '');
          }).join(', ') + '</p></div>'
        : (data.expectAdminWork
          ? '<div class="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">' +
            '<i class="fas fa-circle-check mr-1"></i>Toàn bộ cán bộ trong tầm quản lý đã chấm công.</div>'
          : '');

      el('ccManageTable').innerHTML = notPunchedHtml + (rows.length
        ? '<table class="w-full text-sm min-w-[720px]"><thead><tr class="bg-slate-50 text-slate-600 text-xs uppercase">' +
          '<th class="px-2 py-2 text-left">Mã</th><th class="px-2 py-2 text-left">Họ và tên</th>' +
          '<th class="px-2 py-2 text-left">Bộ phận</th><th class="px-2 py-2">Giờ vào</th>' +
          '<th class="px-2 py-2">Giờ ra</th><th class="px-2 py-2 text-left">Tình trạng</th>' +
          '<th class="px-2 py-2">Thao tác</th></tr></thead><tbody>' +
          rows.map(function (r) {
            var tags = [];
            if (!r.punched) tags.push(badge('Chưa chấm', 'bg-red-100 text-red-800'));
            if (r.late) tags.push(badge('Đi muộn', 'bg-amber-100 text-amber-800'));
            if (r.earlyLeave) tags.push(badge('Về sớm', 'bg-amber-100 text-amber-800'));
            if (r.onLeave) tags.push(badge('Nghỉ phép', 'bg-slate-100 text-slate-700'));
            if (r.onDuty) tags.push(badge(r.dutyCheckedIn ? 'Đang trực' : 'Có ca trực', 'bg-indigo-100 text-indigo-800'));
            if (!tags.length) tags.push(badge('Bình thường', 'bg-emerald-100 text-emerald-800'));
            return '<tr class="border-t border-slate-100">' +
              '<td class="px-2 py-2 text-xs text-slate-500">' + esc(r.code) + '</td>' +
              '<td class="px-2 py-2 font-medium text-slate-800">' + esc(r.fullName) +
              (r.position ? '<span class="block text-[11px] text-slate-400">' + esc(r.position) + '</span>' : '') + '</td>' +
              '<td class="px-2 py-2 text-xs text-slate-600">' + esc(r.departmentName) + '</td>' +
              '<td class="px-2 py-2 text-center tabular-nums">' + esc(r.firstIn || '—') + '</td>' +
              '<td class="px-2 py-2 text-center tabular-nums">' + esc(r.lastOut || '—') + '</td>' +
              '<td class="px-2 py-2"><div class="flex flex-wrap gap-1">' + tags.join(' ') + '</div></td>' +
              '<td class="px-2 py-2 text-center">' +
              '<button type="button" data-cc-act="employee-detail" data-id="' + esc(r.employeeId) +
              '" class="text-xs text-medical-600 hover:underline">Xem chi tiết</button></td></tr>';
          }).join('') + '</tbody></table>'
        : emptyBox('Không có cán bộ nào trong tầm quản lý.'));
    }).catch(function (err) {
      el('ccManageTable').innerHTML = emptyBox(err.message || 'Không tải được số liệu điều hành.');
      fail(err);
    });
  }

  function loadApprovals() {
    var status = el('ccApprovalStatus').value;
    el('ccApprovalList').innerHTML = spinner();
    api('admin', { query: { view: 'approvals', status: status } }).then(function (data) {
      var html = '';
      (data.requests || []).forEach(function (r) {
        var detail;
        if (r.kind === 'ADJUST_PUNCH') {
          var punches = (r.payload && r.payload.punches) || [];
          detail = 'Ngày ' + fmtDateVN(r.targetDate) + ': ' + punches.map(function (p) {
            return (p.type === 'IN' ? 'vào ' : 'ra ') + p.time;
          }).join(', ');
        } else {
          detail = 'Ca ' + (r.shiftName || '') + ' ngày ' + fmtDateVN(r.targetDate) + ' chuyển cho ' + (r.toEmployeeName || '');
        }
        html += approvalCard({
          kind: KIND_LABEL[r.kind] || r.kind, who: r.employeeName + ' (' + r.employeeCode + ')',
          detail: detail, reason: r.reason, status: r.status, createdAt: r.createdAt,
          decidedByName: r.decidedByName, decisionNote: r.decisionNote,
          act: 'decide-request', id: r.id
        });
      });
      (data.leaves || []).forEach(function (l) {
        html += approvalCard({
          kind: 'Đơn nghỉ: ' + (l.leaveTypeName || l.leaveType),
          who: l.employeeName + ' (' + l.employeeCode + ')',
          detail: 'Từ ' + fmtDateVN(l.fromDate) + ' đến ' + fmtDateVN(l.toDate) + ' - ' + fmtNum(l.days) + ' ngày' +
            (l.session !== 'FULL' ? ' (' + (l.session === 'MORNING' ? 'buổi sáng' : 'buổi chiều') + ')' : ''),
          reason: l.reason, status: l.status, createdAt: l.createdAt,
          decidedByName: l.decidedByName, decisionNote: l.decisionNote,
          act: 'decide-leave', id: l.id
        });
      });
      el('ccApprovalList').innerHTML = html || emptyBox('Không có việc nào ở trạng thái này.');
    }).catch(function (err) {
      el('ccApprovalList').innerHTML = emptyBox(err.message || 'Không tải được danh sách chờ duyệt.');
      fail(err);
    });
  }

  function approvalCard(item) {
    var actions = item.status === 'PENDING'
      ? '<div class="flex flex-wrap gap-2 mt-2">' +
        '<button type="button" data-cc-act="' + item.act + '" data-id="' + esc(item.id) + '" data-decision="APPROVE" ' +
        'class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold">' +
        '<i class="fas fa-check mr-1"></i>Duyệt</button>' +
        '<button type="button" data-cc-act="' + item.act + '" data-id="' + esc(item.id) + '" data-decision="REJECT" ' +
        'class="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-bold">' +
        '<i class="fas fa-xmark mr-1"></i>Từ chối</button></div>'
      : '';
    return '<div class="border border-slate-200 rounded-xl p-3">' +
      '<div class="flex flex-wrap items-center gap-2 mb-1">' +
      '<span class="font-semibold text-sm text-slate-800">' + esc(item.kind) + '</span>' +
      statusBadge(item.status) +
      '<span class="text-[11px] text-slate-400 ml-auto">' + esc(fmtTimestamp(item.createdAt)) + '</span></div>' +
      '<p class="text-xs text-slate-700 font-medium">' + esc(item.who) + '</p>' +
      '<p class="text-xs text-slate-600">' + esc(item.detail) + '</p>' +
      '<p class="text-xs text-slate-500 mt-1">Lý do: ' + esc(item.reason) + '</p>' +
      (item.decidedByName ? '<p class="text-xs text-slate-500">Người xử lý: ' + esc(item.decidedByName) +
        (item.decisionNote ? ' - ' + esc(item.decisionNote) : '') + '</p>' : '') +
      actions + '</div>';
  }

  function decide(act, id, decision) {
    var isReject = decision === 'REJECT';
    var label = isReject ? 'Từ chối' : 'Duyệt';
    openModal(label + (act === 'decide-leave' ? ' đơn nghỉ phép' : ' yêu cầu'),
      '<p class="text-sm text-slate-600 mb-3">' +
      (isReject ? 'Nêu rõ lý do từ chối để cán bộ biết cần bổ sung gì.'
        : 'Sau khi duyệt, dữ liệu bảng công được cập nhật ngay và thao tác này được ghi vào lịch sử.') + '</p>' +
      field('Ghi chú xử lý', textarea('note', '', 2), isReject ? 'Nên ghi lý do từ chối.' : 'Không bắt buộc.') +
      submitRow(label),
      function () {
        var v = modalValues();
        api('admin', {
          body: {
            action: act === 'decide-leave' ? 'decide_leave' : 'decide_request',
            id: id, decision: decision, note: v.note
          }
        }).then(function (data) {
          closeModal();
          toast(data.message, 'success');
          loadApprovals();
          if (S.view === 'manage') loadOverview();
        }).catch(fail);
      });
  }

  /** Chi tiết từng lượt chấm của một cán bộ trong kỳ - dùng khi đối chiếu. */
  function openEmployeeDetail(employeeId, period) {
    var wanted = period || currentPeriod();
    // Ghi lại ngữ cảnh để các nút bên trong hộp thoại biết phải tải lại kỳ nào.
    S.detail = { employeeId: employeeId, period: wanted };
    openModal('Chi tiết chấm công', spinner(), null);
    api('reports', { query: { view: 'detail', period: wanted, employeeId: employeeId } }).then(function (data) {
      var html = '<div class="flex flex-wrap items-center gap-2 mb-3">' +
        '<p class="font-bold text-slate-800">' + esc(data.employee.fullName) + '</p>' +
        '<span class="text-xs text-slate-500">' + esc(data.employee.code) + ' - ' + esc(data.employee.position) + '</span>' +
        '<span class="ml-auto flex items-center gap-1">' +
        '<button type="button" data-cc-act="detail-period" data-id="' + esc(employeeId) + '" data-period="' + esc(shiftPeriod(wanted, -1)) +
        '" class="px-2 py-1 bg-slate-100 rounded text-xs">&laquo;</button>' +
        '<span class="text-xs font-semibold">' + esc(data.periodLabel) + '</span>' +
        '<button type="button" data-cc-act="detail-period" data-id="' + esc(employeeId) + '" data-period="' + esc(shiftPeriod(wanted, 1)) +
        '" class="px-2 py-1 bg-slate-100 rounded text-xs">&raquo;</button></span></div>';

      html += '<h4 class="font-bold text-sm text-slate-700 mb-2">Lượt chấm công hành chính</h4>';
      html += (data.punches || []).length
        ? '<div class="overflow-x-auto mb-4"><table class="w-full text-xs min-w-[520px]">' +
          '<thead><tr class="bg-slate-50 text-slate-500"><th class="px-2 py-1 text-left">Ngày</th><th class="px-2 py-1">Loại</th>' +
          '<th class="px-2 py-1">Giờ</th><th class="px-2 py-1">Buổi</th><th class="px-2 py-1">Tình trạng</th>' +
          '<th class="px-2 py-1">Nguồn</th><th class="px-2 py-1"></th></tr></thead><tbody>' +
          data.punches.map(function (p) {
            return '<tr class="border-t border-slate-100">' +
              '<td class="px-2 py-1">' + esc(fmtDateVN(p.workDate)) + '</td>' +
              '<td class="px-2 py-1 text-center">' + (p.punchType === 'IN' ? 'Vào' : 'Ra') + '</td>' +
              '<td class="px-2 py-1 text-center tabular-nums font-semibold">' + esc(p.time) + '</td>' +
              '<td class="px-2 py-1 text-center">' + (p.session === 'MORNING' ? 'Sáng' : p.session === 'AFTERNOON' ? 'Chiều' : '—') + '</td>' +
              '<td class="px-2 py-1 text-center">' + esc({ ON_TIME: 'Đúng giờ', LATE: 'Muộn', EARLY_LEAVE: 'Về sớm', OUTSIDE: 'Ngoài giờ' }[p.status] || p.status) + '</td>' +
              '<td class="px-2 py-1 text-center">' + esc({ SELF: 'Tự bấm', ADMIN: 'Quản trị', REQUEST: 'Duyệt đơn' }[p.source] || p.source) + '</td>' +
              '<td class="px-2 py-1 text-center">' +
              (S.role === 'ADMIN' ? '<button type="button" data-cc-act="punch-delete" data-id="' + esc(p.id) +
                '" class="text-red-600 hover:underline">Xoá</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : emptyBox('Không có lượt chấm công nào trong kỳ.');

      html += '<h4 class="font-bold text-sm text-slate-700 mb-2">Ca trực</h4>';
      html += (data.duties || []).length
        ? '<div class="overflow-x-auto mb-4"><table class="w-full text-xs min-w-[520px]">' +
          '<thead><tr class="bg-slate-50 text-slate-500"><th class="px-2 py-1 text-left">Ngày</th><th class="px-2 py-1 text-left">Ca</th>' +
          '<th class="px-2 py-1">Loại ngày</th><th class="px-2 py-1">Nhận ca</th><th class="px-2 py-1">Kết ca</th>' +
          '<th class="px-2 py-1">Giờ</th><th class="px-2 py-1">Trạng thái</th></tr></thead><tbody>' +
          data.duties.map(function (d) {
            return '<tr class="border-t border-slate-100">' +
              '<td class="px-2 py-1">' + esc(fmtDateVN(d.dutyDate)) + '</td>' +
              '<td class="px-2 py-1">' + esc(d.shiftName) + '</td>' +
              '<td class="px-2 py-1 text-center">' + esc(DAY_TYPE_LABEL[d.dayType] || d.dayType) + '</td>' +
              '<td class="px-2 py-1 text-center tabular-nums">' + esc(d.checkIn || '—') + '</td>' +
              '<td class="px-2 py-1 text-center tabular-nums">' + esc(d.checkOut || '—') + '</td>' +
              '<td class="px-2 py-1 text-center">' + esc(fmtNum(d.hours)) + '</td>' +
              '<td class="px-2 py-1 text-center">' + esc(d.status === 'CANCELLED' ? 'Đã huỷ' : d.checkIn ? 'Đã nhận ca' : 'Chưa nhận ca') + '</td>' +
              '</tr>';
          }).join('') + '</tbody></table></div>'
        : emptyBox('Không có ca trực nào trong kỳ.');

      html += '<h4 class="font-bold text-sm text-slate-700 mb-2">Nghỉ phép</h4>';
      html += (data.leaves || []).length
        ? '<div class="space-y-1 mb-2">' + data.leaves.map(function (l) {
          return '<p class="text-xs text-slate-600">' + esc(leaveTypeName(l.leaveType)) + ': ' +
            esc(fmtDateVN(l.fromDate)) + ' - ' + esc(fmtDateVN(l.toDate)) + ' (' + esc(fmtNum(l.days)) + ' ngày) ' +
            statusBadge(l.status) + '</p>';
        }).join('') + '</div>'
        : emptyBox('Không có đơn nghỉ nào trong kỳ.');

      if (S.role === 'ADMIN' || S.role === 'MANAGER') {
        html += '<div class="flex flex-wrap gap-2 pt-3 border-t border-slate-200 mt-3">' +
          '<button type="button" data-cc-act="punch-add" data-id="' + esc(employeeId) + '" data-period="' + esc(wanted) +
          '" class="px-3 py-1.5 bg-medical-600 text-white rounded-lg text-xs font-semibold">Bổ sung lượt chấm</button>' +
          '<button type="button" data-cc-act="leave-add" data-id="' + esc(employeeId) +
          '" class="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-semibold">Ghi nhận nghỉ phép</button>' +
          '<button type="button" data-cc-act="modal-cancel" class="px-3 py-1.5 bg-slate-100 rounded-lg text-xs">Đóng</button></div>';
      }
      el('ccModalBody').innerHTML = html;
    }).catch(function (err) {
      el('ccModalBody').innerHTML = emptyBox(err.message || 'Không xem được chi tiết.');
    });
  }

  /** Bổ sung / sửa một lượt chấm công (Quản trị và Phụ trách). */
  function openPunchForm(employeeId, period) {
    var defaultDate = (period || currentPeriod()) + '-01';
    if (S.today && periodOfDate(S.today.today) === (period || currentPeriod())) defaultDate = S.today.today;
    var html =
      '<p class="text-xs text-slate-500 mb-3">Lượt chấm do Quản trị nhập được ghi nguồn riêng (ADMIN) và lưu vào lịch sử thao tác, để sau này đối chiếu được ai đã thêm số liệu này.</p>' +
      field('Ngày làm việc', input('workDate', defaultDate, 'date')) +
      '<div class="grid grid-cols-2 gap-3">' +
      field('Loại', select('punchType', [{ value: 'IN', label: 'Chấm vào' }, { value: 'OUT', label: 'Chấm ra' }], 'IN')) +
      field('Giờ (HH:MM)', input('time', '07:30', 'time')) +
      '</div>' +
      field('Ghi chú', input('note', '', 'text')) +
      submitRow('Lưu lượt chấm');
    openModal('Bổ sung lượt chấm công', html, function () {
      var v = modalValues();
      api('admin', {
        body: {
          action: 'punch_save', employeeId: employeeId, workDate: v.workDate,
          punchType: v.punchType, time: v.time, note: v.note
        }
      }).then(function (data) {
        toast(data.message, 'success');
        openEmployeeDetail(employeeId, period);
      }).catch(fail);
    });
  }

  function openLeaveAdminForm(employeeId) {
    var types = (S.settings && S.settings.leaveTypes) || [];
    var today = S.today ? S.today.today : '';
    var html =
      '<p class="text-xs text-slate-500 mb-3">Đơn do Quản trị ghi nhận được duyệt luôn và thể hiện ngay trên bảng công.</p>' +
      field('Loại nghỉ', select('leaveType', types.map(function (t) {
        return { value: t.code, label: t.name };
      }), types.length ? types[0].code : '')) +
      '<div class="grid grid-cols-2 gap-3">' +
      field('Từ ngày', input('fromDate', today, 'date')) +
      field('Đến ngày', input('toDate', today, 'date')) + '</div>' +
      field('Thời lượng', select('session', [
        { value: 'FULL', label: 'Cả ngày' },
        { value: 'MORNING', label: 'Nửa ngày - sáng' },
        { value: 'AFTERNOON', label: 'Nửa ngày - chiều' }
      ], 'FULL')) +
      field('Lý do', textarea('reason', '', 2)) +
      submitRow('Ghi nhận');
    openModal('Ghi nhận nghỉ phép', html, function () {
      var v = modalValues();
      api('admin', {
        body: {
          action: 'leave_save', employeeId: employeeId, leaveType: v.leaveType,
          fromDate: v.fromDate, toDate: v.toDate, session: v.session, reason: v.reason
        }
      }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        if (S.view === 'manage') loadOverview();
      }).catch(fail);
    });
  }

  // =========================================================================
  //  QUẢN TRỊ HỆ THỐNG (nhóm người dùng thứ ba)
  // =========================================================================

  var ADMIN_TABS = [
    { key: 'employees', label: 'Cán bộ', icon: 'fa-users' },
    { key: 'departments', label: 'Bộ phận', icon: 'fa-sitemap' },
    { key: 'accounts', label: 'Tài khoản', icon: 'fa-id-badge' },
    { key: 'worktime', label: 'Thời gian làm việc', icon: 'fa-clock' },
    { key: 'shifts', label: 'Ca trực', icon: 'fa-user-nurse' },
    { key: 'holidays', label: 'Ngày nghỉ, lễ', icon: 'fa-calendar-xmark' },
    { key: 'symbols', label: 'Ký hiệu & loại nghỉ', icon: 'fa-hashtag' },
    { key: 'roster', label: 'Lịch trực tháng', icon: 'fa-calendar-plus' },
    { key: 'periods', label: 'Khoá bảng công', icon: 'fa-lock' },
    { key: 'audits', label: 'Lịch sử thao tác', icon: 'fa-clock-rotate-left' }
  ];

  function renderAdmin() {
    el('ccAdminTabs').innerHTML = ADMIN_TABS.map(function (t) {
      return '<button type="button" data-cc-tab="' + t.key + '" class="px-3 py-2 rounded-xl text-xs md:text-sm font-semibold transition ' +
        (S.adminTab === t.key ? 'bg-medical-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100') + '">' +
        '<i class="fas ' + t.icon + ' mr-1"></i>' + esc(t.label) + '</button>';
    }).join('');
    var body = el('ccAdminBody');
    body.innerHTML = spinner();
    var loader = ADMIN_LOADERS[S.adminTab];
    if (loader) loader(body);
  }

  function adminCard(title, actionsHtml, bodyHtml) {
    return '<div class="bg-white rounded-2xl shadow-sm p-4">' +
      '<div class="flex flex-wrap items-center gap-2 mb-3">' +
      '<h2 class="font-bold text-slate-700 text-sm flex-1">' + esc(title) + '</h2>' +
      (actionsHtml || '') + '</div>' + bodyHtml + '</div>';
  }

  function tableWrap(headers, rowsHtml, minWidth) {
    if (!rowsHtml) return emptyBox('Chưa có dữ liệu.');
    return '<div class="overflow-x-auto"><table class="w-full text-sm" style="min-width:' + (minWidth || 640) + 'px">' +
      '<thead><tr class="bg-slate-50 text-slate-500 text-xs uppercase">' +
      headers.map(function (h) { return '<th class="px-2 py-2 ' + (h.align || 'text-left') + '">' + esc(h.label) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
  }

  function rowActions(editAct, deleteAct, id, extraHtml) {
    return '<td class="px-2 py-2 text-right whitespace-nowrap">' + (extraHtml || '') +
      '<button type="button" data-cc-act="' + editAct + '" data-id="' + esc(id) +
      '" class="px-2 py-1 text-medical-600 hover:underline text-xs">Sửa</button>' +
      (deleteAct ? '<button type="button" data-cc-act="' + deleteAct + '" data-id="' + esc(id) +
        '" class="px-2 py-1 text-red-600 hover:underline text-xs">Xoá</button>' : '') + '</td>';
  }

  // --- Cán bộ ---------------------------------------------------------------

  function loadAdminEmployees(host) {
    Promise.all([
      api('admin', { query: { view: 'employees' } }),
      api('admin', { query: { view: 'departments' } })
    ]).then(function (res) {
      S.employees = res[0].employees || [];
      S.departments = res[1].departments || [];
      var rows = S.employees.map(function (e) {
        return '<tr class="border-t border-slate-100' + (e.status === 'INACTIVE' ? ' opacity-60' : '') + '">' +
          '<td class="px-2 py-2 text-xs text-slate-500">' + esc(e.code) + '</td>' +
          '<td class="px-2 py-2 font-medium text-slate-800">' + esc(e.fullName) +
          (e.status === 'INACTIVE' ? ' ' + badge('Ngừng', 'bg-slate-200 text-slate-600') : '') + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(e.position) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(e.departmentName) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(ROLE_LABEL[e.attendanceRole] || e.attendanceRole) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + (e.hasAccount
            ? esc(e.username) + (e.accountAccess === 'true' ? '' : ' ' + badge('Chưa cấp quyền', 'bg-amber-100 text-amber-800'))
            : '<span class="text-slate-400 italic">chưa có</span>') + '</td>' +
          rowActions('emp-edit', 'emp-delete', e.id,
            e.hasAccount
              ? '<button type="button" data-cc-act="emp-unlink" data-id="' + esc(e.id) + '" class="px-2 py-1 text-slate-500 hover:underline text-xs">Bỏ gán</button>'
              : '<button type="button" data-cc-act="emp-account" data-id="' + esc(e.id) + '" class="px-2 py-1 text-indigo-600 hover:underline text-xs">Tạo tài khoản</button>') +
          '</tr>';
      }).join('');
      host.innerHTML = adminCard('Danh sách cán bộ (' + S.employees.length + ')',
        '<button type="button" data-cc-act="emp-new" class="px-3 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-xs font-semibold">' +
        '<i class="fas fa-plus mr-1"></i>Thêm cán bộ</button>',
        tableWrap([
          { label: 'Mã' }, { label: 'Họ và tên' }, { label: 'Chức vụ' }, { label: 'Bộ phận' },
          { label: 'Vai trò' }, { label: 'Tài khoản' }, { label: '', align: 'text-right' }
        ], rows, 820) +
        '<p class="text-[11px] text-slate-400 mt-3">Cán bộ đã có dữ liệu chấm công sẽ được chuyển sang trạng thái Ngừng thay vì xoá hẳn, để bảng công của các tháng trước không bị mất người.</p>');
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được danh sách cán bộ.');
      fail(err);
    });
  }

  function openEmployeeForm(id) {
    var e = S.employees.filter(function (x) { return x.id === id; })[0] || {};
    var deptOptions = [{ value: '', label: '-- Không thuộc bộ phận nào --' }].concat(
      S.departments.map(function (d) { return { value: d.id, label: d.name }; })
    );
    var html =
      '<div class="grid md:grid-cols-2 gap-3">' +
      field('Mã cán bộ', input('code', e.code || '', 'text', 'required'), 'Ví dụ: CB01. Không trùng nhau.') +
      field('Họ và tên', input('fullName', e.fullName || '', 'text', 'required')) +
      field('Chức vụ', input('position', e.position || '')) +
      field('Bộ phận', select('departmentId', deptOptions, e.departmentId || '')) +
      field('Vai trò trong phân hệ', select('attendanceRole', [
        { value: 'STAFF', label: 'Cán bộ / nhân viên' },
        { value: 'MANAGER', label: 'Phụ trách khoa / bộ phận' },
        { value: 'ADMIN', label: 'Quản trị hệ thống chấm công' }
      ], e.attendanceRole || 'STAFF')) +
      field('Ngày bắt đầu làm việc', input('startDate', e.startDate || '', 'date'), 'Người vào làm sau kỳ báo cáo sẽ không xuất hiện trên bảng công kỳ đó.') +
      field('Số điện thoại', input('phone', e.phone || '')) +
      field('Thư điện tử', input('email', e.email || '', 'email')) +
      field('Thứ tự hiển thị', input('displayOrder', e.displayOrder || 0, 'number')) +
      field('Trạng thái', select('status', [
        { value: 'ACTIVE', label: 'Đang làm việc' }, { value: 'INACTIVE', label: 'Ngừng làm việc' }
      ], e.status || 'ACTIVE')) +
      '</div>' +
      field('Ghi chú', textarea('note', e.note || '', 2)) +
      submitRow(id ? 'Lưu thay đổi' : 'Thêm cán bộ');

    openModal(id ? 'Sửa hồ sơ cán bộ' : 'Thêm cán bộ', html, function () {
      var v = modalValues();
      v.action = 'employee_save';
      if (id) v.id = id;
      api('admin', { body: v }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        renderAdmin();
      }).catch(fail);
    });
  }

  function openCreateAccountForm(employeeId) {
    var e = S.employees.filter(function (x) { return x.id === employeeId; })[0] || {};
    var suggestion = String(e.code || '').toLowerCase();
    var html =
      '<p class="text-sm text-slate-600 mb-3">Tạo tài khoản đăng nhập cho <strong>' + esc(e.fullName) + '</strong>. ' +
      'Tài khoản được cấp quyền vào phân hệ Chấm công và bắt buộc đổi mật khẩu ở lần đăng nhập đầu.</p>' +
      field('Tên đăng nhập', input('username', suggestion, 'text', 'required'), 'Ít nhất 4 ký tự, không dấu cách.') +
      field('Mật khẩu tạm', input('password', '', 'text'), 'Để trống thì hệ thống tự sinh mật khẩu tạm và hiện ra sau khi tạo.') +
      submitRow('Tạo tài khoản');
    openModal('Tạo tài khoản đăng nhập', html, function () {
      var v = modalValues();
      api('admin', {
        body: { action: 'account_create', employeeId: employeeId, username: v.username, password: v.password }
      }).then(function (data) {
        closeModal();
        showTemporaryPassword(data.message, data.temporaryPassword, v.username);
        renderAdmin();
      }).catch(fail);
    });
  }

  function showTemporaryPassword(message, password, username) {
    if (!password) { toast(message, 'success'); return; }
    openModal('Mật khẩu tạm', '<p class="text-sm text-slate-700 mb-3">' + esc(message) + '</p>' +
      '<div class="bg-slate-900 text-white rounded-xl p-4 text-center">' +
      (username ? '<p class="text-xs text-slate-300">Tên đăng nhập</p><p class="font-bold mb-2">' + esc(username) + '</p>' : '') +
      '<p class="text-xs text-slate-300">Mật khẩu tạm</p>' +
      '<p class="text-2xl font-black tracking-wider">' + esc(password) + '</p></div>' +
      '<p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">' +
      'Ghi lại và chuyển trực tiếp cho cán bộ. Mật khẩu này chỉ hiện một lần và phải đổi ở lần đăng nhập đầu tiên.</p>' +
      '<div class="pt-3 mt-3 border-t border-slate-200"><button type="button" data-cc-act="modal-cancel" ' +
      'class="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm">Đã ghi lại, đóng</button></div>', null);
  }

  // --- Bộ phận --------------------------------------------------------------

  function loadAdminDepartments(host) {
    Promise.all([
      api('admin', { query: { view: 'departments' } }),
      api('admin', { query: { view: 'employees' } })
    ]).then(function (res) {
      S.departments = res[0].departments || [];
      S.employees = res[1].employees || [];
      var rows = S.departments.map(function (d) {
        return '<tr class="border-t border-slate-100">' +
          '<td class="px-2 py-2 text-xs text-slate-500">' + esc(d.code) + '</td>' +
          '<td class="px-2 py-2 font-medium text-slate-800">' + esc(d.name) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(d.headName || '—') + '</td>' +
          '<td class="px-2 py-2 text-center">' + d.employeeCount + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(d.status === 'ACTIVE' ? 'Đang dùng' : 'Ngừng') + '</td>' +
          rowActions('dept-edit', 'dept-delete', d.id) + '</tr>';
      }).join('');
      host.innerHTML = adminCard('Danh mục bộ phận (' + S.departments.length + ')',
        '<button type="button" data-cc-act="dept-new" class="px-3 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-xs font-semibold">' +
        '<i class="fas fa-plus mr-1"></i>Thêm bộ phận</button>',
        tableWrap([
          { label: 'Mã' }, { label: 'Tên bộ phận' }, { label: 'Người phụ trách' },
          { label: 'Số cán bộ', align: 'text-center' }, { label: 'Trạng thái' }, { label: '', align: 'text-right' }
        ], rows));
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được danh mục bộ phận.');
      fail(err);
    });
  }

  function openDepartmentForm(id) {
    var d = S.departments.filter(function (x) { return x.id === id; })[0] || {};
    var headOptions = [{ value: '', label: '-- Chưa chỉ định --' }].concat(
      S.employees.map(function (e) { return { value: e.id, label: e.fullName + ' (' + e.code + ')' }; })
    );
    var html =
      field('Mã bộ phận', input('code', d.code || '', 'text', 'required'), 'Ví dụ: KCB, DUOC, YHCT.') +
      field('Tên bộ phận', input('name', d.name || '', 'text', 'required')) +
      field('Người phụ trách', select('headEmployeeId', headOptions, d.headEmployeeId || ''),
        'Người phụ trách thấy được số liệu chấm công của bộ phận và duyệt yêu cầu trong bộ phận đó.') +
      field('Thứ tự hiển thị', input('displayOrder', d.displayOrder || 0, 'number')) +
      field('Trạng thái', select('status', [
        { value: 'ACTIVE', label: 'Đang dùng' }, { value: 'INACTIVE', label: 'Ngừng dùng' }
      ], d.status || 'ACTIVE')) +
      field('Ghi chú', textarea('note', d.note || '', 2)) +
      submitRow(id ? 'Lưu thay đổi' : 'Thêm bộ phận');
    openModal(id ? 'Sửa bộ phận' : 'Thêm bộ phận', html, function () {
      var v = modalValues();
      v.action = 'department_save';
      if (id) v.id = id;
      api('admin', { body: v }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        renderAdmin();
      }).catch(fail);
    });
  }

  // --- Tài khoản ------------------------------------------------------------

  function loadAdminAccounts(host) {
    Promise.all([
      api('admin', { query: { view: 'accounts' } }),
      api('admin', { query: { view: 'employees' } })
    ]).then(function (res) {
      var accounts = res[0].accounts || [];
      S.employees = res[1].employees || [];
      var rows = accounts.map(function (a) {
        return '<tr class="border-t border-slate-100">' +
          '<td class="px-2 py-2 font-medium text-slate-800">' + esc(a.username) +
          (a.mustChangePassword ? ' ' + badge('Phải đổi mật khẩu', 'bg-amber-100 text-amber-800') : '') + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(a.name) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(a.role) + '</td>' +
          '<td class="px-2 py-2 text-center">' + (a.attendanceAccess
            ? badge('Có quyền', 'bg-emerald-100 text-emerald-800') : badge('Chưa cấp', 'bg-slate-100 text-slate-600')) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(a.linkedEmployeeName || '—') + '</td>' +
          '<td class="px-2 py-2 text-right whitespace-nowrap">' +
          '<button type="button" data-cc-act="acc-grant" data-id="' + esc(a.id) + '" data-granted="' + (a.attendanceAccess ? '0' : '1') +
          '" class="px-2 py-1 text-xs ' + (a.attendanceAccess ? 'text-amber-700' : 'text-emerald-700') + ' hover:underline">' +
          (a.attendanceAccess ? 'Thu quyền' : 'Cấp quyền') + '</button>' +
          (a.linkedEmployeeId ? '' : '<button type="button" data-cc-act="acc-link" data-id="' + esc(a.id) +
            '" class="px-2 py-1 text-xs text-medical-600 hover:underline">Gán hồ sơ</button>') +
          '<button type="button" data-cc-act="acc-reset" data-id="' + esc(a.id) +
          '" class="px-2 py-1 text-xs text-red-600 hover:underline">Đặt lại mật khẩu</button></td></tr>';
      }).join('');
      host.innerHTML = adminCard('Tài khoản hệ thống (' + accounts.length + ')', '',
        tableWrap([
          { label: 'Tên đăng nhập' }, { label: 'Họ tên' }, { label: 'Vai trò CMS' },
          { label: 'Quyền chấm công', align: 'text-center' }, { label: 'Hồ sơ cán bộ' }, { label: '', align: 'text-right' }
        ], rows, 820) +
        '<p class="text-[11px] text-slate-400 mt-3">Quyền vào phân hệ được đọc lại từ cơ sở dữ liệu ở mỗi lượt gọi, nên thu quyền là người dùng mất quyền ngay ở thao tác kế tiếp, không cần chờ hết phiên.</p>');
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được danh sách tài khoản.');
      fail(err);
    });
  }

  function openLinkAccountForm(userId) {
    var free = S.employees.filter(function (e) { return !e.hasAccount; });
    if (!free.length) return toast('Mọi hồ sơ cán bộ đều đã có tài khoản.', 'info');
    openModal('Gán tài khoản cho hồ sơ cán bộ',
      field('Chọn hồ sơ cán bộ', select('employeeId', free.map(function (e) {
        return { value: e.id, label: e.fullName + ' (' + e.code + ')' };
      }), free[0].id)) + submitRow('Gán hồ sơ'),
      function () {
        var v = modalValues();
        api('admin', { body: { action: 'account_link', userId: userId, employeeId: v.employeeId } })
          .then(function (data) {
            closeModal();
            toast(data.message, 'success');
            renderAdmin();
          }).catch(fail);
      });
  }

  // --- Thời gian làm việc (mục III) ----------------------------------------

  function loadAdminWorkTime(host) {
    api('admin', { query: { view: 'settings' } }).then(function (data) {
      S.settings = data.settings;
      var wh = data.settings.workHours;
      var dayBoxes = [1, 2, 3, 4, 5, 6, 0].map(function (d) {
        return '<label class="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-sm">' +
          '<input type="checkbox" data-cc-day="' + d + '" class="w-4 h-4 rounded border-slate-300"' +
          ((wh.workDays || []).indexOf(d) !== -1 ? ' checked' : '') + '><span>' + esc(WEEKDAY_NAMES[d]) + '</span></label>';
      }).join('');

      host.innerHTML = adminCard('Thời gian làm việc hành chính', '',
        '<p class="text-xs text-slate-500 mb-4">Giờ hành chính KHÔNG cố định trong mã nguồn. Mọi con số dưới đây do đơn vị tự đặt và có hiệu lực ngay cho các lượt chấm công sau khi lưu.</p>' +
        '<div class="grid md:grid-cols-2 gap-x-6">' +
        '<div><h3 class="font-bold text-sm text-slate-700 mb-2">Buổi sáng</h3>' +
        checkbox('morningEnabled', 'Có làm buổi sáng', wh.morning.enabled !== false) +
        '<div class="grid grid-cols-2 gap-3">' +
        field('Giờ bắt đầu', input('morningStart', wh.morning.start, 'time')) +
        field('Giờ kết thúc', input('morningEnd', wh.morning.end, 'time')) + '</div></div>' +
        '<div><h3 class="font-bold text-sm text-slate-700 mb-2">Buổi chiều</h3>' +
        checkbox('afternoonEnabled', 'Có làm buổi chiều', wh.afternoon.enabled !== false) +
        '<div class="grid grid-cols-2 gap-3">' +
        field('Giờ bắt đầu', input('afternoonStart', wh.afternoon.start, 'time')) +
        field('Giờ kết thúc', input('afternoonEnd', wh.afternoon.end, 'time')) + '</div></div>' +
        '</div>' +
        '<h3 class="font-bold text-sm text-slate-700 mb-2 mt-2">Ngày làm việc trong tuần</h3>' +
        '<div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">' + dayBoxes + '</div>' +
        '<div class="grid md:grid-cols-4 gap-3">' +
        field('Cho phép đến muộn (phút)', input('lateGraceMin', wh.lateGraceMin, 'number', 'min="0"')) +
        field('Cho phép về sớm (phút)', input('earlyGraceMin', wh.earlyGraceMin, 'number', 'min="0"')) +
        field('Chấm vào sớm nhất trước (phút)', input('earliestPunchMin', wh.earliestPunchMin, 'number', 'min="0"')) +
        field('Chấm ra muộn nhất sau (phút)', input('latestPunchMin', wh.latestPunchMin, 'number', 'min="0"')) +
        '</div>' +
        field('Giá trị một nửa ngày công', input('halfDayValue', wh.halfDayValue, 'number', 'step="0.1" min="0" max="1"')) +
        '<div class="mt-2">' +
        checkbox('allowPunchOnNonWorkday', 'Cho phép chấm công vào ngày không phải ngày làm việc (T7, CN, lễ)', wh.allowPunchOnNonWorkday) +
        checkbox('requireDutyAssignment', 'Chỉ nhận ca trực khi đã được phân lịch', wh.requireDutyAssignment) +
        checkbox('allowAdjustRequest', 'Cho phép cán bộ gửi yêu cầu điều chỉnh chấm công', wh.allowAdjustRequest) +
        checkbox('allowSwapRequest', 'Cho phép cán bộ gửi yêu cầu đổi ca trực', wh.allowSwapRequest) +
        '</div>' +
        '<div class="flex flex-wrap gap-2 pt-3 border-t border-slate-200 mt-3">' +
        '<button type="button" data-cc-act="worktime-save" class="px-4 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-sm font-semibold">' +
        '<i class="fas fa-floppy-disk mr-1"></i>Lưu cấu hình</button>' +
        '<button type="button" data-cc-act="admin-refresh" class="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm">Tải lại</button>' +
        '</div>');
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được cấu hình.');
      fail(err);
    });
  }

  function saveWorkTime() {
    var host = el('ccAdminBody');
    var read = function (name) {
      var node = qs('[name="' + name + '"]', host);
      if (!node) return '';
      return node.type === 'checkbox' ? node.checked : node.value;
    };
    var workDays = qsa('[data-cc-day]', host).filter(function (n) { return n.checked; })
      .map(function (n) { return Number(n.getAttribute('data-cc-day')); });

    var value = {
      workDays: workDays,
      morning: { start: read('morningStart'), end: read('morningEnd'), enabled: read('morningEnabled') },
      afternoon: { start: read('afternoonStart'), end: read('afternoonEnd'), enabled: read('afternoonEnabled') },
      lateGraceMin: num(read('lateGraceMin'), 0),
      earlyGraceMin: num(read('earlyGraceMin'), 0),
      earliestPunchMin: num(read('earliestPunchMin'), 90),
      latestPunchMin: num(read('latestPunchMin'), 180),
      halfDayValue: num(read('halfDayValue'), 0.5),
      allowPunchOnNonWorkday: read('allowPunchOnNonWorkday'),
      requireDutyAssignment: read('requireDutyAssignment'),
      allowAdjustRequest: read('allowAdjustRequest'),
      allowSwapRequest: read('allowSwapRequest')
    };
    api('admin', { body: { action: 'settings_save', key: 'work_hours', value: value } }).then(function (data) {
      S.settings = data.settings;
      toast(data.message, 'success');
      renderWorkHoursInfo();
    }).catch(fail);
  }

  // --- Ca trực (mục V) ------------------------------------------------------

  function loadAdminShifts(host) {
    api('admin', { query: { view: 'shifts' } }).then(function (data) {
      S.shifts = data.shifts || [];
      var rows = S.shifts.map(function (s) {
        return '<tr class="border-t border-slate-100' + (s.status === 'INACTIVE' ? ' opacity-60' : '') + '">' +
          '<td class="px-2 py-2 text-xs text-slate-500">' + esc(s.code) + '</td>' +
          '<td class="px-2 py-2 font-medium text-slate-800"><span class="inline-block w-2 h-2 rounded-full mr-2" style="background:' + esc(s.color) + '"></span>' +
          esc(s.name) + (s.status === 'INACTIVE' ? ' ' + badge('Ngừng', 'bg-slate-200 text-slate-600') : '') + '</td>' +
          '<td class="px-2 py-2 text-xs tabular-nums">' + esc(s.startTime) + ' - ' + esc(s.endTime) +
          (s.crossesMidnight ? ' <span class="text-indigo-600">(qua đêm)</span>' : '') + '</td>' +
          '<td class="px-2 py-2 text-center">' + esc(fmtNum(s.hours)) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc({ ANY: 'Mọi ngày', WEEKDAY: 'Ngày thường', WEEKEND: 'Cuối tuần', HOLIDAY: 'Ngày lễ' }[s.dayScope] || s.dayScope) + '</td>' +
          '<td class="px-2 py-2 text-center">' + esc(fmtNum(s.coefficient)) + '</td>' +
          '<td class="px-2 py-2 text-center text-xs">' + (s.countsAsAdminDay
            ? badge('Quy đổi ' + fmtNum(s.adminDayValue) + ' ngày', 'bg-purple-100 text-purple-800')
            : '<span class="text-slate-400">không</span>') + '</td>' +
          rowActions('shift-edit', 'shift-delete', s.id) + '</tr>';
      }).join('');
      host.innerHTML = adminCard('Danh mục ca trực (' + S.shifts.length + ')',
        '<button type="button" data-cc-act="shift-new" class="px-3 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-xs font-semibold">' +
        '<i class="fas fa-plus mr-1"></i>Thêm ca trực</button>' +
        '<button type="button" data-cc-act="shift-seed" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs font-semibold">Nạp ca mẫu</button>',
        tableWrap([
          { label: 'Mã' }, { label: 'Tên ca' }, { label: 'Giờ' }, { label: 'Định mức giờ', align: 'text-center' },
          { label: 'Áp dụng' }, { label: 'Hệ số', align: 'text-center' }, { label: 'Quy đổi công HC', align: 'text-center' },
          { label: '', align: 'text-right' }
        ], rows, 900) +
        '<p class="text-[11px] text-slate-400 mt-3">Mặc định một ca trực KHÔNG trở thành ngày công hành chính (mục VIII). Chỉ khi đơn vị có quy định riêng thì mới bật "Quy đổi thành ngày công", và phần quy đổi luôn được in thành cột riêng trên báo cáo.</p>');
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được danh mục ca trực.');
      fail(err);
    });
  }

  function openShiftForm(id) {
    var s = S.shifts.filter(function (x) { return x.id === id; })[0] || {};
    var html =
      '<div class="grid md:grid-cols-2 gap-3">' +
      field('Mã ca', input('code', s.code || '', 'text', 'required'), 'Ví dụ: TRUC_DEM, TRUC_NGAY.') +
      field('Tên ca trực', input('name', s.name || '', 'text', 'required'), 'Ví dụ: Trực đêm thường.') +
      field('Giờ bắt đầu', input('startTime', s.startTime || '16:30', 'time')) +
      field('Giờ kết thúc', input('endTime', s.endTime || '07:30', 'time'), 'Giờ kết thúc nhỏ hơn giờ bắt đầu nghĩa là ca qua đêm; hệ thống tự nhận biết.') +
      field('Định mức giờ trực', input('hours', s.hours == null ? '' : s.hours, 'number', 'step="0.5" min="0"'),
        'Để trống thì lấy đúng độ dài ca. Giờ trực trên báo cáo lấy theo định mức này, không lấy hiệu giờ bấm.') +
      field('Áp dụng cho loại ngày', select('dayScope', [
        { value: 'ANY', label: 'Mọi ngày' }, { value: 'WEEKDAY', label: 'Chỉ ngày thường' },
        { value: 'WEEKEND', label: 'Chỉ cuối tuần' }, { value: 'HOLIDAY', label: 'Chỉ ngày lễ' }
      ], s.dayScope || 'ANY')) +
      field('Hệ số ca', input('coefficient', s.coefficient == null ? 1 : s.coefficient, 'number', 'step="0.1" min="0"')) +
      field('Màu nhận biết', input('color', s.color || '#0284c7', 'color')) +
      field('Thứ tự hiển thị', input('displayOrder', s.displayOrder || 0, 'number')) +
      field('Trạng thái', select('status', [
        { value: 'ACTIVE', label: 'Đang dùng' }, { value: 'INACTIVE', label: 'Ngừng dùng' }
      ], s.status || 'ACTIVE')) +
      '</div>' +
      '<div class="p-3 rounded-xl bg-purple-50 border border-purple-200 mb-3">' +
      checkbox('countsAsAdminDay', 'Ca này được quy đổi thành ngày công hành chính', s.countsAsAdminDay) +
      field('Số ngày công quy đổi', input('adminDayValue', s.adminDayValue == null ? 0 : s.adminDayValue, 'number', 'step="0.25" min="0" max="2"'),
        'Chỉ có hiệu lực khi ô trên được chọn. Phần quy đổi luôn hiện thành cột riêng, không cộng lẫn vào ngày công hành chính.') +
      '</div>' +
      field('Ghi chú', textarea('note', s.note || '', 2)) +
      submitRow(id ? 'Lưu thay đổi' : 'Thêm ca trực');

    openModal(id ? 'Sửa ca trực' : 'Thêm ca trực', html, function () {
      var v = modalValues();
      v.action = 'shift_save';
      if (id) v.id = id;
      api('admin', { body: v }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        renderAdmin();
      }).catch(fail);
    });
  }

  // --- Ngày nghỉ, lễ (mục XIII) --------------------------------------------

  function loadAdminHolidays(host) {
    api('admin', { query: { view: 'holidays' } }).then(function (data) {
      S.holidays = data.holidays || [];
      var rows = S.holidays.map(function (h) {
        return '<tr class="border-t border-slate-100">' +
          '<td class="px-2 py-2 font-medium text-slate-800">' + esc(h.name) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(fmtDateVN(h.startDate)) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(fmtDateVN(h.endDate)) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(h.dayType === 'HOLIDAY' ? 'Nghỉ lễ' : h.dayType === 'WEEKEND' ? 'Như cuối tuần' : 'Ngày làm bù') + '</td>' +
          '<td class="px-2 py-2 text-xs text-slate-500">' + esc(h.note) + '</td>' +
          rowActions('holiday-edit', 'holiday-delete', h.id) + '</tr>';
      }).join('');
      host.innerHTML = adminCard('Danh mục ngày nghỉ, ngày lễ (' + S.holidays.length + ')',
        '<button type="button" data-cc-act="holiday-new" class="px-3 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-xs font-semibold">' +
        '<i class="fas fa-plus mr-1"></i>Thêm ngày nghỉ</button>',
        tableWrap([
          { label: 'Tên ngày nghỉ' }, { label: 'Từ ngày' }, { label: 'Đến ngày' },
          { label: 'Loại ngày' }, { label: 'Ghi chú' }, { label: '', align: 'text-right' }
        ], rows) +
        '<p class="text-[11px] text-slate-400 mt-3">Bảng công tự nhận diện ngày thường, thứ Bảy, Chủ nhật và ngày lễ theo danh mục này; ca trực rơi vào các ngày đó được đếm riêng ở cột "trực cuối tuần" và "trực ngày lễ".</p>');
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được danh mục ngày nghỉ.');
      fail(err);
    });
  }

  function openHolidayForm(id) {
    var h = S.holidays.filter(function (x) { return x.id === id; })[0] || {};
    var html =
      field('Tên ngày nghỉ', input('name', h.name || '', 'text', 'required'), 'Ví dụ: Tết Nguyên đán, Quốc khánh 2/9.') +
      '<div class="grid grid-cols-2 gap-3">' +
      field('Từ ngày', input('startDate', h.startDate || '', 'date')) +
      field('Đến ngày', input('endDate', h.endDate || '', 'date'), 'Để trống nếu chỉ một ngày.') + '</div>' +
      field('Loại ngày', select('dayType', [
        { value: 'HOLIDAY', label: 'Nghỉ lễ, Tết' },
        { value: 'WEEKEND', label: 'Tính như cuối tuần' },
        { value: 'WEEKDAY', label: 'Ngày làm bù (tính như ngày thường)' }
      ], h.dayType || 'HOLIDAY')) +
      field('Ghi chú', input('note', h.note || '')) +
      submitRow(id ? 'Lưu thay đổi' : 'Thêm ngày nghỉ');
    openModal(id ? 'Sửa ngày nghỉ' : 'Thêm ngày nghỉ', html, function () {
      var v = modalValues();
      v.action = 'holiday_save';
      if (id) v.id = id;
      api('admin', { body: v }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        renderAdmin();
      }).catch(fail);
    });
  }

  // --- Ký hiệu, loại nghỉ, thông tin đơn vị --------------------------------

  function loadAdminSymbols(host) {
    api('admin', { query: { view: 'settings' } }).then(function (data) {
      S.settings = data.settings;
      var sym = data.settings.symbols;
      var org = data.settings.org;
      var types = data.settings.leaveTypes || [];

      host.innerHTML =
        adminCard('Ký hiệu trên bảng chấm công', '',
          '<p class="text-xs text-slate-500 mb-3">Ký hiệu do đơn vị tự đặt. Ví dụ mặc định: X là có mặt, T là trực, P là nghỉ phép - đổi ở đây là bảng công và tệp xuất ra đổi theo.</p>' +
          '<div class="grid grid-cols-2 md:grid-cols-4 gap-3">' +
          field('Có mặt (công hành chính)', input('symPresent', sym.present)) +
          field('Nửa ngày', input('symHalfPresent', sym.halfPresent)) +
          field('Trực', input('symDuty', sym.duty)) +
          field('Nghỉ phép', input('symLeave', sym.leave)) +
          field('Nghỉ không lý do', input('symAbsent', sym.absent)) +
          field('Ngày lễ', input('symHoliday', sym.holiday)) +
          field('Cuối tuần', input('symWeekend', sym.weekend)) +
          field('Thiếu lượt chấm', input('symMissing', sym.missing)) +
          field('Dấu nối khi vừa làm vừa trực', input('symSeparator', sym.separator), 'Ví dụ X+T.') +
          '</div>' +
          '<button type="button" data-cc-act="symbols-save" class="px-4 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-sm font-semibold">' +
          '<i class="fas fa-floppy-disk mr-1"></i>Lưu ký hiệu</button>') +
        adminCard('Loại nghỉ phép (' + types.length + ')',
          '<button type="button" data-cc-act="leavetype-new" class="px-3 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-xs font-semibold">' +
          '<i class="fas fa-plus mr-1"></i>Thêm loại nghỉ</button>',
          tableWrap([
            { label: 'Mã' }, { label: 'Tên loại nghỉ' }, { label: 'Ký hiệu', align: 'text-center' },
            { label: 'Tính lương', align: 'text-center' }, { label: 'Nhóm' }, { label: '', align: 'text-right' }
          ], types.map(function (t, index) {
            return '<tr class="border-t border-slate-100">' +
              '<td class="px-2 py-2 text-xs text-slate-500">' + esc(t.code) + '</td>' +
              '<td class="px-2 py-2 font-medium text-slate-800">' + esc(t.name) + '</td>' +
              '<td class="px-2 py-2 text-center font-bold">' + esc(t.symbol) + '</td>' +
              '<td class="px-2 py-2 text-center text-xs">' + (t.paid ? 'Có' : 'Không') + '</td>' +
              '<td class="px-2 py-2 text-xs">' + esc(t.group === 'ANNUAL' ? 'Nghỉ phép năm' : 'Nghỉ khác') + '</td>' +
              rowActions('leavetype-edit', 'leavetype-delete', String(index)) + '</tr>';
          }).join('')) +
          '<p class="text-[11px] text-slate-400 mt-3">Nhóm "Nghỉ phép năm" được cộng vào cột Số ngày nghỉ phép của báo cáo; các loại còn lại vào cột Nghỉ khác.</p>') +
        adminCard('Thông tin đơn vị in trên báo cáo', '',
          '<div class="grid md:grid-cols-2 gap-3">' +
          field('Tên đơn vị', input('orgName', org.name)) +
          field('Cơ quan chủ quản', input('orgParent', org.parentName)) +
          field('Địa chỉ', input('orgAddress', org.address)) +
          field('Chức danh người lập biểu', input('orgPreparedBy', org.preparedByTitle)) +
          field('Chức danh người kiểm tra', input('orgCheckedBy', org.checkedByTitle)) +
          field('Chức danh người phê duyệt', input('orgApprovedBy', org.approvedByTitle)) +
          '</div>' +
          '<button type="button" data-cc-act="org-save" class="px-4 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-sm font-semibold">' +
          '<i class="fas fa-floppy-disk mr-1"></i>Lưu thông tin đơn vị</button>');
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được cấu hình.');
      fail(err);
    });
  }

  function saveSymbols() {
    var host = el('ccAdminBody');
    var read = function (name) { var n = qs('[name="' + name + '"]', host); return n ? n.value.trim() : ''; };
    var value = {
      present: read('symPresent'), halfPresent: read('symHalfPresent'), duty: read('symDuty'),
      leave: read('symLeave'), absent: read('symAbsent'), holiday: read('symHoliday'),
      weekend: read('symWeekend'), missing: read('symMissing'), separator: read('symSeparator')
    };
    api('admin', { body: { action: 'settings_save', key: 'symbols', value: value } }).then(function (data) {
      S.settings = data.settings;
      toast(data.message, 'success');
    }).catch(fail);
  }

  function saveOrg() {
    var host = el('ccAdminBody');
    var read = function (name) { var n = qs('[name="' + name + '"]', host); return n ? n.value.trim() : ''; };
    var value = {
      name: read('orgName'), parentName: read('orgParent'), address: read('orgAddress'),
      preparedByTitle: read('orgPreparedBy'), checkedByTitle: read('orgCheckedBy'), approvedByTitle: read('orgApprovedBy')
    };
    api('admin', { body: { action: 'settings_save', key: 'org', value: value } }).then(function (data) {
      S.settings = data.settings;
      el('ccSidebarOrg').textContent = value.name;
      toast(data.message, 'success');
    }).catch(fail);
  }

  function openLeaveTypeForm(index) {
    var types = ((S.settings && S.settings.leaveTypes) || []).slice();
    var t = index === null || index === '' ? {} : types[Number(index)] || {};
    var html =
      field('Mã loại nghỉ', input('code', t.code || '', 'text', 'required'), 'Ví dụ: PHEP, OM, KHONG_LUONG.') +
      field('Tên loại nghỉ', input('name', t.name || '', 'text', 'required')) +
      field('Ký hiệu trên bảng công', input('symbol', t.symbol || 'P')) +
      field('Nhóm', select('group', [
        { value: 'ANNUAL', label: 'Nghỉ phép năm' }, { value: 'OTHER', label: 'Nghỉ khác' }
      ], t.group || 'OTHER')) +
      checkbox('paid', 'Có tính lương', t.paid !== false) +
      submitRow('Lưu loại nghỉ');
    openModal(index === null ? 'Thêm loại nghỉ' : 'Sửa loại nghỉ', html, function () {
      var v = modalValues();
      var entry = {
        code: String(v.code || '').toUpperCase(), name: v.name, symbol: v.symbol,
        group: v.group, paid: !!v.paid
      };
      if (index === null) types.push(entry); else types[Number(index)] = entry;
      api('admin', { body: { action: 'settings_save', key: 'leave_types', value: types } }).then(function (data) {
        S.settings = data.settings;
        closeModal();
        toast(data.message, 'success');
        renderAdmin();
      }).catch(fail);
    });
  }

  function deleteLeaveType(index) {
    var types = ((S.settings && S.settings.leaveTypes) || []).slice();
    var removed = types.splice(Number(index), 1)[0];
    if (!removed) return;
    confirmBox('Xoá loại nghỉ "' + removed.name + '" khỏi danh mục? Các đơn nghỉ đã ghi nhận trước đó vẫn giữ nguyên.', function () {
      api('admin', { body: { action: 'settings_save', key: 'leave_types', value: types } }).then(function (data) {
        S.settings = data.settings;
        closeModal();
        toast(data.message, 'success');
        renderAdmin();
      }).catch(fail);
    }, 'Xoá');
  }

  // --- Lịch trực tháng (mục VI) --------------------------------------------

  function loadAdminRoster(host, period) {
    var wanted = period || (S.rosterData && S.rosterData.period) || currentPeriod();
    host.innerHTML = spinner('Đang tải lịch trực...');
    Promise.all([
      api('admin', { query: { view: 'roster', period: wanted } }),
      S.employees.length ? Promise.resolve({ employees: S.employees }) : api('admin', { query: { view: 'employees' } })
    ]).then(function (res) {
      var data = res[0];
      S.rosterData = data;
      S.employees = res[1].employees || S.employees;
      var activeShifts = (data.shifts || []).filter(function (s) { return s.status === 'ACTIVE'; });

      var toolbar =
        '<div class="bg-white rounded-2xl shadow-sm p-4 flex flex-wrap items-end gap-3">' +
        '<div><label class="block text-xs font-semibold text-slate-600 mb-1" for="ccRosterPeriod">Tháng lập lịch</label>' +
        '<input type="month" id="ccRosterPeriod" value="' + esc(wanted) + '" class="px-3 py-2 border border-slate-300 rounded-lg text-sm"></div>' +
        '<button type="button" data-cc-act="roster-load" class="px-4 py-2 bg-medical-600 hover:bg-medical-700 text-white rounded-lg text-sm font-semibold">Xem lịch</button>' +
        '<button type="button" data-cc-act="roster-copy" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm"><i class="fas fa-copy mr-1"></i>Sao chép tháng trước</button>' +
        '<button type="button" data-cc-act="roster-auto" class="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm"><i class="fas fa-wand-magic-sparkles mr-1"></i>Phân lịch tự động</button>' +
        '<button type="button" data-cc-act="roster-import" class="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm"><i class="fas fa-file-import mr-1"></i>Nhập từ Excel</button>' +
        (data.locked ? badge('Kỳ đã khoá - không sửa được', 'bg-slate-800 text-white') : '') +
        '</div>';

      var workload = '<div class="bg-white rounded-2xl shadow-sm p-4">' +
        '<h3 class="font-bold text-sm text-slate-700 mb-2">Số suất trực trong tháng theo cán bộ</h3>' +
        '<div class="flex flex-wrap gap-2">' + (data.workload || []).map(function (w) {
          return '<span class="px-3 py-1.5 rounded-lg text-xs ' +
            (w.shifts === 0 ? 'bg-slate-100 text-slate-500' : 'bg-medical-50 text-medical-800 font-semibold') + '">' +
            esc(w.fullName) + ': ' + w.shifts + '</span>';
        }).join('') + '</div></div>';

      var dayRows = (data.days || []).map(function (day) {
        var entries = day.entries.map(function (e) {
          return '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-white border border-slate-200">' +
            '<span class="w-2 h-2 rounded-full" style="background:' + esc(e.color) + '"></span>' +
            '<span class="font-semibold">' + esc(e.shiftName) + '</span>: ' + esc(e.employeeName) +
            (e.swappedFromName ? ' <i class="fas fa-right-left text-indigo-500" title="Đổi từ ' + esc(e.swappedFromName) + '"></i>' : '') +
            (e.checkInAt ? ' <i class="fas fa-circle-check text-emerald-500" title="Đã nhận ca"></i>' : '') +
            (data.locked ? '' : '<button type="button" data-cc-act="roster-remove" data-id="' + esc(e.assignmentId) +
              '" class="ml-1 text-red-500 hover:text-red-700" title="Bỏ suất trực này"><i class="fas fa-xmark"></i></button>') +
            '</span>';
        }).join('');
        return '<tr class="border-t border-slate-100 ' + (DAY_TYPE_CLASS[day.dayType] || '') + '">' +
          '<td class="px-2 py-2 text-center font-bold">' + day.day + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(WEEKDAY_SHORT[num(day.weekday, 0)]) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(day.holidayName || DAY_TYPE_LABEL[day.dayType]) + '</td>' +
          '<td class="px-2 py-2"><div class="flex flex-wrap gap-1">' + (entries || '<span class="text-xs text-slate-400 italic">chưa phân</span>') + '</div></td>' +
          '<td class="px-2 py-2 text-right">' + (data.locked ? '' :
            '<button type="button" data-cc-act="roster-add" data-date="' + esc(day.date) +
            '" class="px-2 py-1 bg-medical-50 text-medical-700 rounded text-xs font-semibold whitespace-nowrap"><i class="fas fa-plus mr-1"></i>Phân người</button>') +
          '</td></tr>';
      }).join('');

      host.innerHTML = toolbar + workload +
        adminCard('Lịch trực ' + periodLabel(wanted),
          '<span class="text-xs text-slate-500">' + activeShifts.length + ' ca trực đang dùng</span>',
          tableWrap([
            { label: 'Ngày', align: 'text-center' }, { label: 'Thứ' }, { label: 'Loại ngày' },
            { label: 'Ca trực và người trực' }, { label: '', align: 'text-right' }
          ], dayRows, 760));
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được lịch trực.');
      fail(err);
    });
  }

  function rosterPeriod() {
    var input2 = qs('#ccRosterPeriod');
    return (input2 && input2.value) || currentPeriod();
  }

  function openRosterAssignForm(date) {
    var shifts = ((S.rosterData && S.rosterData.shifts) || S.shifts).filter(function (s) { return s.status === 'ACTIVE'; });
    var staff = S.employees.filter(function (e) { return e.status === 'ACTIVE'; });
    if (!shifts.length) return toast('Chưa có ca trực nào đang dùng. Hãy khai báo ca trực trước.', 'warn');
    if (!staff.length) return toast('Chưa có cán bộ nào để phân trực.', 'warn');
    var html =
      '<p class="text-sm text-slate-600 mb-3">Phân người trực cho ngày <strong>' + esc(fmtDateVN(date)) + '</strong>.</p>' +
      field('Ca trực', select('shiftId', shifts.map(function (s) {
        return { value: s.id, label: s.name + ' (' + s.startTime + ' - ' + s.endTime + ')' };
      }), shifts[0].id)) +
      field('Cán bộ trực', select('employeeId', staff.map(function (e) {
        return { value: e.id, label: e.fullName + (e.departmentName ? ' - ' + e.departmentName : '') };
      }), staff[0].id)) +
      field('Ghi chú', input('note', '')) +
      submitRow('Phân trực');
    openModal('Phân người trực', html, function () {
      var v = modalValues();
      api('admin', {
        body: {
          action: 'roster_assign', dutyDate: date, shiftId: v.shiftId,
          employeeId: v.employeeId, note: v.note
        }
      }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        loadAdminRoster(el('ccAdminBody'), rosterPeriod());
      }).catch(fail);
    });
  }

  function openRosterAutoForm() {
    var period = rosterPeriod();
    var shifts = ((S.rosterData && S.rosterData.shifts) || S.shifts).filter(function (s) { return s.status === 'ACTIVE'; });
    var staff = S.employees.filter(function (e) { return e.status === 'ACTIVE'; });
    var html =
      '<p class="text-xs text-slate-500 mb-3">Hệ thống phân lần lượt theo vòng, tránh xếp hai đêm liền nhau và bỏ qua người đang nghỉ phép. Những suất đã phân bằng tay được giữ nguyên, không bị ghi đè.</p>' +
      '<div class="mb-3"><p class="text-xs font-semibold text-slate-600 mb-1">Ca trực cần phân</p>' +
      shifts.map(function (s) {
        return '<label class="flex items-center gap-2 text-sm mb-1"><input type="checkbox" data-cc-shift="' + esc(s.id) +
          '" class="w-4 h-4" checked><span>' + esc(s.name) + ' (' + esc(s.startTime) + ' - ' + esc(s.endTime) + ')</span></label>';
      }).join('') + '</div>' +
      '<div class="mb-3"><p class="text-xs font-semibold text-slate-600 mb-1">Cán bộ tham gia trực</p>' +
      '<div class="max-h-48 overflow-y-auto border border-slate-200 rounded-lg p-2">' +
      staff.map(function (e) {
        return '<label class="flex items-center gap-2 text-sm mb-1"><input type="checkbox" data-cc-emp="' + esc(e.id) +
          '" class="w-4 h-4" checked><span>' + esc(e.fullName) + '</span></label>';
      }).join('') + '</div></div>' +
      field('Số người mỗi ca', input('peoplePerShift', 1, 'number', 'min="1" max="10"')) +
      submitRow('Phân lịch cho ' + periodLabel(period));
    openModal('Phân lịch trực tự động', html, function () {
      var body = el('ccModalBody');
      var shiftIds = qsa('[data-cc-shift]', body).filter(function (n) { return n.checked; })
        .map(function (n) { return n.getAttribute('data-cc-shift'); });
      var employeeIds = qsa('[data-cc-emp]', body).filter(function (n) { return n.checked; })
        .map(function (n) { return n.getAttribute('data-cc-emp'); });
      var v = modalValues();
      api('admin', {
        body: {
          action: 'roster_auto', period: period, shiftIds: shiftIds,
          employeeIds: employeeIds, peoplePerShift: num(v.peoplePerShift, 1)
        }
      }).then(function (data) {
        closeModal();
        toast(data.message, 'success');
        if (data.unfilled && data.unfilled.length) {
          toast('Còn ' + data.unfilled.length + ' suất chưa phân được người, cần xếp tay.', 'warn');
        }
        loadAdminRoster(el('ccAdminBody'), period);
      }).catch(fail);
    });
  }

  function openRosterImportForm() {
    var period = rosterPeriod();
    var html =
      '<p class="text-xs text-slate-500 mb-2">Mở tệp Excel lịch trực, chọn vùng dữ liệu rồi sao chép và dán vào ô dưới. Mỗi dòng ba cột, phân cách bằng dấu Tab (dán từ Excel là đã đúng) hoặc dấu chấm phẩy:</p>' +
      '<pre class="bg-slate-900 text-slate-100 text-[11px] rounded-lg p-3 mb-3 overflow-x-auto">Ngày	Ca trực	Người trực\n5	Trực đêm thường	Nguyễn Văn A\n2026-09-06	TRUC_NGAY	CB02</pre>' +
      '<p class="text-xs text-slate-500 mb-3">Cột ngày nhận cả số ngày trong tháng lẫn dạng đầy đủ. Ca trực và người trực nhận cả mã lẫn tên. Dòng tiêu đề được bỏ qua.</p>' +
      field('Dữ liệu dán từ Excel', textarea('raw', '', 10)) +
      submitRow('Nhập ' + periodLabel(period));
    openModal('Nhập lịch trực từ Excel', html, function () {
      var v = modalValues();
      var rows = [];
      String(v.raw || '').split(/\r?\n/).forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed) return;
        var cols = trimmed.split(/\t|;/).map(function (c) { return c.trim(); });
        if (cols.length < 3) return;
        // Bỏ dòng tiêu đề: ô đầu không phải ngày.
        if (!/^\d{1,2}$/.test(cols[0]) && !/^\d{4}-\d{2}-\d{2}$/.test(cols[0])) return;
        rows.push({ date: cols[0], shift: cols[1], employee: cols[2], note: cols[3] || '' });
      });
      if (!rows.length) return toast('Không đọc được dòng dữ liệu nào. Kiểm tra lại định dạng.', 'warn');
      api('admin', { body: { action: 'roster_import', period: period, rows: rows } }).then(function (data) {
        closeModal();
        toast(data.message, data.errors && data.errors.length ? 'warn' : 'success');
        if (data.errors && data.errors.length) {
          openModal('Các dòng bị bỏ qua', '<ul class="text-xs text-slate-700 space-y-1 list-disc pl-5">' +
            data.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' +
            '<div class="pt-3 mt-3 border-t border-slate-200"><button type="button" data-cc-act="modal-cancel" class="px-4 py-2 bg-slate-100 rounded-lg text-sm">Đóng</button></div>', null);
        }
        loadAdminRoster(el('ccAdminBody'), period);
      }).catch(fail);
    });
  }

  // --- Khoá bảng công ------------------------------------------------------

  function loadAdminPeriods(host) {
    api('admin', { query: { view: 'periods' } }).then(function (data) {
      var rows = (data.periods || []).map(function (p) {
        return '<tr class="border-t border-slate-100">' +
          '<td class="px-2 py-2 font-medium text-slate-800">' + esc(periodLabel(p.id)) + '</td>' +
          '<td class="px-2 py-2">' + (p.status === 'LOCKED'
            ? badge('Đã khoá', 'bg-slate-800 text-white') : badge('Đang mở', 'bg-emerald-100 text-emerald-800')) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(p.lockedByName || '—') + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(fmtTimestamp(p.lockedAt)) + '</td>' +
          '<td class="px-2 py-2 text-xs text-slate-500">' + esc(p.note) + '</td>' +
          '<td class="px-2 py-2 text-right"><button type="button" data-cc-act="' +
          (p.status === 'LOCKED' ? 'period-unlock' : 'period-lock') + '" data-id="' + esc(p.id) +
          '" class="px-2 py-1 text-xs ' + (p.status === 'LOCKED' ? 'text-emerald-700' : 'text-red-700') + ' hover:underline">' +
          (p.status === 'LOCKED' ? 'Mở lại kỳ' : 'Khoá kỳ') + '</button></td></tr>';
      }).join('');
      host.innerHTML = adminCard('Khoá bảng công theo kỳ',
        '<button type="button" data-cc-act="period-lock-new" class="px-3 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold">' +
        '<i class="fas fa-lock mr-1"></i>Khoá một kỳ khác</button>',
        '<p class="text-xs text-slate-500 mb-3">Khoá kỳ là bước chốt số liệu cuối tháng: sau khi khoá, mọi lượt chấm công, chấm trực, điều chỉnh và ghi nhận nghỉ phép trong kỳ đó đều bị từ chối, kể cả thao tác của Quản trị. Mở lại kỳ vẫn được nhưng việc đó có ghi vào lịch sử thao tác.</p>' +
        tableWrap([
          { label: 'Kỳ' }, { label: 'Trạng thái' }, { label: 'Người khoá' },
          { label: 'Thời điểm' }, { label: 'Ghi chú' }, { label: '', align: 'text-right' }
        ], rows));
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được trạng thái các kỳ.');
      fail(err);
    });
  }

  function openPeriodLock(period, lock) {
    var wanted = period || currentPeriod();
    openModal(lock ? 'Khoá bảng công' : 'Mở lại bảng công',
      (period ? '<p class="text-sm text-slate-700 mb-3">Kỳ <strong>' + esc(periodLabel(wanted)) + '</strong>.</p>'
        : field('Kỳ cần khoá', input('period', wanted, 'month'))) +
      field('Ghi chú', textarea('note', lock ? 'Chốt số liệu cuối tháng.' : 'Mở lại để bổ sung số liệu.', 2)) +
      submitRow(lock ? 'Khoá kỳ' : 'Mở lại kỳ'),
      function () {
        var v = modalValues();
        api('admin', {
          body: {
            action: lock ? 'period_lock' : 'period_unlock',
            period: period || v.period, note: v.note
          }
        }).then(function (data) {
          closeModal();
          toast(data.message, 'success');
          renderAdmin();
        }).catch(fail);
      });
  }

  // --- Lịch sử thao tác ----------------------------------------------------

  function loadAdminAudits(host) {
    api('admin', { query: { view: 'audits', limit: 200 } }).then(function (data) {
      var rows = (data.audits || []).map(function (a) {
        return '<tr class="border-t border-slate-100">' +
          '<td class="px-2 py-2 text-xs whitespace-nowrap">' + esc(fmtTimestamp(a.ts)) + '</td>' +
          '<td class="px-2 py-2 text-xs font-medium">' + esc(a.actorName || a.actorUsername) + '</td>' +
          '<td class="px-2 py-2 text-xs">' + esc(a.entity) + '</td>' +
          '<td class="px-2 py-2 text-xs font-semibold text-medical-700">' + esc(a.action) + '</td>' +
          '<td class="px-2 py-2 text-[11px] text-slate-500 max-w-xs truncate" title="' + esc(a.newValue) + '">' +
          esc(a.newValue || a.oldValue || '') + '</td>' +
          '<td class="px-2 py-2 text-[11px] text-slate-400">' + esc(a.ip) + '</td></tr>';
      }).join('');
      host.innerHTML = adminCard('Lịch sử thao tác (200 dòng gần nhất)', '',
        '<p class="text-xs text-slate-500 mb-3">Mọi thao tác sửa dữ liệu, duyệt đơn, khoá kỳ và đổi cấu hình đều được ghi lại kèm người thực hiện, thời điểm và giá trị trước - sau.</p>' +
        tableWrap([
          { label: 'Thời điểm' }, { label: 'Người thực hiện' }, { label: 'Đối tượng' },
          { label: 'Thao tác' }, { label: 'Nội dung' }, { label: 'IP' }
        ], rows, 900));
    }).catch(function (err) {
      host.innerHTML = emptyBox(err.message || 'Không tải được lịch sử thao tác.');
      fail(err);
    });
  }

  var ADMIN_LOADERS = {
    employees: loadAdminEmployees,
    departments: loadAdminDepartments,
    accounts: loadAdminAccounts,
    worktime: loadAdminWorkTime,
    shifts: loadAdminShifts,
    holidays: loadAdminHolidays,
    symbols: loadAdminSymbols,
    roster: function (host) { loadAdminRoster(host, null); },
    periods: loadAdminPeriods,
    audits: loadAdminAudits
  };

  // =========================================================================
  //  BÁO CÁO THÁNG (mục IX, X) + XUẤT EXCEL (XI) + XUẤT PDF (XII)
  // =========================================================================

  var REPORT_KINDS = {
    timesheet: 'BẢNG CHẤM CÔNG THÁNG',
    duty: 'BẢNG TỔNG HỢP CHẤM TRỰC THÁNG',
    combined: 'BẢNG CHẤM CÔNG VÀ CHẤM TRỰC'
  };

  /** Chuẩn bị các ô chọn của khung báo cáo. Chỉ chạy một lần cho mỗi phiên. */
  function initReportFilters() {
    var monthSel = el('ccReportMonth');
    var yearSel = el('ccReportYear');
    if (monthSel.options.length) return;
    var parts = vnParts();
    var thisYear = num(parts.year, 2026);
    for (var m = 1; m <= 12; m++) {
      monthSel.appendChild(optionNode(String(m), MONTH_NAMES[m - 1]));
    }
    for (var y = thisYear + 1; y >= thisYear - 5; y--) {
      yearSel.appendChild(optionNode(String(y), 'Năm ' + y));
    }
    monthSel.value = String(num(parts.month, 1));
    yearSel.value = String(thisYear);
  }

  function optionNode(value, label) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }

  /** Bộ phận: Quản trị và Phụ trách chọn được, Cán bộ chỉ thấy số liệu của mình. */
  function fillReportDepartments() {
    var sel = el('ccReportDepartment');
    var keep = sel.value;
    sel.innerHTML = '';
    sel.appendChild(optionNode('', 'Toàn trạm'));
    (S.departments || []).forEach(function (d) {
      sel.appendChild(optionNode(d.id, d.name));
    });
    if (keep) sel.value = keep;
  }

  function loadReports() {
    initReportFilters();
    if (!S.departments.length && S.role !== 'STAFF') {
      api('admin', { query: { view: 'departments' } }).then(function (data) {
        S.departments = data.departments || [];
        fillReportDepartments();
      }).catch(function () { /* Không có quyền đọc danh mục thì để trống Toàn trạm. */ });
    } else {
      fillReportDepartments();
    }
    if (S.report) renderReport(); else runReport();
  }

  function runReport() {
    var kind = el('ccReportKind').value || 'combined';
    var month = el('ccReportMonth').value;
    var year = el('ccReportYear').value;
    var departmentId = el('ccReportDepartment').value;
    var table = el('ccReportTable');
    table.innerHTML = spinner('Đang tổng hợp số liệu...');
    el('ccReportMeta').innerHTML = '';

    var query = { view: kind, month: month, year: year };
    if (departmentId) query.departmentId = departmentId;
    api('reports', { query: query }).then(function (data) {
      S.report = data;
      S.report.kind = kind;
      renderReport();
    }).catch(function (err) {
      S.report = null;
      table.innerHTML = emptyBox(err.message || 'Không lập được báo cáo.');
      fail(err);
    });
  }

  function renderReport() {
    var r = S.report;
    if (!r) return;
    var meta = r.meta;
    el('ccReportMeta').innerHTML =
      '<div class="bg-white rounded-2xl shadow-sm p-4">' +
      '<p class="text-xs text-slate-500 uppercase">' + esc(meta.org.parentName) + '</p>' +
      '<p class="font-bold text-slate-800">' + esc(meta.org.name) + '</p>' +
      '<h2 class="text-lg font-black text-medical-700 mt-2">' + esc(r.title) + '</h2>' +
      '<p class="text-sm text-slate-600">' + esc(meta.periodLabel) + ' — ' + esc(meta.scopeLabel) + '</p>' +
      '<div class="flex flex-wrap gap-2 mt-2 text-xs">' +
      badge(r.rows.length + ' cán bộ', 'bg-medical-50 text-medical-800') +
      badge(meta.days.length + ' ngày', 'bg-slate-100 text-slate-700') +
      (meta.locked ? badge('Kỳ đã khoá — số liệu đã chốt', 'bg-slate-800 text-white')
        : badge('Kỳ đang mở — số liệu còn thay đổi', 'bg-amber-100 text-amber-800')) +
      '</div>' +
      '<p class="text-[11px] text-slate-400 mt-2">Người lập biểu: ' + esc(meta.preparedBy) +
      ' — lập lúc ' + esc(meta.preparedAt) + '</p>' +
      '</div>';

    var html = r.kind === 'timesheet' ? reportTimesheetHtml(r)
      : r.kind === 'duty' ? reportDutyHtml(r) : reportCombinedHtml(r);
    el('ccReportTable').innerHTML = html;
  }

  /** Chú giải ký hiệu, in kèm bảng để người đọc không phải tra cứu. */
  function symbolLegend(sym) {
    var items = [
      [sym.present, 'có mặt (công hành chính)'], [sym.halfPresent, 'nửa ngày'],
      [sym.duty, 'trực'], [sym.leave, 'nghỉ phép'], [sym.absent, 'nghỉ không lý do'],
      [sym.missing, 'thiếu lượt chấm'], [sym.holiday, 'ngày lễ'], [sym.weekend, 'cuối tuần']
    ];
    return '<div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 mt-3">' +
      items.map(function (it) {
        return '<span><strong class="text-slate-700">' + esc(it[0]) + '</strong> = ' + esc(it[1]) + '</span>';
      }).join('') +
      '<span><strong class="text-slate-700">' + esc(sym.present + sym.separator + sym.duty) +
      '</strong> = vừa làm hành chính vừa trực</span></div>';
  }

  function dayHeaderCells(days, cls) {
    return days.map(function (d) {
      return '<th class="px-1 py-1 text-center ' + (DAY_TYPE_CLASS[d.dayType] || '') + ' ' + (cls || '') + '" ' +
        'title="' + esc(d.weekdayName + ', ' + fmtDateVN(d.date) + (d.holidayName ? ' — ' + d.holidayName : '')) + '">' +
        '<div class="font-bold">' + d.day + '</div>' +
        '<div class="text-[9px] font-normal text-slate-500">' + esc(d.weekdayShort) + '</div></th>';
    }).join('');
  }

  function reportTimesheetHtml(r) {
    var days = r.meta.days;
    var sym = r.meta.symbols;
    var head =
      '<thead><tr class="bg-slate-50 text-[10px] uppercase text-slate-500">' +
      '<th class="px-2 py-1 text-center sticky left-0 bg-slate-50 z-10">STT</th>' +
      '<th class="px-2 py-1 text-left sticky left-10 bg-slate-50 z-10 min-w-[10rem]">Họ và tên</th>' +
      '<th class="px-2 py-1 text-left">Chức vụ</th>' +
      '<th class="px-2 py-1 text-left">Bộ phận</th>' +
      dayHeaderCells(days) +
      '<th class="px-2 py-1 text-center bg-medical-50">Tổng ngày công HC</th>' +
      '<th class="px-2 py-1 text-center bg-medical-50">Tổng giờ HC</th>' +
      '<th class="px-2 py-1 text-center bg-amber-50">Nghỉ phép</th>' +
      '<th class="px-2 py-1 text-center bg-amber-50">Nghỉ khác</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Tổng ca trực</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Tổng giờ trực</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Trực ngày thường</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Trực T7, CN</th>' +
      '<th class="px-2 py-1 text-center bg-red-50">Trực lễ, Tết</th>' +
      '<th class="px-2 py-1 text-left min-w-[10rem]">Ghi chú</th>' +
      '</tr></thead>';

    var body = r.rows.map(function (row) {
      var t = row.totals;
      return '<tr class="border-t border-slate-100 hover:bg-slate-50">' +
        '<td class="px-2 py-1 text-center text-slate-500 sticky left-0 bg-white">' + row.index + '</td>' +
        '<td class="px-2 py-1 font-medium text-slate-800 sticky left-10 bg-white whitespace-nowrap">' + esc(row.employee.fullName) + '</td>' +
        '<td class="px-2 py-1 text-xs">' + esc(row.employee.position) + '</td>' +
        '<td class="px-2 py-1 text-xs">' + esc(row.employee.departmentName) + '</td>' +
        row.days.map(function (d) {
          return '<td class="px-1 py-1 text-center text-[11px] font-semibold ' + (DAY_TYPE_CLASS[d.dayType] || '') + '" ' +
            'title="' + esc(dayTooltip(d)) + '">' + esc(d.symbol) + '</td>';
        }).join('') +
        '<td class="px-2 py-1 text-center font-bold bg-medical-50">' + esc(fmtNum(t.adminDays)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-medical-50">' + esc(fmtNum(t.adminHours)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-amber-50">' + esc(fmtNum(t.annualLeaveDays)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-amber-50">' + esc(fmtNum(t.otherLeaveDays)) + '</td>' +
        '<td class="px-2 py-1 text-center font-bold bg-indigo-50">' + t.dutyShifts + '</td>' +
        '<td class="px-2 py-1 text-center bg-indigo-50">' + esc(fmtNum(t.dutyHours)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-indigo-50">' + t.dutyWeekday + '</td>' +
        '<td class="px-2 py-1 text-center bg-indigo-50">' + t.dutyWeekend + '</td>' +
        '<td class="px-2 py-1 text-center bg-red-50">' + t.dutyHoliday + '</td>' +
        '<td class="px-2 py-1 text-[11px] text-slate-500">' + esc(row.note || '') + '</td>' +
        '</tr>';
    }).join('');

    var g = r.grandTotals;
    var foot = '<tfoot><tr class="border-t-2 border-slate-300 bg-slate-100 font-bold text-xs">' +
      '<td class="px-2 py-2 text-center sticky left-0 bg-slate-100"></td>' +
      '<td class="px-2 py-2 sticky left-10 bg-slate-100">TỔNG CỘNG</td>' +
      '<td colspan="2"></td>' +
      '<td colspan="' + days.length + '"></td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.adminDays)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.adminHours)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.annualLeaveDays)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.otherLeaveDays)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyShifts + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.dutyHours)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyWeekday + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyWeekend + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyHoliday + '</td>' +
      '<td></td></tr></tfoot>';

    return reportShell(head + '<tbody>' + body + '</tbody>' + foot, 1600) +
      symbolLegend(sym) +
      (g.convertedAdminDays ? '<p class="text-[11px] text-purple-700 mt-2">Trong kỳ có ' + esc(fmtNum(g.convertedAdminDays)) +
        ' ngày công quy đổi từ ca trực theo quy định của đơn vị. Con số này KHÔNG nằm trong cột Tổng ngày công hành chính.</p>' : '');
  }

  function dayTooltip(d) {
    var bits = [fmtDateVN(d.date)];
    if (d.firstIn) bits.push('vào ' + d.firstIn);
    if (d.lastOut) bits.push('ra ' + d.lastOut);
    if (d.adminHours) bits.push(fmtNum(d.adminHours) + ' giờ HC');
    if (d.dutyNames && d.dutyNames.length) bits.push('trực: ' + d.dutyNames.join(', '));
    else if (d.dutyShifts) bits.push(d.dutyShifts + ' ca trực');
    if (d.leaveType) bits.push('nghỉ: ' + leaveTypeName(d.leaveType));
    if (d.late) bits.push('đi muộn');
    if (d.earlyLeave) bits.push('về sớm');
    if (d.missing) bits.push('thiếu lượt chấm');
    return bits.join(' — ');
  }

  function reportDutyHtml(r) {
    var head = '<thead><tr class="bg-slate-50 text-[10px] uppercase text-slate-500">' +
      '<th class="px-2 py-1 text-center">STT</th>' +
      '<th class="px-2 py-1 text-left">Họ và tên</th>' +
      '<th class="px-2 py-1 text-left">Bộ phận</th>' +
      '<th class="px-2 py-1 text-center">Ca trực ngày thường</th>' +
      '<th class="px-2 py-1 text-center">Ca trực cuối tuần</th>' +
      '<th class="px-2 py-1 text-center">Ca trực ngày lễ, Tết</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Tổng số ca</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Tổng số giờ trực</th>' +
      '<th class="px-2 py-1 text-center">Đã bấm nhận ca</th>' +
      '<th class="px-2 py-1 text-left min-w-[12rem]">Ngày trực trong tháng</th>' +
      '</tr></thead>';

    var body = r.rows.map(function (row) {
      return '<tr class="border-t border-slate-100 hover:bg-slate-50">' +
        '<td class="px-2 py-1 text-center text-slate-500">' + row.index + '</td>' +
        '<td class="px-2 py-1 font-medium text-slate-800 whitespace-nowrap">' + esc(row.fullName) + '</td>' +
        '<td class="px-2 py-1 text-xs">' + esc(row.departmentName) + '</td>' +
        '<td class="px-2 py-1 text-center">' + row.dutyWeekday + '</td>' +
        '<td class="px-2 py-1 text-center">' + row.dutyWeekend + '</td>' +
        '<td class="px-2 py-1 text-center">' + row.dutyHoliday + '</td>' +
        '<td class="px-2 py-1 text-center font-bold bg-indigo-50">' + row.dutyShifts + '</td>' +
        '<td class="px-2 py-1 text-center bg-indigo-50">' + esc(fmtNum(row.dutyHours)) + '</td>' +
        '<td class="px-2 py-1 text-center text-xs">' + row.dutyCheckedIn + ' / ' + row.dutyShifts +
        (row.dutyNotCheckedIn ? ' <i class="fas fa-triangle-exclamation text-amber-500" title="' +
          row.dutyNotCheckedIn + ' ca chưa bấm nhận ca"></i>' : '') + '</td>' +
        '<td class="px-2 py-1 text-[11px] text-slate-600">' + (row.dates.length
          ? row.dates.map(function (d) {
            return '<span class="inline-block px-1.5 py-0.5 rounded mr-1 mb-1 ' + (DAY_TYPE_CLASS[d.dayType] || 'bg-slate-100') +
              '" title="' + esc(d.shifts.join(', ')) + '">' + d.day + (d.checkedIn ? '' : '*') + '</span>';
          }).join('')
          : '<span class="text-slate-400 italic">không có ca trực</span>') + '</td>' +
        '</tr>';
    }).join('');

    var g = r.grandTotals;
    var foot = '<tfoot><tr class="border-t-2 border-slate-300 bg-slate-100 font-bold text-xs">' +
      '<td></td><td class="px-2 py-2">TỔNG CỘNG</td><td></td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyWeekday + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyWeekend + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyHoliday + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyShifts + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.dutyHours)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyCheckedIn + '</td><td></td></tr></tfoot>';

    return reportShell(head + '<tbody>' + body + '</tbody>' + foot, 1100) +
      '<p class="text-[11px] text-slate-400 mt-3">Dấu * sau số ngày nghĩa là suất trực đã được phân lịch nhưng chưa có ai bấm nhận ca. ' +
      'Bảng này chỉ chứa số liệu công trực, không có một con số công hành chính nào lẫn vào.</p>';
  }

  function reportCombinedHtml(r) {
    var head = '<thead>' +
      '<tr class="bg-slate-50 text-[10px] uppercase text-slate-500">' +
      '<th rowspan="2" class="px-2 py-1 text-center">STT</th>' +
      '<th rowspan="2" class="px-2 py-1 text-left">Họ và tên</th>' +
      '<th rowspan="2" class="px-2 py-1 text-left">Chức vụ</th>' +
      '<th rowspan="2" class="px-2 py-1 text-left">Bộ phận</th>' +
      '<th colspan="5" class="px-2 py-1 text-center bg-medical-100 text-medical-800">Công hành chính</th>' +
      '<th colspan="5" class="px-2 py-1 text-center bg-indigo-100 text-indigo-800">Công trực (sổ riêng)</th>' +
      '<th rowspan="2" class="px-2 py-1 text-center bg-purple-50">Ngày công quy đổi từ trực</th>' +
      '<th rowspan="2" class="px-2 py-1 text-left min-w-[12rem]">Ghi chú</th>' +
      '</tr>' +
      '<tr class="bg-slate-50 text-[10px] uppercase text-slate-500">' +
      '<th class="px-2 py-1 text-center bg-medical-50">Ngày công</th>' +
      '<th class="px-2 py-1 text-center bg-medical-50">Giờ công</th>' +
      '<th class="px-2 py-1 text-center bg-medical-50">Nghỉ phép</th>' +
      '<th class="px-2 py-1 text-center bg-medical-50">Nghỉ khác</th>' +
      '<th class="px-2 py-1 text-center bg-medical-50">Nghỉ không lý do</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Ngày thường</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Cuối tuần</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Lễ, Tết</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Tổng ca</th>' +
      '<th class="px-2 py-1 text-center bg-indigo-50">Tổng giờ</th>' +
      '</tr></thead>';

    var body = r.rows.map(function (row) {
      return '<tr class="border-t border-slate-100 hover:bg-slate-50">' +
        '<td class="px-2 py-1 text-center text-slate-500">' + row.index + '</td>' +
        '<td class="px-2 py-1 font-medium text-slate-800 whitespace-nowrap">' +
        '<button type="button" data-cc-act="employee-detail" data-id="' + esc(row.employeeId) +
        '" class="hover:text-medical-700 hover:underline text-left">' + esc(row.fullName) + '</button></td>' +
        '<td class="px-2 py-1 text-xs">' + esc(row.position) + '</td>' +
        '<td class="px-2 py-1 text-xs">' + esc(row.departmentName) + '</td>' +
        '<td class="px-2 py-1 text-center font-bold bg-medical-50">' + esc(fmtNum(row.adminDays)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-medical-50">' + esc(fmtNum(row.adminHours)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-medical-50">' + esc(fmtNum(row.annualLeaveDays)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-medical-50">' + esc(fmtNum(row.otherLeaveDays)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-medical-50">' + esc(fmtNum(row.absentDays)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-indigo-50">' + row.dutyWeekday + '</td>' +
        '<td class="px-2 py-1 text-center bg-indigo-50">' + row.dutyWeekend + '</td>' +
        '<td class="px-2 py-1 text-center bg-indigo-50">' + row.dutyHoliday + '</td>' +
        '<td class="px-2 py-1 text-center font-bold bg-indigo-50">' + row.dutyShifts + '</td>' +
        '<td class="px-2 py-1 text-center bg-indigo-50">' + esc(fmtNum(row.dutyHours)) + '</td>' +
        '<td class="px-2 py-1 text-center bg-purple-50">' + (row.convertedAdminDays ? esc(fmtNum(row.convertedAdminDays)) : '—') + '</td>' +
        '<td class="px-2 py-1 text-[11px] text-slate-500">' + esc(row.note || '') + '</td>' +
        '</tr>';
    }).join('');

    var g = r.grandTotals;
    var foot = '<tfoot><tr class="border-t-2 border-slate-300 bg-slate-100 font-bold text-xs">' +
      '<td></td><td class="px-2 py-2">TỔNG CỘNG</td><td></td><td></td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.adminDays)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.adminHours)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.annualLeaveDays)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.otherLeaveDays)) + '</td>' +
      '<td></td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyWeekday + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyWeekend + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyHoliday + '</td>' +
      '<td class="px-2 py-2 text-center">' + g.dutyShifts + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.dutyHours)) + '</td>' +
      '<td class="px-2 py-2 text-center">' + esc(fmtNum(g.convertedAdminDays)) + '</td>' +
      '<td></td></tr></tfoot>';

    return reportShell(head + '<tbody>' + body + '</tbody>' + foot, 1400) +
      '<p class="text-[11px] text-slate-400 mt-3">Hai nhóm cột nằm riêng và không cộng vào nhau: một ca trực không tự trở thành một ngày công hành chính. ' +
      'Cột cuối chỉ khác 0 khi Quản trị đã bật quy định quy đổi cho một ca trực cụ thể. Bấm vào tên cán bộ để xem chi tiết từng ngày.</p>';
  }

  function reportShell(inner, minWidth) {
    return '<div class="bg-white rounded-2xl shadow-sm p-3 overflow-x-auto">' +
      '<table class="w-full text-sm border-collapse" style="min-width:' + minWidth + 'px">' + inner + '</table></div>';
  }

  // -------------------------------------------------------------------------
  //  XUẤT EXCEL (mục XI) - tự dựng tệp .xlsx đúng chuẩn OOXML
  // -------------------------------------------------------------------------
  //  Tệp được dựng ngay trên máy người dùng, không gọi dịch vụ ngoài và không
  //  phụ thuộc thư viện tải từ Internet, nên phòng máy của trạm dùng được cả
  //  khi đường truyền ra ngoài bị chặn. Tệp mở ra là bảng tính thật, sửa và in
  //  được trong Excel, không phải CSV đổi đuôi.
  // -------------------------------------------------------------------------

  var CRC_TABLE = null;

  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c;
      }
    }
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ -1) >>> 0;
  }

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  /**
   * Gói các tệp thành ZIP theo phương thức "stored" (không nén).
   *
   * Không nén để khỏi phải nhúng một bộ deflate: tệp bảng công một tháng chỉ
   * vài trăm KB nên kích thước không phải vấn đề, còn Excel đọc stored ZIP hoàn
   * toàn bình thường.
   */
  function zipFiles(entries) {
    var chunks = [];
    var central = [];
    var offset = 0;

    var u16 = function (v) { return [v & 0xFF, (v >>> 8) & 0xFF]; };
    var u32 = function (v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; };

    entries.forEach(function (entry) {
      var nameBytes = utf8(entry.name);
      var dataBytes = utf8(entry.data);
      var crc = crc32(dataBytes);
      var header = [].concat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(dataBytes.length), u32(dataBytes.length),
        u16(nameBytes.length), u16(0)
      );
      chunks.push(new Uint8Array(header), nameBytes, dataBytes);
      central.push({ name: nameBytes, crc: crc, size: dataBytes.length, offset: offset });
      offset += header.length + nameBytes.length + dataBytes.length;
    });

    var centralStart = offset;
    var centralSize = 0;
    central.forEach(function (c) {
      var rec = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(c.crc), u32(c.size), u32(c.size),
        u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset)
      );
      chunks.push(new Uint8Array(rec), c.name);
      centralSize += rec.length + c.name.length;
    });

    chunks.push(new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(centralSize), u32(centralStart), u16(0)
    )));

    return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function xmlEsc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      // Ký tự điều khiển không hợp lệ trong XML 1.0 sẽ làm Excel báo tệp hỏng.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colName(index) {
    var name = '';
    var n = index;
    while (n >= 0) {
      name = String.fromCharCode(65 + (n % 26)) + name;
      n = Math.floor(n / 26) - 1;
    }
    return name;
  }

  /**
   * Chỉ số kiểu ô trong styles.xml dưới đây. Giữ thành hằng số có tên để phần
   * dựng bảng đọc được, thay vì rải các con số 0..9 khắp nơi.
   */
  var XS = {
    BASE: 0, TITLE: 1, SUBTITLE: 2, HEAD: 3, HEAD_WEEKEND: 4, HEAD_HOLIDAY: 5,
    TEXT: 6, TEXT_CENTER: 7, NUMBER: 8, TOTAL_TEXT: 9, TOTAL_NUMBER: 10,
    CELL_WEEKEND: 11, CELL_HOLIDAY: 12, SIGN: 13, NOTE: 14
  };

  function stylesXml() {
    var border = '<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right>' +
      '<top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom></border>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="5">' +
      '<font><sz val="10"/><name val="Times New Roman"/></font>' +
      '<font><b/><sz val="14"/><name val="Times New Roman"/></font>' +
      '<font><sz val="11"/><name val="Times New Roman"/></font>' +
      '<font><b/><sz val="10"/><name val="Times New Roman"/></font>' +
      '<font><b/><i/><sz val="10"/><name val="Times New Roman"/></font>' +
      '</fonts>' +
      '<fills count="6">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE0F2FE"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFEF9C3"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2"><border/>' + border + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="15">' +
      // 0 BASE
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyFont="1"/>' +
      // 1 TITLE
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 2 SUBTITLE
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 3 HEAD
      '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      // 4 HEAD_WEEKEND
      '<xf numFmtId="0" fontId="3" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      // 5 HEAD_HOLIDAY
      '<xf numFmtId="0" fontId="3" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      // 6 TEXT
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>' +
      // 7 TEXT_CENTER
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 8 NUMBER
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 9 TOTAL_TEXT
      '<xf numFmtId="0" fontId="3" fillId="5" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
      // 10 TOTAL_NUMBER
      '<xf numFmtId="0" fontId="3" fillId="5" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 11 CELL_WEEKEND
      '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 12 CELL_HOLIDAY
      '<xf numFmtId="0" fontId="0" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 13 SIGN
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 14 NOTE
      '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  /**
   * Dựng một sheet từ mảng hai chiều các ô { v, s, t } và danh sách vùng gộp.
   * Ô ghi dạng inlineStr nên không cần bảng sharedStrings riêng - tệp to hơn
   * một chút nhưng ít chỗ sai hơn nhiều.
   */
  function sheetXml(rows, opts) {
    var options = opts || {};
    var rowsXml = rows.map(function (cells, rowIndex) {
      var r = rowIndex + 1;
      var cellsXml = cells.map(function (cell, colIndex) {
        if (cell == null) return '';
        var value = typeof cell === 'object' ? cell.v : cell;
        var style = typeof cell === 'object' && cell.s != null ? cell.s : XS.BASE;
        var ref = colName(colIndex) + r;
        if (value === '' || value == null) return '<c r="' + ref + '" s="' + style + '"/>';
        var isNumber = typeof cell === 'object' ? cell.t === 'n' : false;
        if (isNumber) return '<c r="' + ref + '" s="' + style + '"><v>' + Number(value) + '</v></c>';
        return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
          xmlEsc(value) + '</t></is></c>';
      }).join('');
      var height = options.rowHeights && options.rowHeights[rowIndex];
      return '<row r="' + r + '"' + (height ? ' ht="' + height + '" customHeight="1"' : '') + '>' + cellsXml + '</row>';
    }).join('');

    var cols = (options.cols || []).map(function (c, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + c + '" customWidth="1"/>';
    }).join('');

    var merges = (options.merges || []);
    var freeze = options.freeze
      ? '<sheetView showGridLines="0" workbookViewId="0" tabSelected="1"><pane xSplit="' + options.freeze.x +
        '" ySplit="' + options.freeze.y + '" topLeftCell="' + colName(options.freeze.x) + (options.freeze.y + 1) +
        '" activePane="bottomRight" state="frozen"/></sheetView>'
      : '<sheetView showGridLines="0" workbookViewId="0" tabSelected="1"/>';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews>' + freeze + '</sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      (cols ? '<cols>' + cols + '</cols>' : '') +
      '<sheetData>' + rowsXml + '</sheetData>' +
      (merges.length ? '<mergeCells count="' + merges.length + '">' +
        merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>' : '') +
      '<printOptions horizontalCentered="1"/>' +
      '<pageMargins left="0.35" right="0.35" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>' +
      '<pageSetup paperSize="9" orientation="' + (options.orientation || 'landscape') +
      '" fitToWidth="1" fitToHeight="0" scale="' + (options.scale || 70) + '"/>' +
      '</worksheet>';
  }

  /** Đóng gói một hoặc nhiều sheet thành tệp .xlsx rồi tải về. */
  function downloadXlsx(fileName, sheets) {
    var entries = [
      {
        name: '[Content_Types].xml',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          sheets.map(function (s, i) {
            return '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
              '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
          }).join('') +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>'
      },
      {
        name: '_rels/.rels',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>'
      },
      {
        name: 'xl/workbook.xml',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          sheets.map(function (s, i) {
            return '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
          }).join('') + '</sheets></workbook>'
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          sheets.map(function (s, i) {
            return '<Relationship Id="rId' + (i + 1) +
              '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
              (i + 1) + '.xml"/>';
          }).join('') +
          '<Relationship Id="rId' + (sheets.length + 1) +
          '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          '</Relationships>'
      },
      { name: 'xl/styles.xml', data: stylesXml() }
    ];
    sheets.forEach(function (s, i) {
      entries.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: s.xml });
    });

    var blob = zipFiles(entries);
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Thu hồi sau một nhịp để Safari trên iPhone kịp bắt đầu tải.
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /** Khối tiêu đề dùng chung cho cả ba tệp xuất, theo mẫu văn bản của trạm. */
  function excelHeaderRows(r, width) {
    var meta = r.meta;
    var last = colName(width - 1);
    var rows = [
      [{ v: meta.org.parentName, s: XS.SUBTITLE }],
      [{ v: meta.org.name, s: XS.SUBTITLE }],
      [],
      [{ v: r.title, s: XS.TITLE }],
      [{ v: meta.periodLabel, s: XS.SUBTITLE }],
      [{ v: meta.scopeLabel + (meta.locked ? ' — số liệu đã chốt' : ''), s: XS.SUBTITLE }],
      []
    ];
    var merges = [
      'A1:' + last + '1', 'A2:' + last + '2', 'A4:' + last + '4',
      'A5:' + last + '5', 'A6:' + last + '6'
    ];
    return { rows: rows, merges: merges, headerRowCount: rows.length };
  }

  /** Khối chữ ký cuối biểu (mục XII): người lập biểu, người kiểm tra, phụ trách. */
  function excelSignatureRows(r, width) {
    var org = r.meta.org;
    var third = Math.max(1, Math.floor(width / 3));
    var rows = [[], []];
    var dateRow = new Array(width);
    dateRow[Math.max(0, width - third)] = { v: 'Bát Xát, ngày ..... tháng ..... năm .........', s: XS.SIGN };
    rows.push(dateRow);

    var titleRow = new Array(width);
    titleRow[0] = { v: org.preparedByTitle, s: XS.SIGN };
    titleRow[third] = { v: org.checkedByTitle, s: XS.SIGN };
    titleRow[Math.min(width - 1, third * 2)] = { v: org.approvedByTitle, s: XS.SIGN };
    rows.push(titleRow);

    var hintRow = new Array(width);
    hintRow[0] = { v: '(Ký, ghi rõ họ tên)', s: XS.SIGN };
    hintRow[third] = { v: '(Ký, ghi rõ họ tên)', s: XS.SIGN };
    hintRow[Math.min(width - 1, third * 2)] = { v: '(Ký, ghi rõ họ tên)', s: XS.SIGN };
    rows.push(hintRow);
    rows.push([], [], []);

    var nameRow = new Array(width);
    nameRow[0] = { v: r.meta.preparedBy, s: XS.SIGN };
    rows.push(nameRow);
    rows.push([{ v: 'Biểu do hệ thống chấm công điện tử của Trạm Y tế Bát Xát lập lúc ' +
      r.meta.preparedAt + '. Ký hiệu trên biểu do đơn vị tự đặt trong phần Cài đặt.', s: XS.NOTE }]);
    return rows;
  }

  function headStyleFor(dayType) {
    return dayType === 'HOLIDAY' ? XS.HEAD_HOLIDAY : dayType === 'WEEKEND' ? XS.HEAD_WEEKEND : XS.HEAD;
  }

  function cellStyleFor(dayType) {
    return dayType === 'HOLIDAY' ? XS.CELL_HOLIDAY : dayType === 'WEEKEND' ? XS.CELL_WEEKEND : XS.TEXT_CENTER;
  }

  /** Sheet 1 - BẢNG CHẤM CÔNG THÁNG. */
  function timesheetSheet(r) {
    var days = r.meta.days;
    var fixed = ['STT', 'Mã CB', 'Họ và tên', 'Chức vụ', 'Bộ phận'];
    var tail = ['Tổng ngày công HC', 'Tổng giờ công HC', 'Nghỉ phép', 'Nghỉ khác',
      'Nghỉ không lý do', 'Tổng số ca trực', 'Tổng giờ trực', 'Trực ngày thường',
      'Trực T7, CN', 'Trực lễ, Tết', 'Ngày công quy đổi từ trực', 'Ghi chú'];
    var width = fixed.length + days.length + tail.length;
    var header = excelHeaderRows(r, width);
    var rows = header.rows.slice();

    rows.push(
      fixed.map(function (h) { return { v: h, s: XS.HEAD }; })
        .concat(days.map(function (d) { return { v: String(d.day), s: headStyleFor(d.dayType) }; }))
        .concat(tail.map(function (h) { return { v: h, s: XS.HEAD }; }))
    );
    rows.push(
      fixed.map(function () { return { v: '', s: XS.HEAD }; })
        .concat(days.map(function (d) { return { v: d.weekdayShort, s: headStyleFor(d.dayType) }; }))
        .concat(tail.map(function () { return { v: '', s: XS.HEAD }; }))
    );
    var headerRow = header.headerRowCount + 1;
    var merges = header.merges.slice();
    for (var c = 0; c < fixed.length; c++) {
      merges.push(colName(c) + headerRow + ':' + colName(c) + (headerRow + 1));
    }
    for (var t = 0; t < tail.length; t++) {
      var col = colName(fixed.length + days.length + t);
      merges.push(col + headerRow + ':' + col + (headerRow + 1));
    }

    r.rows.forEach(function (row) {
      var tt = row.totals;
      rows.push([
        { v: row.index, s: XS.TEXT_CENTER, t: 'n' },
        { v: row.employee.code, s: XS.TEXT_CENTER },
        { v: row.employee.fullName, s: XS.TEXT },
        { v: row.employee.position, s: XS.TEXT },
        { v: row.employee.departmentName, s: XS.TEXT }
      ].concat(row.days.map(function (d, i) {
        return { v: d.symbol, s: cellStyleFor(days[i] ? days[i].dayType : d.dayType) };
      })).concat([
        { v: tt.adminDays, s: XS.NUMBER, t: 'n' },
        { v: tt.adminHours, s: XS.NUMBER, t: 'n' },
        { v: tt.annualLeaveDays, s: XS.NUMBER, t: 'n' },
        { v: tt.otherLeaveDays, s: XS.NUMBER, t: 'n' },
        { v: tt.absentDays, s: XS.NUMBER, t: 'n' },
        { v: tt.dutyShifts, s: XS.NUMBER, t: 'n' },
        { v: tt.dutyHours, s: XS.NUMBER, t: 'n' },
        { v: tt.dutyWeekday, s: XS.NUMBER, t: 'n' },
        { v: tt.dutyWeekend, s: XS.NUMBER, t: 'n' },
        { v: tt.dutyHoliday, s: XS.NUMBER, t: 'n' },
        { v: tt.convertedAdminDays, s: XS.NUMBER, t: 'n' },
        { v: row.note || '', s: XS.TEXT }
      ]));
    });

    var g = r.grandTotals;
    rows.push([
      { v: '', s: XS.TOTAL_NUMBER }, { v: '', s: XS.TOTAL_NUMBER },
      { v: 'TỔNG CỘNG', s: XS.TOTAL_TEXT }, { v: '', s: XS.TOTAL_TEXT }, { v: '', s: XS.TOTAL_TEXT }
    ].concat(days.map(function () { return { v: '', s: XS.TOTAL_NUMBER }; })).concat([
      { v: g.adminDays, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.adminHours, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.annualLeaveDays, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.otherLeaveDays, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.absentDays, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyShifts, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyHours, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyWeekday, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyWeekend, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyHoliday, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.convertedAdminDays, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: '', s: XS.TOTAL_TEXT }
    ]));

    var sym = r.meta.symbols;
    rows.push([]);
    rows.push([{ v: 'Ký hiệu: ' + sym.present + ' = có mặt (công hành chính); ' + sym.halfPresent + ' = nửa ngày; ' +
      sym.duty + ' = trực; ' + sym.leave + ' = nghỉ phép; ' + sym.absent + ' = nghỉ không lý do; ' +
      sym.missing + ' = thiếu lượt chấm; ' + sym.holiday + ' = ngày lễ; ' + sym.weekend + ' = cuối tuần; ' +
      sym.present + sym.separator + sym.duty + ' = vừa làm hành chính vừa trực.', s: XS.NOTE }]);
    rows.push([{ v: 'Công trực được ghi thành sổ riêng và KHÔNG cộng vào ngày công hành chính. ' +
      'Cột "Ngày công quy đổi từ trực" chỉ khác 0 khi đơn vị có quy định quy đổi cho ca trực đó.', s: XS.NOTE }]);
    excelSignatureRows(r, width).forEach(function (row) { rows.push(row); });

    var cols = [5, 8, 24, 16, 16].concat(days.map(function () { return 3.6; }))
      .concat([9, 9, 8, 8, 9, 8, 8, 9, 8, 8, 10, 26]);

    return {
      name: 'Chấm công ' + r.meta.period,
      xml: sheetXml(rows, {
        cols: cols, merges: merges, orientation: 'landscape', scale: 55,
        freeze: { x: 5, y: headerRow + 1 }
      })
    };
  }

  /** Sheet 2 - BẢNG TỔNG HỢP CHẤM TRỰC THÁNG. */
  function dutySheet(r) {
    var headers = ['STT', 'Mã CB', 'Họ và tên', 'Bộ phận', 'Ca trực ngày thường',
      'Ca trực cuối tuần', 'Ca trực ngày lễ, Tết', 'Tổng số ca', 'Tổng số giờ trực',
      'Đã bấm nhận ca', 'Chưa bấm nhận ca', 'Các ngày trực trong tháng'];
    var width = headers.length;
    var header = excelHeaderRows(r, width);
    var rows = header.rows.slice();
    rows.push(headers.map(function (h) { return { v: h, s: XS.HEAD }; }));

    r.rows.forEach(function (row) {
      rows.push([
        { v: row.index, s: XS.TEXT_CENTER, t: 'n' },
        { v: row.code, s: XS.TEXT_CENTER },
        { v: row.fullName, s: XS.TEXT },
        { v: row.departmentName, s: XS.TEXT },
        { v: row.dutyWeekday, s: XS.NUMBER, t: 'n' },
        { v: row.dutyWeekend, s: XS.NUMBER, t: 'n' },
        { v: row.dutyHoliday, s: XS.NUMBER, t: 'n' },
        { v: row.dutyShifts, s: XS.NUMBER, t: 'n' },
        { v: row.dutyHours, s: XS.NUMBER, t: 'n' },
        { v: row.dutyCheckedIn, s: XS.NUMBER, t: 'n' },
        { v: row.dutyNotCheckedIn, s: XS.NUMBER, t: 'n' },
        { v: row.dates.map(function (d) { return d.day; }).join(', '), s: XS.TEXT }
      ]);
    });

    var g = r.grandTotals;
    rows.push([
      { v: '', s: XS.TOTAL_NUMBER }, { v: '', s: XS.TOTAL_NUMBER },
      { v: 'TỔNG CỘNG', s: XS.TOTAL_TEXT }, { v: '', s: XS.TOTAL_TEXT },
      { v: g.dutyWeekday, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyWeekend, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyHoliday, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyShifts, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyHours, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyCheckedIn, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyShifts - g.dutyCheckedIn, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: '', s: XS.TOTAL_TEXT }
    ]);
    rows.push([]);
    rows.push([{ v: 'Biểu này chỉ chứa số liệu công trực. Số ca và số giờ trực lấy theo định mức của ca trực do đơn vị khai báo.', s: XS.NOTE }]);
    excelSignatureRows(r, width).forEach(function (row) { rows.push(row); });

    return {
      name: 'Chấm trực ' + r.meta.period,
      xml: sheetXml(rows, {
        cols: [5, 8, 24, 18, 11, 11, 11, 9, 10, 10, 10, 34],
        merges: header.merges, orientation: 'landscape', scale: 80,
        freeze: { x: 4, y: header.headerRowCount + 1 }
      })
    };
  }

  /** Sheet 3 - TỔNG HỢP CÔNG + TRỰC, hai nhóm cột tách rời. */
  function combinedSheet(r) {
    var width = 17;
    var header = excelHeaderRows(r, width);
    var rows = header.rows.slice();
    var headerRow = header.headerRowCount + 1;

    rows.push([
      { v: 'STT', s: XS.HEAD }, { v: 'Mã CB', s: XS.HEAD }, { v: 'Họ và tên', s: XS.HEAD },
      { v: 'Chức vụ', s: XS.HEAD }, { v: 'Bộ phận', s: XS.HEAD },
      { v: 'CÔNG HÀNH CHÍNH', s: XS.HEAD }, { v: '', s: XS.HEAD }, { v: '', s: XS.HEAD },
      { v: '', s: XS.HEAD }, { v: '', s: XS.HEAD },
      { v: 'CÔNG TRỰC (SỔ RIÊNG)', s: XS.HEAD }, { v: '', s: XS.HEAD }, { v: '', s: XS.HEAD },
      { v: '', s: XS.HEAD }, { v: '', s: XS.HEAD },
      { v: 'Ngày công quy đổi từ trực', s: XS.HEAD }, { v: 'Ghi chú', s: XS.HEAD }
    ]);
    rows.push([
      { v: '', s: XS.HEAD }, { v: '', s: XS.HEAD }, { v: '', s: XS.HEAD },
      { v: '', s: XS.HEAD }, { v: '', s: XS.HEAD },
      { v: 'Ngày công', s: XS.HEAD }, { v: 'Giờ công', s: XS.HEAD },
      { v: 'Nghỉ phép', s: XS.HEAD }, { v: 'Nghỉ khác', s: XS.HEAD }, { v: 'Nghỉ không lý do', s: XS.HEAD },
      { v: 'Ngày thường', s: XS.HEAD }, { v: 'Cuối tuần', s: XS.HEAD }, { v: 'Lễ, Tết', s: XS.HEAD },
      { v: 'Tổng ca', s: XS.HEAD }, { v: 'Tổng giờ', s: XS.HEAD },
      { v: '', s: XS.HEAD }, { v: '', s: XS.HEAD }
    ]);

    var merges = header.merges.concat([
      'F' + headerRow + ':J' + headerRow,
      'K' + headerRow + ':O' + headerRow
    ]);
    [0, 1, 2, 3, 4, 15, 16].forEach(function (c) {
      merges.push(colName(c) + headerRow + ':' + colName(c) + (headerRow + 1));
    });

    r.rows.forEach(function (row) {
      rows.push([
        { v: row.index, s: XS.TEXT_CENTER, t: 'n' },
        { v: row.code, s: XS.TEXT_CENTER },
        { v: row.fullName, s: XS.TEXT },
        { v: row.position, s: XS.TEXT },
        { v: row.departmentName, s: XS.TEXT },
        { v: row.adminDays, s: XS.NUMBER, t: 'n' },
        { v: row.adminHours, s: XS.NUMBER, t: 'n' },
        { v: row.annualLeaveDays, s: XS.NUMBER, t: 'n' },
        { v: row.otherLeaveDays, s: XS.NUMBER, t: 'n' },
        { v: row.absentDays, s: XS.NUMBER, t: 'n' },
        { v: row.dutyWeekday, s: XS.NUMBER, t: 'n' },
        { v: row.dutyWeekend, s: XS.NUMBER, t: 'n' },
        { v: row.dutyHoliday, s: XS.NUMBER, t: 'n' },
        { v: row.dutyShifts, s: XS.NUMBER, t: 'n' },
        { v: row.dutyHours, s: XS.NUMBER, t: 'n' },
        { v: row.convertedAdminDays, s: XS.NUMBER, t: 'n' },
        { v: row.note || '', s: XS.TEXT }
      ]);
    });

    var g = r.grandTotals;
    rows.push([
      { v: '', s: XS.TOTAL_NUMBER }, { v: '', s: XS.TOTAL_NUMBER },
      { v: 'TỔNG CỘNG', s: XS.TOTAL_TEXT }, { v: '', s: XS.TOTAL_TEXT }, { v: '', s: XS.TOTAL_TEXT },
      { v: g.adminDays, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.adminHours, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.annualLeaveDays, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.otherLeaveDays, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: '', s: XS.TOTAL_NUMBER },
      { v: g.dutyWeekday, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyWeekend, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyHoliday, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyShifts, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.dutyHours, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: g.convertedAdminDays, s: XS.TOTAL_NUMBER, t: 'n' },
      { v: '', s: XS.TOTAL_TEXT }
    ]);
    rows.push([]);
    rows.push([{ v: 'Hai nhóm cột nằm riêng và không cộng vào nhau: một ca trực không tự trở thành một ngày công hành chính.', s: XS.NOTE }]);
    excelSignatureRows(r, width).forEach(function (row) { rows.push(row); });

    return {
      name: 'Tổng hợp ' + r.meta.period,
      xml: sheetXml(rows, {
        cols: [5, 8, 24, 16, 16, 9, 9, 9, 9, 10, 10, 9, 8, 8, 9, 12, 30],
        merges: merges, orientation: 'landscape', scale: 70,
        freeze: { x: 5, y: headerRow + 1 }
      })
    };
  }

  /**
   * Xuất Excel: tải đủ cả ba báo cáo của kỳ đang xem rồi ghi thành một tệp ba
   * sheet, đúng ba biểu mà mục XI yêu cầu.
   */
  function exportExcel() {
    if (!S.report) return toast('Hãy lập báo cáo trước khi xuất tệp.', 'warn');
    var meta = S.report.meta;
    var query = { month: String(num(meta.period.slice(5, 7), 1)), year: meta.period.slice(0, 4) };
    var departmentId = el('ccReportDepartment').value;
    if (departmentId) query.departmentId = departmentId;
    var btn = el('ccExportExcel');
    btn.disabled = true;
    var label = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Đang tạo tệp...';

    Promise.all(['timesheet', 'duty', 'combined'].map(function (view) {
      var q = { view: view };
      Object.keys(query).forEach(function (k) { q[k] = query[k]; });
      return api('reports', { query: q });
    })).then(function (res) {
      var sheets = [timesheetSheet(res[0]), dutySheet(res[1]), combinedSheet(res[2])];
      downloadXlsx('Bang-cham-cong-cham-truc-' + meta.period + '.xlsx', sheets);
      toast('Đã tạo tệp Excel gồm ba biểu: bảng chấm công, bảng chấm trực và bảng tổng hợp.', 'success');
    }).catch(function (err) {
      toast(err.message || 'Không tạo được tệp Excel.', 'error');
      fail(err);
    }).then(function () {
      btn.disabled = false;
      btn.innerHTML = label;
    });
  }

  // -------------------------------------------------------------------------
  //  XUẤT PDF (mục XII) - dựng bản in A4 rồi gọi hộp thoại in của máy
  // -------------------------------------------------------------------------
  //  Dùng cơ chế in của trình duyệt thay vì một thư viện sinh PDF vì phông của
  //  các thư viện đó không có đủ dấu tiếng Việt. Đường "In / Lưu thành PDF" thì
  //  dùng đúng phông hệ thống, chữ có dấu hiển thị đúng, và trên iPhone cũng có
  //  sẵn lựa chọn lưu thành tệp PDF trong hộp thoại in.
  // -------------------------------------------------------------------------

  function exportPdf() {
    if (!S.report) return toast('Hãy lập báo cáo trước khi xuất PDF.', 'warn');
    var r = S.report;
    var meta = r.meta;
    var org = meta.org;

    var printable = r.kind === 'timesheet' ? printTimesheetTable(r)
      : r.kind === 'duty' ? printDutyTable(r) : printCombinedTable(r);

    el('ccPrint').innerHTML =
      '<div class="cc-print-doc">' +
      '<div style="text-align:center">' +
      '<div style="font-size:11pt">' + esc(org.parentName) + '</div>' +
      '<div style="font-size:12pt;font-weight:bold;text-transform:uppercase">' + esc(org.name) + '</div>' +
      '<div style="font-size:15pt;font-weight:bold;margin-top:8px">' + esc(r.title) + '</div>' +
      '<div style="font-size:12pt">' + esc(meta.periodLabel) + '</div>' +
      '<div style="font-size:10pt;font-style:italic">' + esc(meta.scopeLabel) + '</div>' +
      '</div>' +
      printable +
      printLegend(r) +
      printSignatures(r) +
      '</div>';

    // Chờ một nhịp vẽ để bảng có kích thước thật trước khi mở hộp thoại in.
    window.requestAnimationFrame(function () {
      window.setTimeout(function () { window.print(); }, 60);
    });
    toast('Trong hộp thoại in, chọn "Lưu thành PDF" (iPhone: Tuỳ chọn khác > Lưu vào Tệp) để có tệp PDF.', 'info', 7000);
  }

  function printTimesheetTable(r) {
    var days = r.meta.days;
    var g = r.grandTotals;
    return '<table class="cc-print-table"><thead>' +
      '<tr><th rowspan="2">STT</th><th rowspan="2">Họ và tên</th><th rowspan="2">Chức vụ</th>' +
      '<th colspan="' + days.length + '">Ngày trong tháng</th>' +
      '<th rowspan="2">Ngày công HC</th><th rowspan="2">Giờ công HC</th>' +
      '<th rowspan="2">Nghỉ phép</th><th rowspan="2">Nghỉ khác</th>' +
      '<th rowspan="2">Tổng ca trực</th><th rowspan="2">Giờ trực</th>' +
      '<th rowspan="2">Trực T7, CN</th><th rowspan="2">Trực lễ, Tết</th><th rowspan="2">Ghi chú</th></tr>' +
      '<tr>' + days.map(function (d) {
        return '<th class="' + printDayClass(d.dayType) + '">' + d.day + '</th>';
      }).join('') + '</tr></thead><tbody>' +
      r.rows.map(function (row) {
        var t = row.totals;
        return '<tr><td class="c">' + row.index + '</td><td>' + esc(row.employee.fullName) + '</td>' +
          '<td>' + esc(row.employee.position) + '</td>' +
          row.days.map(function (d, i) {
            return '<td class="c ' + printDayClass(days[i] ? days[i].dayType : d.dayType) + '">' + esc(d.symbol) + '</td>';
          }).join('') +
          '<td class="c b">' + esc(fmtNum(t.adminDays)) + '</td><td class="c">' + esc(fmtNum(t.adminHours)) + '</td>' +
          '<td class="c">' + esc(fmtNum(t.annualLeaveDays)) + '</td><td class="c">' + esc(fmtNum(t.otherLeaveDays)) + '</td>' +
          '<td class="c b">' + t.dutyShifts + '</td><td class="c">' + esc(fmtNum(t.dutyHours)) + '</td>' +
          '<td class="c">' + t.dutyWeekend + '</td><td class="c">' + t.dutyHoliday + '</td>' +
          '<td>' + esc(row.note || '') + '</td></tr>';
      }).join('') +
      '<tr class="cc-print-total"><td colspan="3">TỔNG CỘNG</td>' +
      '<td colspan="' + days.length + '"></td>' +
      '<td class="c">' + esc(fmtNum(g.adminDays)) + '</td><td class="c">' + esc(fmtNum(g.adminHours)) + '</td>' +
      '<td class="c">' + esc(fmtNum(g.annualLeaveDays)) + '</td><td class="c">' + esc(fmtNum(g.otherLeaveDays)) + '</td>' +
      '<td class="c">' + g.dutyShifts + '</td><td class="c">' + esc(fmtNum(g.dutyHours)) + '</td>' +
      '<td class="c">' + g.dutyWeekend + '</td><td class="c">' + g.dutyHoliday + '</td><td></td></tr>' +
      '</tbody></table>';
  }

  function printDutyTable(r) {
    var g = r.grandTotals;
    return '<table class="cc-print-table"><thead><tr>' +
      '<th>STT</th><th>Họ và tên</th><th>Bộ phận</th><th>Ca ngày thường</th>' +
      '<th>Ca cuối tuần</th><th>Ca lễ, Tết</th><th>Tổng số ca</th><th>Tổng số giờ</th><th>Các ngày trực</th>' +
      '</tr></thead><tbody>' +
      r.rows.map(function (row) {
        return '<tr><td class="c">' + row.index + '</td><td>' + esc(row.fullName) + '</td>' +
          '<td>' + esc(row.departmentName) + '</td>' +
          '<td class="c">' + row.dutyWeekday + '</td><td class="c">' + row.dutyWeekend + '</td>' +
          '<td class="c">' + row.dutyHoliday + '</td><td class="c b">' + row.dutyShifts + '</td>' +
          '<td class="c">' + esc(fmtNum(row.dutyHours)) + '</td>' +
          '<td>' + esc(row.dates.map(function (d) { return d.day; }).join(', ')) + '</td></tr>';
      }).join('') +
      '<tr class="cc-print-total"><td colspan="3">TỔNG CỘNG</td>' +
      '<td class="c">' + g.dutyWeekday + '</td><td class="c">' + g.dutyWeekend + '</td>' +
      '<td class="c">' + g.dutyHoliday + '</td><td class="c">' + g.dutyShifts + '</td>' +
      '<td class="c">' + esc(fmtNum(g.dutyHours)) + '</td><td></td></tr></tbody></table>';
  }

  function printCombinedTable(r) {
    var g = r.grandTotals;
    return '<table class="cc-print-table"><thead>' +
      '<tr><th rowspan="2">STT</th><th rowspan="2">Họ và tên</th><th rowspan="2">Chức vụ</th><th rowspan="2">Bộ phận</th>' +
      '<th colspan="4">Công hành chính</th><th colspan="5">Công trực (sổ riêng)</th>' +
      '<th rowspan="2">Quy đổi</th><th rowspan="2">Ghi chú</th></tr>' +
      '<tr><th>Ngày công</th><th>Giờ công</th><th>Nghỉ phép</th><th>Nghỉ khác</th>' +
      '<th>Ngày thường</th><th>Cuối tuần</th><th>Lễ, Tết</th><th>Tổng ca</th><th>Tổng giờ</th></tr>' +
      '</thead><tbody>' +
      r.rows.map(function (row) {
        return '<tr><td class="c">' + row.index + '</td><td>' + esc(row.fullName) + '</td>' +
          '<td>' + esc(row.position) + '</td><td>' + esc(row.departmentName) + '</td>' +
          '<td class="c b">' + esc(fmtNum(row.adminDays)) + '</td><td class="c">' + esc(fmtNum(row.adminHours)) + '</td>' +
          '<td class="c">' + esc(fmtNum(row.annualLeaveDays)) + '</td><td class="c">' + esc(fmtNum(row.otherLeaveDays)) + '</td>' +
          '<td class="c">' + row.dutyWeekday + '</td><td class="c">' + row.dutyWeekend + '</td>' +
          '<td class="c">' + row.dutyHoliday + '</td><td class="c b">' + row.dutyShifts + '</td>' +
          '<td class="c">' + esc(fmtNum(row.dutyHours)) + '</td>' +
          '<td class="c">' + (row.convertedAdminDays ? esc(fmtNum(row.convertedAdminDays)) : '') + '</td>' +
          '<td>' + esc(row.note || '') + '</td></tr>';
      }).join('') +
      '<tr class="cc-print-total"><td colspan="4">TỔNG CỘNG</td>' +
      '<td class="c">' + esc(fmtNum(g.adminDays)) + '</td><td class="c">' + esc(fmtNum(g.adminHours)) + '</td>' +
      '<td class="c">' + esc(fmtNum(g.annualLeaveDays)) + '</td><td class="c">' + esc(fmtNum(g.otherLeaveDays)) + '</td>' +
      '<td class="c">' + g.dutyWeekday + '</td><td class="c">' + g.dutyWeekend + '</td>' +
      '<td class="c">' + g.dutyHoliday + '</td><td class="c">' + g.dutyShifts + '</td>' +
      '<td class="c">' + esc(fmtNum(g.dutyHours)) + '</td>' +
      '<td class="c">' + esc(fmtNum(g.convertedAdminDays)) + '</td><td></td></tr></tbody></table>';
  }

  function printDayClass(dayType) {
    return dayType === 'HOLIDAY' ? 'cc-print-holiday' : dayType === 'WEEKEND' ? 'cc-print-weekend' : '';
  }

  function printLegend(r) {
    if (r.kind === 'duty') {
      return '<p class="cc-print-note">Biểu này chỉ chứa số liệu công trực, không có số liệu công hành chính.</p>';
    }
    var s = r.meta.symbols;
    return '<p class="cc-print-note">Ký hiệu: <strong>' + esc(s.present) + '</strong> có mặt; <strong>' +
      esc(s.halfPresent) + '</strong> nửa ngày; <strong>' + esc(s.duty) + '</strong> trực; <strong>' +
      esc(s.leave) + '</strong> nghỉ phép; <strong>' + esc(s.absent) + '</strong> nghỉ không lý do; <strong>' +
      esc(s.missing) + '</strong> thiếu lượt chấm; <strong>' + esc(s.present + s.separator + s.duty) +
      '</strong> vừa làm hành chính vừa trực. Ô vàng là thứ Bảy, Chủ nhật; ô đỏ là ngày nghỉ lễ. ' +
      'Công trực là sổ riêng, không cộng vào ngày công hành chính.</p>';
  }

  function printSignatures(r) {
    var org = r.meta.org;
    return '<div class="cc-print-date">Bát Xát, ngày ..... tháng ..... năm .........</div>' +
      '<table class="cc-print-sign"><tr>' +
      '<td><div class="t">' + esc(org.preparedByTitle) + '</div><div class="h">(Ký, ghi rõ họ tên)</div>' +
      '<div class="n">' + esc(r.meta.preparedBy) + '</div></td>' +
      '<td><div class="t">' + esc(org.checkedByTitle) + '</div><div class="h">(Ký, ghi rõ họ tên)</div><div class="n"></div></td>' +
      '<td><div class="t">' + esc(org.approvedByTitle) + '</div><div class="h">(Ký, ghi rõ họ tên)</div><div class="n"></div></td>' +
      '</tr></table>';
  }

  // =========================================================================
  //  CÀI LÊN MÀN HÌNH CHÍNH (Web App / PWA)
  // =========================================================================
  //  Không làm ứng dụng riêng ở giai đoạn này. Trang này tự khai báo manifest
  //  và service worker riêng trong phạm vi /chamcong, nên thêm vào màn hình
  //  chính là mở ra toàn màn hình, bấm công nhanh như một ứng dụng thật.
  // =========================================================================

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      // iPad từ iPadOS 13 báo là Macintosh nhưng có cảm ứng.
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function setupInstall() {
    var bar = el('ccInstallBar');
    var hint = el('ccInstallHint');
    var hintText = el('ccInstallHintText');

    if (isStandalone()) return;

    if (isIos()) {
      // Safari trên iPhone không có beforeinstallprompt, phải hướng dẫn bằng lời.
      hintText.textContent = 'Trên iPhone và iPad: bấm nút Chia sẻ ở thanh dưới của Safari, ' +
        'chọn "Thêm vào MH chính" để dùng như một ứng dụng.';
      hint.classList.remove('hidden');
      return;
    }

    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      S.installEvent = event;
      if (window.localStorage.getItem('tyt-chamcong-install-dismissed') === '1') return;
      bar.classList.remove('hidden');
    });

    window.addEventListener('appinstalled', function () {
      S.installEvent = null;
      bar.classList.add('hidden');
      toast('Đã thêm Chấm công TYT vào màn hình chính.', 'success');
    });
  }

  function doInstall() {
    var bar = el('ccInstallBar');
    if (!S.installEvent) {
      bar.classList.add('hidden');
      return toast('Thiết bị này chưa hỗ trợ thêm tự động. Hãy dùng menu của trình duyệt và chọn "Thêm vào màn hình chính".', 'info', 6000);
    }
    S.installEvent.prompt();
    S.installEvent.userChoice.then(function () {
      S.installEvent = null;
      bar.classList.add('hidden');
    });
  }

  function dismissInstall() {
    el('ccInstallBar').classList.add('hidden');
    try {
      window.localStorage.setItem('tyt-chamcong-install-dismissed', '1');
    } catch (err) { /* chế độ riêng tư chặn ghi thì thôi, chỉ mất việc ghi nhớ */ }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Phạm vi /chamcong để service worker của phân hệ này không đụng tới
    // service worker thông báo của trang chính.
    navigator.serviceWorker.register('/chamcong-sw.js', { scope: '/chamcong' })
      .catch(function () { /* thiếu service worker thì phân hệ vẫn chạy bình thường */ });
  }

  // =========================================================================
  //  GẮN SỰ KIỆN
  // =========================================================================
  //  Toàn bộ trang không dùng một thuộc tính onclick nào. Các nút cố định gắn
  //  trực tiếp; các nút do JavaScript sinh ra được xử lý qua một bộ điều phối
  //  đọc data-cc-act, nên thêm nút mới không phải sửa chỗ gắn sự kiện.
  // =========================================================================

  /** Bảng điều phối: tên thao tác -> việc cần làm, đọc dữ liệu từ data-*. */
  var ACTIONS = {
    'modal-submit': function () { if (modalSubmit) modalSubmit(); },
    'modal-cancel': function () { closeModal(); },
    'more-menu': function () { openMoreMenu(); },
    'go-view': function (node) { closeModal(); go(node.getAttribute('data-view')); },
    'go-change-password': function () { closeModal(); openChangePassword(false); },
    'go-logout': function () { closeModal(); doLogout(); },

    // Trang chủ
    'duty-in': function (node) { doDutyCheck(node.getAttribute('data-id'), 'in'); },
    'duty-out': function (node) { doDutyCheck(node.getAttribute('data-id'), 'out'); },

    // Yêu cầu của cán bộ
    'cancel-request': function (node) { cancelRequest(node.getAttribute('data-id')); },
    'cancel-leave': function (node) { cancelLeave(node.getAttribute('data-id')); },

    // Theo dõi và duyệt
    'employee-detail': function (node) { openEmployeeDetail(node.getAttribute('data-id'), null); },
    'decide-request': function (node) {
      decide('decide-request', node.getAttribute('data-id'), node.getAttribute('data-decision'));
    },
    'decide-leave': function (node) {
      decide('decide-leave', node.getAttribute('data-id'), node.getAttribute('data-decision'));
    },
    'detail-period': function (node) {
      openEmployeeDetail(node.getAttribute('data-id'), node.getAttribute('data-period'));
    },
    'punch-add': function (node) {
      openPunchForm(node.getAttribute('data-id'), node.getAttribute('data-period'));
    },
    'leave-add': function (node) { openLeaveAdminForm(node.getAttribute('data-id')); },
    'punch-delete': function (node) {
      var id = node.getAttribute('data-id');
      var ctx = S.detail || {};
      confirmBox('Xoá lượt chấm công này? Thao tác được ghi vào lịch sử và không lấy lại được.', function () {
        api('admin', { body: { action: 'punch_delete', id: id } }).then(function (data) {
          toast(data.message, 'success');
          if (ctx.employeeId) openEmployeeDetail(ctx.employeeId, ctx.period); else closeModal();
        }).catch(fail);
      }, 'Xoá');
    },

    // Cán bộ
    'emp-new': function () { openEmployeeForm(null); },
    'emp-edit': function (node) { openEmployeeForm(node.getAttribute('data-id')); },
    'emp-delete': function (node) {
      var id = node.getAttribute('data-id');
      confirmBox('Xoá hồ sơ cán bộ này? Nếu cán bộ đã có dữ liệu chấm công, hệ thống chỉ chuyển sang trạng thái Ngừng làm việc để bảng công các tháng trước không bị mất người.', function () {
        api('admin', { body: { action: 'employee_delete', id: id } }).then(function (data) {
          closeModal();
          toast(data.message, 'success');
          renderAdmin();
        }).catch(fail);
      }, 'Xoá');
    },
    'emp-account': function (node) { openCreateAccountForm(node.getAttribute('data-id')); },
    'emp-unlink': function (node) {
      var id = node.getAttribute('data-id');
      confirmBox('Bỏ gán tài khoản khỏi hồ sơ cán bộ này? Cán bộ sẽ không đăng nhập chấm công được nữa nhưng vẫn còn trên bảng công.', function () {
        api('admin', { body: { action: 'account_unlink', employeeId: id } }).then(function (data) {
          closeModal();
          toast(data.message, 'success');
          renderAdmin();
        }).catch(fail);
      }, 'Bỏ gán');
    },

    // Bộ phận
    'dept-new': function () { openDepartmentForm(null); },
    'dept-edit': function (node) { openDepartmentForm(node.getAttribute('data-id')); },
    'dept-delete': function (node) {
      var id = node.getAttribute('data-id');
      confirmBox('Xoá bộ phận này? Bộ phận còn cán bộ sẽ không xoá được.', function () {
        api('admin', { body: { action: 'department_delete', id: id } }).then(function (data) {
          closeModal();
          toast(data.message, 'success');
          renderAdmin();
        }).catch(fail);
      }, 'Xoá');
    },

    // Tài khoản
    'acc-grant': function (node) {
      var id = node.getAttribute('data-id');
      var granted = node.getAttribute('data-granted') === '1';
      confirmBox(granted
        ? 'Cấp quyền vào phân hệ Chấm công cho tài khoản này?'
        : 'Thu hồi quyền vào phân hệ Chấm công của tài khoản này? Quyền mất hiệu lực ngay ở thao tác kế tiếp của người đó.',
        function () {
          api('admin', { body: { action: 'account_grant', userId: id, granted: granted } }).then(function (data) {
            closeModal();
            toast(data.message, 'success');
            renderAdmin();
          }).catch(fail);
        }, granted ? 'Cấp quyền' : 'Thu hồi');
    },
    'acc-link': function (node) { openLinkAccountForm(node.getAttribute('data-id')); },
    'acc-reset': function (node) {
      var id = node.getAttribute('data-id');
      openModal('Đặt lại mật khẩu',
        '<p class="text-sm text-slate-600 mb-3">Mật khẩu mới có hiệu lực ngay và cán bộ bắt buộc đổi lại ở lần đăng nhập kế tiếp.</p>' +
        field('Mật khẩu mới', input('password', '', 'text'), 'Để trống thì hệ thống tự sinh mật khẩu tạm.') +
        submitRow('Đặt lại mật khẩu'),
        function () {
          var v = modalValues();
          api('admin', { body: { action: 'account_reset_password', userId: id, password: v.password } })
            .then(function (data) {
              closeModal();
              showTemporaryPassword(data.message, data.temporaryPassword, '');
            }).catch(fail);
        });
    },

    // Thời gian làm việc
    'worktime-save': function () { saveWorkTime(); },
    'admin-refresh': function () { renderAdmin(); },

    // Ca trực
    'shift-new': function () { openShiftForm(null); },
    'shift-edit': function (node) { openShiftForm(node.getAttribute('data-id')); },
    'shift-delete': function (node) {
      var id = node.getAttribute('data-id');
      confirmBox('Xoá ca trực này? Ca đã được dùng trong lịch trực sẽ chỉ chuyển sang trạng thái Ngừng dùng.', function () {
        api('admin', { body: { action: 'shift_delete', id: id } }).then(function (data) {
          closeModal();
          toast(data.message, 'success');
          renderAdmin();
        }).catch(fail);
      }, 'Xoá');
    },
    'shift-seed': function () {
      confirmBox('Nạp danh mục ca trực mẫu (trực đêm thường, trực ngày, trực cuối tuần, trực ngày lễ)? Các ca đang có không bị thay đổi, đơn vị vẫn sửa lại giờ theo quy định của mình.', function () {
        api('admin', { body: { action: 'seed_defaults' } }).then(function (data) {
          closeModal();
          toast(data.message, 'success');
          renderAdmin();
        }).catch(fail);
      }, 'Nạp ca mẫu');
    },

    // Ngày nghỉ, lễ
    'holiday-new': function () { openHolidayForm(null); },
    'holiday-edit': function (node) { openHolidayForm(node.getAttribute('data-id')); },
    'holiday-delete': function (node) {
      var id = node.getAttribute('data-id');
      confirmBox('Xoá ngày nghỉ này khỏi danh mục? Bảng công của các tháng liên quan sẽ được tính lại theo danh mục mới.', function () {
        api('admin', { body: { action: 'holiday_delete', id: id } }).then(function (data) {
          closeModal();
          toast(data.message, 'success');
          renderAdmin();
        }).catch(fail);
      }, 'Xoá');
    },

    // Ký hiệu, loại nghỉ, đơn vị
    'symbols-save': function () { saveSymbols(); },
    'org-save': function () { saveOrg(); },
    'leavetype-new': function () { openLeaveTypeForm(null); },
    'leavetype-edit': function (node) { openLeaveTypeForm(node.getAttribute('data-id')); },
    'leavetype-delete': function (node) { deleteLeaveType(node.getAttribute('data-id')); },

    // Lịch trực
    'roster-load': function () { loadAdminRoster(el('ccAdminBody'), rosterPeriod()); },
    'roster-add': function (node) { openRosterAssignForm(node.getAttribute('data-date')); },
    'roster-remove': function (node) {
      var id = node.getAttribute('data-id');
      var period = rosterPeriod();
      api('admin', { body: { action: 'roster_remove', id: id } }).then(function (data) {
        toast(data.message, 'success');
        loadAdminRoster(el('ccAdminBody'), period);
      }).catch(fail);
    },
    'roster-copy': function () {
      var period = rosterPeriod();
      confirmBox('Sao chép lịch trực của tháng trước sang ' + periodLabel(period) +
        '? Các suất đã có trong tháng này được giữ nguyên, hệ thống chỉ thêm những suất còn thiếu theo đúng thứ tự ngày.',
        function () {
          api('admin', { body: { action: 'roster_copy_previous', period: period } }).then(function (data) {
            closeModal();
            toast(data.message, 'success');
            loadAdminRoster(el('ccAdminBody'), period);
          }).catch(fail);
        }, 'Sao chép');
    },
    'roster-auto': function () { openRosterAutoForm(); },
    'roster-import': function () { openRosterImportForm(); },

    // Khoá kỳ
    'period-lock': function (node) { openPeriodLock(node.getAttribute('data-id'), true); },
    'period-unlock': function (node) { openPeriodLock(node.getAttribute('data-id'), false); },
    'period-lock-new': function () { openPeriodLock(null, true); }
  };

  function bindEvents() {
    // --- Đăng nhập ---
    el('ccLoginForm').addEventListener('submit', function (event) {
      event.preventDefault();
      doLogin();
    });
    el('ccTogglePassword').addEventListener('click', function () {
      var field2 = el('ccLoginPassword');
      var icon = qs('i', el('ccTogglePassword'));
      var showing = field2.type === 'text';
      field2.type = showing ? 'password' : 'text';
      if (icon) icon.className = showing ? 'fas fa-eye' : 'fas fa-eye-slash';
    });

    // --- Thanh trên và thanh bên ---
    el('ccLogoutBtn').addEventListener('click', doLogout);
    el('ccChangePasswordBtn').addEventListener('click', function () { openChangePassword(false); });
    el('ccRefreshBtn').addEventListener('click', refreshAll);
    el('ccNotifyBtn').addEventListener('click', function () { go('notifications'); });
    el('ccMobileMenuBtn').addEventListener('click', openMoreMenu);

    // --- Trang chủ: hai nút chấm công ---
    el('ccPunchInBtn').addEventListener('click', function () { doPunch('IN'); });
    el('ccPunchOutBtn').addEventListener('click', function () { doPunch('OUT'); });

    // --- Lịch trực ---
    el('ccDutyReload').addEventListener('click', loadDutySchedule);
    el('ccDutyPeriod').addEventListener('change', loadDutySchedule);
    el('ccDutyScope').addEventListener('change', loadDutySchedule);

    // --- Bảng công cá nhân ---
    el('ccSheetReload').addEventListener('click', loadMyTimesheet);
    el('ccSheetPeriod').addEventListener('change', loadMyTimesheet);

    // --- Yêu cầu ---
    el('ccNewAdjustBtn').addEventListener('click', function () { openAdjustForm(); });
    el('ccNewSwapBtn').addEventListener('click', function () { openSwapForm(); });
    el('ccNewLeaveBtn').addEventListener('click', function () { openLeaveForm(); });

    // --- Theo dõi bộ phận ---
    el('ccManageReload').addEventListener('click', loadOverview);
    el('ccApprovalReload').addEventListener('click', loadApprovals);
    el('ccApprovalStatus').addEventListener('change', loadApprovals);

    // --- Báo cáo ---
    el('ccReportRun').addEventListener('click', runReport);
    el('ccReportKind').addEventListener('change', runReport);
    el('ccExportExcel').addEventListener('click', exportExcel);
    el('ccExportPdf').addEventListener('click', exportPdf);

    // --- Thông báo ---
    el('ccMarkAllRead').addEventListener('click', markNotificationsRead);

    // --- Hộp thoại ---
    el('ccModalClose').addEventListener('click', closeModal);
    el('ccModal').addEventListener('click', function (event) {
      // Bấm ra ngoài khung để đóng, bấm trong khung thì không.
      if (event.target === el('ccModal')) closeModal();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !el('ccModal').classList.contains('hidden')) closeModal();
    });

    // --- Cài lên màn hình chính ---
    el('ccInstallBtn').addEventListener('click', doInstall);
    el('ccInstallDismiss').addEventListener('click', dismissInstall);

    // --- Bộ điều phối cho mọi nút do JavaScript sinh ra ---
    document.addEventListener('click', function (event) {
      var node = event.target.closest('[data-cc-act], [data-cc-view], [data-cc-tab]');
      if (!node) return;

      var tab = node.getAttribute('data-cc-tab');
      if (tab) {
        S.adminTab = tab;
        renderAdmin();
        return;
      }

      var view = node.getAttribute('data-cc-view');
      if (view) {
        closeModal();
        go(view);
        return;
      }

      var act = node.getAttribute('data-cc-act');
      var handler = ACTIONS[act];
      if (handler) {
        event.preventDefault();
        handler(node);
      }
    });

    // Enter trong hộp thoại một dòng cũng gửi được, cho nhanh trên máy tính.
    el('ccModalBody').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.shiftKey) return;
      if (event.target.tagName === 'TEXTAREA') return;
      if (!modalSubmit) return;
      event.preventDefault();
      modalSubmit();
    });

    // Quay lại phân hệ sau khi khoá màn hình: làm mới số liệu để hai nút chấm
    // công không còn ở trạng thái của lần mở trước.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!S.session || el('ccApp').classList.contains('hidden')) return;
      refreshToday();
    });
  }

  // =========================================================================
  //  KHỞI ĐỘNG
  // =========================================================================

  function start() {
    bindEvents();
    setupInstall();
    registerServiceWorker();

    var org = (S.settings && S.settings.org && S.settings.org.name) || 'TRẠM Y TẾ BÁT XÁT';
    el('ccLoginOrg').textContent = org;

    var saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(SESSION_KEY) || 'null');
    } catch (err) {
      saved = null;
    }
    if (saved && saved.token && saved.expiresAt > Date.now()) {
      S.session = saved;
      boot();
    } else {
      window.localStorage.removeItem(SESSION_KEY);
      el('ccLogin').classList.remove('hidden');
      el('ccLoginUsername').focus();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
