/**
 * MODULE BÁC SĨ TUYẾN TRÊN - lớp vỏ của trang /bacsi
 * ============================================================================
 *
 * Nghiệp vụ khám từ xa (hàng đợi cuộc gọi, WebRTC, sinh hiệu, căn cước công dân,
 * trao đổi lâm sàng, trợ lý AI, kết xuất phiếu khám) dùng CHUNG bộ máy app.js với
 * Mod Bảng điều khiển điểm trạm. Nhờ vậy bác sĩ tuyến trên có đầy đủ đúng các
 * chức năng của điểm trạm và hai module không bao giờ lệch nhau khi sửa về sau.
 *
 * Tệp này chỉ lo phần mà app.js CỐ Ý để trống cho trang chủ quản:
 *
 *   1. Khai báo phạm vi module ("doctor") và danh mục điểm trạm.
 *   2. Rào chắn phiên đăng nhập RIÊNG của bác sĩ tuyến trên: giữ phiếu phiên,
 *      xác minh lại với máy chủ, mở/đóng buồng khám, đăng xuất.
 *   3. Cửa sổ (lớp phủ, phiếu khám A5) và thông báo nhanh.
 *   4. Chữ ký số & người kê đơn, đồng bộ kết luận hội chẩn sang điểm trạm.
 *   5. Bản in Đơn thuốc khổ A5 theo Mẫu số 01 - Thông tư 52/2017/TT-BYT.
 *
 * BẮT BUỘC nạp tệp này TRƯỚC app.js: app.js đọc window.STATION_MODULE_SCOPE và
 * window.TELEHEALTH_STATIONS ngay khi nó chạy.
 */
