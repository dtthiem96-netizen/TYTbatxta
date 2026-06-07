import { db } from "../../db/index.js";
import { news, vaccines, documents, services, users, siteConfigs } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const defaultUsers = [
  { id: 'U1', username: 'tytbatxat@laocai.gov.vn', name: 'Trạm trưởng', role: 'Quản trị viên (Admin)' }
];

const defaultNews = [
  { id: 'N3', title: 'Cảnh báo khẩn: Gia tăng ca mắc sốt xuất huyết tại địa bàn xã', description: 'Trạm Y tế Bát Xát khuyến cáo bà con diệt bọ gậy, dọn dẹp vật chứa nước.', date: '29/05/2026', icon: 'fa-mosquito', color: 'red', ts: 3 },
  { id: 'N2', title: 'Hướng dẫn phòng tránh ngộ độc nấm độc rừng mùa hè', description: 'Tuyệt đối không hái nấm lạ, nấm có màu sắc sặc sỡ để ăn.', date: '25/05/2026', icon: 'fa-skull-crossbones', color: 'orange', ts: 2 }
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

      let configsList = await db.select().from(siteConfigs);

      return new Response(JSON.stringify({
        news: newsList,
        vaccines: vaccinesList,
        documents: docsList,
        services: servicesList,
        users: usersList,
        siteConfigs: configsList
      }), { headers, status: 200 });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const { action, type, data, id } = body;

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
        } else if (type === "users") {
          const existing = await db.select().from(users).where(eq(users.id, data.id));
          if (existing.length > 0) {
            await db.update(users).set(data).where(eq(users.id, data.id));
          } else {
            await db.insert(users).values(data);
          }
        } else if (type === "siteConfigs") {
          const existing = await db.select().from(siteConfigs).where(eq(siteConfigs.id, data.id));
          if (existing.length > 0) {
            await db.update(siteConfigs).set(data).where(eq(siteConfigs.id, data.id));
          } else {
            await db.insert(siteConfigs).values(data);
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
        } else if (type === "users") {
          await db.delete(users).where(eq(users.id, id));
        } else if (type === "siteConfigs") {
          await db.delete(siteConfigs).where(eq(siteConfigs.id, id));
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
