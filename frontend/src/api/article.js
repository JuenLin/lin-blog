import request from './request.js';

// 文章接口。路径与字段严格按 docs/API.md，不在这里改字段名。
// 所有请求都走 request.js 实例，不写完整 URL（契约第 5 节 / 第 10 节）。

// 博客广场列表，无需登录。params 只允许 page / pageSize / sortBy / order / keyword，
// sortBy 只能是 createdAt / updatedAt / id，传别的值后端返回 40000。
// keyword（第六批后端已支持）：trim 后最长 50 字符，匹配 title OR content；空串视为不传。
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

// ---------- 第 6 批：草稿 / 自动保存 / 版本历史 / 回滚 ----------

/**
 * 自动保存草稿。对应 docs/API.md 的 POST /api/articles/auto-save。
 *
 * 字段全部可选：
 *   - draftId    传了 = 更新该草稿（必须是本人 DRAFT，否则 404/40400，坑 1）
 *   - sourceArticleId 编辑已发布文章时的来源校验（仅校验归属，不落库，补丁 1）
 *   - title/content/category
 *
 * 返回两种形状（前端状态机据此分档，补丁 3）：
 *   - 建草稿门槛未过（无 draftId 且 title 空且 content < 10 字）：
 *       { id: null, status: 'IDLE', saved: false } —— 保持 idle，不再发更多请求
 *   - 建成 / 更新成功：{ id: 草稿id, status: 'DRAFT', saved: true }
 *
 * ⚠️ 一旦持有 draftId，任何内容变化（含清空到 0 字）都必须继续发请求，
 * 不再受建草稿门槛限制 —— 门槛判断只在「还没有 draftId」时做。
 *
 * @param {object} data { title?, content?, category?, draftId?, sourceArticleId? }
 * @returns {Promise<{id: number|null, status: string, saved: boolean}>}
 */
export function autoSaveArticle(data) {
  return request.post('/articles/auto-save', data);
}

/**
 * 我的草稿箱列表。对应 docs/API.md 的 GET /api/users/me/drafts。
 *
 * 仅本人（需要登录）。`list[]` 与广场列表项同形（id/title/summary/category/
 * likeCount/createdAt/updatedAt），但**多一个 content 全文** ——
 * 草稿过不了公开详情（DRAFT 详情 404），「继续编辑」回填全文只有这一个来源。
 * 默认按 updatedAt 倒序（最近编辑的在前）。
 *
 * @param {object} [params] { page, pageSize, keyword }
 */
export function listMyDrafts(params) {
  return request.get('/users/me/drafts', { params });
}

/**
 * 删除指定草稿（物理删除）。对应 docs/API.md 的 DELETE /api/users/me/drafts/:id。
 *
 * 必须是本人 DRAFT，否则 404/40400（不区分「不存在 / 非草稿 / 非本人」，
 * 与公开详情同口径，不泄露草稿存在性）。成功时 data 为 null。
 *
 * @param {number|string} id 草稿 id
 */
export function deleteDraft(id) {
  return request.delete(`/users/me/drafts/${id}`);
}

/**
 * 文章版本历史（方案 A：每条带完整 content）。对应 docs/API.md 的 GET /api/articles/:id/revisions。
 *
 * 仅作者本人：非作者 403/40300；文章不存在 / 已软删 / 非 PUBLISHED（含草稿）→ 404/40400。
 * 返回 { articleId, revisions[], total }，revisions 按 createdAt 倒序（最新快照在前），
 * 每条 { id, articleId, title, content, category, authorId, createdAt }。
 * 当前线上版本不在 revisions 里（它就是 GET /api/articles/:id 的内容）。
 *
 * @param {number|string} id 已发布文章 id
 */
export function listRevisions(id) {
  return request.get(`/articles/${id}/revisions`);
}

/**
 * 回滚到指定版本（先快照当前版、后覆盖，回滚本身也可再回滚）。
 * 对应 docs/API.md 的 POST /api/articles/:id/restore。
 *
 * 仅作者本人，文章必须 PUBLISHED；revisionId 必须属于该文章，否则 404/40400。
 * 返回更新后的文章（结构与文章详情相同）。
 *
 * @param {number|string} id 目标文章 id
 * @param {number} revisionId 要回滚到的版本 id（来自 listRevisions）
 */
export function restoreArticle(id, revisionId) {
  return request.post(`/articles/${id}/restore`, { revisionId });
}

/**
 * 热门标签列表。对应 docs/API.md 的 GET /api/tags（第 7 批新增）。无需登录。
 *
 * 返回 { list: [{ id, name, articleCount }] }，按 articleCount desc → name asc。
 * articleCount 只数已发布且未软删的文章（草稿 / 软删不计入）。
 *
 * @param {object} [params] { limit } 默认 20，上限 100
 */
export function listHotTags(params) {
  return request.get('/tags', { params });
}

// ---------- 第 9 批：阅读量 ----------

/**
 * 记录一次阅读（viewCount +1）。对应 docs/API.md 的 POST /api/articles/:id/view。
 *
 * **无需登录** —— 阅读是匿名行为，与点赞 / 收藏刻意不同（docs/API.md）。
 * 文章不存在 / 已软删 / 草稿 → 404/40400。
 *
 * 响应 data：{ viewCount: number }（+1 后的最新值；被判重未 +1 时返回当前值，仍 200）。
 * 后端判重：内存 Map，key = `${articleId}:${req.ip}`，同 key 5 分钟内只计一次
 * （尽力而为，重启丢窗口，不保证连续性 —— docs/API.md 已写明）。
 *
 * ⚠️ 前端纪律（详情页 ArticleDetail.vue 执行）：mounted 后**只调一次**，
 * 不 await 阻塞渲染；不暴露任何手动「再计一次」的入口。
 *
 * @param {number|string} id 文章 id
 * @returns {Promise<{viewCount: number}>}
 */
export function recordArticleView(id) {
  return request.post(`/articles/${id}/view`);
}
