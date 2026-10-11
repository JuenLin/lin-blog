<!--
  正式文档声明（ARCHITECTURE.md）：
  - 纳入版本控制：会 commit、会 push，是仓库正式文档。
  - 可被引用：README.md / docs/AI_CONTRACT.md 等文档可链接本文件。
  - 进文档清单：docs/AI_CONTRACT.md §3 目录结构中收录本文件。
  - 定位：本文件是「视图文档」，用 Mermaid 呈现系统各维度的关系图，不是契约。
    若与 API.md（接口契约）/ DB.md（表结构）冲突，以 API.md / DB.md 为准。
  - 更新触发标准（仅结构性变更才更新）：
    ✅ 新增/删除：表、模块、页面路由、跨模块 service 复用、接口
    ❌ 不触发：改字段名、改文案、改样式、修 bug、加探针
-->

# 系统架构图（ARCHITECTURE）

> 本文档用 Mermaid 画「关系」，不重复 API.md / README / DB.md 的字段清单。
> 六张图：A 系统架构 / B 后端请求链路 / C 数据库 ER / D 用户功能地图 / E 接口全景 / F 前端路由+组件树。
> 视图文档，冲突以 API.md / DB.md 为准。

---

## A · 系统架构图

三层：前端 (Vue3) / 后端 (Express) / 数据层 (MySQL + Prisma)。标注端口、鉴权方式、静态资源路径、CORS 白名单；MySQL 层一眼看到「4 张表 + 6 个迁移」的数据规模。

```mermaid
graph TB
  user([浏览器 用户])

  subgraph FE[前端层 Vue3]
    fe["前端 dev 服务器\n端口 5173\nCORS 仅放行 http://localhost:5173"]
  end

  subgraph BE[后端层 Express]
    be["后端 API 服务\n端口 3000\nJWT 鉴权 Authorization Bearer"]
    authn["auth 中间件\nverifyToken 解析出 userId"]
    vld["validate 中间件\nzod 校验入参"]
  end

  subgraph DATA[数据层 MySQL Prisma]
    db[("MySQL")]
    tables["4 张表\nusers / articles / comments / likes"]
    migs["6 个迁移 migrations\ninit → avatar_bio → likes → category"]
  end

  uploads["静态资源 /uploads\nexpress.static 挂 /uploads\n头像路径 /uploads/avatars/userId/file"]

  user -->|打开页面| fe
  fe -->|"HTTPS /api/* 调接口"| be
  fe -->|"GET /uploads/* 取头像"| uploads
  be --> authn
  be --> vld
  be -->|"Prisma Client 读写"| db
  be -->|"写头像文件"| uploads
  db --- tables
  db --- migs
```

---

## B · 后端请求链路图（带鉴权写请求）

以 `DELETE /api/comments/:id` 为例，画出一次写请求的完整中间件顺序与错误分支。**中间件注册顺序为 `auth` → `validate`**（见 `comment.routes.js:14`），因此未登录请求即便参数非法也先回 401。统一响应体 `{ code, message, data }`。

```mermaid
flowchart LR
  req["客户端请求\nDELETE /api/comments/:id\n带 Authorization Bearer"]

  route["路由匹配\ncommentRootRouter.delete('/:id')"]
  auth["auth 中间件\nverifyToken 解析 userId"]
  vld["validate 中间件\nzod 校验 commentIdParamSchema"]
  ctrl["comment.controller.remove"]
  svc["comment.service.deleteComment"]
  prisma["Prisma\nwhereNotDeleted 查评论"]
  mysql[("MySQL")]

  resp["统一响应\ncode message data"]

  e400["400 参数错误\nzod 校验失败"]
  e401["401 未登录\ntoken 缺失或无效"]
  e403["403 无权删除\n非评论作者且非文章作者"]
  e404["404 评论不存在\n或已软删除"]
  e500["500 服务器错误\nerrorHandler 兜底"]

  authnote["auth 先于 validate\n未登录请求即使 id 非法也先回 401"]

  req --> route
  route --> auth
  auth -->|"token 缺失或无效"| e401
  auth -->|"通过 userId"| vld
  vld -->|"参数非法"| e400
  vld -->|"通过"| ctrl
  ctrl --> svc
  svc --> prisma
  prisma --> mysql
  svc -->|"评论不存在或已软删"| e404
  svc -->|"无权限"| e403
  svc -->|"未捕获异常"| e500
  svc -->|"软删成功"| resp

  route -.->|"中间件注册顺序"| authnote
```

