import request from './request.js';

// 文章接口。路径与字段严格按 docs/API.md，不在这里改字段名。
// 所有请求都走 request.js 实例，不写完整 URL（契约第 5 节 / 第 10 节）。

// 博客广场列表，无需登录。params 只允许 page / pageSize / sortBy / order，
// sortBy 只能是 createdAt / updatedAt / id，传别的值后端返回 40000。
export function listArticles(params) {
  return request.get('/articles', { params });
}

export function getArticle(id) {
  return request.get(`/articles/${id}`);
}

export function createArticle(data) {
  return request.post('/articles', data);
}

export function updateArticle(id, data) {
  return request.put(`/articles/${id}`, data);
}

export function deleteArticle(id) {
  return request.delete(`/articles/${id}`);
}
