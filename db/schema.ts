import { pgTable, text, bigint, serial, integer, real, index } from "drizzle-orm/pg-core";

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
  symptoms: text("symptoms"),
  vitals: text("vitals"),
  notes: text("notes"),
  status: text("status").default("WAITING"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Danh sách thành viên đang có mặt trong phòng (presence) dùng cho signaling WebRTC
export const telehealthPeers = pgTable(
  "telehealth_peers",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    role: text("role").notNull(),
    name: text("name").notNull(),
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