---

## C · 数据库 ER 图

4 张表，标出外键、唯一约束、软删列。关键差异：`users` / `articles` / `comments` 有 `deleted_at`（软删除），`likes` **没有**（物理删除，因为唯一约束 + 「点赞 = 行存在」不变式）。

```mermaid
erDiagram
  USER ||--o{ ARTICLE : "发布"
  USER ||--o{ COMMENT : "撰写"
  USER ||--o{ LIKE : "点赞"
  ARTICLE ||--o{ COMMENT : "拥有"
  ARTICLE ||--o{ LIKE : "被赞"

  USER {
    int id PK
    string username UK "唯一 不可重复"
    string password "bcrypt 哈希"
    string nickname "可空"
    string avatar "可空 站内 /uploads 路径"
    string bio "可空"
    datetime created_at
    datetime updated_at
    datetime deleted_at "软删 可空"
  }
  ARTICLE {
    int id PK
    string title
    text content
    string category "默认 未分类"
    int author_id FK
    datetime created_at
    datetime updated_at
    datetime deleted_at "软删 可空"
  }
  COMMENT {
    int id PK
    int article_id FK
    int author_id FK
    string content "最长 500"
    datetime created_at
    datetime updated_at
    datetime deleted_at "软删 可空"
  }
  LIKE {
    int id PK
    int user_id FK "与 article_id 复合唯一"
    int article_id FK "与 user_id 复合唯一"
    datetime created_at
  }
```

> `likes` 表无 `deleted_at`：取消点赞是物理 DELETE，而非软删——避免与 `(user_id, article_id)` 唯一约束冲突（详见 DB.md 第十一批说明）。

---

## D · 用户功能地图（mindmap）

中心=已注册用户；四分支：看（公开）／写（登录）／管自己（登录）／删（登录）。画「功能 → 入口（页面/组件） → 接口」的映射，不列功能清单。

```mermaid
mindmap
  root((已注册用户))
    成为用户
      注册
        入口 LoginView
        接口 POST ／api／auth／register
      登录
        入口 LoginView
        接口 POST ／api／auth／login
    看（公开）
      浏览广场列表
        入口 HomeView·ArticleCard
        接口 GET ／api／articles
      看文章详情
        入口 ArticleDetailView
        接口 GET ／api／articles／：id
      看他人主页
        入口 UserProfileView
        接口 GET ／api／users／：id
      看用户文章
        入口 UserProfileView
        接口 GET ／api／users／：id／articles
      看评论
        入口 ArticleDetailView·CommentList
        接口 GET ／api／articles／：id／comments
    写（登录）
      发文章
        入口 ArticleEditorView（／editor）
        接口 POST ／api／articles
      编辑文章
        入口 ArticleEditorView（／editor／：id）
        接口 PUT ／api／articles／：id
      发评论
        入口 CommentList 内
        接口 POST ／api／comments
      点赞
        入口 ArticleCard 赞按钮
        接口 POST ／api／articles／：id／like
      取消赞
        入口 ArticleCard 赞按钮
        接口 DELETE ／api／articles／：id／like
    管自己（登录）
      改简介
        入口 ProfileEditView（／settings／profile）
        接口 PUT ／api／users／me
      传头像
        入口 ProfileEditView
        接口 POST ／api／users／me／avatar
      改密码
        入口 ChangePasswordView（／settings／password）
        接口 PUT ／api／auth／password
    删（登录）
      删自己文章
        入口 ArticleDetailView
        接口 DELETE ／api／articles／：id
      删自己评论
        入口 CommentList 内
        接口 DELETE ／api／comments／：id
```

---

## E · 接口全景图（flowchart）

