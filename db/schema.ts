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
