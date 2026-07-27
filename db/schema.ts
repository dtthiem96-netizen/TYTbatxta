import { pgTable, text, bigint, serial, index } from "drizzle-orm/pg-core";

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

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  canReceiveVideo: text("can_receive_video").default("true"),
});

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