21 个接口按模块聚合（auth+health 5 / user 5 / article 5 / like 3 / comment 3）。画三类关系——这正是 API.md 接口表看不出来的部分：**① 模块归属独立 service**（auth 有独立 auth.service，直接碰 users 表，不经 user.service）**② 跨模块 service 复用**（article.service 导出的 `toArticleListItem / ARTICLE_DETAIL_SELECT / ARTICLE_SORT_MAP` 被 user.service 复用，第 2 批）**③ 跨 service 共享数据表**（user.service 直接查 likes 表，不经 like.service；users 表被 auth.service 与 user.service 共同直连）。所有 service 均经 Prisma 直连表，无 service 间链式调用（除第 2 批那一条复用）。不重复 API.md 接口表。

```mermaid
flowchart TB
  subgraph MOD[接口按模块聚合（共 21 个）]
    authH["auth + health 5\nregister / login / me / password / health"]
    userM["user 模块 5\nme / avatar / :id / :id/articles / me/likes"]
    artM["article 模块 5\n列表 / 详情 / 发布 / 编辑 / 删除"]
    likeM["like 模块 3\nPOST+DELETE /like + GET /liked"]
    cmtM["comment 模块 3\nPOST /comments + GET /:id/comments + DELETE /:id"]
  end

  subgraph SVC[Service 层（各模块独立 service）]
    authSvc["Auth service"]
    userSvc["User service"]
    artSvc["Article service"]
    likeSvc["Like service"]
    cmtSvc["Comment service"]
  end

  subgraph DBT[数据层（Prisma 直连）]
    usersTable["users 表"]
    likesTable["likes 表"]
  end

  %% 模块归属各自独立 service
  authH --> authSvc
  userM --> userSvc
  artM --> artSvc
  likeM --> likeSvc
  cmtM --> cmtSvc

  %% service 直连数据表
  authSvc --> usersTable
  userSvc --> usersTable
  likeSvc --> likesTable

  %% 跨边界核心关系（API.md 接口表看不出）
  artSvc -. "article.service 导出 toArticleListItem / ARTICLE_DETAIL_SELECT / ARTICLE_SORT_MAP（第 2 批）" .-> userSvc
  userSvc -. "user.service 直接查 likes 表（不经 like.service）" .-> likesTable
```

---

## F · 前端路由 + 组件树（graph）

画三类关系：**① 路由嵌套（壳+子页、双路径共用组件）② 组件复用（ArticleCard / Pagination 被哪几处用）③ store 订阅（likedStore 消费与 reset 触发链）**。不重复 README 目录。

```mermaid
graph TB
  subgraph ROUTE[前端路由 router/index.js]
    rLogin["/login → LoginView\nlayout: blank 无 Header"]
    rHome["/ → HomeView\n落地页 静态引入"]
    rDetail["/article/:id → ArticleDetailView"]
    rEditor["/editor → ArticleEditorView\nrequiresAuth"]
    rEditorId["/editor/:id → ArticleEditorView\nrequiresAuth 双路径"]
    rUser["/user/:id → UserProfileView\n公开"]
    rSettings["/settings → SettingsView 壳\nrequiresAuth redirect profile"]
    rPwd["/settings/password → ChangePasswordView\n子页"]
    rProfile["/settings/profile → ProfileEditView\n子页"]
  end

  subgraph COMP[组件]
    card["ArticleCard\n已赞态来自 likedStore"]
    editorComp["ArticleEditorView\n新建+编辑共用"]
    clist["CommentList\n内含 Pagination"]
    pag["Pagination\n@change 翻页 不 watch"]
    header["AppHeader\n监听 AUTH_CLEARED_EVENT"]
  end

  subgraph STORE[Store]
    liked["likedStore\n已赞 id 集合 Set"]
    user["userStore\nsetToken 联动 reset"]
  end

  %% ① 路由嵌套 / 双路径共用
  rSettings --- rPwd
  rSettings --- rProfile
  rEditor --> editorComp
  rEditorId --> editorComp

  %% ② 组件复用
  rHome --> card
  rUser --> card
  rDetail --> card
  rDetail --> clist
  card --> pag
  clist --> pag

  %% ③ store 订阅
  card --> liked
  header --> liked
  header --> user
  user -->|setToken 触发 reset| liked
  header -. "监听 AUTH_CLEARED_EVENT\n→ setToken('')" .-> user
```
