<!-- 文档：FEATURES.md | 定位：产品功能总览 | 核心：按 6 大模块列出全站已实现功能、接口数与自动化验收规模 -->

# 项目完整功能清单（全站功能总览）

> 本文档基于代码核查整理，覆盖截至第 12 批（举报与审核系统）的全部已实现功能。
> 技术栈：Vue 3 + Express + Prisma + MySQL；所有接口挂在 `/api` 下。
> 接口总数以 [`docs/API.md`](./API.md) 为准（约 59 个），表结构以 [`docs/DB.md`](./DB.md) 为准（10 张业务表），前端 12 个页面，验收探针 33 个（`scripts/acceptance/probe-*.mjs`）。

## 1. 身份与权限
| 接口 | 权限 | 说明 |
|---|---|---|
| `POST /api/auth/register` | 公开 | 注册，用户名查重（已存在→409） |
| `POST /api/auth/login` | 公开 | 登录（密码比对**后**才判 `BANNED`） |
| `GET /api/auth/me` | 用户 | 当前登录用户 |
| `PUT /api/auth/password` | 用户 | 改密码（userId 取自 token，不可改他人） |

- **JWT 鉴权中间件**：验签后**实时查 `user.status`**，`BANNED → 401`（旧 token 立即失效，payload 不放 role/status）。
- **角色中间件 `requireAdmin`**：必须挂在 auth 之后，非 `ADMIN → 403`（与「用户不存在」同口径，不泄露存在性）。
- **`optionalAuth`**：公开接口静默放行，仅做「是否已点赞/收藏」视角增强。
- 角色两态 `USER / ADMIN`；管理员不可被封禁、不可被改角色。

## 2. 创作端
| 接口 | 权限 | 说明 |
|---|---|---|
| `POST /api/articles` | 作者 | 发布文章 |
| `PUT /api/articles/:id` | 作者 | 编辑（编辑前若为 `PUBLISHED` 先写版本快照） |
| `DELETE /api/articles/:id` | 作者 | 软删 |
| `POST /api/articles/auto-save` | 用户 | 草稿自动保存（达门槛新建，否则更新） |
| `GET /api/users/me`（drafts） | 用户 | 草稿箱（含正文回填） |
| `DELETE /api/users/me/drafts/:id` | 用户 | 删草稿（硬删） |
| `GET/POST /api/articles/:id/revisions` `…/restore` | 作者 | 版本历史 / 回滚（回滚前先快照） |
| `POST /api/articles/upload-image` | 用户 | 图片上传（仅落盘返 URL，前端插入 Markdown） |
| `POST/GET/PUT/DELETE /api/series` | 作者/ADMIN | 专栏系列（删系列 `SET NULL` 解绑文章） |
| `GET /api/users/:id/series` | 公开 | 某用户的系列列表（公开数据） |

- **Markdown 渲染**：`marked.parse → DOMPurify.sanitize → v-html`（**XSS 净化在前端**），`highlight.js` 代码高亮，`ArticleToc.vue` 生成 TOC（h1–h3 补 id，跳过代码块内 `#`）。
- 后端**不净化**、只存原始 Markdown。

## 3. 内容发现
- `GET /api/articles`（广场列表）、`GET /api/tags`（热门标签，groupBy 聚合）。
- **分类筛选**（白名单 `技术/生活/随笔/未分类`）、**标签筛选**（`EXISTS` 子查询，与 keyword/分类正交叠加）、**全文搜索**（`title OR content` 模糊）。
- **排序**：最新=createdAt / 热门=likeCount / 阅读最多=viewCount；前端暴露「热门 / 最新」Tab 与默认列表。

## 4. 互动与社交
| 能力 | 接口 | 语义要点 |
|---|---|---|
| 文章点赞 | `POST/DELETE/GET /api/articles/:id/like` | 重复→409，未赞取消→404 |
| 收藏 | `POST/DELETE/GET /api/articles/:id/bookmark` | **幂等 200**（与 like 刻意相反） |
| 评论 | `POST /api/comments`（楼中楼，两层硬限制）、`GET /api/articles/:id/comments`、`DELETE /api/comments/:id` | 删评论=软删+级联子评论（同事务）；作者或文章作者可删 |
| 评论点赞 | `POST/DELETE/GET /api/comments/:id/like` | **幂等 200** |
| @提及 | 创建文章/评论时触发 | 正则 `/@(\w+)/g`，去重+过滤自己+**单篇上限 20**，事务提交后发 `MENTION` 通知 |
| 关注/粉丝 | `POST/DELETE /api/users/:id/follow`、粉丝/关注列表 | **幂等 200**，自关注→400 |
| 通知中心 | `GET /notifications`、`/unread-count`、`PUT /read`、`PUT /:id/read` | 10 种类型 + 自通知抑制 + 软删降级「已注销用户 / 内容已删除」；前端轮询未读 |

## 5. 平台治理
- **看板**：`GET /api/admin/stats`（6 个实时计数）。
- **用户封禁**：`PATCH /api/admin/users/:id/status`（`ADMIN` 不可动）。
- **软删管理**：admin 删文章/评论=软删（无视作者）+ 评论级联子评论（同事务）；全局 `whereNotDeleted` 统一过滤（禁手写 `deletedAt:null`）。
- **举报与审核**：用户 `POST /api/reports`（唯一约束去重→409，不能自举报→400，软删/草稿目标→404）；管理 `GET/PUT /api/admin/reports`。
- **单事务处理机制（核心）**：`$transaction` 内「软删目标（文章 / 评论+级联子树）+ 该目标全部 `PENDING` 举报批转 `RESOLVED`」，事务**提交后**才发 `REPORT_RESOLVED / REPORT_REJECTED` 通知，单条通知失败不回滚。

## 6. 自动化基建
- **33 个探针** `scripts/acceptance/probe-*.mjs` + 主验收 `run.mjs`（headless Chrome + CDP）。
- 本轮统计：33 探针共 **688 断言** + `run.mjs` **50 断言** = **约 738 自动化断言**。
- **清理铁律**：绝不 `deleteMany({})` 全表清空；按 id 集合 / `PROBE_PREFIX` 用户名精确回收；跑前/跑后全表行数快照 diff 必须为 0。
- **FK RESTRICT 顺序**：notification → bookmark → follow → like → commentLike → comment → article → series → user。
- **安全机制**：JWT 实时查库不信任 token 内嵌状态；授权在 service 层**先 404 后 403**；前端 `DOMPurify` 净化；上传 mimetype 白名单+2MB+随机文件名+路径越权校验；并发靠唯一约束 `P2002` 兜底；阅读 `(articleId, ip)` 5 分钟去重 + `increment` 原子计数。
