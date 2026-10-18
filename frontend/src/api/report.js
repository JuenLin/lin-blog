// 举报接口（第 12 批，docs/API.md「举报与审核（第 12 批）」）。
// 用户端 POST /api/reports 需登录；管理端两个接口需 ADMIN（非管理员 403/40300）。
//
// 口径速记：
//   - 防重复：同一用户对同一对象只有一行，第二次举报 409/40900（含上次已被处理的）；
//   - 404 = 目标不可见（软删 / 草稿文章、所属文章不可见的评论）；
//   - 400 = 字段校验失败 / 不能举报自己；
//   - 管理端处理是后端单事务：deleteTarget=true 时联动软删目标（评论级联子评论）
//     并把该目标全部 PENDING 举报批转 RESOLVED，前端只需一次调用。
import request from './request.js';

/**
 * 提交举报。对应 POST /api/reports。
 *
 * @param {{ targetType: 'ARTICLE'|'COMMENT', targetId: number, reason?: string }} body
 *   reason 选填，最长 200 字；空串按「没填」处理。
 * @returns {Promise<{id: number, targetType: string, targetId: number, status: string}>}
 */
export function createReport(body) {
  return request.post('/reports', body);
}

/**
 * 管理端举报列表。对应 GET /api/admin/reports。
 *
 * list[]：id / targetType / targetId / reason / status / createdAt / resolvedAt /
 * reporter{id,username,nickname} / targetPreview{title,authorName,deleted}
 * （目标已软删时 title / authorName 为 null、deleted 为 true）。
 *
 * @param {object} [params] { page, pageSize, status: 'PENDING'|'RESOLVED'|'REJECTED' }
 */
export function listAdminReports(params) {
  return request.get('/admin/reports', { params });
}

/**
 * 管理端处理举报。对应 PUT /api/admin/reports/:id。
 *
 * @param {number} id
 * @param {{ status: 'RESOLVED'|'REJECTED', deleteTarget?: boolean }} body
 *   RESOLVED + deleteTarget:true = 「删除违规内容并处理」（单事务联动）；
 *   REJECTED = 忽略（核实未违规）；REJECTED + deleteTarget 组合后端 400。
 * @returns {Promise<{id: number, status: string, resolvedAt: string, resolvedCount: number, targetDeleted: boolean}>}
 */
export function resolveAdminReport(id, body) {
  return request.put('/admin/reports/' + id, body);
}
