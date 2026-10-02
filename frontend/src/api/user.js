// 用户管理接口：列表、详情、新增、更新、删除。
// 契约第 3 节声明本文件承载用户类接口，但 MVP 阶段不做用户管理：
// docs/API.md 已把 GET/POST/PUT/DELETE /api/users 全部登记为「未实现」，
// 文章与评论的作者信息改为内嵌 author 对象返回，不依赖本文件。
// 因此这里保持空实现，等做用户模块时再填充，不要删文件（契约第 3 节有声明）。

// 将来的形状示例（未启用）：
// import request from './request.js';
//
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
