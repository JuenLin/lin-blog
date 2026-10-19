<!-- 文档：ARCHITECTURE.md | 定位：架构说明 | 核心：前后端分层、请求链路、ER 图与前端路由组件树。 -->

# 系统架构图（ARCHITECTURE）

> 本文档用 Mermaid 画「关系」，不重复 API.md / README / DB.md 的字段清单。  
> 六张图：A 系统架构 / B 后端请求链路 / C 数据库 ER / D 用户功能地图 / E 接口全景 / F 前端路由+组件树。  
> 视图文档，冲突以 API.md / DB.md 为准。

---

## A · 系统架构图

三层：前端 (Vue3) / 后端 (Express) / 数据层 (MySQL + Prisma)。标注端口、鉴权方式、静态资源路径、CORS 白名单；MySQL 层一眼看到「13 张表 + 17 个迁移」的数据规模。

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
    tables["13 张表\nusers / articles / comments / likes / follows / notifications / tags / article_tags / bookmarks / article_revisions / series / comment_likes / reports"]
    migs["17 个迁移（示意链）\ninit → avatar_bio → likes → category → follows → role_status → article_status → revisions → tags → notifications → bookmarks → series → comment_likes → reports"]
  end

  uploads["静态资源 /uploads\nexpress.static 挂 /uploads\n头像路径 /uploads/avatars/userId/file\n配图路径 /uploads/articles/userId/file"]

  user -->|打开页面| fe
  fe -->|"HTTPS /api/* 调接口"| be
  fe -->|"GET /uploads/* 取资源"| uploads
  be --> authn
  be --> vld
  be -->|"Prisma Client 读写"| db
  be -->|"写资源文件"| uploads
  db --- tables
  db --- migs
