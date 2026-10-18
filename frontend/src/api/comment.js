import request from './request.js';

// 评论接口。路径与字段严格按 docs/API.md。
// 评论列表挂在文章下：GET /api/articles/:id/comments
// 发表评论是顶层资源：POST /api/comments

export function listComments(articleId, params) {
  return request.get(`/articles/${articleId}/comments`, { params });
}

export function createComment(data) {
  return request.post('/comments', data);
}

export function deleteComment(id) {
  return request.delete('/comments/' + id);
}

// 第 11 批：评论点赞三件套。**幂等 200**（bookmark / follow 族）——
// 重复赞 / 取消未赞过的评论都成功返回，没有 409 / 404 分支可纠正
// （与文章点赞的 409/404 刻意相反，docs/API.md「评论点赞与 @提及」）。
// 404 的语义只有一种：评论不可见（软删评论 / 草稿文章下的评论）。
// POST / DELETE 响应 { liked, likeCount }；GET /:id/liked 只回 { liked }（计数唯一来源是列表 / 点赞响应）。
export function likeComment(id) {
  return request.post(`/comments/${id}/like`);
}

export function unlikeComment(id) {
  return request.delete(`/comments/${id}/like`);
}

export function getCommentLiked(id) {
  return request.get(`/comments/${id}/liked`);
}