(function initDoctorModule() {
  'use strict';

  /* ==========================================================================
     1. PHẠM VI MODULE & DANH MỤC ĐIỂM TRẠM
     ========================================================================== */

  // app.js đọc biến này để chuyển sang chế độ Bác sĩ tuyến trên: vai trò trong
  // phòng khám là "doctor", đăng nhập gửi scope "doctor", danh sách tài khoản
  // lọc theo quyền doctor_access.
  window.STATION_MODULE_SCOPE = 'doctor';

  window.TELEHEALTH_STATIONS = [
    { code: 'TYT-BATXAT-01', name: 'Trạm Y tế Bát Xát (Trung tâm)' },
    { code: 'TYT-BATXAT-BQ-02', name: 'Điểm phòng khám Bản Qua' },
    { code: 'TYT-BATXAT-BV-03', name: 'Điểm phòng khám Bản Vược' },
    { code: 'TYT-BATXAT-QK-04', name: 'Điểm phòng khám Quang Kim' },
    { code: 'TYT-BATXAT-PN-05', name: 'Điểm phòng khám Phìn Ngan' }
  ];

  /** Đổ danh mục điểm trạm vào ô chọn lúc đăng nhập và ô đổi trạm trên thanh tiêu đề. */
  function fillStationSelects() {
    const options = window.TELEHEALTH_STATIONS
      .map(s => `<option value="${s.code}">${s.name} [${s.code}]</option>`)
      .join('');
    ['input-station-code', 'station-switcher'].forEach(id => {
      const sel = document.getElementById(id);
      if (sel && !sel.options.length) sel.innerHTML = options;
    });
  }

  /* ==========================================================================
     2. PHIÊN LÀM VIỆC RIÊNG CỦA BÁC SĨ TUYẾN TRÊN

     Phiếu phiên (JWT) được giữ trong sessionStorage: đóng thẻ trình duyệt là mất,
     đúng với đặc thù máy dùng chung ở cơ sở y tế. Khoá lưu KHÁC với khoá của
     Bảng điều khiển điểm trạm nên hai module không mượn phiên của nhau; máy chủ
     vẫn đọc lại quyền từ cơ sở dữ liệu theo từng yêu cầu, thu hồi quyền là phiên
     mất hiệu lực ngay ở lần gọi kế tiếp.
     ========================================================================== */

  const SESSION_KEY = 'tyt-doctor-session';
  const AUTH_URL = '/api/station-auth';
  let session = null;

  function readStoredSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.token) return null;
      if (parsed.expiresAt && Date.now() >= Number(parsed.expiresAt)) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function writeStoredSession(value) {
    try {
      if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (err) {
      // Trình duyệt chặn lưu trữ: phiên chỉ sống trong bộ nhớ của trang.
    }
  }

  /** app.js gắn phiếu này vào mọi lệnh gọi API cần xác thực. */
  window.getStationToken = function() {
    if (session && session.token) return session.token;
    const stored = readStoredSession();
    if (stored) session = stored;
    return (session && session.token) || '';
  };

  /** app.js gọi sau khi máy chủ xác thực xong tài khoản Bác sĩ tuyến trên. */
  window.setStationSession = function(value) {
    session = value || null;
    writeStoredSession(session);
    renderAuthUserBadge();
  };

  /** Máy chủ trả 401/403: phiên không còn hiệu lực, đóng buồng khám ngay. */
  window.handleStationAuthFailure = function(message) {
    session = null;
    writeStoredSession(null);
    if (typeof window.stopQueuePolling === 'function') window.stopQueuePolling();
    hideConsole();
    if (typeof window.openLoginModal === 'function') window.openLoginModal();
    setLoginNotice(message || 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  };

  function renderAuthUserBadge() {
    const wrap = document.getElementById('station-auth-user');
    const nameEl = document.getElementById('station-auth-user-name');
    if (!wrap || !nameEl) return;
    if (session && (session.name || session.username)) {
      nameEl.textContent = session.name || session.username;
      wrap.classList.remove('hidden');
      wrap.classList.add('flex');
    } else {
      wrap.classList.add('hidden');
      wrap.classList.remove('flex');
    }
  }

  function setLoginNotice(message) {
    const el = document.getElementById('station-login-status');
    if (!el) return;
    el.className = 'text-[11px] font-bold text-rose-400';
    el.textContent = '⛔ ' + message;
  }

  /**
   * Xác minh lại phiếu phiên với máy chủ khi mở trang.
   *
   * Không tin phiếu đang giữ trong máy: máy chủ đọc quyền tươi từ cơ sở dữ liệu
   * và phải trả về phạm vi "doctor" thì buồng khám mới mở. Tài khoản chỉ có
   * quyền điểm trạm, tài khoản đã bị khoá hay đã bị Quản trị gỡ quyền đều rơi
   * lại về cổng đăng nhập.
   */
  async function restoreSession() {
    const stored = readStoredSession();
    if (!stored) return false;
    session = stored;

    try {
      const res = await fetch(AUTH_URL, { headers: { Authorization: `Bearer ${stored.token}` } });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.success !== true) throw new Error('unauthenticated');

      const scopes = Array.isArray(data.scopes) ? data.scopes : [];
      if (!scopes.includes('doctor')) {
        setLoginNotice('Tài khoản chưa được CMS Quản trị cấp quyền truy cập Module Bác sĩ tuyến trên.');
        throw new Error('no-doctor-scope');
      }

      const user = data.user || {};
      session = Object.assign({}, stored, {
        scopes,
        expiresAt: data.expiresAt || stored.expiresAt,
        username: user.username || stored.username,
        name: user.name || stored.name,
        role: user.role || stored.role
      });
      writeStoredSession(session);
      return true;
    } catch (err) {
      session = null;
      writeStoredSession(null);
      return false;
    }
  }

  /* ==========================================================================
     3. CỬA SỔ: LỚP PHỦ, CỔNG ĐĂNG NHẬP, BUỒNG KHÁM, PHIẾU KHÁM A5
     ========================================================================== */

  function showConsole() {
    const el = document.getElementById('doctor-console');
    if (el) el.classList.remove('hidden');
  }

  function hideConsole() {
    const el = document.getElementById('doctor-console');
    if (el) el.classList.add('hidden');
  }

  /** Mở một cửa sổ trong lớp phủ; app.js gọi hàm này để bật phiếu khám A5. */
  window.openModal = function(modalId) {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.remove('hidden');
    document.querySelectorAll('#modal-overlay .modal-content').forEach(el => {
      el.classList.toggle('hidden', el.id !== modalId);
    });
    document.body.style.overflow = 'hidden';
  };

  window.closeModal = function() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = 'auto';
  };

  /** app.js gọi ngay sau khi máy chủ chấp nhận đăng nhập. */
  window.openStationPanel = function() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.querySelectorAll('#modal-overlay .modal-content').forEach(el => el.classList.add('hidden'));
    document.body.style.overflow = 'auto';

    showConsole();
    renderAuthUserBadge();

    // Hàng đợi cuộc gọi của người dân chỉ được quét khi đã có phiên hợp lệ.
    if (typeof window.startQueuePolling === 'function') window.startQueuePolling();
  };

  window.closeStationPanel = function() {
    hideConsole();
    if (typeof window.stopQueuePolling === 'function') window.stopQueuePolling();
  };

  /** Thoát khỏi module: cắt cuộc gọi, xoá phiếu phiên, trả về cổng đăng nhập. */
  window.logoutStationPanel = function() {
    const inCall = typeof window.isStationCallActive === 'function' && window.isStationCallActive();
    if (inCall && !window.confirm('Cuộc gọi khám từ xa đang diễn ra. Đăng xuất sẽ kết thúc cuộc gọi. Tiếp tục?')) {
      return;
    }
    if (inCall && typeof window.endTeleconsultation === 'function') {
      try { window.endTeleconsultation(); } catch (err) { console.warn('Không kết thúc được cuộc gọi:', err); }
    }

    session = null;
    writeStoredSession(null);
    renderAuthUserBadge();
    if (typeof window.stopQueuePolling === 'function') window.stopQueuePolling();
    hideConsole();

    if (typeof window.openLoginModal === 'function') window.openLoginModal();
    const status = document.getElementById('station-login-status');
    if (status) {
      status.className = 'text-[11px] font-bold text-slate-400';
      status.textContent = 'Đã đăng xuất khỏi Module Bác sĩ tuyến trên.';
    }
  };

  /** Enter trong ô mật khẩu = bấm nút đăng nhập. */
  window.handleStationLoginKey = function(event) {
    if (event && event.key === 'Enter') {
      event.preventDefault();
      if (typeof window.submitLogin === 'function') window.submitLogin();
    }
  };

  /** Thông báo nhanh góc màn hình (bản gọn của trang chủ). */
  window.showToast = function(message, tone) {
    const box = document.createElement('div');
    const color = tone === 'error' ? 'bg-rose-600' : (tone === 'warn' ? 'bg-amber-600' : 'bg-emerald-600');
    box.className = `fixed bottom-5 right-5 z-[60] ${color} text-white text-xs font-bold px-4 py-3 rounded-xl shadow-2xl max-w-sm transition-opacity duration-300`;
    box.textContent = String(message == null ? '' : message);
    document.body.appendChild(box);
    setTimeout(() => { box.style.opacity = '0'; }, 3200);
    setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 3600);
  };

  /* ==========================================================================
     4. CHỮ KÝ SỐ, NGƯỜI KÊ ĐƠN & ĐỒNG BỘ KẾT LUẬN HỘI CHẨN

     Danh sách người ký lấy từ CMS (mục "Chữ ký số & Người ký đơn"), giống hệt
     nguồn mà điểm trạm dùng, nên đơn thuốc in ở hai đầu cùng một chữ ký.
     ========================================================================== */

  let signers = [];
  let activeSignerId = '';

  const SIGNER_SELECT_IDS = ['station-prescription-signer', 'rpt-edit-signer-select'];
  const SIGNER_PREVIEW_IDS = [
    ['station-signer-signature-preview', 'station-signer-signature-empty'],
    ['rpt-signer-sig-img', 'rpt-signer-sig-empty']
  ];

  async function loadSigners() {
    try {
      const res = await fetch('/api/cms');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.prescriptionSigners)) signers = data.prescriptionSigners;
      window.renderSignerSelectors();
    } catch (err) {
      console.warn('Không tải được danh sách người ký đơn:', err.message);
    }
  }

  window.getActiveSigner = function() {
    if (!activeSignerId) return null;
    return signers.find(s => s.id === activeSignerId) || null;
  };

  window.renderSignerSelectors = function() {
    SIGNER_SELECT_IDS.forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const current = activeSignerId || sel.value || '';
      sel.innerHTML = '<option value="">-- Chọn Bác sĩ kê đơn &amp; ký số --</option>' +
        signers.map(s =>
          `<option value="${s.id}">${s.title || 'Bác sỹ'} ${s.name}${s.isDefault === 'true' ? ' (mặc định)' : ''}</option>`
        ).join('');
      if (current && signers.some(s => s.id === current)) sel.value = current;
    });

    if (!activeSignerId) {
      const fallback = signers.find(s => s.isDefault === 'true');
      if (fallback) {
        window.selectPrescriptionSigner(fallback.id, false);
        return;
      }
    }
    window.renderActiveSignerPreview();
  };

  window.renderActiveSignerPreview = function() {
    const signer = window.getActiveSigner();
    SIGNER_PREVIEW_IDS.forEach(([imgId, emptyId]) => {
      const img = document.getElementById(imgId);
      const empty = document.getElementById(emptyId);
      if (!img || !empty) return;
      if (signer && signer.signature) {
        img.src = signer.signature;
        img.classList.remove('hidden');
        empty.classList.add('hidden');
      } else {
        img.src = '';
        img.classList.add('hidden');
        empty.classList.remove('hidden');
        empty.textContent = signer
          ? 'Người ký chưa tải chữ ký số.'
          : 'Chữ ký số sẽ hiển thị tự động khi chọn Bác sĩ.';
      }
    });

    const nameEl = document.getElementById('rpt-sig-doctor-name');
    const licenseEl = document.getElementById('rpt-sig-doctor-license');
    if (signer) {
      if (nameEl) nameEl.textContent = `${signer.title || 'Bác sĩ'} ${signer.name}`;
      if (licenseEl) licenseEl.textContent = signer.license ? `CCHN: ${signer.license}` : 'Đã xác thực chữ ký số từ xa';
    }

    // Bác sĩ tuyến trên chính là người ký ở đầu này, nên ô "Cán bộ điểm trạm"
    // trên bản in giữ đúng tên cán bộ trực do phiếu khám điền vào.
    const opEl = document.getElementById('rpt-sig-operator-name');
    const opInput = document.getElementById('rpt-edit-operator');
    if (opEl && opInput) opEl.textContent = opInput.value || ' ';
  };

  /** Chọn người ký; broadcast = true thì báo sang đầu bên kia để hai đầu khớp nhau. */
  window.selectPrescriptionSigner = function(signerId, broadcast) {
    activeSignerId = signerId || '';
    SIGNER_SELECT_IDS.forEach(id => {
      const sel = document.getElementById(id);
      if (sel && sel.value !== activeSignerId) sel.value = activeSignerId;
    });
    window.renderActiveSignerPreview();

    if (broadcast && typeof window.sendStationSignal === 'function') {
      window.sendStationSignal('signer', { signerId: activeSignerId });
      const signer = window.getActiveSigner();
      window.showToast(signer
        ? `Đơn thuốc sẽ do ${signer.title || 'Bác sĩ'} ${signer.name} ký số.`
        : 'Đã bỏ chọn người ký đơn thuốc.');
    }
  };

  window.onReportSignerChange = function(signerId) {
    window.selectPrescriptionSigner(signerId, true);
  };

  /** Đẩy chẩn đoán, đơn thuốc và lời dặn của tuyến trên sang điểm trạm. */
  window.syncStationPrescriptionData = function() {
    const val = (id) => {
      const el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    };
    const payload = {
      diagnosis: val('station-dx-diagnosis'),
      plan: 'Hội chẩn và tư vấn từ xa bởi bác sĩ tuyến trên',
      drugs: val('station-dx-drugs'),
      advice: val('station-doctor-advice'),
      signerId: val('station-prescription-signer') || activeSignerId
    };
    if (typeof window.sendStationSignal === 'function') {
      window.sendStationSignal('doctor_dx', payload);
    }
  };

  /* ==========================================================================
     5. TỆP ĐÍNH KÈM TRONG TRAO ĐỔI LÂM SÀNG

     app.js đọc window.stationPendingAttachment khi gửi tin nhắn, nên tệp/ảnh
     chọn ở đây đi thẳng sang điểm trạm cùng với dòng tin.
     ========================================================================== */

  window.handleStationChatFile = function(e) {
    const file = e && e.target && e.target.files && e.target.files[0];
    if (!file) return;

    // Ảnh chụp tổn thương / phiếu xét nghiệm đi kèm dạng data-URL trong bản tin
    // signaling, nên phải chặn tệp quá lớn trước khi đọc.
    const MAX_BYTES = 3 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      window.showToast('Tệp vượt quá 3 MB. Vui lòng nén hoặc chụp lại với dung lượng nhỏ hơn.', 'error');
      window.clearStationChatFile();
      return;
    }

    const reader = new FileReader();
    reader.onload = function(evt) {
      window.stationPendingAttachment = { name: file.name, data: evt.target.result };
      const fn = document.getElementById('station-file-name');
      if (fn) fn.textContent = file.name;
      const fp = document.getElementById('station-file-preview');
      if (fp) fp.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  };

  window.clearStationChatFile = function() {
    window.stationPendingAttachment = null;
    const inp = document.getElementById('station-chat-file-input');
    if (inp) inp.value = '';
    const fp = document.getElementById('station-file-preview');
    if (fp) fp.classList.add('hidden');
  };

  /* ==========================================================================
     6. BẢN IN ĐƠN THUỐC KHỔ A5
        Mẫu số 01 - Đơn thuốc, Thông tư 52/2017/TT-BYT.
        Giữ đúng bộ dựng bản in của trang chủ để đơn in ra ở hai module giống hệt.
     ========================================================================== */

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const RX_UNIT_WORDS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

  /** Đọc số khoản thuốc thành chữ (đơn thuốc chỉ cần tới hàng chục). */
  function rxNumberToWords(n) {
    const num = Number(n) || 0;
    if (num < 10) return RX_UNIT_WORDS[num];
    if (num > 99) return String(num);
    const chuc = Math.floor(num / 10);
    const donvi = num % 10;
    const out = (chuc === 1 ? 'mười' : RX_UNIT_WORDS[chuc] + ' mươi');
    if (donvi === 0) return out;
    if (donvi === 1 && chuc > 1) return out + ' mốt';
    if (donvi === 5 && chuc >= 1) return out + ' lăm';
    return out + ' ' + RX_UNIT_WORDS[donvi];
  }

  /**
   * Tách nội dung ô "Thuốc điều trị" thành từng dòng của bảng.
   *
   * Chấp nhận hai cách gõ:
   *   - Có gạch đứng:  Tên thuốc hàm lượng | số lượng | liều dùng, cách dùng
   *   - Gõ tự do:      1. Paracetamol 500mg - uống 1 viên x 3 lần/ngày
   * Cách gõ tự do vẫn tách được tên thuốc và liều dùng; ô số lượng để trống cho
   * cán bộ ghi tay nếu chưa nhập.
   */
  function rxParsePrescription(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        // Bỏ số thứ tự người dùng tự đánh (1. / 1) / - / •)
        const clean = line.replace(/^\s*(?:\d+\s*[.)\-]|[-•*])\s*/, '').trim();
        if (clean.includes('|')) {
          const parts = clean.split('|').map(p => p.trim());
          return { name: parts[0] || '', qty: parts[1] || '', dose: parts.slice(2).join(' - ') || '' };
        }
        const split = clean.split(/\s+[-–—]\s+/);
        const name = (split.shift() || '').trim();
        const dose = split.join(' - ').trim();
        // Cố gắng nhặt số lượng dạng "SL 20 viên" hoặc "x 20 viên"
        const qtyMatch = clean.match(/(?:SL|Số lượng|SL:)\s*[:=]?\s*([\d.,]+\s*\S+)/i);
        return { name, qty: qtyMatch ? qtyMatch[1].trim() : '', dose };
      });
  }

  /** Gom toàn bộ dữ liệu đang hiển thị trong cửa sổ Phiếu khám & Đơn thuốc. */
  function rxCollectData() {
    const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
    const txt = (id) => { const el = document.getElementById(id); return el ? String(el.textContent || '').trim() : ''; };
    const sel = (id) => {
      const el = document.getElementById(id);
      if (!el || el.selectedIndex < 0) return '';
      return (el.options[el.selectedIndex] && el.options[el.selectedIndex].text) || el.value || '';
    };
    const sigImg = document.getElementById('rpt-signer-sig-img');
    const now = new Date();

    return {
      code: txt('rpt-code'),
      station: txt('rpt-station'),
      patientName: val('rpt-edit-patient-name'),
      dob: val('rpt-edit-dob'),
      age: val('rpt-edit-age-gender'),
      gender: sel('rpt-edit-gender'),
      weight: val('rpt-edit-weight') || (txt('rpt-val-weight') || '').replace(/\s*kg\s*$/i, ''),
      address: val('rpt-edit-address'),
      idCard: val('rpt-edit-idcard'),
      guardian: val('rpt-edit-guardian'),
      phone: val('rpt-edit-phone'),
      symptoms: val('rpt-edit-symptoms'),
      clinicalNotes: val('rpt-edit-clinical-notes'),
      diagnosis: val('rpt-edit-diagnosis'),
      treatment: val('rpt-edit-treatment'),
      drugs: rxParsePrescription(val('rpt-edit-prescription')),
      advice: val('rpt-edit-advice'),
      operator: val('rpt-edit-operator'),
      doctorName: txt('rpt-sig-doctor-name'),
      doctorLicense: txt('rpt-sig-doctor-license'),
      signatureSrc: (sigImg && !sigImg.classList.contains('hidden')) ? sigImg.getAttribute('src') : '',
      vitals: {
        bp: txt('rpt-val-bp'),
        hr: txt('rpt-val-hr'),
        spo2: txt('rpt-val-spo2'),
        temp: txt('rpt-val-temp'),
        weight: txt('rpt-val-weight')
      },
      day: now.getDate(),
      month: now.getMonth() + 1,
      year: now.getFullYear()
    };
  }

  /** Phần thân đơn thuốc (dùng chung cho bản in A5 và bản tải về Word). */
  function rxBuildBodyHtml(d) {
    const dots = (v, min) => v ? esc(v) : '.'.repeat(min || 30);
    const rows = d.drugs.length
      ? d.drugs.map((it, i) => `<tr>
                        <td class="c">${i + 1}</td>
                        <td>${esc(it.name)}</td>
                        <td class="c">${esc(it.qty)}</td>
                        <td>${esc(it.dose)}</td>
                    </tr>`).join('')
      : `<tr><td class="c">1</td><td>&nbsp;</td><td class="c">&nbsp;</td><td>&nbsp;</td></tr>`;
    // Mẫu số 01 yêu cầu ghi rõ số khoản đã kê để chống sửa chữa, thêm bớt.
    const khoan = d.drugs.length;
    const vitalLine = [d.vitals.bp, d.vitals.hr, d.vitals.spo2, d.vitals.temp, d.vitals.weight]
      .filter(Boolean).join(' &nbsp;·&nbsp; ');

    return `
                <div class="hdr">
                    <div class="hdr-left">
                        <div class="org">SỞ Y TẾ TỈNH LÀO CAI</div>
                        <div class="unit">TRẠM Y TẾ BÁT XÁT</div>
                        <div class="sub">${dots(d.station, 20)}</div>
                    </div>
                    <div class="hdr-right">
                        <div class="code">${dots(d.code, 10)}</div>
                        <div class="sub">Khám chữa bệnh từ xa</div>
                    </div>
                </div>

                <h1>ĐƠN THUỐC</h1>

                <div class="admin">
                    <p>1. Họ tên: <b>${dots(d.patientName, 40)}</b></p>
                    <p>2. Ngày sinh: <b>${dots(d.dob, 14)}</b> &nbsp; Tuổi: <b>${dots(d.age, 10)}</b></p>
                    <p>3. Giới tính: <b>${dots(d.gender, 8)}</b> &nbsp; 4. Cân nặng: <b>${dots(d.weight, 6)}</b> kg</p>
                    <p>5. Địa chỉ: <b>${dots(d.address, 46)}</b></p>
                    <p>6. Số thẻ BHYT/CCCD: <b>${dots(d.idCard, 26)}</b></p>
                    ${d.guardian ? `<p>Bố/mẹ hoặc người giám hộ: <b>${esc(d.guardian)}</b></p>` : ''}
                </div>

                ${d.symptoms || vitalLine ? `<div class="note">
                    ${d.symptoms ? `<p>Triệu chứng: ${esc(d.symptoms)}</p>` : ''}
                    ${vitalLine ? `<p>Sinh hiệu: ${vitalLine}</p>` : ''}
                </div>` : ''}

                <p class="dx">Chẩn đoán: <b>${dots(d.diagnosis, 40)}</b></p>
                ${d.treatment ? `<p class="dx">Hướng xử trí: ${esc(d.treatment)}</p>` : ''}

                <p class="lbl">Thuốc điều trị:</p>
                <table>
                    <thead>
                        <tr>
                            <th style="width:8%">TT</th>
                            <th style="width:38%">Tên thuốc, nồng độ/hàm lượng</th>
                            <th style="width:16%">Số lượng</th>
                            <th style="width:38%">Liều dùng, cách dùng</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                <p class="khoan">Cộng khoản: <b>${khoan}</b> (${esc(rxNumberToWords(khoan))}) khoản.</p>

                <p class="advice">Lời dặn: ${d.advice ? esc(d.advice) : '.'.repeat(50)}</p>
                ${d.clinicalNotes ? `<p class="advice">Diễn biến lâm sàng: ${esc(d.clinicalNotes)}</p>` : ''}

                <div class="sig">
                    <div class="sig-col">
                        <p class="role">CÁN BỘ ĐIỂM TRẠM</p>
                        <p class="hint">(Ký, ghi rõ họ tên)</p>
                        <div class="sig-space"></div>
                        <p class="name">${esc(d.operator)}</p>
                    </div>
                    <div class="sig-col">
                        <p class="date">Ngày ${d.day} tháng ${d.month} năm ${d.year}</p>
                        <p class="role">NGƯỜI KÊ ĐƠN</p>
                        <p class="hint">(Ký, ghi rõ họ tên)</p>
                        <div class="sig-space">${d.signatureSrc ? `<img src="${esc(d.signatureSrc)}" alt="Chữ ký số">` : ''}</div>
                        <p class="name">${esc(d.doctorName)}</p>
                        <p class="hint">${esc(d.doctorLicense)}</p>
                    </div>
                </div>

                <div class="foot">
                    <p><b>Khám lại xin mang theo đơn này.</b></p>
                    <p>Số điện thoại liên hệ khi cần: <b>${dots(d.phone, 14)}</b></p>
                    <p class="tiny">Đơn thuốc theo Mẫu số 01 - Thông tư 52/2017/TT-BYT. Đơn có giá trị mua, lĩnh thuốc trong thời hạn tối đa 05 ngày kể từ ngày kê đơn.</p>
                </div>
            `;
  }

  /** Bộ định dạng khổ A5 dọc cho bản in giấy. */
  function rxPrintStyles() {
    return `
                @page { size: A5 portrait; margin: 10mm 10mm 8mm 12mm; }
                * { box-sizing: border-box; }
                body { font-family: "Times New Roman", Times, serif; font-size: 11pt; line-height: 1.35; color: #000; margin: 0; }
                p { margin: 0 0 2pt; }
                .hdr { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #000; padding-bottom: 3pt; }
                .hdr-left { text-align: left; }
                .hdr-right { text-align: right; }
                .org { font-size: 9.5pt; text-transform: uppercase; }
                .unit { font-size: 10.5pt; font-weight: bold; text-transform: uppercase; }
                .code { font-size: 10pt; font-weight: bold; }
                .sub { font-size: 8.5pt; font-style: italic; }
                h1 { font-size: 15pt; font-weight: bold; text-align: center; text-transform: uppercase; letter-spacing: 1pt; margin: 6pt 0 5pt; }
                .admin p { margin-bottom: 2.5pt; }
                .note { font-size: 9.5pt; font-style: italic; margin: 3pt 0; }
                .dx { margin: 3pt 0; }
                .lbl { font-weight: bold; margin: 4pt 0 2pt; }
                table { width: 100%; border-collapse: collapse; font-size: 10pt; }
                th, td { border: 1px solid #000; padding: 3pt 4pt; vertical-align: top; }
                th { font-weight: bold; text-align: center; }
                td.c, th.c { text-align: center; }
                .khoan { margin-top: 3pt; font-style: italic; }
                .advice { margin-top: 4pt; }
                .sig { display: flex; justify-content: space-between; margin-top: 8pt; text-align: center; font-size: 10pt; }
                .sig-col { width: 48%; }
                .date { font-style: italic; font-size: 9.5pt; margin-bottom: 2pt; }
                .role { font-weight: bold; text-transform: uppercase; font-size: 9.5pt; }
                .hint { font-style: italic; font-size: 8.5pt; }
                .sig-space { height: 46pt; display: flex; align-items: center; justify-content: center; }
                .sig-space img { max-height: 44pt; max-width: 100%; }
                .name { font-weight: bold; }
                .foot { margin-top: 8pt; border-top: 1px dashed #000; padding-top: 3pt; font-size: 9.5pt; }
                .tiny { font-size: 8pt; font-style: italic; margin-top: 2pt; }
            `;
  }

  /**
   * Chờ toàn bộ ảnh (đặc biệt là ảnh chữ ký số dạng data-URL) trong cửa sổ in
   * giải mã xong rồi mới gọi print, tránh mất chữ ký trên bản in A5.
   */
  function printA5WindowWhenReady(win) {
    const fire = () => {
      try {
        win.focus();
        win.print();
      } catch (err) {
        console.warn('Không gọi được hộp thoại in:', err);
      }
    };

    const run = () => {
      const images = Array.from(win.document.images || []);
      const pending = images.filter(img => !img.complete);
      if (!pending.length) {
        fire();
        return;
      }
      Promise.all(pending.map(img => new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }))).then(fire);
    };

    setTimeout(run, 400);
  }

  window.printReportA5 = function() {
    const printWin = window.open('', '_blank');
    if (!printWin) {
      window.showToast('Trình duyệt đã chặn pop-up. Vui lòng cho phép pop-up để in đơn thuốc A5.', 'error');
      return;
    }

    const data = rxCollectData();
    printWin.document.write(`<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="utf-8">
    <title>Đơn thuốc - ${esc(data.patientName)}</title>
    <style>${rxPrintStyles()}</style>
</head>
<body>${rxBuildBodyHtml(data)}</body>
</html>`);
    printWin.document.close();

    printA5WindowWhenReady(printWin);
  };

  window.downloadReportWord = function() {
    const data = rxCollectData();
    // Word đọc HTML nhưng không hỗ trợ flexbox: đổi hai khu vực dàn ngang (đầu
    // trang và khối chữ ký) sang bảng để bản .doc không bị vỡ khung.
    const body = rxBuildBodyHtml(data)
      .replace('<div class="hdr">', '<table class="lay"><tr><td width="60%">')
      .replace('<div class="hdr-right">', '</td><td width="40%" align="right"><div class="hdr-right">')
      .replace('<h1>', '</td></tr></table><h1>')
      .replace('<div class="sig">', '<table class="lay"><tr><td width="50%" align="center">')
      .replace('<div class="sig-col">\n                        <p class="date">', '</td><td width="50%" align="center"><div class="sig-col"><p class="date">')
      .replace('<div class="foot">', '</td></tr></table><div class="foot">');

    const header = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>Đơn thuốc A5</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
@page Section1 { size: 14.8cm 21.0cm; margin: 1.0cm 1.0cm 0.8cm 1.2cm; }
div.Section1 { page: Section1; }
${rxPrintStyles().replace(/@page[^}]*\}/, '')}
table.lay { border-collapse: collapse; width: 100%; }
table.lay td { border: none; padding: 0; vertical-align: top; }
.hdr, .sig { display: block; }
</style></head><body><div class="Section1">`;
    const source = '﻿' + header + body + '</div></body></html>';

    const blob = new Blob([source], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Don_thuoc_A5_${(data.patientName || 'benh-nhan').replace(/\s+/g, '_')}_${data.day}-${data.month}-${data.year}.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    window.showToast('Đã tải xuống Đơn thuốc chuẩn Bộ Y tế, khổ A5, định dạng Word (.doc)');
  };

  window.downloadReportPDF = function() {
    window.printReportA5();
  };

  /* ==========================================================================
     7. KHỞI ĐỘNG MODULE
     ========================================================================== */

  async function boot() {
    fillStationSelects();
    hideConsole();
    loadSigners();

    // Có phiên cũ còn hiệu lực và còn quyền doctor thì vào thẳng buồng khám,
    // không bắt bác sĩ đăng nhập lại giữa ca trực.
    const restored = await restoreSession();
    if (restored) {
      const nameInput = document.getElementById('input-operator-name');
      if (nameInput && session && session.name) nameInput.value = session.name;
      const codeSelect = document.getElementById('input-station-code');
      if (codeSelect && session && session.stationCode
        && window.TELEHEALTH_STATIONS.some(s => s.code === session.stationCode)) {
        codeSelect.value = session.stationCode;
      }
      // Dựng lại tên bác sĩ và điểm trạm của phiên cũ trong bộ máy chung.
      if (typeof window.restoreStationIdentity === 'function') {
        window.restoreStationIdentity({
          name: (session && session.name) || '',
          stationCode: (session && session.stationCode) || ''
        });
      }
      window.openStationPanel();
      return;
    }

    if (typeof window.openLoginModal === 'function') {
      window.openLoginModal();
    } else {
      const overlay = document.getElementById('modal-overlay');
      const login = document.getElementById('login-modal');
      if (overlay) overlay.classList.remove('hidden');
      if (login) login.classList.remove('hidden');
    }
  }

  /* Khởi động PHẢI chờ tới DOMContentLoaded, không được chạy ngay.
     Tệp này nạp trước app.js (để app.js đọc được window.STATION_MODULE_SCOPE),
     nên tại thời điểm nó chạy thì app.js CHƯA gán window.openLoginModal,
     window.startQueuePolling... DOMContentLoaded chỉ nổ sau khi mọi tệp defer đã
     chạy xong, lúc đó bộ máy chung mới đầy đủ. */
  if (document.readyState === 'complete') {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
