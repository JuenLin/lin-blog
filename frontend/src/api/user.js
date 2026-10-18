// 用户接口。路径与字段严格按 docs/API.md，不在这里改字段名。
// 所有请求都走 request.js 实例，不写完整 URL（契约第 3 节 / 第 10 节）。
//
// 现状：MVP 不做用户管理——
// docs/API.md 已把 GET/POST/PUT/DELETE /api/users（列表 / 新增 / 更新 / 删除）全部登记为「未实现」，
// 文章与评论的作者信息通过内嵌 author 对象返回，不依赖用户列表接口。
//
// **已实现的 user 接口共十个**：
//   - PUT  /api/users/me            改资料（第九批）
//   - POST /api/users/me/avatar     传头像（第十一批）
//   - GET  /api/users/:id           公开详情 + 三个计数（第 2 批）
//   - GET  /api/users/:id/articles  该用户文章列表，真后端分页（第 2 批）
//   - GET  /api/users/me/likes      当前用户点赞列表，仅本人（第 2 批）
//   - GET  /api/users/me/bookmarks  当前用户收藏列表，仅本人（第 9 批）
//   - POST /api/users/:id/follow    关注（第 4 批）
//   - DELETE /api/users/:id/follow  取消关注（第 4 批）
//   - GET  /api/users/:id/followers 粉丝列表（第 4 批）
//   - GET  /api/users/:id/following 关注列表（第 4 批）
//
// 保留本文件而不删除：契约第 3 节声明了api/ 下的文件划分（契约 §3 有清单）。
import request from './request.js';

/**
 * 修改当前用户资料（简介 / 清空头像）。对应 docs/API.md 的 PUT /api/users/me。
 *
 * userId 取自 token，请求体不接受 id / userId / username / password。
 *
 * **三态语义**：调用方只放「用户实际改动过」的键，这里不做任何加工。
 *   - 不放 avatar 键→ 不改头像
 *   - avatar: null      → 清空头像（**外链下线后这是 avatar 唯一的用法**）
 *   - avatar: '/uploads/...' → 设置头像。⚠️ 前端**不暴露**这条路：
 *     设置头像统一走 `uploadAvatar()`（上传接口），它自带落盘 + 写库 + 清旧文件
 *
 * ⚠️ 不要在这里做「补全字段 / 填默认值」之类的处理：多加一个键就等于
 * 替用户做了决定，会把用户没动过的字段误清空。判断逻辑在 ProfileEdit.vue。
 *
 * 成功时 data 是完整的 public user（含 avatar / bio），
 * 调用方应直接用它更新本地 store，不必再发一次 GET /auth/me。
 *
 * @param {object} data 只包含用户实际改动的键
 * @returns {Promise<object>} 更新后的 public user
 */
export function updateMyProfile(data) {
  return request.put('/users/me', data);
}

/**
 * 上传头像文件。对应 docs/API.md 的 POST /api/users/me/avatar。
 *
 * **外链下线后，这是设置头像的唯一入口**（`updateMyProfile` 只能把它清空）。
 *
 * **一步到位**：后端落盘 → 写库 → 删旧文件，一次请求全做完，
 * 不返回「临时 url 让你再调 PUT /me」——那样中途放弃就会留下孤儿文件。
 *
 * ## ⚠️ Content-Type 的两道保险（本项目最容易踩的坑）
 * request.js 给实例默认设了 `Content-Type: application/json`，
 * 而 multipart 的 boundary 只能由浏览器生成，手工写死就会解析失败
 * （表现为「接口说没收到文件」）。这里靠两道保险把默认头摘掉：
 *
 *   1. **显式置 undefined**（下面 headers 里那行）。
 *      axios 的 `AxiosHeaders.toJSON()` 会过滤掉 `null / undefined` 的值
 *      （见 axios/lib/core/AxiosHeaders.js），所以置 undefined = 删掉这个头，
 *      不会真的发出一个值为 "undefined" 的头。
 *   2. **axios 自己在浏览器环境也会摘**：data 是 FormData 时，
 *      axios/lib/helpers/resolveConfig.js 调 `headers.setContentType(undefined)`，
 *      把 Content-Type 留给浏览器。
 *
 * 两道保险都写上，是为了将来有人换了 axios 版本 / 换了请求库时，
 * 至少有一处还生效——这个坑排查起来非常费劲（症状是「上传接口什么都没收到」）。
 *
 * @param {File} file 来自 <input type="file"> 的图片文件
 * @returns {Promise<object>} 更新后的 public user（data.avatar 是站内相对路径）
 */
export function uploadAvatar(file) {
  const form = new FormData();

  // 字段名必须是 avatar，与后端 multer 的 single('avatar') 对齐
  form.append('avatar', file);

  return request.post('/users/me/avatar', form, {
    headers: { 'Content-Type': undefined },
  });
}

// ---------- 第 2 批：用户主页三接口 ----------

