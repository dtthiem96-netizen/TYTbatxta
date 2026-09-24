import { pgTable, text, bigint, serial, integer, real, index, uniqueIndex } from "drizzle-orm/pg-core";

export const news = pgTable("news", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  date: text("date").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
  icon: text("icon"),
  color: text("color"),
  image: text("image"),
  attachments: text("attachments"),
});

export const vaccines = pgTable("vaccines", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  time: text("time").notNull(),
  target: text("target").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
});

export const documents = pgTable("documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  url: text("url").notNull(),
  date: text("date").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
});

export const services = pgTable("services", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  person: text("person").notNull(),
  zalo: text("zalo").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
});

export const contacts = pgTable("contacts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  phone: text("phone").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    canReceiveVideo: text("can_receive_video").default("true"),
    // Quyền đăng nhập Module Bảng điều khiển trạm, do CMS Quản trị cấp/thu hồi.
    stationAccess: text("station_access").default("false"),
    // Quyền đăng nhập Module Bác sĩ tuyến trên (/bacsi) - cấp riêng, không đi
    // kèm quyền điểm trạm: bác sĩ tuyến trên hội chẩn từ xa nhưng không thao
    // tác trên bảng điều khiển của trạm.
    doctorAccess: text("doctor_access").default("false"),
    /* Quyền đăng nhập Phân hệ Chấm công - Chấm trực (/chamcong). Cũng là quyền
       cấp riêng: một cán bộ có thể chỉ chấm công mà không hề tham gia khám từ
       xa, và ngược lại. Vai trò TRONG phân hệ (cán bộ / phụ trách bộ phận /
       quản trị) nằm ở att_employees.attendance_role, không nằm ở đây. */
    attendanceAccess: text("attendance_access").default("false"),
    /* Mật khẩu KHÔNG bao giờ lưu dạng rõ: chỉ giữ chuỗi băm bcrypt ($2b$...).
       Tài khoản tạo trước tính năng này còn để trống, xem netlify/lib/auth.ts
       để biết luồng đặt mật khẩu lần đầu. */
    passwordHash: text("password_hash"),
    email: text("email"),
    phone: text("phone"),
    // Điểm trạm trực thuộc (mã trạm, ví dụ TYT-YTY-03).
    stationCode: text("station_code"),
    // ACTIVE | DISABLED - tài khoản bị khoá không đăng nhập được ở bất kỳ cổng nào.
    status: text("status").default("ACTIVE"),
    // Bật sau khi Quản trị đặt lại mật khẩu, nhắc cán bộ đổi lại mật khẩu riêng.
    mustChangePassword: text("must_change_password").default("false"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
    lastLoginAt: bigint("last_login_at", { mode: "number" }),
  },
  (table) => [index("users_station_code_idx").on(table.stationCode)]
);

export const siteConfigs = pgTable("site_configs", {
  id: text("id").primaryKey(),
  value: text("value").notNull(),
});

export const videos = pgTable("videos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  url: text("url").notNull(),
  date: text("date").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
  isCollapsed: text("is_collapsed").default("false"),
});

