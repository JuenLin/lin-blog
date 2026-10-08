import axios from 'axios';

// 401 后通过事件通知前端登录态同步清空（见下方响应拦截器）。
// 用事件而非直接 import userStore，是为规避 request.js ↔ stores/user.js 的静态循环依赖
// （store 的 reset 挂在 setToken 上，走事件让 AppHeader 调 setToken('') 即可覆盖这条路径）。
export const AUTH_CLEARED_EVENT = 'auth:cleared';

const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

request.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

request.interceptors.response.use(
  (response) => {
    const body = response.data;

    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) {
        return body.data;
      }

      const error = new Error(body.message || '请求失败');
      error.businessCode = body.code;
      return Promise.reject(error);
    }

    return body;
  },
  async (error) => {
    const response = error.response;
    const message = (response && response.data && response.data.message) || error.message || '网络错误';

    if (response && response.status === 401) {
      localStorage.removeItem('token');

      // 通知前端登录态同步清空：头部退回「登录」按钮、likedStore 的 Set 清空（防卡片错误变红）。
      // 不直接调 userStore 是为规避循环依赖；AppHeader 监听该事件后调 setToken('')，
      // 既更新 token ref（isLogin=false）又触发 likedStore.reset()。
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(AUTH_CLEARED_EVENT));
      }

      const { default: router } = await import('../router/index.js');

      if (router.hasRoute('login') && router.currentRoute.value.name !== 'login') {
        router.push({ name: 'login' });
      }
    }

    const failure = new Error(message);

    // 第十批：把 HTTP 状态码挂到 error 上。
    // 原来非 2xx 一律丢成「只有 message 的 Error」，调用方分不清 409 和 404，
    // 而这两者对点赞来说语义完全不同（重复点赞 vs 没赞过）。纯附加字段，不改已有行为。
    failure.httpStatus = response ? response.status : 0;

    return Promise.reject(failure);
  }
);

export default request;
