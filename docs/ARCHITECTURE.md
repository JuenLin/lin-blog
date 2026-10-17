# 系统架构图（ARCHITECTURE）

> 本文档用 Mermaid 画「关系」，不重复 API.md / README / DB.md 的字段清单。  
> 六张图：A 系统架构 / B 后端请求链路 / C 数据库 ER / D 用户功能地图 / E 接口全景 / F 前端路由+组件树。  
> 视图文档，冲突以 API.md / DB.md 为准。

---

## A · 系统架构图

三层：前端 (Vue3) / 后端 (Express) / 数据层 (MySQL + Prisma)。标注端口、鉴权方式、静态资源路径、CORS 白名单；MySQL 层一眼看到「5 张表 + 7 个迁移」的数据规模。

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
    tables["5 张表\nusers / articles / comments / likes / follows"]
    migs["7 个迁移 migrations\ninit → avatar_bio → likes → category → follows"]
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

5 张表，标出外键、唯一约束、软删列。关键差异：`users` / `articles` / `comments` 有 `deleted_at`（软删除），`likes` 与 `follows` **没有**（物理删除，因为唯一约束 + 「关系 = 行存在」不变式）。

```mermaid
erDiagram
  USER ||--o{ ARTICLE : "发布"
  USER ||--o{ COMMENT : "撰写"
  USER ||--o{ LIKE : "点赞"
  USER ||--o{ FOLLOW : "关注"
  USER ||--o{ FOLLOW : "被关注"
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
  FOLLOW {
    int id PK
    int follower_id FK "关注人 与 following_id 复合唯一"
    int following_id FK "被关注人 与 follower_id 复合唯一"
    datetime created_at
  }
```

> `likes` 表无 `deleted_at`：取消点赞是物理 DELETE，而非软删——避免与 `(user_id, article_id)` 唯一约束冲突（详见 DB.md 第十一批说明）。
> `follows` 表同样无 `deleted_at`：取关是物理 DELETE；`(follower_id, following_id)` 复合唯一即「一段关注关系只有一行」，重复关注由唯一约束兜底、应用层返回幂等成功（第 4 批）。

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
      看他关注谁
        入口 UserFollowsView
        接口 GET ／api／users／：id／following
      看他的粉丝
        入口 UserFollowsView
        接口 GET ／api／users／：id／followers
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
      关注他人
        入口 UserProfileView 关注按钮
        接口 POST ／api／users／：id／follow
      取消关注
        入口 UserProfileView 已关注按钮
        接口 DELETE ／api／users／：id／follow
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

25 个接口按模块聚合（auth+health 5 / user 9 / article 5 / like 3 / comment 3）。画四类关系——这正是 API.md 接口表看不出来的部分：**① 模块归属独立 service**（auth 有独立 auth.service，直接碰 users 表，不经 user.service）**② 跨模块 service 复用**（article.service 导出的 `toArticleListItem / ARTICLE_DETAIL_SELECT / ARTICLE_SORT_MAP` 被 user.service 复用，第 2 批）**③ 跨 service 共享数据表**（user.service 直接查 likes 表，不经 like.service；users 表被 auth.service 与 user.service 共同直连）**④ 同模块跨 service**（user 路由下的 4 个 follow 接口走独立 follow.service，挂在 user.routes.js 下但不经 user.service；follows 表只被 follow.service 直连，第 4 批）。所有 service 均经 Prisma 直连表，无 service 间链式调用（除第 2 批那一条复用）。不重复 API.md 接口表。

```mermaid
flowchart TB
  subgraph MOD[接口按模块聚合（共 25 个）]
    authH["auth + health 5\nregister / login / me / password / health"]
    userM["user 模块 9\nme / avatar / :id / :id/articles / me/likes / follow / followers / following"]
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
    followSvc["Follow service"]
  end

  subgraph DBT[数据层（Prisma 直连）]
    usersTable["users 表"]
    likesTable["likes 表"]
    followsTable["follows 表"]
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
  userM -. "follow 四接口走独立 follow.service（挂在 user.routes 下，第 4 批）" .-> followSvc
  followSvc --> followsTable
```

---

## F · 前端路由 + 组件树（graph）

画三类关系：**① 路由嵌套（壳+子页、双路径共用组件）② 组件复用（ArticleCard / Pagination 被哪几处用）③ store 订阅（likedStore / followingStore 消费与 reset 触发链）**。不重复 README 目录。

```mermaid
graph TB
  subgraph ROUTE[前端路由 router/index.js]
    rLogin["/login → LoginView\nlayout: blank 无 Header"]
    rHome["/ → HomeView\n落地页 静态引入"]
    rDetail["/article/:id → ArticleDetailView"]
    rEditor["/editor → ArticleEditorView\nrequiresAuth"]
    rEditorId["/editor/:id → ArticleEditorView\nrequiresAuth 双路径"]
    rUser["/user/:id → UserProfileView\n公开"]
    rFollows["/user/:id/follows/:type → UserFollowsView\n公开 type 白名单 beforeEnter"]
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
    followsComp["UserFollowsView\n粉丝/关注列表 复用 Pagination"]
    profileComp["UserProfileView\n关注按钮 + 主页入口"]
  end

  subgraph STORE[Store]
    liked["likedStore\n已赞 id 集合 Set"]
    following["followingStore\n已关注 id 集合 Set"]
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
  user -->|setToken 触发 reset| following
  header -. "监听 AUTH_CLEARED_EVENT\n→ setToken('')" .-> user

  %% 第 4 批：关注链路
  rFollows --> followsComp
  rUser --> profileComp
  followsComp --> pag
  profileComp --> following
  header -. "ensureLoaded(user.id)\n按钮初始态 + 主页计数" .-> following
```
