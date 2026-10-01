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

    return Promise.reject(new Error(message));
  }
);

export default request;
