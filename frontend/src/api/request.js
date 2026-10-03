import axios from 'axios';

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
