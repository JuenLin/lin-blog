import { sendOk, sendCreated } from '../utils/response.js';
import {
  createReport as createReportService,
  listReports as listReportsService,
  resolveReport as resolveReportService,
} from '../services/report.service.js';

// 第 12 批举报控制器。薄封装：解析 req → 调 service → sendOk/sendCreated，
// 错误一律 next(error) 交全局 errorHandler。
// 管理端两个接口的角色判断在路由层的 auth → requireAdmin 完成；
// POST /api/reports 的登录判断在路由层 auth 完成。

/** POST /api/reports（需登录）。举报人取 token 中的 userId。 */
export async function create(req, res, next) {
  try {
    const data = await createReportService(req.user.userId, req.validated.body);

    return sendCreated(res, data);
  } catch (error) {
    return next(error);
  }
}

/** GET /api/admin/reports（需 ADMIN）。分页 / status 筛选在 service 层 parse。 */
export async function list(req, res, next) {
  try {
    const data = await listReportsService(req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

/**
 * PUT /api/admin/reports/:id（需 ADMIN）。
 * 处理人取 token 中的 userId（通知 actor；恰为举报人时自通知抑制在 service 层）。
 */
export async function resolve(req, res, next) {
  try {
    const data = await resolveReportService(req.user.userId, req.validated.params.id, req.validated.body);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
