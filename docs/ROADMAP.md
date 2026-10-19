<!-- 文档：ROADMAP.md | 定位：批次路线图 | 核心：批次规划、已完成与待办功能及插队候选。 -->

# ROADMAP — 批次规划（第 9-12 批回顾与未来展望）

> 2026-10-19 更新。第 12 批（举报与审核）已完结，本文档为第 9-12 批的详细规划与未来展望。第 1-8 批的批次记录见 MEMORY.md，不在此重复。
> 权威约定以 MEMORY.md 与 docs/AI_CONTRACT.md 为准；本文只做规划，不构成契约。
> **每批开工前必跑全量回归**（`node scripts/acceptance/run.mjs`），确认基线未漂再动 schema。

## 总体约束（写给未来的自己）

- 用户明确要求：**暂不做真实生产部署 / 安全防护**（WAF、限流、HTTPS、防盗链等），聚焦产品体验。
- 每批沿用老流程：只读调研 → 草案 → 用户拍板 → 文档四步纪律 → migrate → 后端 → 前端 → 探针 → 回归 → 分笔 commit（后端 / 前端 / 探针+基建 / 文档四笔，沿用第 8 批模式）。
- 每批开工前必跑全量回归，确认基线未漂。
- 探针清理严守「按创建 ID 精确删」铁律（`id: { in: [...] }`，禁 `deleteMany({})` / 跨表关联删）。
- 文档口径随批递增（开工时重读 AI_CONTRACT.md 核准，不引缓存）：第 12 批后接口 59、schema 例外 17 项（reports 为第 17 项）。

---

## 第 9 批：收藏夹 + 阅读量统计

数据层互动，改动独立，风险低。文档口径预计：接口 42→47，schema 例外 12→13。

### 一、收藏夹 Bookmarks

**目标**：区分「点赞（认可）」与「收藏（稍后看/反复用）」，对标掘金/知乎。

**Schema**（新增第 13 项例外）：

- `bookmarks` 表：`id` / `userId` / `articleId` / `createdAt`
- 联合唯一索引 `@@unique([userId, articleId])` 防重复
- FK：`userId` → users.id（RESTRICT）、`articleId` → articles.id（RESTRICT）
- 无 `deletedAt`：收藏关系物理删除，与 likes/follows 同族
- ⚠️ 双 RESTRICT FK → 硬删文章/用户前必须先删 bookmarks（第 8 批 notifications 同款教训，验收清理同步改）

**API**：

- `POST   /api/articles/:id/bookmark`    收藏（幂等 200）
- `DELETE /api/articles/:id/bookmark`    取消收藏（幂等 200）
- `GET    /api/articles/:id/bookmarked`  查当前用户是否收藏（需登录）
- `GET    /api/users/me/bookmarks`       我的收藏列表（需登录，分页，pageSize 默认 10 同全局口径；返回 `bookmarkedAt` = bookmarks.createdAt，与文章 createdAt 不同，探针需断言这一点）

**前端**：

- ArticleCard / ArticleDetail：星标按钮（图标 un-star / star）。注意 `<a>` 卡片内不嵌 `<button>`，用 `span role=button tabindex=0` + `@click.prevent.stop` 范式
- UserProfile：新增「收藏」Tab（仅本人可见，对标现有「点赞」Tab）
- `stores/bookmarks.js`：仿 likedStore —— 缓存已收藏 id 集合、ensureLoaded、add/remove 幂等、**按钮成功后才写回（不乐观更新）**、setToken 挂 reset、不 import userStore 防环
- 401 清 token 时联动 reset（AUTH_CLEARED_EVENT 链路）

**探针 probe-bookmark.mjs（约 12 项）**：

- 收藏/取消幂等（重复 200 非 409，与 like 相反还是相同需按 API 草案定）
- 未登录 401
- 软删文章收藏 404
- 列表返回 bookmarkedAt（与文章 createdAt 不同）
- 卡片按钮态同步 / 换账号不串号
- 清理：按创建的 bookmark id + 文章/账号 id 精确删，跑前跑后全表行数自检

### 二、阅读量统计 Article Views

**目标**：热度榜从「仅按点赞」升级为「综合热度」或新增「阅读最多」Tab。

**Schema 变更（推荐方案：简化计数）**：

