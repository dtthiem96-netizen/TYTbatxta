import { db } from "../../db/index.js";
import { news, vaccines, documents, services, users, siteConfigs, contacts, videos, appointments, prescriptionSigners } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { getStore } from "@netlify/blobs";
import { publicUser } from "../lib/auth.js";

const defaultUsers = [
  { id: 'U1', username: 'tytbatxat@laocai.gov.vn', name: 'Trạm trưởng', role: 'Quản trị viên (Admin)', canReceiveVideo: 'true', stationAccess: 'true' },
  { id: 'U2', username: 'bacsituvan@laocai.gov.vn', name: 'BS. Nguyễn Thị Mai (Tư vấn Telehealth)', role: 'Bác sĩ nhận cuộc gọi', canReceiveVideo: 'true', stationAccess: 'false' },
  { id: 'U3', username: 'bientapvien@laocai.gov.vn', name: 'Cán bộ Truyền thông', role: 'Cán bộ biên tập (Editor)', canReceiveVideo: 'false', stationAccess: 'false' },
  { id: 'U4', username: 'canbotram@laocai.gov.vn', name: 'Y sĩ Cán bộ Điểm trạm', role: 'Cán bộ Điểm trạm (Station Operator)', canReceiveVideo: 'true', stationAccess: 'true' }
];

/* Khoá cấu hình mang bí mật của hệ thống, không được đi ra trình duyệt cùng
   phần cấu hình công khai (tên phòng khám, ...). */
const PRIVATE_CONFIG_IDS = new Set(['auth-jwt-secret']);

const defaultSigners = [
  { id: 'SIG1', name: 'BS. Nguyễn Thị Mai (Tư vấn Telehealth)', title: 'Bác sĩ', license: '001234/LCA-CCHN', workplace: 'Trạm Y tế Bát Xát', signature: '', isDefault: 'true', ts: Date.now() },
  { id: 'SIG2', name: 'Trạm trưởng', title: 'BS. Trạm Trưởng', license: '001000/LCA-CCHN', workplace: 'Trạm Y tế Bát Xát', signature: '', isDefault: 'false', ts: Date.now() }
];

const defaultNews = [
  { id: 'N3', title: 'Cảnh báo khẩn: Gia tăng ca mắc sốt xuất huyết tại địa bàn xã', description: 'Trạm Y tế Bát Xát khuyến cáo bà con diệt bọ gậy, dọn dẹp vật chứa nước.', date: '29/05/2026', icon: 'fa-mosquito', color: 'red', ts: 3, image: null },
  { id: 'N2', title: 'Hướng dẫn phòng tránh ngộ độc nấm độc rừng mùa hè', description: 'Tuyệt đối không hái nấm lạ, nấm có màu sắc sặc sỡ để ăn.', date: '25/05/2026', icon: 'fa-skull-crossbones', color: 'orange', ts: 2, image: null }
];

const defaultDocuments = [
  { id: 'D1', title: 'Mẫu Giấy xin chuyển tuyến BHYT chuẩn', type: 'Biểu mẫu y tế', url: '#', date: '26/05/2026', ts: 2 },
  { id: 'D2', title: 'Tài liệu hướng dẫn 3 bước phòng Sốt Rét tại nhà', type: 'Tài liệu y tế', url: '#', date: '25/05/2026', ts: 1 }
];

const defaultVaccines = [
  { id: 'V1', date: 'Sáng 05/06/2026', time: '07:30 - 11:30', target: 'Trẻ em & Phụ nữ mang thai thuộc: Thôn 1, Thôn 2, Thôn 3, Thôn 4, Thôn 5', ts: 2 },
  { id: 'V2', date: 'Sáng 06/06/2026', time: '07:30 - 11:30', target: 'Trẻ em & Phụ nữ mang thai thuộc: Thôn 6, Thôn 7, Thôn 8, Thôn 9, Thôn 10', ts: 1 }
];

const defaultServices = [
  { id: 'S1', name: 'Phòng Khám Chung / Đa Khoa', person: 'BS. Trạm Trưởng', zalo: '0382103002', ts: 3 },
  { id: 'S2', name: 'Phòng Khám Sản - Phụ Khoa', person: 'Nữ hộ sinh chuyên trách', zalo: '0382103002', ts: 2 },
  { id: 'S3', name: 'Phòng Y Học Cổ Truyền', person: 'Cán bộ Đông Y', zalo: '0382103002', ts: 1 }
];

