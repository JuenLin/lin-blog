// 管理端接口（第 5 批，docs/API.md「管理端接口（第 5 批）」）。
// 7 个接口全部需要「已登录 + ADMIN」：非管理员会拿到 403 / 40300，
// 被封禁账号会拿到 401 / 40101（旧 token 即刻失效）。
//
// 与 api/user.js 的 /api/users/* 是两套：管理端用户管理走这里，
// api/user.js 里的 /api/users 列表 / 新增 / 改他人 / 删**仍未实现**。
import request from './request.js';

/**
 * 数据概览。对应 GET /api/admin/stats。
 * data：{ users, articles, comments, likes, follows, deletedArticles }
 * 六个实时 COUNT，全部只数未软删（likes / follows 数全表，
 * deletedArticles 是已软删文章数）。**不含「待办举报数」**（未建）。
 *
 * @returns {Promise<{users: number, articles: number, comments: number, likes: number, follows: number, deletedArticles: number}>}
 */
export function getAdminStats() {
  return request.get('/admin/stats');
}

/**
 * 用户列表。对应 GET /api/admin/users。
 *
 * **不含软删用户**（与所有用户只读接口口径一致）。
 * list[]：id / username / nickname / avatar / role / status / createdAt（无 password）。
 *
 * @param {object} [params] { page, pageSize, sortBy, order, keyword, status }
 * @returns {Promise<{list: object[], page: number, pageSize: number, total: number, totalPages: number}>}
 */
export function listAdminUsers(params) {
  return request.get('/admin/users', { params });
}

/**
 * 封禁 / 解禁用户。对应 PATCH /api/admin/users/:id/status。
 *
 * 幂等：已是目标状态也返回 200。
 * **一刀切防呆**：目标 role = 'ADMIN' → 400 / 40000「不能封禁或解禁管理员账号」
 * （含自己封自己）——管理员权限变更只由开发者直接改数据库。
 *
 * @param {number|string} id 目标用户 id
 * @param {'ACTIVE'|'BANNED'} status 目标状态
 * @returns {Promise<object>} 更新后的 public user（含 role / status）
 */
export function updateUserStatus(id, status) {
  return request.patch(`/admin/users/${id}/status`, { status });
}

/**
 * 文章列表（管理视角）。对应 GET /api/admin/articles。
 *
 * 默认**含软删**；deleted 传 'true' / 'false' 可筛选。
 * list[] 与广场逐字同形，附加 deletedAt。
 *
 * @param {object} [params] { page, pageSize, sortBy, order, keyword, deleted }
 * @returns {Promise<{list: object[], page: number, pageSize: number, total: number, totalPages: number}>}
 */
export function listAdminArticles(params) {
  return request.get('/admin/articles', { params });
}

/**
 * 删除文章（软删，无视作者权限）。对应 DELETE /api/admin/articles/:id。
 * 已软删或不存在 → 404。
 *
 * @param {number|string} id 文章 id
 * @returns {Promise<null>}
 */
export function deleteAdminArticle(id) {
  return request.delete(`/admin/articles/${id}`);
}

/**
 * 评论列表（管理视角）。对应 GET /api/admin/comments。
 *
 * 默认**含软删**，deleted 可筛选；不过滤文章的软删状态
 * （已软删文章的评论也要能管）。list[] 比公开评论多 articleTitle 与 deletedAt。
 *
 * @param {object} [params] { page, pageSize, sortBy, order, keyword, deleted }
 * @returns {Promise<{list: object[], page: number, pageSize: number, total: number, totalPages: number}>}
 */
export function listAdminComments(params) {
  return request.get('/admin/comments', { params });
}

/**
 * 删除评论（软删，无视作者权限）。对应 DELETE /api/admin/comments/:id。
 * 已软删或不存在 → 404。
 *
 * @param {number|string} id 评论 id
 * @returns {Promise<null>}
 */
export function deleteAdminComment(id) {
  return request.delete(`/admin/comments/${id}`);
}