```

---

## B · 后端请求链路图（带鉴权写请求）

以 `DELETE /api/comments/:id` 为例，画出一次写请求的完整中间件顺序与错误分支。**中间件注册顺序为 `auth` → `validate`**（见 `comment.routes.js:14`），因此未登录请求即便参数非法也先回 401。统一响应体 `{ code, message, data }`。第 5 批之后新增的所有 admin / report 接口也是同一鉴权链（`auth` → `requireAdmin` → `validate`），不再单独画。

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

13 张表，标出外键、唯一约束、软删列。关键差异：`users` / `articles` / `comments` 有 `deleted_at`（软删除），`likes` / `follows` / `bookmarks` / `comment_likes` / `series` **没有**（物理删除，因为唯一约束 + 「关系 = 行存在」不变式）；`tags` / `article_tags` / `article_revisions` / `notifications` / `reports` 也均无软删（tags 为共享词典、article_tags 为联结表、article_revisions 为历史快照、notifications / reports 为事件记录）。

```mermaid
erDiagram
  USER ||--o{ ARTICLE : "发布"
  USER ||--o{ COMMENT : "撰写"
  USER ||--o{ LIKE : "点赞"
  USER ||--o{ FOLLOW : "关注"
  USER ||--o{ FOLLOW : "被关注"
  ARTICLE ||--o{ COMMENT : "拥有"
  ARTICLE ||--o{ LIKE : "被赞"
  USER ||--o{ NOTIFICATION : "接收"
  USER ||--o{ NOTIFICATION : "触发"
  ARTICLE ||--o{ NOTIFICATION : "目标"
  ARTICLE ||--o{ ARTICLE_TAG : "拥有标签"
  TAG ||--o{ ARTICLE_TAG : "被关联"
  USER ||--o{ BOOKMARK : "收藏"
  ARTICLE ||--o{ BOOKMARK : "被收藏"
  ARTICLE ||--o{ ARTICLE_REVISION : "版本快照"
  USER ||--o{ ARTICLE_REVISION : "快照作者"
  USER ||--o{ SERIES : "创建系列"
  SERIES ||--o{ ARTICLE : "可选归属"
  USER ||--o{ COMMENT_LIKE : "赞评论"
  COMMENT ||--o{ COMMENT_LIKE : "被赞"
  USER ||--o{ REPORT : "提交举报"

  USER {
    int id PK
    string username UK "唯一 不可重复"
    string password "bcrypt 哈希"
    string nickname "可空"
    string avatar "可空 站内 /uploads 路径"
    string bio "可空"
    string role "USER/ADMIN 第5批"
    string status "ACTIVE/BANNED 第5批"
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
    int view_count "第9批 阅读量"
    int series_id FK "第10批 SET NULL"
    int series_order "第10批 可空"
    datetime created_at
    datetime updated_at
    datetime deleted_at "软删 可空"
  }
  COMMENT {
    int id PK
    int article_id FK
    int author_id FK
    int parent_id FK "第7批 楼中楼"
    int like_count "第11批"
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
  NOTIFICATION {
    int id PK
    int user_id FK "接收人 RESTRICT"
    int actor_id FK "触发人 RESTRICT"
    string type "6类动作枚举"
    int article_id FK "目标 可空 RESTRICT"
    int comment_id FK "目标 可空 无FK"
    datetime read_at "可空"
    datetime created_at
  }
  TAG {
    int id PK
    string name UK "大小写不敏感 1-20"
    datetime created_at
  }
  ARTICLE_TAG {
    int article_id PK,FK
    int tag_id PK,FK
    datetime created_at
  }
  BOOKMARK {
    int id PK
    int user_id FK "与 article_id 复合唯一"
    int article_id FK "与 user_id 复合唯一"
    datetime created_at
  }
  ARTICLE_REVISION {
    int id PK
    int article_id FK "CASCADE"
    int author_id FK "RESTRICT"
    string title
    text content
    string category
    datetime created_at
  }
  SERIES {
    int id PK
    string title
    string description "可空"
    int author_id FK "RESTRICT"
    datetime created_at
    datetime updated_at
  }
  COMMENT_LIKE {
    int id PK
    int user_id FK "与 comment_id 复合唯一"
    int comment_id FK "与 user_id 复合唯一"
    datetime created_at
  }
  REPORT {
    int id PK
    int reporter_id FK "RESTRICT"
    string target_type "ARTICLE/COMMENT"
    int target_id "多态 无FK"
    string reason "≤200"
    string status "PENDING/RESOLVED/REJECTED"
    datetime resolved_at "可空"
    datetime created_at
  }
```

> `likes` 表无 `deleted_at`：取消点赞是物理 DELETE，而非软删——避免与 `(user_id, article_id)` 唯一约束冲突（详见 DB.md 第十一批说明）。
> `follows` 表同样无 `deleted_at`：取关是物理 DELETE；`(follower_id, following_id)` 复合唯一即「一段关注关系只有一行」，重复关注由唯一约束兜底、应用层返回幂等成功（第 4 批）。
> `bookmarks` / `comment_likes` / `series` 同样无 `deleted_at`（物理删，与 likes / follows 同族）；`article_revisions` 的 `article_id` 是 CASCADE、`author_id` 是 RESTRICT；`articles.series_id` 是 SET NULL（全库唯一）。

---

## D · 用户功能地图（mindmap）

中心=已注册用户；分支：看（公开）／写（登录）／管自己（登录）／删（登录）／收通知（登录）／当管理员（ADMIN）。画「功能 → 入口（页面/组件） → 接口」的映射，不列功能清单。

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
      浏览热门／最新／阅读最多
        入口 HomeView Tab
        接口 GET ／api／articles？sortBy=
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
      查看系列
        入口 UserProfile 系列 Tab
        接口 GET ／api／users／：id／series
    写（登录）
      发文章
        入口 ArticleEditorView（／editor）
        接口 POST ／api／articles
      编辑文章
        入口 ArticleEditorView（／editor／：id）
        接口 PUT ／api／articles／：id
      存草稿
        入口 ArticleEditorView
        接口 POST ／api／articles／auto-save
      发布／切已发布
        入口 ArticleEditorView
        接口 PUT ／api／articles／：id
      发评论
        入口 CommentList 内
        接口 POST ／api／comments
      赞文章
        入口 ArticleCard 赞按钮
        接口 POST ／api／articles／：id／like
      取消赞文章
        入口 ArticleCard 赞按钮
        接口 DELETE ／api／articles／：id／like
      赞评论
        入口 CommentList 赞按钮
        接口 POST ／api／comments／：id／like
      取消赞评论
        入口 CommentList 赞按钮
        接口 DELETE ／api／comments／：id／like
      @提及他人
        入口 ArticleEditorView 发布时触发
        说明 正则提取 事务后发 MENTION 通知
      收藏文章
        入口 ArticleCard 星标按钮
        接口 POST ／api／articles／：id／bookmark
      新建系列
        入口 ArticleEditorView 系列选择
        接口 POST ／api／series
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
      查看草稿箱
        入口 UserProfile 草稿 Tab
        接口 GET ／api／users／me／drafts
      删除草稿
        入口 草稿箱列表
        接口 DELETE ／api／users／me／drafts／：id
      查看版本历史
        入口 ArticleDetailView 历史按钮
        接口 GET ／api／articles／：id／revisions
      回滚版本
        入口 版本历史弹窗
        接口 POST ／api／articles／：id／restore
      我的收藏
        入口 UserProfile 收藏 Tab
        接口 GET ／api／users／me／bookmarks
      我的系列
        入口 UserProfile 系列 Tab
        接口 GET ／api／users／：id／series
    删（登录）
      删自己文章
        入口 ArticleDetailView
        接口 DELETE ／api／articles／：id
      删自己评论
        入口 CommentList 内
        接口 DELETE ／api／comments／：id
      删自己草稿
        入口 草稿箱列表
        接口 DELETE ／api／users／me／drafts／：id
    收通知（登录）
      通知列表
        入口 AppHeader 铃铛下拉（无独立路由页）
        接口 GET ／notifications
      标已读
        入口 AppHeader 铃铛下拉（无独立路由页）
        接口 PUT ／notifications／read 与 ／：id／read
      未读数轮询
        入口 AppHeader 红点
        接口 GET ／notifications／unread-count
    当管理员（ADMIN）
      数据看板
        入口 AdminStats
        接口 GET ／api／admin／stats
      用户管理
        入口 AdminUsers
        接口 GET ／api／admin／users 与 PATCH ／api／admin／users／：id／status
      内容管理-文章
        入口 AdminArticles
        接口 GET ／api／admin／articles 与 DELETE ／api／admin／articles／：id
      内容管理-评论
        入口 AdminComments
        接口 GET ／api／admin／comments 与 DELETE ／api／admin／comments／：id
      举报处理
        入口 AdminReports
        接口 GET ／api／admin／reports 与 PUT ／api／admin／reports／：id
```

---

## E · 接口全景图（flowchart）

59 个接口按模块聚合（auth+health 5 / user 13 / article 12 / like 3 / comment 3 / comment_like 3 / bookmark 4 / notification 4 / admin 7 / report 3）。画四类关系——这正是 API.md 接口表看不出来的部分：**① 模块归属独立 service** **② 跨模块 service 复用** **③ 跨 service 共享数据表** **④ 同模块跨 service**。所有 service 均经 Prisma 直连表，无 service 间链式调用。不重复 API.md 接口表。

```mermaid
flowchart TB
  subgraph MOD[接口按模块聚合（共 59 个）]
    authH["auth + health 5\nregister / login / me / password / health"]
    userM["user 模块 13\nme / avatar / :id / :id/articles / me/likes / follow / followers / following / me/drafts / me/drafts/:id / revisions / restore / series"]
    artM["article 模块 12\n列表 / 详情 / 发布 / 编辑 / 删除 / auto-save / upload-image / 标签 / 分类筛选 / revisions / restore / view"]
    likeM["like 模块 3\nPOST+DELETE /like + GET /liked"]
    cmtM["comment 模块 3\nPOST /comments + GET /:id/comments + DELETE /:id"]
    cmtLikeM["comment_like 模块 3\nPOST+DELETE /comments/:id/like + GET /liked"]
    bmM["bookmark 模块 4\nPOST+DELETE /bookmark + GET /bookmarked + GET /users/me/bookmarks + view"]
    notiM["notification 模块 4\nGET /notifications + unread-count + PUT /read + /:id/read"]
    adminM["admin 模块 7\nstats / users / users/:id/status / articles / articles/:id / comments / comments/:id"]
    rptM["report 模块 3\nPOST /reports + GET /admin/reports + PUT /admin/reports/:id"]
  end

  subgraph SVC[Service 层（各模块独立 service，共 14 个）]
    authSvc["Auth service"]
    userSvc["User service"]
    artSvc["Article service"]
    likeSvc["Like service"]
    cmtSvc["Comment service"]
    followSvc["Follow service"]
    notiSvc["Notification service"]
    tagSvc["Tag service"]
    bmSvc["Bookmark service"]
    seriesSvc["Series service"]
    rptSvc["Report service"]
    cmtLikeSvc["CommentLike service"]
    viewSvc["View service"]
    adminSvc["Admin service"]
  end

  subgraph DBT[数据层（Prisma 直连，13 张表）]
    usersTable["users 表"]
    artTable["articles 表"]
    cmtTable["comments 表"]
    likesTable["likes 表"]
    followsTable["follows 表"]
    notiTable["notifications 表"]
    tagsTable["tags / article_tags 表"]
    bmTable["bookmarks 表"]
    revTable["article_revisions 表"]
    seriesTable["series 表"]
    cmtLikeTable["comment_likes 表"]
    rptTable["reports 表"]
  end

  authH --> authSvc
  userM --> userSvc
  artM --> artSvc
  likeM --> likeSvc
  cmtM --> cmtSvc
  cmtLikeM --> cmtLikeSvc
  bmM --> bmSvc
  notiM --> notiSvc
  adminM --> adminSvc
  rptM --> rptSvc

  authSvc --> usersTable
  userSvc --> usersTable
  likeSvc --> likesTable
  followSvc --> followsTable
  artSvc --> artTable
  cmtSvc --> cmtTable
  notiSvc --> notiTable
  tagSvc --> tagsTable
  bmSvc --> bmTable
  seriesSvc --> seriesTable
  cmtLikeSvc --> cmtLikeTable
  rptSvc --> rptTable
  viewSvc --> artTable

  artSvc -. "article.service 导出 toArticleListItem / ARTICLE_DETAIL_SELECT / ARTICLE_SORT_MAP（第 2 批）" .-> userSvc
  userSvc -. "user.service 直接查 likes 表（不经 like.service）" .-> likesTable
  userM -. "follow 四接口走独立 follow.service（挂在 user.routes 下，第 4 批）" .-> followSvc
  followSvc --> followsTable
  notiSvc -. "被 comment / follow / like / report 四处触发" .-> cmtSvc
  notiSvc -. "被 comment / follow / like / report 四处触发" .-> followSvc
  notiSvc -. "被 comment / follow / like / report 四处触发" .-> likeSvc
  notiSvc -. "被 comment / follow / like / report 四处触发" .-> rptSvc
  rptSvc -. "事务提交后发 REPORT_RESOLVED / REPORT_REJECTED 通知" .-> notiSvc
  adminSvc -. "复用共享 select 与 deleteComment（评论级联软删）" .-> cmtSvc
```

---

## F · 前端路由 + 组件树（graph）

画三类关系：**① 路由嵌套（壳+子页、双路径共用组件）② 组件复用（ArticleCard / Pagination 被哪几处用）③ store 订阅（likedStore / followingStore / bookmarksStore / notificationStore 消费与 reset 触发链）**。不重复 README 目录。

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
    rAdmin["/admin → AdminLayout 壳\nrequiresAdmin"]
    rStats["/admin/stats → AdminStats"]
    rUsers["/admin/users → AdminUsers"]
    rArts["/admin/articles → AdminArticles"]
    rCmts["/admin/comments → AdminComments"]
    rReps["/admin/reports → AdminReports"]
  end

  subgraph COMP[组件]
    card["ArticleCard\n已赞态来自 likedStore"]
    editorComp["ArticleEditorView\n新建+编辑共用"]
    clist["CommentList\n内含 Pagination"]
    ceditor["CommentEditor 主评论框"]
    pag["Pagination\n@change 翻页 不 watch"]
    header["AppHeader\n监听 AUTH_CLEARED_EVENT\n未读红点来自 notificationStore"]
    followsComp["UserFollowsView\n粉丝/关注列表 复用 Pagination"]
    profileComp["UserProfileView\n关注按钮 + 主页入口 + 收藏/系列 Tab"]
    badge["UserBadge 管理员徽章"]
    toc["ArticleToc 侧边目录"]
    adminSide["AdminLayout 侧边栏"]
  end

  subgraph STORE[Store]
    liked["likedStore\n已赞 id 集合 Set"]
    following["followingStore\n已关注 id 集合 Set"]
    user["userStore\nsetToken 联动 reset"]
    bookmarks["bookmarksStore\n已收藏 id 集合 Set"]
    notification["notificationStore\n未读数 + 30s 轮询"]
  end

  rSettings --- rPwd
  rSettings --- rProfile
  rEditor --> editorComp
  rEditorId --> editorComp
  rAdmin --- rStats
  rAdmin --- rUsers
  rAdmin --- rArts
  rAdmin --- rCmts
  rAdmin --- rReps

  rHome --> card
  rUser --> card
  rDetail --> card
  rDetail --> clist
  rDetail --> toc
  card --> pag
  clist --> pag
  clist --> ceditor

  card --> liked
  header --> liked
  header --> user
  header --> notification
  user -->|setToken 触发 reset| liked
  user -->|setToken 触发 reset| following
  user -->|setToken 触发 reset| bookmarks
  header -. "监听 AUTH_CLEARED_EVENT\n→ setToken('')" .-> user

  rFollows --> followsComp
  rUser --> profileComp
  followsComp --> pag
  profileComp --> following
  header -. "ensureLoaded(user.id)\n按钮初始态 + 主页计数" .-> following
  profileComp --> bookmarks
  rStats --> adminSide
  rUsers --> adminSide
  rArts --> adminSide
  rCmts --> adminSide
  rReps --> adminSide
  profileComp --> badge
```
