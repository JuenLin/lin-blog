// 用户管理接口：列表、详情、新增、更新、删除。
// 契约第 3 节声明本文件承载用户类接口。
//
// 现状（第九批起变化）：MVP 不做用户管理——
// docs/API.md 已把 GET/POST/PUT/DELETE /api/users 全部登记为「未实现」，
// 文章与评论的作者信息通过内嵌 author 对象返回，不依赖用户列表接口。
// **唯一已实现的是 PUT /api/users/me**（修改自己的资料），见下方updateMyProfile。
//
// 保留本文件而不删除：契约第 3 节声明了api/ 下的文件划分（契约 §3 有清单）。
import request from './request.js';

/**
 * 修改当前用户资料（头像 / 简介）。对应 docs/API.md 的 PUT /api/users/me。
 *
 * userId 取自 token，请求体不接受 id / userId / username / password。
 *
 * **三态语义**：调用方只放「用户实际改动过」的键，这里不做任何加工。
 *   - 不放 avatar 键→ 不改头像
 *   - avatar: null      → 清空头像
 *   - avatar: 'https://' → 设置头像
 *
 * ⚠️ 不要在这里做「补全字段 / 填默认值」之类的处理：多加一个键就等于
 * 替用户做了决定，会把用户没动过的字段误清空。判断逻辑在 ProfileEdit.vue。
 *
 * 成功时 data 是完整的 public user（含 avatar / bio），
 * 调用方应直接用它更新本地 store，不必再发一次 GET /auth/me。
 *
 * @param {object} data 只包含用户实际改动的键
 * @returns {Promise<object>} 更新后的 public user
 */
export function updateMyProfile(data) {
  return request.put('/users/me', data);
}

// 将来的形状示例（未启用）：
// export function listUsers(params) {
//   return request.get('/users', { params });
// }
//
// export function getUser(id) {
//   return request.get(`/users/${id}`);
// }
//
// export function createUser(data) {
//   return request.post('/users', data);
// }
//
// export function updateUser(id, data) {
//   return request.put(`/users/${id}`, data);
// }
//
// export function deleteUser(id) {
//   return request.delete(`/users/${id}`);
// }