// Phòng khám từ xa: trạng thái phòng, sinh hiệu mới nhất và ghi chép lâm sàng
export const telehealthRooms = pgTable("telehealth_rooms", {
  id: text("id").primaryKey(),
  patientName: text("patient_name"),
  // Số căn cước công dân/thẻ BHYT do chính người dân nhập ở màn hình đăng ký,
  // theo cuộc gọi sang Bảng điều khiển điểm trạm và Module Bác sĩ tuyến trên.
  patientId: text("patient_id"),
  symptoms: text("symptoms"),
  vitals: text("vitals"),
  notes: text("notes"),
  status: text("status").default("WAITING"),
  /* ĐIỀU HƯỚNG THEO ĐIỂM TRẠM
     Mã điểm trạm người dân chọn được lưu thành TRƯỜNG DỮ LIỆU thay vì chỉ nằm
     trong chuỗi roomId. Quy ước "room-<slug trạm>-<thời điểm>" vẫn giữ nguyên để
     tương thích ngược và làm đường đọc dự phòng, nhưng máy chủ định tuyến theo
     cột này - đổi tên trạm hay thêm trạm mới không còn phải đụng vào cách đặt tên. */
  stationCode: text("station_code"),
  // WAITING | RINGING | ACCEPTED | ESCALATED | MISSED | CANCELLED | ENDED
  routingState: text("routing_state").default("WAITING"),
  // Trạm ĐANG đổ chuông: bằng stationCode lúc đầu, đổi sang trạm dự phòng khi leo thang.
  ringingStation: text("ringing_station"),
  ringingSince: bigint("ringing_since", { mode: "number" }),
  // Vòng leo thang hiện tại: 0 = ưu tiên 1, 1 = ưu tiên 2..., -1 = đã sang trạm dự phòng.
  escalationRound: integer("escalation_round").default(0),
  // Ai đã giành quyền tiếp nhận. Cột này là chốt chống nhận trùng.
  acceptedBy: text("accepted_by"),
  acceptedName: text("accepted_name"),
  acceptedAt: bigint("accepted_at", { mode: "number" }),
  /* MỜI HỘI CHẨN TUYẾN TRÊN
     Điểm trạm đã tiếp nhận cuộc gọi rồi vẫn cần kéo bác sĩ tuyến trên vào CÙNG
     phòng. Lời mời phải nằm trong hồ sơ phòng chứ không phải trong hộp thư
     signaling: bác sĩ mở Module ở chân trang sau đó vài phút vẫn phải thấy lời
     mời còn treo, mà bản tin signaling thì đã bị dọn theo hạn. Ba cột này được
     xoá trắng ngay khi có bác sĩ tuyến trên thực sự vào phòng. */
  consultRequestedAt: bigint("consult_requested_at", { mode: "number" }),
  consultRequestedBy: text("consult_requested_by"),
  consultNote: text("consult_note"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

/* HỒ SƠ ĐIỂM TRẠM
   Nguồn sự thật duy nhất cho danh mục điểm trạm: ô chọn của người dân, phòng gọi
   khám từ xa của cán bộ trực và bộ định tuyến của máy chủ đều đọc từ đây. Quản
   trị viên cấu hình toàn bộ tại mô-đun "Bảng điều khiển điểm trạm" ở chân trang CMS.
   Mỗi điểm trạm có đúng MỘT phòng gọi cố định "room-<slug mã trạm>" - không cấp
   phát, không chia phòng, nên hồ sơ trạm không lưu liên kết phòng họp bên ngoài. */
export const stationRooms = pgTable(
  "station_rooms",
  {
    stationCode: text("station_code").primaryKey(),
    stationName: text("station_name").notNull(),
    note: text("note"),
    fallbackStationCode: text("fallback_station_code"),
    ringTimeoutSec: integer("ring_timeout_sec").default(45),
    // JSON khung giờ trực, ví dụ {"always":true} hoặc {"mon_fri":["07:30","17:00"]}
    dutyHours: text("duty_hours"),
    // Ngoài giờ trực: HIDE (ẩn khỏi danh sách người dân) | SHOW (hiện kèm cảnh báo)
    offHoursMode: text("off_hours_mode").default("SHOW"),
    // ACTIVE | PAUSED | DISABLED
    status: text("status").default("ACTIVE"),
    displayOrder: integer("display_order").default(0),
    updatedBy: text("updated_by"),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [index("station_rooms_status_idx").on(table.status)]
);

/* Tài khoản nhận cuộc gọi được gán vào điểm trạm, kèm mức ưu tiên đổ chuông.
   MỖI TÀI KHOẢN CHỈ ĐƯỢC GẮN VÀO MỘT ĐIỂM TRẠM: khoá duy nhất đặt trên user_id
   (không phải trên cặp trạm+tài khoản) nên cán bộ không thể trực - và cũng không
   thể vào - phòng gọi của bất kỳ điểm trạm nào khác ngoài trạm CMS chỉ định. */
export const stationReceivers = pgTable(
  "station_receivers",
  {
    id: text("id").primaryKey(),
    stationCode: text("station_code").notNull(),
    userId: text("user_id").notNull(),
    // 1 = trực chính, 2 = trực phụ... quyết định thứ tự leo thang.
    priority: integer("priority").default(1),
    // Danh sách kênh bật cho tài khoản: POPUP,SOUND,PUSH,ZALO
    notifyChannels: text("notify_channels").default("POPUP,SOUND,PUSH"),
    isActive: text("is_active").default("true"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [
    index("station_receivers_station_idx").on(table.stationCode),
    uniqueIndex("station_receivers_user_uidx").on(table.userId),
  ]
);

/* Thiết bị đã đăng ký nhận thông báo đẩy (Web Push) của cán bộ trực. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    stationCode: text("station_code"),
    endpoint: text("endpoint").notNull(),
    keysJson: text("keys_json"),
    userAgent: text("user_agent"),
    createdAt: bigint("created_at", { mode: "number" }),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
  },
  (table) => [index("push_subscriptions_user_idx").on(table.userId)]
);

/* Nhật ký thay đổi cấu hình điểm trạm - tab "Nhật ký thay đổi" của mô-đun CMS.
   Giá trị mật khẩu phòng luôn được che trước khi ghi, chỉ lưu VIỆC ĐÃ ĐỔI. */
export const stationRoomAudits = pgTable(
  "station_room_audits",
  {
    id: serial("id").primaryKey(),
    stationCode: text("station_code").notNull(),
    actorName: text("actor_name"),
    actorUsername: text("actor_username"),
    action: text("action").notNull(),
    field: text("field"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (table) => [index("station_room_audits_station_ts_idx").on(table.stationCode, table.ts)]
);

// Danh sách thành viên đang có mặt trong phòng (presence) dùng cho signaling WebRTC
export const telehealthPeers = pgTable(
  "telehealth_peers",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    role: text("role").notNull(),
    name: text("name").notNull(),
    /* Cán bộ đang trực báo kèm điểm trạm và tài khoản của mình khi mở kênh tiếp
       nhận. Nhờ hai cột này, màn hình người dân đếm được số người trực CỦA TỪNG
       TRẠM, và bộ định tuyến biết ai đang online để đổ chuông theo mức ưu tiên. */
    stationCode: text("station_code"),
    userId: text("user_id"),
    lastSeen: bigint("last_seen", { mode: "number" }).notNull(),
  },
  (table) => [index("telehealth_peers_room_idx").on(table.roomId)]
);

// Hộp thư signaling (offer / answer / ICE candidate / chat / sinh hiệu)
export const telehealthSignals = pgTable(
  "telehealth_signals",
  {
    seq: serial("seq").primaryKey(),
    roomId: text("room_id").notNull(),
    fromPeer: text("from_peer").notNull(),
    toPeer: text("to_peer"),
    type: text("type").notNull(),
    payload: text("payload"),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (table) => [index("telehealth_signals_room_seq_idx").on(table.roomId, table.seq)]
);

// Người ký đơn thuốc & chữ ký số lưu sẵn (ký đơn từ xa)
export const prescriptionSigners = pgTable("prescription_signers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  title: text("title").notNull().default("Bác sỹ"),
  license: text("license"),
  workplace: text("workplace"),
  signature: text("signature"),
  isDefault: text("is_default").default("false"),
  ts: bigint("ts", { mode: "number" }).notNull(),
});

export const appointments = pgTable("appointments", {
  id: text("id").primaryKey(),
  patientName: text("patient_name").notNull(),
  phone: text("phone").notNull(),
  dob: text("dob"),
  gender: text("gender"),
  idCard: text("id_card"),
  service: text("service"),
  appointmentDate: text("appointment_date").notNull(),
  symptoms: text("symptoms"),
  isTelehealth: text("is_telehealth").default("false"),
  status: text("status").default("PENDING"),
  roomId: text("room_id"),
  assignedDoctor: text("assigned_doctor"),
  ts: bigint("ts", { mode: "number" }).notNull(),
});

// Lịch sử sinh hiệu điểm trạm nhập trong buổi khám (tra cứu lại sau khi kết thúc cuộc gọi)
export const stationVitals = pgTable(
  "station_vitals",
  {
    id: serial("id").primaryKey(),
    roomId: text("room_id").notNull(),
    stationCode: text("station_code"),
    operatorName: text("operator_name"),
    patientName: text("patient_name"),
    patientAge: integer("patient_age"),
    patientGender: text("patient_gender"),
    bpSys: integer("bp_sys"),
    bpDia: integer("bp_dia"),
    heartRate: integer("heart_rate"),
    spo2: real("spo2"),
    temperature: real("temperature"),
    weight: real("weight"),
    symptoms: text("symptoms"),
    status: text("status").default("NORMAL"),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (table) => [index("station_vitals_room_ts_idx").on(table.roomId, table.ts)]
);

/* Lịch sử cuộc gọi khám từ xa hiển thị trong CMS Quản trị, ngay dưới
   "Danh sách Đăng ký Khám bệnh & Khám Từ xa".

   Mỗi bản ghi là một lượt cán bộ tiếp nhận cuộc gọi: mở lúc bấm "Tiếp nhận"
   và chốt lại khi kết thúc cuộc gọi. Bản ghi giữ đủ 5 nhóm thông tin nghiệp vụ
   yêu cầu: thời gian/ngày gọi, điểm tiếp nhận, cán bộ nhận cuộc gọi, đơn thuốc
   đã kê trong lượt khám và toàn bộ nội dung trò chuyện. */
export const callLogs = pgTable(
  "call_logs",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    appointmentId: text("appointment_id"),
    patientName: text("patient_name"),
    patientId: text("patient_id"),
    // Điểm tiếp nhận cuộc gọi (đọc ngược từ mã phòng khám).
    stationCode: text("station_code"),
    stationName: text("station_name"),
    // Cán bộ nhận cuộc gọi.
    operatorName: text("operator_name"),
    operatorUsername: text("operator_username"),
    operatorRole: text("operator_role"),
    // Ngày + giờ tiếp nhận, lưu sẵn dạng hiển thị tiếng Việt để in báo cáo.
    callDate: text("call_date"),
    callTime: text("call_time"),
    startedAt: bigint("started_at", { mode: "number" }),
    endedAt: bigint("ended_at", { mode: "number" }),
    durationSec: integer("duration_sec").default(0),
    // Lịch sử đơn thuốc của lượt khám.
    diagnosis: text("diagnosis"),
    treatmentPlan: text("treatment_plan"),
    prescription: text("prescription"),
    doctorAdvice: text("doctor_advice"),
    signerName: text("signer_name"),
    vitalsJson: text("vitals_json"),
    // Toàn bộ nội dung trò chuyện, JSON: [{ sender, text, at }]
    chatTranscript: text("chat_transcript"),
    chatCount: integer("chat_count").default(0),
    // IN_CALL | COMPLETED
    status: text("status").default("IN_CALL"),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (table) => [
    index("call_logs_ts_idx").on(table.ts),
    index("call_logs_room_idx").on(table.roomId),
  ]
);

// Phiếu khám từ xa xuất ra khi kết thúc buổi khám
export const examinationReports = pgTable(
  "examination_reports",
  {
    reportCode: text("report_code").primaryKey(),
    roomId: text("room_id").notNull(),
    stationCode: text("station_code"),
    operatorName: text("operator_name"),
    patientName: text("patient_name"),
    patientAge: integer("patient_age"),
    patientGender: text("patient_gender"),
    vitalsJson: text("vitals_json"),
    clinicalNotes: text("clinical_notes"),
    diagnosis: text("diagnosis"),
    icd10: text("icd10"),
    treatmentPlan: text("treatment_plan"),
    prescription: text("prescription"),
    doctorNotes: text("doctor_notes"),
    status: text("status").default("COMPLETED"),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (table) => [index("examination_reports_room_idx").on(table.roomId)]
);

/* ===========================================================================
   HỆ THỐNG CHẤM CÔNG - CHẤM TRỰC ĐIỆN TỬ NỘI BỘ (Mô-đun /chamcong)

   Mười ba bảng dưới đây là toàn bộ kho dữ liệu của phân hệ chấm công. Tất cả
   đều mang tiền tố "att_" để không bao giờ lẫn với các bảng của cổng thông tin
   và của phòng khám từ xa.

   HAI NGUYÊN TẮC CHI PHỐI CẢ SƠ ĐỒ NÀY:

   1. KHÔNG CỐ ĐỊNH QUY ĐỊNH TRONG MÃ NGUỒN. Giờ hành chính, ca trực, ký hiệu
      bảng công, ngày nghỉ lễ, loại nghỉ phép - không giá trị nào nằm trong mã.
      Chúng là DỮ LIỆU: att_settings, att_shifts, att_holidays. Quản trị đổi
      trong giao diện là có hiệu lực ngay, không cần triển khai lại.

   2. CÔNG HÀNH CHÍNH VÀ CÔNG TRỰC LÀ HAI SỔ RIÊNG. att_punches ghi giờ hành
      chính, att_duty_assignments + att_duty_logs ghi ca trực. Không có đường
      nào để một ca trực tự biến thành một ngày công hành chính: muốn quy đổi
      thì Quản trị phải bật tường minh trên từng ca trực (countsAsAdminDay +
      adminDayValue), và ngay cả khi ấy hai con số vẫn được báo cáo tách nhau.
   =========================================================================== */

/* Khoa/bộ phận. Người phụ trách được trỏ tới một cán bộ (att_employees.id) chứ
   không phải một tài khoản: phụ trách bộ phận là một chức trách trong sơ đồ tổ
   chức, còn tài khoản chỉ là phương tiện đăng nhập. */
export const attDepartments = pgTable(
  "att_departments",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    headEmployeeId: text("head_employee_id"),
    note: text("note"),
    displayOrder: integer("display_order").default(0),
    // ACTIVE | ARCHIVED - bộ phận đã giải thể vẫn phải giữ lại để tra cứu
    // bảng công của những tháng trước đó.
    status: text("status").default("ACTIVE"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [uniqueIndex("att_departments_code_uidx").on(table.code)]
);

/* Hồ sơ cán bộ - đối tượng được chấm công.

   TÁCH KHỎI BẢNG users LÀ CỐ Ý. Một cán bộ vẫn phải có mặt trong bảng công dù
   chưa được cấp tài khoản đăng nhập (người mới về trạm, người không dùng điện
   thoại thông minh - Quản trị chấm hộ và hệ thống ghi rõ nguồn là ADMIN). Ngược
   lại, một tài khoản CMS thuần quản trị không phải là một cán bộ được chấm công.
   Cột user_id là mối nối tuỳ chọn giữa hai thế giới đó.

   Khoá duy nhất trên user_id chặn việc hai hồ sơ cán bộ dùng chung một tài
   khoản. PostgreSQL coi các giá trị NULL là khác nhau trong khoá duy nhất, nên
   số hồ sơ chưa gắn tài khoản không bị giới hạn. */
export const attEmployees = pgTable(
  "att_employees",
  {
    id: text("id").primaryKey(),
    // Mã cán bộ do trạm tự quy định, in trên bảng công.
    code: text("code").notNull(),
    fullName: text("full_name").notNull(),
    position: text("position"),
    departmentId: text("department_id"),
    userId: text("user_id"),
    // STAFF | MANAGER | ADMIN - quyền trong phân hệ chấm công, độc lập với
    // vai trò ở cổng thông tin.
    attendanceRole: text("attendance_role").default("STAFF"),
    phone: text("phone"),
    email: text("email"),
    startDate: text("start_date"),
    // ACTIVE | INACTIVE - thôi việc/chuyển công tác thì ngừng xuất hiện trong
    // bảng công của các tháng sau, nhưng tháng cũ vẫn nguyên.
    status: text("status").default("ACTIVE"),
    note: text("note"),
    displayOrder: integer("display_order").default(0),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("att_employees_code_uidx").on(table.code),
    uniqueIndex("att_employees_user_uidx").on(table.userId),
    index("att_employees_department_idx").on(table.departmentId),
  ]
);

/* Cấu hình dạng khoá - giá trị JSON: thời gian làm việc, ký hiệu bảng công,
   danh mục loại nghỉ phép, quy tắc quy đổi. Xem netlify/lib/attendance.ts để
   biết khoá nào mang nội dung gì và giá trị mặc định ra sao. */
export const attSettings = pgTable("att_settings", {
  id: text("id").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: bigint("updated_at", { mode: "number" }),
});

/* Danh mục ca trực. Trạm đặt bao nhiêu ca cũng được, với giờ bắt đầu/kết thúc
   bất kỳ - ca qua đêm chỉ là ca có end_time nhỏ hơn start_time. */
export const attShifts = pgTable(
  "att_shifts",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    // Ca kết thúc sang ngày hôm sau (16:30 -> 07:30). Được suy ra từ giờ nhưng
    // vẫn lưu lại để báo cáo không phải đoán.
    crossesMidnight: text("crosses_midnight").default("false"),
    // Số giờ trực được tính cho một ca. Lưu riêng thay vì luôn lấy hiệu hai mốc
    // giờ, vì trạm có thể quy định một ca 24 giờ chỉ tính 16 giờ trực.
    hours: real("hours"),
    // ANY | WEEKDAY | WEEKEND | HOLIDAY - ca này được dùng cho loại ngày nào.
    dayScope: text("day_scope").default("ANY"),
    // Hệ số quy đổi khi tính phụ cấp, chỉ để báo cáo.
    coefficient: real("coefficient").default(1),
    /* QUY ĐỔI SANG CÔNG HÀNH CHÍNH - mặc định TẮT.
       Chừng nào Quản trị chưa bật cờ này trên chính ca đó thì một ca trực không
       bao giờ được cộng vào ngày công hành chính (mục VIII của yêu cầu nghiệp
       vụ). Khi bật, admin_day_value quyết định cộng bao nhiêu ngày công. */
    countsAsAdminDay: text("counts_as_admin_day").default("false"),
    adminDayValue: real("admin_day_value").default(0),
    color: text("color"),
    note: text("note"),
    displayOrder: integer("display_order").default(0),
    status: text("status").default("ACTIVE"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [uniqueIndex("att_shifts_code_uidx").on(table.code)]
);

/* Danh mục ngày nghỉ lễ. Khoảng ngày (start_date..end_date) chứ không phải một
   ngày, để nghỉ Tết nhiều ngày chỉ cần một bản ghi. */
export const attHolidays = pgTable(
  "att_holidays",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    // HOLIDAY (lễ) | TET (tết) | OTHER (ngày nghỉ khác do cấp trên cho)
    dayType: text("day_type").default("HOLIDAY"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [index("att_holidays_range_idx").on(table.startDate, table.endDate)]
);

/* SỔ CHẤM CÔNG HÀNH CHÍNH - mỗi lần bấm CHẤM VÀO / CHẤM RA là một bản ghi.

   Bản ghi chỉ THÊM, không sửa: một lượt chấm sai được xử lý bằng yêu cầu điều
   chỉnh (att_requests), và khi được duyệt thì hệ thống ghi thêm một lượt chấm
   mới với source = REQUEST kèm con trỏ về yêu cầu gốc. Nhờ vậy dữ liệu gốc do
   cán bộ tạo ra không bao giờ bị ghi đè mất. */
export const attPunches = pgTable(
  "att_punches",
  {
    id: serial("id").primaryKey(),
    employeeId: text("employee_id").notNull(),
    // Ngày làm việc dạng YYYY-MM-DD theo giờ Việt Nam, KHÔNG phải theo giờ máy
    // chủ: máy chủ Netlify chạy theo UTC nên một lượt chấm lúc 07:30 sáng ở Lào
    // Cai sẽ bị xếp sang ngày hôm trước nếu lấy ngày từ dấu thời gian UTC.
    workDate: text("work_date").notNull(),
    // IN | OUT
    punchType: text("punch_type").notNull(),
    punchAt: bigint("punch_at", { mode: "number" }).notNull(),
    // MORNING | AFTERNOON | OUTSIDE - buổi làm việc mà lượt chấm này thuộc về.
    session: text("session"),
    // ON_TIME | LATE | EARLY_LEAVE | OUTSIDE - kết luận của hệ thống tại thời
    // điểm chấm, lưu lại để bảng công tháng cũ không đổi khi Quản trị sửa giờ
    // hành chính về sau.
    status: text("status"),
    // Số phút lệch so với mốc giờ quy định: dương là muộn/về sớm.
    minutesDelta: integer("minutes_delta").default(0),
    device: text("device"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    // SELF (cán bộ tự chấm) | ADMIN (Quản trị chấm hộ) | REQUEST (sinh ra từ
    // yêu cầu điều chỉnh đã được duyệt)
    source: text("source").default("SELF"),
    requestId: text("request_id"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: bigint("created_at", { mode: "number" }),
  },
  (table) => [
    index("att_punches_employee_date_idx").on(table.employeeId, table.workDate),
    index("att_punches_date_idx").on(table.workDate),
  ]
);

/* LỊCH TRỰC - ai trực ca nào, ngày nào. Một bản ghi là một suất trực.

   day_type được chốt lại ngay lúc phân lịch thay vì luôn tính lại từ danh mục
   ngày lễ. Lý do: danh mục ngày lễ có thể được bổ sung muộn (cấp trên cho nghỉ
   bù), mà bảng tổng hợp của tháng đã chốt thì không được tự đổi số liệu. Khi
   Quản trị muốn áp lại, có hành động "tính lại loại ngày" tường minh. */
export const attDutyAssignments = pgTable(
  "att_duty_assignments",
  {
    id: text("id").primaryKey(),
    dutyDate: text("duty_date").notNull(),
    shiftId: text("shift_id").notNull(),
    employeeId: text("employee_id").notNull(),
    // WEEKDAY | WEEKEND | HOLIDAY
    dayType: text("day_type").default("WEEKDAY"),
    // PLANNED | CANCELLED
    status: text("status").default("PLANNED"),
    // Suất trực này có được từ một lần đổi ca đã duyệt.
    swappedFromEmployeeId: text("swapped_from_employee_id"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("att_duty_unique_idx").on(table.dutyDate, table.shiftId, table.employeeId),
    index("att_duty_date_idx").on(table.dutyDate),
    index("att_duty_employee_idx").on(table.employeeId),
  ]
);

/* SỔ CHẤM TRỰC - cán bộ bấm nhận ca và kết ca trên suất trực đã được phân.
   Tách khỏi att_punches để không có phép cộng nào trộn lẫn hai loại công. */
export const attDutyLogs = pgTable(
  "att_duty_logs",
  {
    id: serial("id").primaryKey(),
    assignmentId: text("assignment_id").notNull(),
    employeeId: text("employee_id").notNull(),
    dutyDate: text("duty_date").notNull(),
    shiftId: text("shift_id").notNull(),
    checkInAt: bigint("check_in_at", { mode: "number" }),
    checkOutAt: bigint("check_out_at", { mode: "number" }),
    // Số giờ trực được ghi nhận. Lấy theo định mức của ca, không lấy hiệu giờ
    // thực bấm: cán bộ kết ca muộn 10 phút không làm tăng giờ trực của trạm.
    hours: real("hours"),
    device: text("device"),
    ip: text("ip"),
    // OPEN (đã nhận ca, chưa kết) | DONE | ADMIN (Quản trị ghi nhận thay)
    status: text("status").default("OPEN"),
    source: text("source").default("SELF"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [
    index("att_duty_logs_employee_date_idx").on(table.employeeId, table.dutyDate),
    index("att_duty_logs_assignment_idx").on(table.assignmentId),
  ]
);

/* Đơn nghỉ phép. Loại nghỉ là MÃ tự do khớp với danh mục trong att_settings
   (khoá "leave_types"), nhờ đó trạm thêm loại nghỉ mới mà không phải di trú
   cơ sở dữ liệu. */
export const attLeaves = pgTable(
  "att_leaves",
  {
    id: text("id").primaryKey(),
    employeeId: text("employee_id").notNull(),
    leaveType: text("leave_type").notNull(),
    fromDate: text("from_date").notNull(),
    toDate: text("to_date").notNull(),
    // Số ngày nghỉ quy đổi (0.5 cho nửa ngày).
    days: real("days"),
    // FULL | MORNING | AFTERNOON
    session: text("session").default("FULL"),
    reason: text("reason"),
    attachment: text("attachment"),
    // PENDING | APPROVED | REJECTED | CANCELLED
    status: text("status").default("PENDING"),
    decidedBy: text("decided_by"),
    decidedByName: text("decided_by_name"),
    decidedAt: bigint("decided_at", { mode: "number" }),
    decisionNote: text("decision_note"),
    createdBy: text("created_by"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [
    index("att_leaves_employee_idx").on(table.employeeId),
    index("att_leaves_range_idx").on(table.fromDate, table.toDate),
    index("att_leaves_status_idx").on(table.status),
  ]
);

/* Yêu cầu của cán bộ cần người phụ trách duyệt: điều chỉnh chấm công và đổi ca
   trực. Nội dung cụ thể nằm trong payload JSON vì hai loại yêu cầu có hình
   dạng khác nhau, nhưng luồng duyệt thì giống nhau hoàn toàn. */
export const attRequests = pgTable(
  "att_requests",
  {
    id: text("id").primaryKey(),
    // ADJUST_PUNCH | SWAP_DUTY
    kind: text("kind").notNull(),
    employeeId: text("employee_id").notNull(),
    targetDate: text("target_date"),
    payload: text("payload"),
    reason: text("reason"),
    // PENDING | APPROVED | REJECTED | CANCELLED
    status: text("status").default("PENDING"),
    decidedBy: text("decided_by"),
    decidedByName: text("decided_by_name"),
    decidedAt: bigint("decided_at", { mode: "number" }),
    decisionNote: text("decision_note"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (table) => [
    index("att_requests_status_idx").on(table.status),
    index("att_requests_employee_idx").on(table.employeeId),
  ]
);

/* Kỳ bảng công tháng. Khoá kỳ (status = LOCKED) là chốt cuối cùng: mọi đường
   ghi dữ liệu của tháng đó đều bị máy chủ từ chối, kể cả đường của Quản trị. */
export const attPeriods = pgTable("att_periods", {
  // Dạng YYYY-MM.
  id: text("id").primaryKey(),
  // OPEN | LOCKED
  status: text("status").default("OPEN"),
  lockedBy: text("locked_by"),
  lockedByName: text("locked_by_name"),
  lockedAt: bigint("locked_at", { mode: "number" }),
  note: text("note"),
  updatedAt: bigint("updated_at", { mode: "number" }),
});

/* Thông báo trong phân hệ: yêu cầu được duyệt/từ chối, lịch trực mới, nhắc
   chưa chấm công. Gắn theo cán bộ chứ không theo tài khoản, để người được cấp
   tài khoản muộn vẫn đọc được thông báo cũ của mình. */
export const attNotifications = pgTable(
  "att_notifications",
  {
    id: serial("id").primaryKey(),
    employeeId: text("employee_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    kind: text("kind").default("INFO"),
    refId: text("ref_id"),
    readAt: bigint("read_at", { mode: "number" }),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (table) => [index("att_notifications_employee_ts_idx").on(table.employeeId, table.ts)]
);

/* LỊCH SỬ THAO TÁC. Mọi đường ghi của phân hệ đều đi qua đây - không có ngoại
   lệ cho Quản trị. Đây là điều kiện để bảng công có giá trị đối chiếu: một con
   số bị sửa mà không ai biết ai sửa thì cả bảng mất tin cậy. */
export const attAudits = pgTable(
  "att_audits",
  {
    id: serial("id").primaryKey(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    action: text("action").notNull(),
    field: text("field"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    actorUsername: text("actor_username"),
    ip: text("ip"),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (table) => [
    index("att_audits_entity_ts_idx").on(table.entity, table.ts),
    index("att_audits_ts_idx").on(table.ts),
  ]
);