- `articles` 表加 `viewCount Int @default(0)`（仅总计数，不存明细）
- 理由：个人博客量级无需明细表；减少 schema 负担
- 备选（未来要分析趋势再做）：独立 `article_views` 表（id/articleId/viewedAt/ipHash）

**API**：

- `POST /api/articles/:id/view`  +1 阅读量（无需登录）
- `GET /api/articles` / `:id` 响应加 `viewCount` 字段
- `GET /api/articles?sortBy=hot` 可选：按 viewCount 或综合热度排序（走 utils/query.js 翻译器 + ARTICLE_SORT_MAP；综合热度若用 `viewCount*0.3 + likeCount*0.7`，注意分页场景下排序必须在 SQL 层完成，参照 `_count.likes` 折算先例）

**防刷（用户明确不做生产级安全，仅做最简）**：

- 前端 mounted 时调一次 POST /view
- 后端简单判重：同一 IP + 同文章 5 分钟内不重复计数（**内存 Map 即可，不建表**；node --watch 重启即丢，博客量级可接受）
- 并发 +1 用 Prisma `increment`（原子操作），禁止 read-modify-write
- 不做 CSRF、不做频率 WAF

**前端**：

- 详情页/卡片显示阅读量（🔥 1000）
- Home 页新增「阅读最多」Tab，或热门排序改综合热度

**探针 probe-view.mjs（约 8 项）**：

- viewCount 准确 +1
- 5 分钟内重复调用不再 +1（防刷；注意探针自身跑在固定 IP，跨项要错开或接受判重语义）
- 软删文章 view 404
- 排序正确（sortBy=hot）

---

## 第 10 批：文章图片上传 + 专栏系列

创作端增强，让写长文更爽。文档口径预计：接口 47→53，schema 例外 13→14。

### 一、文章图片上传

**目标**：编辑器支持插入图片，不再依赖外链。Schema 无需变更（复用现有 multer + /uploads 目录）。

**API**：

