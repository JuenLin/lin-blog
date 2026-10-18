import request from './request.js';

// 通知中心接口（第 8 批）。路径与字段严格按 docs/API.md，不在这里改字段名。
// 所有请求都走 request.js 实例，不写完整 URL（契约第 5 节 / 第 10 节）。

/**
 * 我的通知列表（扁平分页）。对应 docs/API.md 的 GET /api/notifications。
 * 需登录。返回 { list, page, pageSize, total, totalPages }，list 已含 actorName / targetTitle（后端拼文案）。
 *
 * @param {object} [params] { page, pageSize }
 */
export function listNotifications(params) {
  return request.get('/notifications', { params });
}

/**
 * 未读数。对应 docs/API.md 的 GET /api/notifications/unread-count。
 * 返回 { unreadCount }，前端 30s 轮询数据源。
 */
export function getUnreadCount() {
  return request.get('/notifications/unread-count');
}

/**
 * 批量标记已读。对应 docs/API.md 的 PUT /api/notifications/read。
 * 传 ids: [] 表示全部已读。返回 { count }。
 *
 * @param {number[]} ids 要标记已读的 id 数组；空数组 = 全部已读
 */
export function markRead(ids) {
  return request.put('/notifications/read', { ids });
}

/**
 * 单条标记已读。对应 docs/API.md 的 PUT /api/notifications/:id/read。
 * 返回 data 为 null。已读 / 不存在 / 不属于自己 → 200 幂等。
 *
 * @param {number|string} id 通知 id
 */
export function markReadOne(id) {
  return request.put(`/notifications/${id}/read`);
}
