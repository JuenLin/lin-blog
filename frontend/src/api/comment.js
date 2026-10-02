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
