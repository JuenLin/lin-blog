import request from './request.js';

// 点赞接口（第十批）。路径与字段严格按 docs/API.md，不在这里改字段名。
// 两个接口都挂在文章下，且都要求登录（后端 auth 中间件），未登录返回 40100。
//
// 响应体：{ liked: boolean, likeCount: number }
//   - liked 只有这两个接口会返回。列表 / 详情这类公开接口只给 likeCount
//     （docs/API.md 通用约定：不按登录态变化，避免给公共缓存带来差异）。
//   - 重复点赞返回 40900「已点赞过这篇文章」，取消没赞过的返回 40400。

export function likeArticle(id) {
  return request.post(`/articles/${id}/like`);
}

export function unlikeArticle(id) {
  return request.delete(`/articles/${id}/like`);
}

// 第十四批：查询当前登录用户是否已点赞该文章（需登录）。
// 用于刷新详情页 / 切换文章后还原点赞按钮的初始态 —— 列表与详情这类公开接口
// 不返回 liked（docs/API.md 通用约定），只能靠这个接口补。
//
// 响应体：{ liked: boolean }。**不带 likeCount**：详情页已从 GET /api/articles/:id
// 拿到计数，同一个值若有两个来源，口径不一致时无法判断哪个对。
//
// 未登录不要调：后端强制 401，request.js 的 401 拦截器会清 token 并跳登录页。
export function getArticleLiked(id) {
  return request.get(`/articles/${id}/liked`);
}