const defaultContacts = [
  { id: 'C1', name: 'BS. Trạm Trưởng', role: 'Trạm trưởng Trạm Y tế', phone: '0382103002', ts: 3 },
  { id: 'C2', name: 'Nữ hộ sinh chuyên trách', role: 'Phòng Khám Sản - Phụ Khoa', phone: '0382103002', ts: 2 },
  { id: 'C3', name: 'Cán bộ Đông Y', role: 'Phòng Y Học Cổ Truyền', phone: '0382103002', ts: 1 }
];

const defaultVideos = [
  { id: 'VD1', title: 'Hướng dẫn rửa tay 6 bước chuẩn Bộ Y tế', description: 'Video hướng dẫn rửa tay bằng xà phòng đúng cách phòng tránh dịch bệnh truyền nhiễm hiệu quả.', url: 'https://www.youtube.com/embed/fA4P9B2U-q0', date: '01/06/2026', ts: 101, isCollapsed: 'false' },
  { id: 'VD2', title: 'Sơ cứu dị vật đường thở ở trẻ em', description: 'Hướng dẫn phụ huynh và giáo viên cách xử trí nhanh khi trẻ bị hóc dị vật bằng nghiệm pháp Heimlich an toàn.', url: 'https://www.youtube.com/embed/T00O3IitfRE', date: '28/05/2026', ts: 100, isCollapsed: 'false' }
];

