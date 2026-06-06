import { pgTable, text, bigint } from "drizzle-orm/pg-core";

export const news = pgTable("news", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  date: text("date").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
  icon: text("icon"),
  color: text("color"),
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

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull(),
});

export const siteConfigs = pgTable("site_configs", {
  id: text("id").primaryKey(),
  value: text("value").notNull(),
});
