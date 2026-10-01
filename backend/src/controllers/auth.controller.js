import {
  register as registerService,
  login as loginService,
  getMe as getMeService,
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
