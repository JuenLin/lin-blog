import { z } from 'zod';
import { CODE, httpError } from '../utils/response.js';

// 第 12 批举报接口的校验规则（docs/API.md「举报与审核（第 12 批）」）。
//
// 模式与 admin.validator.js 同源：分页四参数由 parsePagination 在 service 层解析，
// status 筛选（parseReportStatus）由 service 层调用——不进路由 validate。
// 本文件只放「举报独有」的校验：提交 body、处理 body、路径 id。

/** reports.target_type 的合法值（POST body 用，DB 层 ENUM 兜底同值域）。 */
export const REPORT_TARGET_TYPES = ['ARTICLE', 'COMMENT'];

/** 管理端处理可 SET 的目标状态。PENDING 不是处理终态，PUT body 里非法。 */
export const REPORT_RESOLVE_STATUSES = ['RESOLVED', 'REJECTED'];

/** GET /api/admin/reports 的 status 筛选白名单（含 PENDING）。 */
export const REPORT_STATUSES = ['PENDING', 'RESOLVED', 'REJECTED'];

/** 举报理由上限（DB 层 VARCHAR(200) 兜底，接口层先行拒绝）。 */
export const REPORT_REASON_MAX = 200;

/**
 * POST /api/reports 的请求体。
 * reason 选填：空串按「没填」处理（service 层归一化为 null），不给 DB 塞空串。
 */
export const createReportSchema = z.object({
  targetType: z.enum(REPORT_TARGET_TYPES, {
    message: `targetType 只能是 ${REPORT_TARGET_TYPES.join(' 或 ')}`,
  }),
  targetId: z.coerce
    .number({ message: 'targetId 必须是数字' })
    .int('targetId 必须是整数')
    .positive('targetId 必须是正整数'),
  reason: z
    .string()
    .max(REPORT_REASON_MAX, `举报理由最长 ${REPORT_REASON_MAX} 字`)
    .optional(),
});

/**
 * PUT /api/admin/reports/:id 的请求体。
 * status 必填（状态机 set，显式说清处理成什么）；deleteTarget 选填布尔，
 * REJECTED + deleteTarget 的组合冲突在 service 层报 400（错误语义更贴业务）。
 */
export const resolveReportSchema = z.object({
  status: z.enum(REPORT_RESOLVE_STATUSES, {
    message: `status 只能是 ${REPORT_RESOLVE_STATUSES.join(' 或 ')}`,
  }),
  deleteTarget: z.boolean().optional(),
});

/** /api/admin/reports/:id 与 POST /api/reports 的路径/目标 id。 */
export const reportIdParamSchema = z.object({
  id: z.coerce
    .number()
    .int('必须是整数')
    .positive('必须是正整数'),
});

/**
 * 管理端举报列表的 status 筛选（GET /api/admin/reports）。
 * 与 parseUserStatus 同源同层：service 层调用，不挂路由 validate。
 * 语义：不传 / 空串 = 不过滤；重复传值 / 非法值 = 400 / 40000。
 */
export function parseReportStatus(query) {
  const source = query && typeof query === 'object' ? query : {};
  const value = source.status;

  if (value === undefined || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    throw httpError(400, CODE.PARAM_ERROR, 'status 不允许重复传值');
  }

  if (typeof value !== 'string') {
    throw httpError(400, CODE.PARAM_ERROR, 'status 必须是字符串');
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  if (!REPORT_STATUSES.includes(trimmed)) {
    throw httpError(400, CODE.PARAM_ERROR, `status 不合法，可选值：${REPORT_STATUSES.join(', ')}`);
  }

  return trimmed;
}
