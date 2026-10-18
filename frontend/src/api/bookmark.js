import request from './request.js';

// 收藏接口（第 9 批）。路径与字段严格按 docs/API.md「收藏与阅读量」章节，不在这里改字段名。
// 前三个接口都挂在文章下，且都要求登录（后端 auth 中间件），未登录返回 40100。
//
// ⚠️ 与点赞（api/like.js）**刻意相反**的幂等语义（用户 2026-10-18 拍板）：
//   点赞：重复点赞 40900、取消没赞过的 40400；
//   收藏：重复收藏 / 取消没收藏过的**都返回 200 / code 0**（与 follow 同一家族）。
// 原因：bookmarks 有唯一约束 bookmarks_user_id_article_id_key，直接 create 撞 P2002
// 时语义上就是「已收藏」这个状态已达成；deleteMany 不看 count，恒返回操作后总数。
// 前端**不要**在这里 catch 任何「已收藏 / 没收藏」的错误码 —— 不存在。
//
// 响应体：
//   POST / DELETE → { bookmarked: boolean, bookmarkCount: number }
//     - bookmarked 恒等于操作后的状态（收藏后 true / 取消后 false）
//     - bookmarkCount 是**操作后**该文章的总收藏数，已包含本次
//   GET /bookmarked → { bookmarked: boolean }，**不带 bookmarkCount**（与 /liked 同纪律：
//     计数唯一来源是文章接口，同一个值两个口径将来无法判断哪个对）。

export function bookmarkArticle(id) {
  return request.post(`/articles/${id}/bookmark`);
}

export function unbookmarkArticle(id) {
  return request.delete(`/articles/${id}/bookmark`);
}

/**
 * 查询当前登录用户是否已收藏该文章（需登录）。
 * 用途与 getArticleLiked 完全一致：刷新详情页 / 切换文章后还原星标按钮初始态 ——
 * 列表与详情这类公开接口不返回 bookmarked，只能靠这个接口补。
 *
 * 未登录不要调：后端强制 401，request.js 的 401 拦截器会清 token 并跳登录页。
 *
 * @param {number|string} id 文章 id
 * @returns {Promise<{bookmarked: boolean}>}
 */
export function getArticleBookmarked(id) {
  return request.get(`/articles/${id}/bookmarked`);
}
