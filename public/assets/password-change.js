/**
 * Hộp Đổi mật khẩu dùng chung cho mọi cổng đăng nhập của Trạm Y tế Bát Xát
 * (CMS, Bảng điều khiển trạm, Module Bác sĩ, Chấm công).
 *
 * 1. Bắt buộc đổi mật khẩu tạm. Khi /api/station-auth hoặc /api/auth/login trả
 *    403 PASSWORD_CHANGE_REQUIRED (tài khoản đang giữ mật khẩu tạm do Quản trị
 *    cấp), tệp này mở hộp đặt mật khẩu riêng ngay tại chỗ, đổi mật khẩu qua
 *    action=change_password rồi gửi lại đúng lượt đăng nhập đó bằng mật khẩu
 *    mới. Nơi gọi fetch nhận về kết quả của lượt đăng nhập mới, nên các trang
 *    không phải sửa luồng đăng nhập riêng của mình. Bấm Huỷ thì nơi gọi nhận
 *    nguyên phản hồi 403 kèm thông báo.
 * 2. Tự đổi mật khẩu: TytPasswordChange.open({ username, onDone }).
 *
 * Mật khẩu chỉ nằm trong ô nhập và trong thân yêu cầu gửi tới máy chủ: không
 * ghi vào bộ nhớ trình duyệt, không ghi log.
 */
(function () {
  'use strict';
  if (window.TytPasswordChange) return;

  var nativeFetch = window.fetch.bind(window);
  var LOGIN_URL = /\/api\/(station-auth|auth\/login)\/?(\?|$)/;

  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text) n.textContent = text;
    return n;
  }

  function field(label, type, autocomplete) {
    var wrap = el('label', 'display:block;margin:10px 0 0;font-size:13px;font-weight:600;color:#1e293b', label);
    var input = el('input', 'display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:9px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px');
    input.type = type;
    input.autocomplete = autocomplete;
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function localCheck(pw, confirm) {
    if (pw.length < 8) return 'Mật khẩu phải có tối thiểu 8 ký tự.';
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Mật khẩu phải gồm cả chữ và số.';
    if (pw !== confirm) return 'Hai lần nhập mật khẩu mới không giống nhau.';
    return '';
  }

  /**
   * Mở hộp đổi mật khẩu. Trả về Promise<string|null>: mật khẩu mới khi đổi
   * thành công, null khi người dùng huỷ.
   *   opts.username         tên đăng nhập (bỏ trống thì hiện ô nhập)
   *   opts.currentPassword  đã biết (luồng bắt buộc) thì không hỏi lại
   *   opts.forced           luồng mật khẩu tạm
   */
  function openDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = el('div', 'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      var box = el('form', 'background:#fff;border-radius:14px;max-width:400px;width:100%;padding:20px 20px 16px;box-shadow:0 20px 50px rgba(0,0,0,.3)');
      box.noValidate = true;
      box.appendChild(el('h2', 'margin:0;font-size:17px;font-weight:800;color:#1e3a8a', opts.forced ? 'Đặt mật khẩu riêng' : 'Đổi mật khẩu'));
      box.appendChild(el('p', 'margin:6px 0 0;font-size:13px;line-height:1.45;color:#475569', opts.forced
        ? 'Tài khoản đang dùng mật khẩu tạm do Quản trị cấp. Hãy đặt mật khẩu riêng (tối thiểu 8 ký tự, gồm chữ và số) để tiếp tục. Không chia sẻ mật khẩu với người khác.'
        : 'Sau khi đổi, mọi phiên đăng nhập của tài khoản sẽ kết thúc và bạn cần đăng nhập lại bằng mật khẩu mới.'));

      var user = null;
      if (!opts.username) {
        user = field('Tên đăng nhập', 'text', 'username');
        box.appendChild(user.wrap);
      }
      var current = null;
      if (!opts.currentPassword) {
        current = field('Mật khẩu hiện tại', 'password', 'current-password');
        box.appendChild(current.wrap);
      }
      var next = field('Mật khẩu mới', 'password', 'new-password');
      var again = field('Nhập lại mật khẩu mới', 'password', 'new-password');
      box.appendChild(next.wrap);
      box.appendChild(again.wrap);

      var msg = el('p', 'min-height:18px;margin:10px 0 0;font-size:13px;color:#b91c1c');
      msg.setAttribute('aria-live', 'polite');
      box.appendChild(msg);

      var row = el('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px');
      var cancel = el('button', 'padding:9px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-weight:600;cursor:pointer', 'Huỷ');
      cancel.type = 'button';
      var ok = el('button', 'padding:9px 14px;border-radius:8px;border:0;background:#1e3a8a;color:#fff;font-weight:700;cursor:pointer', 'Lưu mật khẩu');
      ok.type = 'submit';
      row.appendChild(cancel);
      row.appendChild(ok);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      (user || current || next).input.focus();

      function close(value) {
        overlay.remove();
        resolve(value);
      }
      cancel.addEventListener('click', function () { close(null); });

      box.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var username = opts.username || (user ? user.input.value.trim() : '');
        var currentPassword = opts.currentPassword || (current ? current.input.value : '');
        var newPassword = next.input.value;
        if (!username || !currentPassword) { msg.textContent = 'Vui lòng nhập đủ thông tin.'; return; }
        var problem = localCheck(newPassword, again.input.value);
        if (problem) { msg.textContent = problem; return; }
        ok.disabled = true;
        msg.style.color = '#475569';
        msg.textContent = 'Đang lưu...';
        nativeFetch('/api/station-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'change_password', username: username, currentPassword: currentPassword, newPassword: newPassword })
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok || data.success === false) throw new Error(data.error || data.message || 'Không đổi được mật khẩu.');
          });
        }).then(function () {
          close(newPassword);
        }).catch(function (err) {
          ok.disabled = false;
          msg.style.color = '#b91c1c';
          msg.textContent = err.message || 'Không đổi được mật khẩu.';
        });
      });
    });
  }

  function urlOf(input) {
    return typeof input === 'string' ? input : (input && input.url) || '';
  }

  window.fetch = function (input, init) {
    return nativeFetch(input, init).then(function (res) {
      if (res.status !== 403 || !LOGIN_URL.test(urlOf(input)) || !init || typeof init.body !== 'string') return res;
      var body;
      try { body = JSON.parse(init.body); } catch (e) { return res; }
      if (!body || body.action || !body.username || !body.password) return res;
      return res.clone().json().catch(function () { return null; }).then(function (data) {
        if (!data || data.code !== 'PASSWORD_CHANGE_REQUIRED') return res;
        return openDialog({ username: String(body.username), currentPassword: String(body.password), forced: true }).then(function (newPassword) {
          if (!newPassword) return res;
          var retry = Object.assign({}, init, { body: JSON.stringify(Object.assign({}, body, { password: newPassword })) });
          return nativeFetch(input, retry);
        });
      });
    });
  };

  window.TytPasswordChange = {
    /** Tự đổi mật khẩu. opts.onDone chạy sau khi đổi xong (thường là hàm đăng xuất). */
    open: function (opts) {
      opts = opts || {};
      return openDialog({ username: opts.username || '' }).then(function (newPassword) {
        if (!newPassword) return false;
        window.alert('Đã đổi mật khẩu. Vui lòng đăng nhập lại bằng mật khẩu mới.');
        if (typeof opts.onDone === 'function') opts.onDone();
        return true;
      });
    }
  };
})();