/**
 * 用户公开详情。对应 docs/API.md 的 GET /api/users/:id。
 *
 * **无需登录。** 存在的理由：UserProfile.vue 原先靠「从该作者的文章里反推 author」
 * 拿昵称与头像，该用户 0 篇文章时头部会退化成「用户 #id」。本接口让头部信息
 * 不再依赖文章列表 —— 0 篇也正常显示昵称 / 头像 / 简介。
 *
 * 前 6 个字段（id / username / nickname / avatar / bio / createdAt）与
 * `PUT /me`、`POST /me/avatar` 返回的 public user **逐字相同**（同一份 PUBLIC_FIELDS），
 * 三个接口返回同一个对象，调用方可以无差别地用它更新 store。
 * avatar 是**站内相对路径**（`/uploads/...`），渲染前必须走 `resolveAvatar()` 补后端 origin。
 *
 * 三个计数（实时 COUNT，不落冗余列）：
 *   - articleCount          未软删文章数
 *   - receivedLikeCount     未软删文章上收到的赞，**含自赞**
 *   - receivedCommentCount  未软删文章下未软删的评论数（是「收到的」，非他发出的）
 * 作者删文后计数下降是**预期行为**。
 *
 * @param {number|string} id 用户 id
 * @returns {Promise<object>} public user + 三个计数
 * @throws {Error} 400（非正整数）/ 404（不存在**或已软删**）
 */
export function getUser(id) {
  return request.get(`/users/${id}`);
}

/**
 * 某用户发布的文章列表。对应 docs/API.md 的 GET /api/users/:id/articles。
 *
 * **无需登录。真后端分页**（不再是前端拿 100 窗自己过滤）。
 *
 * ⚠️ 与 GET /api/articles 的差异（调用方必须知道）：
 *   - **不支持 keyword / category**：搜索与分类是「广场」维度的筛选，个人主页不叠加
 *   - sortBy 白名单与广场一致：createdAt / updatedAt / id / likeCount，默认 createdAt desc
 *
 * 响应与 `GET /api/articles` **完全同形**（{ list, page, pageSize, total, totalPages }），
 * `list[]` 由同一个 toArticleListItem() 生成，ArticleCard 可原样复用。
 * `total` 是该作者未软删文章的总数（后端 COUNT），**不受 100 上限约束**。
 *
 * **用户存在但 0 篇文章 ≠ 404**：返回 200 + `list: []` + `total: 0` + `totalPages: 0`。
 * 调用方据此渲染空态，不要把整页判成「用户不存在」。
 *
 * @param {number|string} id 用户 id
 * @param {object} [params] { page, pageSize, sortBy, order }
 * @returns {Promise<{list: object[], page: number, pageSize: number, total: number, totalPages: number}>}
 * @throws {Error} 400（分页 / sortBy 非法，或 id 非正整数）/ 404（不存在或已软删）
 */
export function listUserArticles(id, params) {
  return request.get(`/users/${id}/articles`, { params });
}

/**
 * 当前登录用户点赞过的文章。对应 docs/API.md 的 GET /api/users/me/likes。
 *
 * **需要登录。** 路径是 `/me/likes` 而非 `/:id/likes`：只提供查自己，
 * 不提供按 id 查他人点赞记录（「谁赞过什么」属个人隐私维度，
 * 与 PUT /me 只能改自己同一条原则）。
 *
 * ⚠️ 不要写成 `/users/me/likes` 之外的任何形式——后端**没有** `GET /api/users/me`
 * 这个接口（会命中 `/:id` 回 400 / 40000），已登记为预期行为，别当 bug 修。
 *
 * `list[]` 与 `GET /users/:id/articles` 的 `list[]` **逐字相同**，只多一个 `likedAt`
 * （就是 likes.createdAt，虚拟字段、库里没有这一列）。平铺而非包一层
 * `{ likedAt, article }`，是为了让 ArticleCard 原样复用（`:article="item"`）。
 *
 * sortBy 白名单 likedAt / createdAt / likeCount，默认 likedAt desc。
 * 前端 Tab **不暴露排序控件**，只用默认值。
 *
 * 只返回未软删的文章：赞过但作者已删的不出现，也不计入 total。
 *
 * @param {object} [params] { page, pageSize, sortBy, order }
 * @returns {Promise<{list: object[], page: number, pageSize: number, total: number, totalPages: number}>}
 * @throws {Error} 401（未登录）/ 400（分页 / sortBy 非法）
 */
export function listMyLikes(params) {
  return request.get('/users/me/likes', { params });
}

/**
 * 当前登录用户收藏过的文章。对应 docs/API.md 的 GET /api/users/me/bookmarks（第 9 批）。
 *
 * 与 `listMyLikes` **完全对镜**（连注释都同构，改一处记得同步另一处）：
 *   - **需要登录**；路径 `/me/bookmarks` 而非 `/:id/bookmarks`：只提供查自己，
 *     「谁收藏了什么」属个人隐私维度（同 /me/likes 原则）。
 *   - `list[]` 与 `GET /users/:id/articles` 的 `list[]` **逐字相同**，只多一个平铺字段
 *     `bookmarkedAt`（= bookmarks.createdAt，收藏发生时间）。
 *     ⚠️ `bookmarkedAt` 与文章自己的 `createdAt` 是两个时间（收藏时间 vs 发布时间），
 *     断言 / 展示时别拿错。平铺是为了让 ArticleCard 原样复用（`:article="item"`）。
 *   - sortBy 白名单 bookmarkedAt / createdAt / likeCount，默认 bookmarkedAt desc。
 *     前端 Tab **不暴露排序控件**，只用默认值。
 *   - 只返回未软删的文章：收藏过但作者已删的不出现，也不计入 total。
 *
 * @param {object} [params] { page, pageSize, sortBy, order }
 * @returns {Promise<{list: object[], page: number, pageSize: number, total: number, totalPages: number}>}
 * @throws {Error} 401（未登录）/ 400（分页 / sortBy 非法）
 */
