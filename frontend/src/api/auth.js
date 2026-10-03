import request from './request.js';

export function login(data) {
  return request.post('/auth/login', data);
}

export function register(data) {
  return request.post('/auth/register', data);
}

export function getMe() {
  return request.get('/auth/me');
}

// 修改密码（docs/API.md 的 PUT /api/auth/password）：
// 服务端不强制失效已签发的 token（见 API.md「旧 token 语义」一节），
// 所以调用成功后**由调用方**清本地 token 并跳登录页 —— 这里只管发请求，不碰登录态。
// 成功时data 为 null，响应拦截器会把 null 原样返回。
export function changePassword(data) {
  return request.put('/auth/password', data);
}

// logout 暂不对接后端：契约第 5 节的路径清单里没有 /auth/logout，
// 后端也没有提供该接口。按契约第 13 节第 6 条（不擅自改接口路径）
// 和第 12 条（信息不足先确认），这里只保留占位，不发起真实请求。
// 当前退出登录走前端本地清理：useUserStore().logout()。
// 待后端补出该路由并登记 docs/API.md 后，再改成 request.post('/auth/logout')。
export function logout() {
  return Promise.resolve(null);
}
