import {
  register as registerService,
  login as loginService,
  getMe as getMeService,
  changePassword as changePasswordService,
} from '../services/auth.service.js';
import { sendOk, sendCreated } from '../utils/response.js';

export async function register(req, res, next) {
  try {
    const user = await registerService(req.validated.body);

    return sendCreated(res, user);
  } catch (error) {
    return next(error);
  }
}

export async function login(req, res, next) {
  try {
    const data = await loginService(req.validated.body);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function me(req, res, next) {
  try {
    const user = await getMeService(req.user.userId);

    return sendOk(res, user);
  } catch (error) {
    return next(error);
  }
}

// 修改密码：userId 取自 token，不接受请求体传值（docs/API.md）。
// message 用「密码已修改」而不是默认的 'ok'，前端成功提示直接可以用。
export async function changePassword(req, res, next) {
  try {
    await changePasswordService({
      userId: req.user.userId,
      oldPassword: req.validated.body.oldPassword,
      newPassword: req.validated.body.newPassword,
    });

    return sendOk(res, null, 200, '密码已修改');
  } catch (error) {
    return next(error);
  }
}
