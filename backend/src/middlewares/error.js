import { CODE, sendFail } from '../utils/response.js';

export function notFoundHandler(req, res) {
  return sendFail(res, CODE.NOT_FOUND, `资源不存在：${req.method} ${req.originalUrl}`, 404);
}

export function errorHandler(err, req, res, next) {
  console.error('[error]', err.message);
  console.error(err.stack);

  const status = err.status || 500;
  const code = err.businessCode || CODE.SERVER_ERROR;

  return sendFail(res, code, err.message || '服务器错误', status);
}