export function listMyBookmarks(params) {
  return request.get('/users/me/bookmarks', { params });
}

// ---------- 第 4 批：关注相关 4 接口 ----------

/**
 * 关注某用户。对应 docs/API.md 的 POST /api/users/:id/follow。
 *
 * **需要登录**（后端 auth 中间件，未登录 40100）。被关注者身份来自路径 id，
 * 关注者身份来自 token，**请求体不收任何身份字段**。
 *
 * ⚠️ **这是幂等写，不是「重复报错」**：已关注时**仍然返回 200 / code 0**，
 * 与 `POST /api/articles/:id/like`（重复点赞返回 40900）**刻意相反**。
 * 原因：follows 的唯一约束 `follows_follower_id_following_id_key` 会拦住并发重复写入，
 * 应用层「先查再插」有竞态，只能由数据库兜底，兜到之后语义上就是「已关注」这个状态达成。
 * 前端不要在这里 catch 任何"已关注"错误码 —— 不存在。
 *
 * 响应 data：{ following: true, followerCount, followingCount }
 *   - `followerCount` 属于**路径 :id 这个人**（他的粉丝数）
 *   - `followingCount` 属于**我自己**（我的关注数）
 *   两者归属对象不同，别拿混（见 stores/following.js 顶部注释）。
 *
 * @param {number|string} id 被关注者 id
 * @returns {Promise<{following: boolean, followerCount: number, followingCount: number}>}
 * @throws {Error} 401（未登录）/ 400（id 非法，或关注自己）/ 404（目标不存在或已软删）
 */
export function followUser(id) {
  return request.post(`/users/${id}/follow`);
}

/**
 * 取消关注。对应 docs/API.md 的 DELETE /api/users/:id/follow。
 *
 * **需要登录**。与 follow 同为**幂等**：本来就没关注时**也返回 200 / code 0**，
 * 与 `DELETE /api/articles/:id/like`（取消没赞过的返回 40400）**刻意相反**。
 * 语义是「确认关系不存在」——没关注本来就是这个状态，所以是成功而非错误。
 *
 * 响应与 follow 同形，只是 `following: false`。
 *
 * @param {number|string} id 被关注者 id
 * @returns {Promise<{following: boolean, followerCount: number, followingCount: number}>}
 * @throws {Error} 401（未登录）/ 400（id 非法）/ 404（目标不存在或已软删）
 */
export function unfollowUser(id) {
  return request.delete(`/users/${id}/follow`);
}

/**
 * 某用户的粉丝列表。对应 docs/API.md 的 GET /api/users/:id/followers。
 *
 * **无需登录**（公开只读），真后端分页。
 *
 * `list[]` 是**公开用户资料**（id / username / nickname / avatar / bio / createdAt）
 * 再加一个虚拟字段 `followedAt`（= follows.createdAt，关注发生时间）。
 *
 * ⚠️ **两个时间的区别（最容易拿错）**：
 *   - `createdAt` 来自 PUBLIC_FIELDS，是**该用户的注册时间**
 *   - `followedAt` 才是**关注发生时间**
 * 列表上要展示的是后者。
 *
 * sortBy 白名单 followedAt / id，默认 followedAt desc。前端页面**不暴露排序控件**。
 * 用户不存在 / 已软删 → 404；存在但 0 粉丝 → 200 + list:[] + total:0（据此渲染空态）。
 *
 * @param {number|string} id 用户 id
 * @param {object} [params] { page, pageSize, sortBy, order }
 * @returns {Promise<{list: object[], page: number, pageSize: number, total: number, totalPages: number}>}
 */
export function listFollowers(id, params) {
  return request.get(`/users/${id}/followers`, { params });
}

/**
 * 某用户主动关注的列表。与 listFollowers 完全对称（换 querying 端），
 * 详见 docs/API.md 的 GET /api/users/:id/following。
 *
 * @param {number|string} id 用户 id
 * @param {object} [params] { page, pageSize, sortBy, order }
 * @returns {Promise<{list: object[], page: number, pageSize: number, total: number, totalPages: number}>}
 */
export function listFollowing(id, params) {
  return request.get(`/users/${id}/following`, { params });
}

// 将来的形状示例（未启用）：
// export function listUsers(params) {
//   return request.get('/users', { params });
// }
//
// export function createUser(data) {
//   return request.post('/users', data);
// }
//
// export function updateUser(id, data) {
//   return request.put(`/users/${id}`, data);
// }
//
// export function deleteUser(id) {
//   return request.delete(`/users/${id}`);
// }
