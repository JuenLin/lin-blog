import {
  listNotifications as listNotificationsService,
  countUnread as countUnreadService,
  markRead as markReadService,
  markReadOne as markReadOneService,
} from '../services/notification.service.js';
import { sendOk } from '../utils/response.js';

// 与 comment / follow / like controller 同构：不做业务判断，只转发 service 的结果或错误。
// 接收者取 req.user.userId（由 auth 中间件注入），不信任请求体里的身份字段。

export async function list(req, res, next) {
  try {
    const data = await listNotificationsService(req.user.userId, req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function unreadCount(req, res, next) {
  try {
    const unreadCount = await countUnreadService(req.user.userId);

    return sendOk(res, { unreadCount });
  } catch (error) {
    return next(error);
  }
}

export async function markRead(req, res, next) {
  try {
    const data = await markReadService(req.user.userId, req.validated.body.ids);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function markReadOne(req, res, next) {
  try {
    const data = await markReadOneService(req.user.userId, req.validated.params.id);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
