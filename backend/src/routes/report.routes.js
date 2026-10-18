import { Router } from 'express';
import auth from '../middlewares/auth.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import validate from '../middlewares/validate.js';
import { createReportSchema, resolveReportSchema, reportIdParamSchema } from '../validators/report.validator.js';
import { create, list, resolve } from '../controllers/report.controller.js';

// 第 12 批举报路由（docs/API.md「举报与审核（第 12 批）」）。
// 与 series 同构：用户端与管理端两组接口挂不同前缀，导出两个 router，
// 由 routes/index.js 分别挂载，路由定义仍留在本模块（避免改举报动三个文件）。
//
// 顺序与全站同构：auth 在 validate 前——先确认身份再校验参数，
// 避免未登录的人拿构造的参数探测校验错误信息。

// 挂载在 /api/reports：POST /api/reports（需登录）。
export const reportRouter = Router();

reportRouter.post('/', auth, validate({ body: createReportSchema }), create);

// 挂载在 /api/admin：GET /api/admin/reports、PUT /api/admin/reports/:id（均需 ADMIN）。
// 列表 GET 不挂 validate({ query })：分页与 status 筛选由 service 层 parse
// （parsePagination / parseReportStatus），与既有 admin 列表接口同一模式。
export const adminReportRouter = Router();

adminReportRouter.get('/reports', auth, requireAdmin, list);
adminReportRouter.put('/reports/:id', auth, requireAdmin, validate({ params: reportIdParamSchema, body: resolveReportSchema }), resolve);