export default async (req: Request) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  try {
    if (req.method === "GET") {
      let newsList = await db.select().from(news);
      if (newsList.length === 0) {
        await db.insert(news).values(defaultNews);
        newsList = await db.select().from(news);
      }

      let vaccinesList = await db.select().from(vaccines);
      if (vaccinesList.length === 0) {
        await db.insert(vaccines).values(defaultVaccines);
        vaccinesList = await db.select().from(vaccines);
      }

      let docsList = await db.select().from(documents);
      if (docsList.length === 0) {
        await db.insert(documents).values(defaultDocuments);
        docsList = await db.select().from(documents);
      }

      let servicesList = await db.select().from(services);
      if (servicesList.length === 0) {
        await db.insert(services).values(defaultServices);
        servicesList = await db.select().from(services);
      }

      let usersList = await db.select().from(users);
      if (usersList.length === 0) {
        await db.insert(users).values(defaultUsers);
        usersList = await db.select().from(users);
      }

      let contactsList = await db.select().from(contacts);
      if (contactsList.length === 0) {
        await db.insert(contacts).values(defaultContacts);
        contactsList = await db.select().from(contacts);
      }

      let videosList = await db.select().from(videos);
      if (videosList.length === 0) {
        await db.insert(videos).values(defaultVideos);
        videosList = await db.select().from(videos);
      }

      let appointmentsList = await db.select().from(appointments);

      let configsList = await db.select().from(siteConfigs);
      configsList = configsList.filter(c => !PRIVATE_CONFIG_IDS.has(c.id));

      // Danh sách người ký đơn thuốc kèm chữ ký số đã lưu sẵn
      let signersList = await db.select().from(prescriptionSigners);
      if (signersList.length === 0) {
        await db.insert(prescriptionSigners).values(defaultSigners);
        signersList = await db.select().from(prescriptionSigners);
      }

      // Tự động đồng bộ các Bác sĩ được cấp quyền nhận cuộc gọi Video (canReceiveVideo = true) sang danh sách Người ký số
      for (const u of usersList) {
        if (u.canReceiveVideo === 'true') {
          const exists = signersList.some(s => s.id === u.id || s.name.toLowerCase().includes(u.name.toLowerCase()) || u.name.toLowerCase().includes(s.name.toLowerCase()));
          if (!exists) {
            const newSigner = {
              id: 'SIG_' + u.id,
              name: u.name,
              title: u.name.startsWith('BS.') ? 'Bác sĩ' : 'Bác sĩ/Y sĩ',
              license: '00' + Math.floor(100000 + Math.random() * 900000) + '/LCA-CCHN',
              workplace: 'Trạm Y tế Bát Xát',
              signature: '',
              isDefault: 'false',
              ts: Date.now()
            };
            await db.insert(prescriptionSigners).values(newSigner);
          }
        }
      }
      signersList = await db.select().from(prescriptionSigners);

      return new Response(JSON.stringify({
        news: newsList,
        vaccines: vaccinesList,
        documents: docsList,
        services: servicesList,
        /* Danh sách tài khoản đi qua publicUser(): chuỗi băm mật khẩu và mọi
           trường nhạy cảm khác bị loại bỏ trước khi rời máy chủ. Tuyến này công
           khai (trang chủ dùng để dựng danh sách bác sĩ trực), nên đây là ranh
           giới bắt buộc. */
        users: usersList.map(publicUser),
        contacts: contactsList,
        videos: videosList,
        appointments: appointmentsList,
        siteConfigs: configsList,
        prescriptionSigners: signersList
      }), { headers, status: 200 });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const { action, type, data, id } = body;

      if (action === "upload_chunk") {
        const { id: videoId, index, total, chunk, mimeType } = body;
        if (!videoId || index === undefined || !total || !chunk) {
          return new Response(JSON.stringify({ error: "Missing parameters" }), { headers, status: 400 });
        }

        const base64Data = chunk.split(",")[1] || chunk;
        const buffer = Buffer.from(base64Data, "base64");

        const chunkStore = getStore("video-chunks");
        await chunkStore.set(`${videoId}/${index}`, new Blob([buffer]));

        let allUploaded = true;
        const chunkList: Buffer[] = [];
        for (let i = 0; i < total; i++) {
          const got = await chunkStore.get(`${videoId}/${i}`, { type: "arrayBuffer" });
          if (!got) {
            allUploaded = false;
            break;
          }
          chunkList.push(Buffer.from(got));
        }

        if (allUploaded) {
          const finalBuffer = Buffer.concat(chunkList);
          const videoStore = getStore("videos");
          await videoStore.set(videoId, new Blob([finalBuffer]), {
            metadata: { contentType: mimeType || "video/mp4" }
          });

          for (let i = 0; i < total; i++) {
            await chunkStore.delete(`${videoId}/${i}`);
          }

          return new Response(JSON.stringify({ success: true, complete: true, url: `/api/video?id=${videoId}` }), { headers, status: 200 });
        }

        return new Response(JSON.stringify({ success: true, complete: false }), { headers, status: 200 });
      }

      if (action === "upload_attachment_chunk") {
        const { id: fileId, index, total, chunk, mimeType, fileName } = body;
        if (!fileId || index === undefined || !total || !chunk) {
          return new Response(JSON.stringify({ error: "Missing parameters" }), { headers, status: 400 });
        }

        const base64Data = chunk.split(",")[1] || chunk;
        const buffer = Buffer.from(base64Data, "base64");

        const chunkStore = getStore("attachment-chunks");
        await chunkStore.set(`${fileId}/${index}`, new Blob([buffer]));

        let allUploaded = true;
        const chunkList: Buffer[] = [];
        for (let i = 0; i < total; i++) {
          const got = await chunkStore.get(`${fileId}/${i}`, { type: "arrayBuffer" });
          if (!got) {
            allUploaded = false;
            break;
          }
          chunkList.push(Buffer.from(got));
        }

        if (allUploaded) {
          const finalBuffer = Buffer.concat(chunkList);
          const attachmentStore = getStore("attachments");
          await attachmentStore.set(fileId, new Blob([finalBuffer]), {
            metadata: { contentType: mimeType || "application/octet-stream" }
          });

          for (let i = 0; i < total; i++) {
            await chunkStore.delete(`${fileId}/${i}`);
          }

          return new Response(JSON.stringify({ success: true, complete: true, url: `/api/attachment?id=${fileId}`, name: fileName }), { headers, status: 200 });
        }

        return new Response(JSON.stringify({ success: true, complete: false }), { headers, status: 200 });
      }

      if (action === "save") {
        if (type === "news") {
          const existing = await db.select().from(news).where(eq(news.id, data.id));
          if (existing.length > 0) {
            await db.update(news).set(data).where(eq(news.id, data.id));
          } else {
            await db.insert(news).values(data);
          }
        } else if (type === "vaccines") {
          const existing = await db.select().from(vaccines).where(eq(vaccines.id, data.id));
          if (existing.length > 0) {
            await db.update(vaccines).set(data).where(eq(vaccines.id, data.id));
          } else {
            await db.insert(vaccines).values(data);
          }
        } else if (type === "documents") {
          const existing = await db.select().from(documents).where(eq(documents.id, data.id));
          if (existing.length > 0) {
            await db.update(documents).set(data).where(eq(documents.id, data.id));
          } else {
            await db.insert(documents).values(data);
          }
        } else if (type === "services") {
          const existing = await db.select().from(services).where(eq(services.id, data.id));
          if (existing.length > 0) {
            await db.update(services).set(data).where(eq(services.id, data.id));
          } else {
            await db.insert(services).values(data);
          }
        } else if (type === "contacts") {
          const existing = await db.select().from(contacts).where(eq(contacts.id, data.id));
          if (existing.length > 0) {
            await db.update(contacts).set(data).where(eq(contacts.id, data.id));
          } else {
            await db.insert(contacts).values(data);
          }
        } else if (type === "users") {
          /* Tài khoản KHÔNG còn ghi được qua tuyến công khai này. Nếu để nguyên,
             bất kỳ ai gửi một lệnh POST cũng tự cấp được cho mình quyền vào Mod
             Bảng điều khiển điểm trạm - vô hiệu hoá toàn bộ phần phân quyền.
             Mọi thao tác tài khoản đi qua /api/admin-users, nơi bắt buộc phiếu
             phiên có phạm vi "admin". */
          return new Response(JSON.stringify({
            error: "Thao tác tài khoản phải thực hiện qua /api/admin-users (yêu cầu quyền Quản trị)."
          }), { headers, status: 403 });
        } else if (type === "siteConfigs") {
          if (PRIVATE_CONFIG_IDS.has(String(data?.id || ""))) {
            return new Response(JSON.stringify({ error: "Không được sửa cấu hình hệ thống này." }), { headers, status: 403 });
          }
          const existing = await db.select().from(siteConfigs).where(eq(siteConfigs.id, data.id));
          if (existing.length > 0) {
            await db.update(siteConfigs).set(data).where(eq(siteConfigs.id, data.id));
          } else {
            await db.insert(siteConfigs).values(data);
          }
        } else if (type === "videos") {
          const existing = await db.select().from(videos).where(eq(videos.id, data.id));
          if (existing.length > 0) {
            await db.update(videos).set(data).where(eq(videos.id, data.id));
          } else {
            await db.insert(videos).values(data);
          }
        } else if (type === "appointments") {
          const existing = await db.select().from(appointments).where(eq(appointments.id, data.id));
          if (existing.length > 0) {
            await db.update(appointments).set(data).where(eq(appointments.id, data.id));
          } else {
            await db.insert(appointments).values(data);
          }
        } else if (type === "prescriptionSigners") {
          const existing = await db.select().from(prescriptionSigners).where(eq(prescriptionSigners.id, data.id));
          if (existing.length > 0) {
            await db.update(prescriptionSigners).set(data).where(eq(prescriptionSigners.id, data.id));
          } else {
            await db.insert(prescriptionSigners).values(data);
          }
        } else {
          return new Response(JSON.stringify({ error: "Invalid type" }), { headers, status: 400 });
        }
        return new Response(JSON.stringify({ success: true }), { headers, status: 200 });
      }

      if (action === "delete") {
        if (type === "news") {
          await db.delete(news).where(eq(news.id, id));
        } else if (type === "vaccines") {
          await db.delete(vaccines).where(eq(vaccines.id, id));
        } else if (type === "documents") {
          await db.delete(documents).where(eq(documents.id, id));
        } else if (type === "services") {
          await db.delete(services).where(eq(services.id, id));
        } else if (type === "contacts") {
          await db.delete(contacts).where(eq(contacts.id, id));
        } else if (type === "users") {
          // Xoá tài khoản cũng chỉ được phép qua /api/admin-users.
          return new Response(JSON.stringify({
            error: "Thao tác tài khoản phải thực hiện qua /api/admin-users (yêu cầu quyền Quản trị)."
          }), { headers, status: 403 });
        } else if (type === "siteConfigs") {
          if (PRIVATE_CONFIG_IDS.has(String(id || ""))) {
            return new Response(JSON.stringify({ error: "Không được xoá cấu hình hệ thống này." }), { headers, status: 403 });
          }
          await db.delete(siteConfigs).where(eq(siteConfigs.id, id));
        } else if (type === "videos") {
          await db.delete(videos).where(eq(videos.id, id));
        } else if (type === "appointments") {
          await db.delete(appointments).where(eq(appointments.id, id));
        } else if (type === "prescriptionSigners") {
          await db.delete(prescriptionSigners).where(eq(prescriptionSigners.id, id));
        } else {
          return new Response(JSON.stringify({ error: "Invalid type" }), { headers, status: 400 });
        }
        return new Response(JSON.stringify({ success: true }), { headers, status: 200 });
      }

      return new Response(JSON.stringify({ error: "Invalid action" }), { headers, status: 400 });
    }

    return new Response("Method not allowed", { headers, status: 405 });
  } catch (err: any) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), { headers, status: 500 });
  }
};

export const config = {
  path: "/api/cms",
};
