export const CODE = {
  SUCCESS: 0,
  PARAM_ERROR: 40000,
  UNAUTHORIZED: 40100,
  FORBIDDEN: 40300,
  NOT_FOUND: 40400,
  CONFLICT: 40900,
  SERVER_ERROR: 50000,
};

export function ok(data = null, message = 'ok') {
  return {
    code: CODE.SUCCESS,
    message,
    data,
  };
}

export function fail(code = CODE.SERVER_ERROR, message = '服务器错误', data = null) {
  return {
    code,
    message,
    data,
  };
}

export function sendOk(res, data = null, status = 200, message = 'ok') {
  return res.status(status).json(ok(data, message));
}

export function sendFail(res, code = CODE.SERVER_ERROR, message = '服务器错误', status = 400, data = null) {
  return res.status(status).json(fail(code, message, data));
}

export function sendCreated(res, data = null, message = 'ok') {
  return res.status(201).json(ok(data, message));
}

export function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.businessCode = code;

  return error;
}
