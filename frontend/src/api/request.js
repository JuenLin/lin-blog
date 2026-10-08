import axios from 'axios';

// 「认证态已清空」事件 —— 注意：它不是「401 事件」。
// 语义是「登录态已失效，前端需把 token ref / 已赞集合全部清空」，触发源不限于 401：
// 将来若出现「其它标签页登出」「服务端主动吊销 token」「令牌过期主动失效」等场景，
// 都应派发**同一个**事件，而不是为 401 新增一个专属 hook（否则逻辑散落、回归难覆盖）。
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
      // ⚠️ 清 token 的唯一路径：removeItem 之后派发 AUTH_CLEARED_EVENT，
      // 由 AppHeader 监听并调 userStore.setToken('') 完成「ref 置空 + likedStore.reset()」。
      // 任何别处若要清 token，都必须走同一条路（经 setToken 同步 store / likedStore），
      // 绝不能只 removeItem 而不同步 —— 否则 401 后头部仍显示登录态、列表卡片错误变红（真实 bug，
      // 已由 probe-card-liked.mjs 的 E 组永久回归覆盖）。
      localStorage.removeItem('token');

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
