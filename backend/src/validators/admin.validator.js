import { z } from 'zod';
import { CODE, httpError } from '../utils/response.js';

// 第 5 批管理端接口的校验规则（docs/API.md「管理端接口（第 5 批）」）。
//
// 与文章 / 评论列表一致的模式：分页四参数（page / pageSize / sortBy / order）
// 由 utils/pagination.js 的 parsePagination 在 service 层解析，keyword 由
// validators/article.validator.js 的 parseKeyword 解析——都不进本文件。
// 本文件只放「管理端独有」的校验：请求体 status、status / deleted 两个筛选参数。

/** users.status 的合法值（PATCH body 与列表筛选共用）。 */
export const USER_STATUSES = ['ACTIVE', 'BANNED'];

/**
 * PATCH /api/admin/users/:id/status 的请求体。
 *
 * status 必填（显式设值，不传即 400）——与「缺 = 不改」的三态语义区分：
 * 这里是状态机 set 操作，调用方必须明确说要 SET 成什么。
 */
export const updateUserStatusSchema = z.object({
  status: z.enum(USER_STATUSES, { message: `status 只能是 ${USER_STATUSES.join(' 或 ')}` }),
});

/**
 * 管理端列表的 status 筛选（GET /api/admin/users）。
 *
 * 与 parseCategory 同源同层：由 service 层调用，不挂路由 validate。
 * 语义：不传 / 空串 = 不过滤；重复传值 / 非字符串 / 非法值 = 400 / 40000。
 */
export function parseUserStatus(query) {
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

  if (!USER_STATUSES.includes(trimmed)) {
    throw httpError(400, CODE.PARAM_ERROR, `status 不合法，可选值：${USER_STATUSES.join(', ')}`);
  }

  return trimmed;
}

/**
 * 管理端列表的 deleted 筛选（articles / comments）。
 *
 * Express 的 query 全是字符串，所以合法值是 'true' / 'false' 两个字符串，
 * 在这里转成 boolean（null = 不过滤 = 全部，含软删）。
 */
export function parseDeletedFilter(query) {
  const source = query && typeof query === 'object' ? query : {};
  const value = source.deleted;

  if (value === undefined || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    throw httpError(400, CODE.PARAM_ERROR, 'deleted 不允许重复传值');
  }

  if (typeof value !== 'string') {
    throw httpError(400, CODE.PARAM_ERROR, 'deleted 必须是字符串');
  }

  const trimmed = value.trim().toLowerCase();

  if (trimmed === '') {
    return null;
  }

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  throw httpError(400, CODE.PARAM_ERROR, 'deleted 只能是 true 或 false');
}