- `POST /api/articles/upload-image` 上传图片（需登录）
  - 复用 multer（第 11 批配置：2.4.0），落盘 `/uploads/articles/{userId}/{ts}-{hex}.{ext}`
  - 限制 2MB、仅 image/*（与头像上传同款校验）
  - 文件名服务端生成、按 mimetype 定扩展（不收 SVG）
  - 返回 `{ url: '/uploads/articles/...' }`
  - uploads 不进 git（backend/.gitignore 已有规则，开工时 `git check-ignore -v` 复核，别单点读根 gitignore）

**前端（ArticleEditor）**：

- 工具栏加「插入图片」按钮：选文件 → 上传 → 插入 `![](url)` 到光标处（textarea selectionStart/End）
- 支持粘贴图片自动上传（监听 paste 事件）
- 可选：拖拽到编辑器上传

**探针 probe-image-upload.mjs（约 6 项）**：

- 上传成功返回正确 URL
- 落盘路径正确
- 非法类型 400
- 超大文件 400
- 未登录 401
- 清理：删除上传落盘文件 + 精确清理造数

### 二、专栏 / 系列 Series

**目标**：把连载文章组织成「系列」，对标掘金专栏。

**Schema**（新增第 15 项例外，拍板见下方「本轮拍板记录」）：

- `series` 表：`id` / `title` / `description` / `authorId` / `createdAt` / `updatedAt`
- `articles` 表加 `seriesId Int?` + `seriesOrder Int?`
- FK：`seriesId` → series.id。**删系列时推荐 SET NULL（解绑文章、不删文章，符合需求语义）；Cascade 会删文章，排除** —— 最终拍板后落 migrate
- 索引：`@@index([authorId])`
- 约束：同一 seriesId 下 seriesOrder 唯一（**应用层保证**，可空列复合唯一在 MySQL 不可靠，不建复合唯一索引）

**API**：

- `POST   /api/series`            创建系列（需登录）
- `GET    /api/series/:id`        系列详情（含文章列表）
- `PUT    /api/series/:id`        更新系列（作者/ADMIN，第 5 批权限底座）
- `DELETE /api/series/:id`        删除系列（解绑文章，不删文章）
- `GET    /api/users/:id/series`  某用户的系列列表
- 文章 POST/PUT 时可传 `seriesId` + `seriesOrder`

**前端**：

- 编辑器：选择加入某系列 + 设置序号
- 详情页：文章顶部显示「本文属于《xxx 系列》，第 N 篇」
- UserProfile：新增「系列」Tab
- 系列详情页：展示系列下所有文章（按 seriesOrder）
- 侧栏/底部：系列导航（上/下一篇）

**探针 probe-series.mjs（约 15 项）**：

- CRUD
- 文章绑定/解绑
- 顺序正确
- 删系列不删文章（断言 articles 行数不变、seriesId 回 NULL）
- 非作者不能改系列（403）
- 系列列表与文章列表正确关联
- 清理：按创建的 series/article id 精确删（series 先于 article 删或靠 SET NULL，注意顺序）

### 本轮拍板记录（2026-10-18）

1. **孤儿图片文件 MVP 不清**：解析正文反查文件的成本与风险都高（正文可能被并发修改、图片可能被外部引用），推荐方案（定时任务扫描未被引用的文件）已挂「插队候选」。
2. **不加 `GET /api/users/me/series`**：系列没有「草稿/私密」概念，本来就是公开列表（同 `/users/:id/articles`）；`/me` 系列保留给需登录的自己专属数据（likes / bookmarks / drafts）。编辑器下拉直接用 `userStore.user.id` 调 `GET /users/:id/series`。接口数 47 + 6 = 53。
3. **`seriesId` / `seriesOrder` 三态采纳**（不传=不改 / null=解绑 / 有值=绑定，与 `PUT /users/me` 同范式）；新建与 PUT 传 `seriesId` 都必须校验 `series.authorId === 当前用户`（他人 403/404，**绑定侧 ADMIN 无例外**）。
4. **系列导航在详情页顶部**：meta 行下方显示系列横幅「本文属于《xxx》系列，第 N 篇 / 共 M 篇」+ 上/下篇按钮；底部全局 prev/next（时间线维度）不动，两者语义正交不混装。
5. **序号冲突 409 拒绝，新建未传则自动 max+1**：显式传冲突序号 → 409/40900（让用户明确选择）；新建省略 → 自动排到系列末尾；PUT 未传 → 保留原值；**不做服务端自动重排**（用户可能有意识想插中间）。解绑双清：`seriesId=null` 时 `seriesOrder` 同时置 NULL。

---

## 第 11 批：评论点赞 + @提及通知（2026-10-18 执行，插队候选两条转正）

「插队候选」里的评论点赞与 @提及两条在本批合并实现（接口 53 → 56，+3）：

- **Schema**（例外第 16 项）：`comment_likes` 表（`user_id` + `comment_id` 唯一，无软删，likes 族）；`comments.like_count INT DEFAULT 0`；`NotificationType` 枚举追加 `MENTION` / `COMMENT_LIKE`（enum ALTER 走 migrate，generate 前停后端防 EPERM）。
- **评论点赞 3 接口**：`POST` / `DELETE /api/comments/:id/like` **幂等 200**（bookmark/follow 族，与文章 like 的 409/404 刻意相反）+ `GET /api/comments/:id/liked`；评论列表加 `likeCount` / `liked` 字段（`optionalAuth` 可选鉴权，未登录省略 `liked` 键）。
- **通知**：收到评论赞 → `COMMENT_LIKE`（自赞抑制）；发布评论 / 文章时正则 `/@(\w+)/g` 提取用户名 → 查库（存在且未软删）→ `MENTION`（去重、过滤自己；只在发布动作触发，编辑/回滚不补发）。
- **前端**：评论气泡旁点赞按钮（幂等无 409/404 分支）；通知中心补 `MENTION`（「在《文章》中提到了你」）与 `COMMENT_LIKE`（「赞了你的评论」）文案。
- **探针**：`probe-comment-like.mjs`（约 10 项）；`probe-notification.mjs` 补 MENTION / COMMENT_LIKE 断言。
- **硬删序**：`comment_likes` 排最上游（`notifications → bookmarks → likes → follows → comment_likes → comments → articles → series → users`），tmp-account / fixtures 同步（第 8/9 批教训：新 RESTRICT 表当天过所有清理）。

---

## 第 12 批：举报与审核（2026-10-18 执行，远期储备③转正）

「远期储备」的举报 / 内容审核在本批实现（接口 56 → 59，+3；表 9 → 10；例外 16 → 17 项）：

- **Schema**（例外第 17 项）：`reports` 表（`reporter_id` RESTRICT / `target_type`+`target_id` 多态无外键 / `reason` ≤200 / `status` PENDING·RESOLVED·REJECTED / `resolved_at`）；唯一约束防同一用户重复举报同一对象（二次举报 409/40900，不重置状态）；`NotificationType` 追加 **`REPORT_RESOLVED` / `REPORT_REJECTED` 两值**（用户拍板拆分：单值无法在通知文案区分「删了」与「没删」）。
- **3 接口**：`POST /api/reports`（登录；校验链 = 目标可见（文章须 PUBLISHED 且未软删、评论未软删且所属文章可见）→ 不能举报自己 400 → 防重 409）；`GET /api/admin/reports`（ADMIN，status 筛选 + targetPreview 快照，软删降级）；`PUT /api/admin/reports/:id`（ADMIN，**单事务**：软删目标（评论级联子评论）+ 该目标全部 PENDING 批转 RESOLVED；目标已不在 → 幂等跳过 `targetDeleted:false`；通知事务提交后发）。
- **前端**：文章详情 / 评论行内「举报」入口（登录 + 非作者；文章作者也可举报他人评论，用户拍板）+ el-dialog 原因选填 ≤200；管理端 `AdminReports.vue`（筛选 / 忽略 / 删除违规内容并处理二次确认）。
- **顺带修挂账**：admin 版 `deleteComment` 补级联软删子评论（与用户侧口径对齐，历史遗留不一致，用户拍板并入本批后端 commit）。
- **硬删序**：`reports` 排 `comment_likes` 后、`comments` 前：`notifications → bookmarks → likes → follows → comment_likes → reports → comments → articles → series → users`，tmp-account / fixtures 同步（`target_id` 无外键，清理按 reporter_id + 目标 id 双侧删）。

---

## 插队候选（批次之间可随时做的小补丁）

- ~~**评论点赞**：comments 加 `likeCount` + `comment_likes` 表~~ → **第 11 批已实现**（2026-10-18）。
- ~~**@ 提及**：编辑器解析 `@username`，触发通知中心~~ → **第 11 批已实现**（后端正则提取，编辑器暂不做 @ 自动补全 UI，挂账）。
- **图片孤儿清理**：文章删除后 `/uploads/articles/*` 的清理（推荐方案：定时任务扫描未被任何文章正文引用的文件）。第 10 批引入 `uploads/articles/` 后产生的新债——文章删除 / 图片被从正文手动移除都会留孤儿文件；解析正文 Markdown 反查引用成本与风险都高（正文可能被并发修改、图片可能被外部引用），**本批不实现**（2026-10-18 用户拍板）。
- **草稿箱多端同步**：仅在本批技术方案上做记录，暂不实现。
- **评论 @ 自动补全**：第 11 批只做后端提取 + 通知，编辑器输入 `@` 时的用户名下拉补全挂账（需要用户搜索接口或轻量 suggest 接口）。
- **MENTION 限流**：单篇 @ 人数暂无上限（正则全量提取），量大后再设上限或限流（挂账）。

## 优先级建议

1. ~~**第 9 批**：收藏夹 + 阅读量~~（已完成）
2. ~~**第 10 批**：图片上传 + 系列~~（已完成）
3. ~~评论点赞 / @ 提及~~（第 11 批已完成）
4. ~~**第 12 批：举报与审核**~~（第 12 批已完成 2026-10-18）

---

## 附：各批开工检查单（复用）

- [ ] 跑 `node scripts/acceptance/run.mjs` 全量回归绿（基线未漂）
- [ ] 重读 docs/AI_CONTRACT.md（接口总数 / 例外摘要逐项核准，不引缓存）
- [ ] 按老流程走：草案 → 用户拍板 → 文档四步纪律（`grep "^## "` 前后全列比对）→ migrate → 后端 → 前端 → 探针 → 回归 → 四笔 commit
- [ ] 新表带 RESTRICT FK 的，同步改 lib/fixtures.mjs + lib/tmp-account.mjs 清理顺序（第 8 批教训）
- [ ] 探针 finally 只按创建的 id 精确删；跑前跑后全表行数自检
- [ ] commit 前 `git diff --numstat` 对账；README.md / .workbuddy/* 不进 commit
