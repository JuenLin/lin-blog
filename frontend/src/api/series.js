// 专栏系列接口（第 10 批）。路径与字段严格按 docs/API.md，不在这里改字段名。
// 所有请求都走 request.js 实例，不写完整 URL（契约第 5 节 / 第 10 节）。
//
// **为什么没有 `GET /api/users/me/series`**（用户 2026-10-18 拍板）：
// 系列没有「草稿/私密」概念，本来就是公开列表（同 /users/:id/articles）；
// /me 系列保留给「需要登录才能看的自己专属数据」（likes / bookmarks / drafts）。
// 编辑器「加入系列」下拉直接用 userStore.user.id 调 listUserSeries。

import request from './request.js';

/**
 * 创建系列。对应 docs/API.md 的 POST /api/series。**需要登录**，作者取 token。
 *
 * @param {object} data { title: string(1–50), description?: string(≤200) }
 * @returns {Promise<object>} 系列对象 { id, title, description, author, articleCount, createdAt, updatedAt }
 */
export function createSeries(data) {
  return request.post('/series', data);
}

/**
 * 系列详情（含有序文章列表，系列横幅与系列导航的数据源）。
 * 对应 docs/API.md 的 GET /api/series/:id。**无需登录**。
 *
 * articles[] 只含已发布且未软删的文章，按 seriesOrder 升序；
 * 每项 { id, title, seriesOrder, summary }。「第 N 篇」由前端按下标算。
 *
 * @param {number|string} id 系列 id
 */
export function getSeries(id) {
  return request.get(`/series/${id}`);
}

/**
 * 更新系列元信息。对应 docs/API.md 的 PUT /api/series/:id。
 * **需要登录，且作者本人或 ADMIN**。部分更新：不传 = 保留，description: null = 清空。
 *
 * @param {number|string} id 系列 id
 * @param {object} data { title?, description? }
 */
export function updateSeries(id, data) {
  return request.put(`/series/${id}`, data);
}

/**
 * 删除系列。对应 docs/API.md 的 DELETE /api/series/:id。
 * **需要登录，且作者本人或 ADMIN**。SET NULL 解绑文章（不删文章）。
 *
 * @param {number|string} id 系列 id
 * @returns {Promise<{unboundCount: number}>} 被解绑的文章数
 */
export function deleteSeries(id) {
  return request.delete(`/series/${id}`);
}

/**
 * 某用户的系列列表（编辑器「加入系列」下拉、个人主页「系列」Tab）。
 * 对应 docs/API.md 的 GET /api/users/:id/series。**无需登录**。
 *
 * 固定 createdAt desc（无排序参数）；list[] 不带 author（路径已指定用户）。
 *
 * @param {number|string} id 用户 id
 * @param {object} [params] { page, pageSize } 默认 1 / 10，pageSize 上限 100
 * @returns {Promise<{list: Array<{id,title,description,articleCount,createdAt,updatedAt}>, total, page, pageSize}>}
 */
export function listUserSeries(id, params) {
  return request.get(`/users/${id}/series`, { params });
}
