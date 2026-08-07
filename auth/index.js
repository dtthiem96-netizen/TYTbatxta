/**
 * Mô-đun Xác thực (Authentication Module) - điểm vào duy nhất.
 *
 * Gắn vào một ứng dụng Express:
 *
 *   import express from 'express';
 *   import { mountAuthModule } from './auth/index.js';
 *
 *   const app = express();
 *   app.use(express.json());
 *   mountAuthModule(app);   // đăng ký /api/auth/* và /api/cms/*
 *
 * Cấu trúc mô-đun:
 *   authConfig.js     hằng số bảo mật (cost factor, thời hạn phiếu, bí mật ký)
 *   userStore.js      tra cứu tài khoản (mặc định dùng bản gieo hạt, thay được)
 *   authService.js    bcrypt + ký/kiểm JWT
 *   authMiddleware.js rào chắn tuyến đường (401 thiếu phiếu / 403 phiếu hỏng)
 *   authRoutes.js     POST /api/auth/login, GET /api/auth/session
 *   cmsRoutes.js      ví dụ tích hợp: GET /api/cms/dashboard
 */
import authRoutes from "./authRoutes.js";
import cmsRoutes from "./cmsRoutes.js";

/**
 * Đăng ký toàn bộ tuyến đường của mô-đun vào ứng dụng Express.
 *
 * @param {import("express").Express} app
 * @param {{ authBasePath?: string, cmsBasePath?: string }} [options]
 */
export function mountAuthModule(app, options = {}) {
  const authBasePath = options.authBasePath || "/api/auth";
  const cmsBasePath = options.cmsBasePath || "/api/cms";

  app.use(authBasePath, authRoutes);
  app.use(cmsBasePath, cmsRoutes);

  return app;
}

export { default as authMiddleware, requireRole } from "./authMiddleware.js";
export { default as authRoutes } from "./authRoutes.js";
export { default as cmsRoutes } from "./cmsRoutes.js";
export { comparePassword, hashPassword, signAccessToken, verifyAccessToken, extractBearerToken } from "./authService.js";
export { findUserByUsername, setUserProvider, toPublicUser, isActiveUser } from "./userStore.js";
export { BCRYPT_COST_FACTOR, TOKEN_TTL, TOKEN_TTL_SECONDS } from "./authConfig.js";

export default mountAuthModule;
