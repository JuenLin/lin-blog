# 接口文档

> 前后端契约冲突时，以本文件为准（契约第 13 节第 15 条）。  
> 通用约定见 `docs/AI_CONTRACT.md` 第 5、6 节；业务码、HTTP 状态码以契约第 6 节为准。

- 接口前缀：`/api`
- 数据格式：JSON，UTF-8
- 鉴权方式：`Authorization: Bearer <token>`
- 统一响应：成功 `{ code: 0, message: "ok", data: ... }`，失败 `{ code: 非0, message: "...", data: null }`

## 业务码

| code  | 含义            |
| ----- | ------------- |
| 0     | 成功            |
| 40000 | 参数错误          |
| 40100 | 未登录或 token 无效 |
| 40101 | 账号已封禁         |
| 40300 | 无权限           |
| 40400 | 资源不存在         |
| 40900 | 资源冲突          |
| 50000 | 服务器错误         |

---

## 通用接口（已实现）

本节含健康检查与认证类接口：`GET /api/health`、`POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`PUT /api/auth/password`。

### GET /api/health

健康检查，**无需登录**。不查数据库，只反映服务进程本身存活。

请求参数：无

响应 `data`：

```json
{
  "status": "ok",
  "timestamp": "2026-09-29T12:51:23.771Z",
  "uptime": 3
}
```

| 字段        | 类型     | 说明                   |
| --------- | ------ | -------------------- |
| status    | string | 固定 `ok`              |
| timestamp | string | 服务端当前时间，ISO 8601 UTC |
| uptime    | number | 进程已运行秒数，取整           |

---

### POST /api/auth/register

注册。**无需登录**。

请求体：

| 字段       | 类型     | 必填 | 校验                      |
| -------- | ------ | -- | ----------------------- |
| username | string | 是  | 3–50 字符，唯一              |
| password | string | 是  | 6–100 字符，bcryptjs 加密后入库 |
| nickname | string | 否  | 最多 50 字符                |

```json
{
  "username": "demo",
  "password": "123456",
  "nickname": "Demo"
}
```

成功：HTTP 201

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "username": "demo",
    "nickname": "Demo",
    "createdAt": "2026-09-29T12:49:05.911Z"
  }
}
```

失败：

| HTTP | code  | 场景                          |
| ---- | ----- | --------------------------- |
| 400  | 40000 | zod 校验不通过，`message` 为具体字段错误 |
| 409  | 40900 | 用户名已存在                      |

---

### POST /api/auth/login

登录。**无需登录**。

请求体：

| 字段       | 类型     | 必填 | 校验       |
| -------- | ------ | -- | -------- |
| username | string | 是  | 1–50 字符  |
| password | string | 是  | 1–100 字符 |

```json
{
  "username": "demo",
  "password": "123456"
}
```

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "token": "<jwt>",
    "user": {
      "id": 1,
      "username": "demo",
      "nickname": "Demo",
      "createdAt": "2026-09-29T12:49:05.911Z"
    }
  }
}
```

JWT payload：

```json
{
  "userId": 1,
  "username": "demo"
}
```

过期时间取自环境变量 `JWT_EXPIRES_IN`，默认 `7d`。

失败：用户名不存在或密码错误一律返回 **HTTP 401 / code 40100**，message 统一为「用户名或密码错误」，不区分具体原因。

**封禁账号的登录**（第 5 批）：密码校验**通过后**发现 `status = BANNED` → **HTTP 401 / code 40101**「账号已封禁」。判断顺序刻意放在密码比对之后：输错密码只得到「用户名或密码错误」，输对才提示封禁（轻微泄露「此账号已封禁」，但攻击者需已知用户名 + 正确密码，换取正常用户的封禁提示，值）。

---

### GET /api/auth/me

获取当前登录用户。**需要登录**。

请求头：

```text
Authorization: Bearer <token>
```

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "username": "demo",
    "nickname": "Demo",
    "avatar": null,
    "bio": null,
    "role": "USER",
    "createdAt": "2026-09-29T12:49:05.911Z"
  }
}
```

`avatar` / `bio` 为第九批新增字段，**本接口现已稳定返回这两个键**（示例中为 `null`）。必须返回，否则前端无法在登录后立即拿到用户资料。`role` 为第 5 批新增（`USER` / `ADMIN`），供前端渲染管理员徽章与管理端入口；**`status` 不透出**，封禁态只通过 401 / 40101 表现。

失败：

| HTTP | code  | 场景                                |
| ---- | ----- | --------------------------------- |
| 401  | 40100 | 未提供 token、token 格式错、token 过期或签名无效 |
| 401  | 40101 | 账号已封禁（token 本身有效，但 `status = BANNED`，旧 token 即刻失效） |
| 404  | 40400 | token 有效但用户不存在（已删除等）              |

---

### PUT /api/auth/password

修改当前登录用户的密码。**需要登录**。身份完全取自 token。

放在 `/api/auth/` 下而非 `/api/users/`：这是**认证凭据变更**，不是资料编辑，与下方「用户接口（其余未实现）」是两类事。

请求头：

```text
Authorization: Bearer <token>
```

请求体：

| 字段          | 类型     | 必填 | 校验                                                    |
| ----------- | ------ | -- | ----------------------------------------------------- |
| oldPassword | string | 是  | 1–100 字符，原样比对，不 trim（密码首尾空格有意义）                       |
| newPassword | string | 是  | 6–100 字符，不 trim；UTF-8 编码后不超过 72 字节；不得与 oldPassword 相同 |

```json
{
  "oldPassword": "old-pass-123",
  "newPassword": "new-pass-456"
}
```

**不接受** `userId` / `id` / `username`：身份只能来自 token。携带这三个字段一律报 40000，不做静默忽略（静默忽略会让调用方误以为参数生效了）。

> 72 字节上限说明：bcrypt 的经典实现只取密码前 72 字节，超出部分被**静默丢弃**。若不在入口拦截，一个 72 字节之后的字符根本不参与哈希计算，攻击者提交前 72 字节即可通过校验。
>
> 长度上限 100 与 `POST /api/auth/register` 的 `password` 规则严格一致，避免出现「能注册却不能改成同一个密码」的情况。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "密码已修改",
  "data": null
}
```

`data` 固定为 `null`，**不返回新 token** —— 旧 token 判定为仍然有效（见下方「旧 token 语义」），发新 token 会让人误以为旧的已失效。

失败：

| HTTP | code  | message      | 场景                                                                                                                   |
| ---- | ----- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| 400  | 40000 | 依据具体字段       | oldPassword 为空 / newPassword 少于 6 个字符 / newPassword 超过 100 个字符 / newPassword 超过 72 字节 / newPassword 与 oldPassword 相同 |
| 400  | 40000 | 不允许修改其他用户的密码 | 请求体携带 `userId` / `id` / `username`                                                                                   |
| 401  | 40100 | 用户名或密码错误     | oldPassword 与当前密码不匹配（含「用户不存在」，不区分以免成为账号枚举接口）                                                                         |
| 401  | 40100 | —            | 未提供 token、token 格式错、token 过期或签名无效（`auth` 中间件既有行为）                                                                    |
| 404  | 40400 | 用户不存在        | token 有效但用户不存在（已删除等），与 `GET /api/auth/me` 口径一致                                                                       |
| 500  | 50000 | —            | 未预期错误                                                                                                                |

本接口**不新增业务码**，全部复用既有的 40000 / 40100 / 40400 / 50000。

> 注：`newPassword` 与 `oldPassword` 是否相同这条校验**只能在服务端做**。前端拿不到当前密码的哈希，无法可靠判断；前端只做长度与「两次输入一致」的即时校验。

### 旧 token 语义

**旧 token 语义**：修改密码后，服务端**不强制失效已签发的 token**。此前签发的 token 在其 `JWT_EXPIRES_IN`（默认 `7d`）到期前仍然有效。

原因：JWT载荷为 `{ userId, username }`，不含密码版本号，`auth` 中间件只校验签名与过期时间。服务端要主动失效需引入版本号或黑名单，属额外机制，本期不做。

**前端约定**：修改成功后应**清除本地 token 并跳转登录页**。这是客户端行为约定，不构成安全保证 —— 其他设备上已登录的会话仍会保持有效，直到 token 自然过期。如需立即失效所有会话，属后续需求。

---

## 业务接口

### 通用约定（业务部分）

- 作者身份一律从 token 解析，**不接受请求体中的 `userId` / `authorId`**。
- 删除为软删除（设置 `deletedAt`），列表与详情自动过滤已删除数据（契约 §9 删除小节）。
- 分页沿用契约 §7：入参 `page` / `pageSize` / `sortBy` / `order`，返回 `{ list, page, pageSize, total, totalPages }`。
- `sortBy` 白名单：文章 `createdAt` / `updatedAt` / `id` / `likeCount`，默认 `createdAt desc`；评论 `createdAt` / `id`，默认 `createdAt desc`。
- **排序一律在数据库层完成**（SQL 的 `ORDER BY` + `LIMIT/OFFSET`），不是拉全量再在应用层排。`likeCount` 是计算字段（不是 `articles` 的列），它的排序由 Prisma 的关联计数排序表达，同样编译进单条 SQL（「热门」Tab 引入，详见 `GET /api/articles` 的 `sortBy` 说明与 `docs/DB.md`「按点赞数排序」）。
- 排序值并列时**自动追加次级排序 `id`**（同 `order` 方向），保证分页稳定 —— 否则同一批数据在相邻两页可能重复出现或整行丢失（见 `backend/src/utils/query.js` 的 `DEFAULT_SECONDARY_SORT`）。
- 文章列表支持 `keyword` 模糊搜索，命中范围为**标题 + 正文**（不含作者昵称），详见 `GET /api/articles`。
- 文章列表支持 `category` 分类筛选（枚举 `技术` / `生活` / `随笔` / `未分类`），详见 `GET /api/articles`。`category` 与 `keyword` **正交、可叠加**：切分类保留当前 keyword，切 keyword 保留当前 category；非法 `category` 返回 `400 / 40000`。
- 时间字段返回 ISO 8601 UTC 字符串（契约 §9 时间小节）。
- 文章详情页需要显示评论数时，用 `GET /api/articles/:id/comments` 返回的 `total`；不额外开接口，不在文章表加冗余字段。
- **文章的点赞数 `likeCount` 由 `likes` 表实时 `COUNT(*)` 得出**（第十批），同样不在 `articles` 表加冗余列。列表与详情都返回它；**不返回 `liked`（当前用户是否已赞）**，原因见 `POST /api/articles/:id/like`。已登录用户想拿 `liked`，另调 `GET /api/articles/:id/liked`（需登录），列表 / 详情的返回结构不受影响。它同时也是 `sortBy` 的合法值（「热门」Tab 按它倒序），语义见 `GET /api/articles`。
- 作者信息以**内嵌 `author` 对象**（`id` / `username` / `nickname` / `avatar` / `role`）返回，不依赖用户接口。`avatar` 为第九批新增，语义与 `PUT /api/users/me` 的三态一致（可能为 `null`）；`bio` **不在** `author` 内，仅在 `PUT /api/users/me` 与个人主页相关位置返回。`role` 为第 5 批新增（`USER` / `ADMIN`），供前端渲染管理员徽章与管理端入口；**`status` 不在 `author` 内**，封禁态只通过 401 / 40101 表现。
- **`role` 透出（第 5 批）**：`role` 同时进入 `toPublicUser`（`auth.service.js` 与 `user.service.js` 两份重复定义都加）与 `AUTHOR_SELECT`（`article.service.js` 与 `comment.service.js` 两份都加），因此 `GET /api/auth/me`、`GET /api/users/:id`、登录 / 注册响应的 `user`、所有文章 / 评论列表项的内嵌 `author` 都带 `role`。沿用第九批 `avatar` 的「只加字段、不做重构」先例，两份重复定义的抽取单独排批。
- **`avatar` 只有一种形态**（外链下线后）：**站内相对路径** `/uploads/avatars/{userId}/{filename}`，由 `POST /api/users/me/avatar` 上传产生。它可能出现在 `author` 内嵌对象里。**前端渲染时必须补上后端 origin**，规则见文末「前端调用约定」。
  - 演变史（三批）：第九批引入 `avatar` 时是「用户自填的外链 URL」；第十一批加上传能力，**两种并存**；**本次把外链下线**，只留站内上传。`avatar` 的**列定义**（`VARCHAR(255) NULL`）与 `null`（未设头像）语义**三批都没变过**。
- 作者被软删除时，MVP 阶段文章保留、`author` 正常返回；更细的处理策略（作者注销后文章是否可见）留到后续需求评估。

- **文章发布状态 `status`（第 6 批）**：枚举 `DRAFT` / `PUBLISHED`，默认 `PUBLISHED`。**草稿（`DRAFT`）是完整的 `articles` 行**，仅在作者自己的「草稿箱」（`GET /api/users/me/drafts`）可见；公开广场列表（`GET /api/articles`）默认只返回 `PUBLISHED`，已软删与草稿一律不出现。公开详情（`GET /api/articles/:id`）遇 `DRAFT` **一律返回 `404`**（不分作者与否，草稿不通过公开详情暴露）——刻意与软删同口径（404 而非 403），避免泄露草稿存在性。个人主页计数与文章列表（`GET /api/users/:id`、`GET /api/users/:id/articles`）**只统计 `PUBLISHED`**。管理端文章列表可额外按 `status` 筛选（含草稿）。
- **用户主页接口（第 2 批）**：`GET /api/users/:id`（详情 + 计数）、`GET /api/users/:id/articles`（文章 Tab）、`GET /api/users/me/likes`（点赞 Tab，仅本人）。**前两个无需登录，第三个必须登录**。用户不存在或已软删一律 `404 / 40400`。
- **用户主页的计数一律实时 `COUNT(*)`**：`articleCount` / `receivedLikeCount` / `receivedCommentCount` 三个数字都不落 `users` 冗余列，与文章 `likeCount` 同一纪律；且**只统计未软删的文章及其上的记录**（作者删文后计数下降是预期行为）。**本批零 schema 变更**。
- **「用户不存在」与「用户没发过文章」是两个状态**：用户存在但 0 篇文章时，`GET /api/users/:id/articles` 返回 `200` + 空 `list` + `total: 0`，**不是 404**。前端据此渲染空态，不要把整页判成不存在。

### 接口清单

| 方法     | 路径                         | 说明                                                | 登录 |
| ------ | -------------------------- | ------------------------------------------------- | -- |
| PUT    | /api/auth/password         | 修改当前用户密码（详见通用接口一节）                                | 是  |
| PUT    | /api/users/me              | 修改当前用户资料（简介；`avatar` 只能传 `null` 清空，**设置头像走上传接口**） | 是  |
| POST   | /api/users/me/avatar       | 上传头像（multipart，详见业务接口一节）                          | 是  |
| POST   | /api/articles              | 发布文章                                              | 是  |
| GET    | /api/articles              | 博客广场列表                                            | 否  |
| GET    | /api/articles/:id          | 文章详情                                              | 否  |
| PUT    | /api/articles/:id          | 编辑文章（仅作者）                                         | 是  |
| DELETE | /api/articles/:id          | 删除文章（仅作者，软删除）                                     | 是  |
| POST   | /api/articles/:id/like     | 点赞文章（可对自己的文章点赞）                                   | 是  |
| DELETE | /api/articles/:id/like     | 取消点赞                                              | 是  |
| GET    | /api/articles/:id/liked    | 查询当前用户是否已点赞该文章（刷新后取按钮态）                           | 是  |
| POST   | /api/comments              | 发表评论                                              | 是  |
| GET    | /api/articles/:id/comments | 文章评论列表                                            | 否  |
| DELETE | /api/comments/:id          | 删除评论（评论作者或文章作者，软删除）                           | 是  |
| GET    | /api/users/:id             | 用户详情（含文章数 / 获赞数 / 评论数）                            | 否  |
| GET    | /api/users/:id/articles    | 该用户发布的文章列表（真后端分页）                                 | 否  |
| GET    | /api/users/me/likes        | 我点赞过的文章列表（分页，**仅本人**）                             | 是  |
| POST   | /api/users/:id/follow      | 关注用户（需登录，幂等；不能关注自己）                            | 是  |
| DELETE | /api/users/:id/follow      | 取消关注（需登录，幂等；未关注也返回 200）                         | 是  |
| GET    | /api/users/:id/followers   | 粉丝列表（关注 :id 的人，公开）                                  | 否  |
| GET    | /api/users/:id/following   | 关注列表（:id 关注的人，公开）                                   | 否  |
| GET    | /api/admin/stats           | 管理端数据概览（6 个实时 COUNT，需 ADMIN）                          | 是  |
| GET    | /api/admin/users           | 管理端用户列表（分页 / 搜索 / 状态筛选，需 ADMIN）                      | 是  |
| PATCH  | /api/admin/users/:id/status | 封禁 / 解禁用户（幂等；ADMIN 不可操作，需 ADMIN）                     | 是  |
| GET    | /api/admin/articles        | 管理端文章列表（含软删，可筛选，需 ADMIN）                          | 是  |
| DELETE | /api/admin/articles/:id     | 管理端删除文章（软删，无视作者，需 ADMIN）                          | 是  |
| GET    | /api/admin/comments        | 管理端评论列表（含软删，可筛选，需 ADMIN）                          | 是  |
| DELETE | /api/admin/comments/:id     | 管理端删除评论（软删，无视作者，需 ADMIN）                          | 是  |
| POST   | /api/articles/auto-save     | 自动保存草稿（新建 / 更新；可带 sourceArticleId 校验归属，需登录）           | 是  |
| GET    | /api/users/me/drafts        | 我的草稿箱列表（仅本人草稿，需登录）                                    | 是  |
| DELETE | /api/users/me/drafts/:id    | 删除指定草稿（仅作者，需登录）                                      | 是  |
| GET    | /api/articles/:id/revisions | 文章版本历史（全量 content；仅作者，需登录）                           | 是  |
| POST   | /api/articles/:id/restore   | 回滚到指定版本（先快照当前版，仅作者，需登录）                           | 是  |

---

### POST /api/articles

发布文章。**需要登录**。作者取 token 中的 `userId`。

请求体：

| 字段       | 类型     | 必填 | 校验                                                                |
| -------- | ------ | -- | ----------------------------------------------------------------- |
| title    | string | 是  | 1–100 字符，trim，不能为纯空格                                              |
| content  | string | 是  | 1–20000 字符                                                        |
| category | string | 否  | 枚举 `技术` / `生活` / `随笔` / `未分类`；**省略时默认 `未分类`**；非法值返回 `400 / 40000` |
| status   | string | 否  | 枚举 `DRAFT` / `PUBLISHED`；**省略时默认 `PUBLISHED`**（即「发布」）；传 `DRAFT` 则创建一篇仅作者可见的草稿 |

> 备注：`content` 的数据库类型为 `MEDIUMTEXT`（见 `docs/DB.md`），不影响本接口契约。

```json
{
  "title": "我的第一篇博客",
  "content": "正文……",
  "category": "技术"
}
```

> `category` 省略时后端填入默认值 `未分类`；`"category": "未分类"` 与省略等价。

> `status` 省略或传 `PUBLISHED` 都是发布；传 `DRAFT` 创建草稿（仅作者「草稿箱」可见，不进广场）。自动保存草稿请走 `POST /api/articles/auto-save`，本接口是「直接发布」入口。


成功：HTTP 201

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "title": "我的第一篇博客",
    "content": "正文……",
    "category": "技术",
    "author": { "id": 1, "username": "demo", "nickname": "Demo", "avatar": null },
    "likeCount": 0,
    "createdAt": "2026-09-29T14:00:00.000Z",
    "updatedAt": "2026-09-29T14:00:00.000Z"
  }
}
```

> 新建文章的 `likeCount` **恒为 0**（`likes` 表里还没有任何行）。这里显式返回 0 而不是省略该键 ——
> 文章对象在任何接口里都带 `likeCount`，前端不需要区分「接口没返回」和「确实是 0」。

失败：

| HTTP | code  | 场景                          |
| ---- | ----- | --------------------------- |
| 400  | 40000 | zod 校验不通过，`message` 为具体字段错误 |
| 401  | 40100 | 未提供 token、token 无效或过期       |

---

### GET /api/articles

博客广场列表。**无需登录**。

查询参数：

| 字段       | 类型     | 必填 | 校验                                                  |
| -------- | ------ | -- | --------------------------------------------------- |
| page     | number | 否  | 默认 1                                                |
| pageSize | number | 否  | 默认 10，最大 100                                        |
| sortBy   | string | 否  | 白名单 `createdAt` / `updatedAt` / `id` / `likeCount`，默认 `createdAt` |
| order    | string | 否  | `asc` 或 `desc`，默认 `desc`                            |
| keyword  | string | 否  | 标题 + 正文模糊搜索；trim 后最长 50 字符，**空串或纯空白视为不搜索（等价于不传）**，返回全量列表       |
| category | string | 否  | 分类筛选，枚举 `技术` / `生活` / `随笔` / `未分类`；非法值返回 `400 / 40000`；**不传或传空串视为不过滤（返回全部分类）** |

`sortBy` 语义：

- `createdAt` / `updatedAt` / `id` 直接映射 `articles` 表的真实列。
- **`likeCount`（「热门」）**：按 `likes` 表对该文章的**累计点赞条数**排序。口径是 **all-time**——不做时间窗衰减、不引入阅读量（`docs/DB.md`「按点赞数排序」）。0 赞的文章也参与排序（聚合为 `NULL` 时按 `0` 处理），不会从列表里消失。
- **次级排序**：排序值并列时追加 `id`（同 `order` 方向）。`likeCount` 大量并列（多数文章都是 0 赞）时这条尤其重要，否则翻页会重复/丢行。
- **非法值**：不在白名单内返回 `400 / 40000`，message 形如 `sortBy 不合法，可选值：createdAt, updatedAt, id, likeCount`。**大小写敏感**（`likecount` 不合法）。
- **性能**：`likeCount` 排序会让查询带上 `LEFT JOIN` 聚合派生表并走 `Using temporary; Using filesort`（按聚合值排序不可避免）。当前数据量下无感，量级上来后这里是第一个瓶颈——取舍与实测 EXPLAIN 见 `docs/DB.md`「按点赞数排序」。

`keyword` 语义（三条，逐条都有验收断言）：

- **匹配范围**：对 `title` 与 `content` 做 `LIKE '%keyword%'` 模糊匹配，任一命中即返回该文章（`OR`）。**不匹配作者昵称 / 用户名** —— 作者维度筛选不在本期范围。
- **空串或纯空白视为不搜索**：`keyword=`（空串）、只含空白字符（如 `keyword=%20%20`）、或该参数完全不传，**三种情况等价**，都返回全量列表而非报错。前端清空搜索框时会发空串，不做这个容错会 400。
- **超长报错**：trim 后超过 50 字符返回 `400 / 40000`，message 为 `keyword 最多 50 个字符`。
- 与 `page` / `pageSize` / `sortBy` / `order` **正交**：搜索结果同样参与分页与排序，`total` 是命中总数而非全库总数。
- 已软删除的文章不参与搜索（与列表、详情口径一致）。

`category` 语义（与 `keyword` 正交、可叠加）：

- **筛选范围**：对 `articles.category` 做精确相等匹配（`WHERE category = ?`），命中即返回该分类下的文章。**不做模糊匹配**——分类是固定枚举，模糊匹配无意义。
- **空串或纯空白 / 不传视为不过滤**：`category=`、`category=%20%20`、或不传，三种情况等价，都返回全部分类（含 `未分类`）的文章，而非报错。前端清空筛选器时会发空串，不做容错会 400。
- **与 `keyword` 正交、可叠加**：`?keyword=Vue&category=技术` 同时生效（`title/content LIKE '%Vue%'` **且** `category='技术'`）。前端交互要求——**切分类保留当前 keyword，切 keyword 保留当前 category**，两者互不清掉对方。
- **与分页 / 排序正交**：分类筛选结果同样参与分页与排序，`total` 是「该分类 + 该 keyword」的命中总数。
- **非法值**：不在枚举内（如 `category=美食`、`category=tech`）返回 `400 / 40000`，message 形如 `category 不合法，可选值：技术, 生活, 随笔, 未分类`。**大小写敏感**（`技术` 是全角中文，不存在大小写问题；但若日后扩展英文枚举需注意）。
- **不建索引**：`category` 是低基数列，MVP 数据量下全表扫描无感，筛选在 service 层拼 `where.category = x`，不引入索引（理由见 `docs/DB.md`「category 分类列」小节）。

- **只返回已发布（`status = PUBLISHED`）**：本接口是公开广场，**不暴露 `status` 过滤参数**，永远只返回 `PUBLISHED` 的文章；草稿（`DRAFT`）与已软删文章都不出现。这是第 6 批新增的默认过滤，不影响现有调用方（它们 `POST` 文章时不带 `status`，默认即 `PUBLISHED`）。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [
      {
        "id": 1,
        "title": "我的第一篇博客",
        "summary": "正文前 100 字……",
        "category": "技术",
        "author": { "id": 1, "username": "demo", "nickname": "Demo", "avatar": null },
        "likeCount": 3,
        "createdAt": "2026-09-29T14:00:00.000Z",
        "updatedAt": "2026-09-29T14:00:00.000Z"
      }
    ],
    "page": 1,
    "pageSize": 10,
    "total": 1,
    "totalPages": 1
  }
}
```

| 字段               | 类型     | 说明                                 |
| ---------------- | ------ | ---------------------------------- |
| list[].summary   | string | 后端截取 `content` 前 100 字符，列表不返回全文    |
| list[].category  | string | 文章分类，枚举 `技术` / `生活` / `随笔` / `未分类`；后端白名单保证一定在这 4 个值内 |
| list[].author    | object | 作者 `id` / `username` / `nickname`  |
| list[].likeCount | number | 该文章的点赞数（第十批新增），实时 `COUNT(*)`；不含 `liked`（已登录用户改调 `GET /api/articles/:id/liked`） |

- `likeCount` 是**实时统计**而非冗余字段：由 `likes` 表 `COUNT(*)` 得出，不在 `articles` 表存列，因此永远不会与真实点赞数不一致。
- 列表**不返回 `liked`**（当前用户是否已赞）。这两个接口无需登录，若要在它们里区分「当前用户是否已赞」，就必须给 `auth` 中间件加「token 无效也不报错」的可选模式 —— 那会改动所有接口共用的中间件，影响面超出点赞功能本身。改由独立接口 `GET /api/articles/:id/liked`（需登录）提供，列表与详情本身不动。详见 `POST /api/articles/:id/like` 的「为什么不返回 `liked`」。

`summary` 为原始 `content` 截取，可能包含 Markdown 标记，前端负责渲染时清理。

失败：400 / 40000（分页参数非法，或 `keyword` 超长 / 格式非法，或 `category` 非法值）。

---

### GET /api/articles/:id

文章详情。**无需登录**。返回全文。

路径参数：`id`，正整数。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "title": "我的第一篇博客",
    "content": "正文……",
    "category": "技术",
    "author": { "id": 1, "username": "demo", "nickname": "Demo", "avatar": null },
    "likeCount": 3,
    "createdAt": "2026-09-29T14:00:00.000Z",
    "updatedAt": "2026-09-29T14:00:00.000Z"
  }
}
```

`likeCount` 与列表口径一致（实时 `COUNT(*)`），同样**不返回 `liked`** —— 详情页刷新后要还原按钮态，由前端在已登录时调 `GET /api/articles/:id/liked`。`category` 为文章的分类枚举值。

失败：

| HTTP | code  | 场景         |
| ---- | ----- | ---------- |
| 400  | 40000 | id 非正整数    |
| 404  | 40400 | 文章不存在或已软删除 |
| 404  | 40400 | 文章是草稿（`DRAFT`），公开详情不暴露草稿 |

> 第 6 批起：草稿（`DRAFT`）通过公开详情返回 **404**（与「不存在」同口径），不区分请求者是否为作者——草稿只通过 `GET /api/users/me/drafts` 暴露给作者本人。

---

### PUT /api/articles/:id

编辑文章。**需要登录，且必须是作者本人**。全量更新，`title` 与 `content` 都必填。

路径参数：`id`，正整数。请求体同 `POST /api/articles`（含可选 `category` 与可选 `status`）。`status` 省略=保留原值；传 `DRAFT`/`PUBLISHED` 显式切换。

**`category` 在 PUT 下的三态语义**（与 `PUT /api/users/me` 的 `avatar`/`bio` 区分「不传 / 传非法值 / 传合法值」逻辑一致，但语义更简单）：

| 请求体写法 | 含义 | 存储结果 |
|---|---|---|
| 字段**不出现** | **保留原值** | 文章 `category` 保持库中原值不变（用户只想改标题/正文时分类不动） |
| `"category": "技术"`（合法枚举） | **设置** | 写入该分类 |
| `"category": "美食"`（非法值） | 报错 | 返回 `400 / 40000`，不更新任何字段（与 title/content 校验同一口径） |

> 与 `POST` 的「省略默认 `未分类`」不同：`PUT` 的省略是**保留原值**（因为文章已经有分类了，不该因没传就被改回 `未分类`）。实现上：`category` 用 zod `.optional()` —— 缺失时得到 `undefined`，**跳过该字段**；传入时再按枚举白名单校验。
> 成功响应（`data` 结构同「文章详情」）会带更新后的 `category`。

> **版本快照（第 6 批）**：当目标文章**更新前**的状态为 `PUBLISHED` 时，后端会先把它的当前 `title`/`content`/`category` 存入 `article_revisions` 表（生成一条版本历史），再应用本次更新——这就是「版本历史 / 回滚」的数据来源。若目标更新前是 `DRAFT`（例如把一篇草稿 `PUT` 成 `PUBLISHED` 来「发布」），则**不快照**（草稿本身不进版本历史）。详见 `GET /api/articles/:id/revisions` 与 `POST /api/articles/:id/restore`。

成功：HTTP 200，`data` 结构同「文章详情」（更新后的内容）。

失败：

| HTTP | code  | 场景               |
| ---- | ----- | ---------------- |
| 400  | 40000 | id 非法或 zod 校验不通过 |
| 401  | 40100 | 未登录或 token 无效    |
| 403  | 40300 | 不是作者本人           |
| 404  | 40400 | 文章不存在或已软删除       |

判断顺序：**先查文章是否存在（不存在返回 404），再判断是否为作者（非作者返回 403）**。不得先判断作者，避免通过 403 / 404 的差异枚举真实存在的文章 id。

---

### DELETE /api/articles/:id

删除文章。**需要登录，且必须是作者本人**。软删除（设置 `deletedAt`）。

成功：HTTP 200，`data` 为 `null`。

失败：

| HTTP | code  | 场景                |
| ---- | ----- | ----------------- |
| 400  | 40000 | id 非正整数           |
| 401  | 40100 | 未登录或 token 无效     |
| 403  | 40300 | 不是作者本人            |
| 404  | 40400 | 文章不存在或已软删除（含重复删除） |

判断顺序：**先查文章是否存在（不存在返回 404），再判断是否为作者（非作者返回 403）**。不得先判断作者，避免通过 403 / 404 的差异枚举真实存在的文章 id。

删除后，该文章的评论数据保留，但随文章一起不可见。

---

### POST /api/articles/:id/like

点赞文章。**需要登录**。点赞者取 token 中的 `userId`，不接受请求体里的身份字段。

路径参数：`id`，正整数。**无请求体**（传了也忽略，不校验、不报错）。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "已点赞",
  "data": {
    "liked": true,
    "likeCount": 4
  }
}
```

| 字段                | 类型      | 说明                                    |
| ----------------- | ------- | ------------------------------------- |
| data.liked        | boolean | 恒为 `true`（点赞后的状态）                     |
| data.likeCount    | number  | **点赞后**的总数，已包含本次这一票                   |

失败：

| HTTP | code  | message        | 场景                       |
| ---- | ----- | -------------- | ------------------------ |
| 400  | 40000 | id 非正整数        | 路径参数非法                   |
| 401  | 40100 | 未登录或 token 无效  | 未提供 token、token 无效或过期    |
| 404  | 40400 | 文章不存在          | 文章不存在**或已被软删除**          |
| 409  | 40900 | 已点赞过这篇文章       | 同一用户对同一文章重复点赞            |

判断顺序：**先校验路径参数 → 再鉴权（401）→ 再判定文章存在性（404）→ 最后才写库**。与 `DELETE /api/articles/:id` 一致，**文章不存在必须先于任何写操作返回**，不得先写后回滚。

**允许给自己的文章点赞**。理由：① 技术上无任何约束障碍（唯一约束只管「同一人不能重复赞」）；② 小红书 / 掘金 / 知乎等主流平台均允许，楼主给自己文章点赞是常见行为；③ 禁止反而会让「用户给自己发的文章点赞做功能验证」这个正常场景失败。

#### 幂等与并发：唯一约束是唯一真相

`likes` 表有唯一约束 `likes_user_id_article_id_key (user_id, article_id)`。**并发下的重复点赞只能由数据库拦截**，应用层的「先查是否已赞再插入」存在竞态窗口 —— 两个并发请求都在对方写入前查到「未赞过」，然后都会执行 INSERT。

因此实现必须是：

1. 直接 `create`，捕获 Prisma 的 `P2002`（底层是 MySQL `1062`）→ 转 `409 / 40900`。
2. **不允许把「先查后写」当作正确性保障**。它最多用来给出更友好的提示，真正的拦截靠唯一约束。

> 该约束已在数据库层实测：重复插入报 `1062 Duplicate entry '1-7' for key 'likes.likes_user_id_article_id_key'`
> （见 `docs/DB.md`「likes」小节的「约束实测」）。本接口要做的只是把这个错误翻译成 409。

`40900`（资源冲突）是**既有业务码**，此前用于「用户名已存在」，本接口复用它，**不新增业务码**。

#### 为什么不返回 `liked`（列表 / 详情接口）

`GET /api/articles` 与 `GET /api/articles/:id` **都是无需登录的公开接口**。若在它们里返回 `liked`，就必须判断「请求带没带 token、token 是否对应某个真实用户」—— 而本项目的 `auth` 中间件是强制 401 的，没有「可选认证」这个模式。

给 `auth` 加可选模式能解决这个问题，但**改的是所有接口共用的中间件**，影响面超出点赞这一项功能。按 `docs/AI_CONTRACT.md` 第 13 节第 21 条（发现契约 / API / DB 三边冲突，或涉及公共文件改动时，先列出影响范围等确认），这一项**留待单独排批**。因此本批采用：

- 列表 / 详情**只返回 `likeCount`，不返回 `liked`**；
- `liked` 由本接口与 `DELETE` 接口的**响应**给出；
- 已登录用户**刷新详情页后要拿回按钮态**，走独立接口 `GET /api/articles/:id/liked`（需登录，见同名小节）。

> 上面第 3 条是对「已知代价」的收口。此前已点赞的用户刷新详情页后，按钮仍显示「未赞」态（`likeCount` 是对的，只有按钮态不准，此时再点一次会收到 `409`）。该问题已由 `GET /api/articles/:id/liked` 解决，**列表 / 详情的返回结构与 `auth` 中间件都未改动**。

---

### DELETE /api/articles/:id/like

取消点赞。**需要登录**。

路径参数：`id`，正整数。**无请求体**。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "已取消点赞",
  "data": {
    "liked": false,
    "likeCount": 3
  }
}
```

| 字段             | 类型      | 说明                |
| -------------- | ------- | ----------------- |
| data.liked     | boolean | 恒为 `false`        |
| data.likeCount | number  | **取消后**的总数，已扣除这一票 |

失败：

| HTTP | code  | message       | 场景              |
| ---- | ----- | ------------- | --------------- |
| 400  | 40000 | id 非正整数       | 路径参数非法          |
| 401  | 40100 | 未登录或 token 无效 | 未提供 token、token 无效或过期 |
| 404  | 40400 | 文章不存在         | 文章不存在或已被软删除     |
| 404  | 40400 | 还没有点赞过这篇文章    | 用户此前未点赞，或已取消过   |

判断顺序同 `POST`：参数 → 鉴权 → 文章存在性 → 写库。

**取消点赞未点赞过的文章返回 404 而非 204**：这两个状态在语义上不同 —— 「文章不存在」和「你没赞过」都是调用方的错误假设，静默成功会让前端无法区分「已取消」与「本来就没赞」。

#### 为什么是物理 DELETE 而不是软删

`likes` 表**不设 `deleted_at`**（与 `articles` / `comments` 不同，是刻意设计，理由见 `docs/DB.md`）：

- 点赞是**一个动作**，不是一条可隐藏的内容，没有「隐藏但保留」的语义；
- 若做软删，同一 `(user_id, article_id)` 取消后再点赞会撞唯一约束，只能改成 `UPDATE ... SET deleted_at = NULL` 而非 `INSERT`，「点赞 = 该行存在」这个不变式就不成立了。


因此取消点赞是 `DELETE FROM likes WHERE user_id = ? AND article_id = ?`，且**用 `deleteMany` 而非 `delete`** —— 后者在记录不存在时会抛 `P2025`，前者返回 `{ count }`，用 `count === 0` 判断「没赞过」更直接。

#### 软删除联动

| 场景                     | 行为                                                                          |
| ---------------------- | --------------------------------------------------------------------------- |
| 对已软删的文章点赞 / 取消点赞      | **404**（复用 `requireArticleForWrite(id)`，与发表评论同一条路径）                         |
| 文章被软删后，已有的点赞行         | **保留**，不连带删除。文章整体不可见，其 `likeCount` 不会外泄                                     |
| 点赞者被软删后，他的点赞行         | **保留，且仍计入 `likeCount`** —— 计数只按 `article_id` 过滤，不过滤点赞者。MVP 无用户删除功能故不触发，已登记在 `docs/DB.md`「已知限制」第 3 条 |

---

### GET /api/articles/:id/liked

查询**当前登录用户**对某篇文章是否已点赞。**需要登录**。用途：刷新详情页后还原点赞按钮的初始态。

路径参数：`id`，正整数。**无请求体**。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "liked": true
  }
}
```

| 字段         | 类型      | 说明               |
| ---------- | ------- | ---------------- |
| data.liked | boolean | 当前登录用户是否已点赞该文章 |

失败：

| HTTP | code  | message       | 场景                    |
| ---- | ----- | ------------- | --------------------- |
| 400  | 40000 | id 非正整数       | 路径参数非法                |
| 401  | 40100 | 未登录或 token 无效 | 未提供 token、token 无效或过期 |
| 404  | 40400 | 文章不存在         | 文章不存在**或已被软删除**       |

判断顺序同 `POST` / `DELETE`：参数 → 鉴权（401）→ 文章存在性（404）→ 查询。

#### 为什么单独开接口，而不是给列表 / 详情加 `liked`

列表 / 详情是**无需登录的公开接口**，要在它们里返回 `liked`，就必须给 `auth` 中间件加「token 无效也不报错」的可选模式 —— 那是所有接口共用的中间件，影响面超出点赞本身（理由见 `POST /api/articles/:id/like` 的「为什么不返回 `liked`」）。

本接口**不动 `auth` 一个字**：它本来就要求登录，`auth` 保持强制 401 的单一语义。同时**不改列表 / 详情的返回结构**，既有断言零影响。

#### `data` 只含 `liked`，不带 `likeCount`

调用方（文章详情页）已从 `GET /api/articles/:id` 拿到 `likeCount`。若本接口再返回一份，同一个值就有了两个来源，将来口径不一致时无法判断哪个对。保持最小响应。

#### 文章已软删返回 404，而不是 `{ liked: false }`

与 `POST` / `DELETE /:id/like` 一致（两者都先调 `requireArticleForWrite(id)`）。若返回 `{ liked: false }`，前端会渲染成「未赞 + 可点」，用户一点就吃 404，体验割裂。代价是多一次主键查询，换来三个 like 接口语义完全统一。

#### 前端接入要点

- **仅在已登录时调用**。未登录访问详情页**不发这个请求** —— `request.js` 的 401 拦截器会清 token 并跳登录页，会把匿名读者踢走。
- 调用时机：详情页 `onMounted`；切换文章时重新拉取。
- 请求失败：保持 `liked = false`，**不弹错误提示**（非关键路径）。
- 切换文章时的响应竞态：用 `articleId` 闭包比对，丢弃过期响应。
- **列表页卡片按钮态不修**：`ArticleCard` 点击时的 409 兜底仍在（已赞时点击会拿到 409 并自动修正为 `liked = true`），卡片态不准时可自愈。

---

### POST /api/comments

发表评论。**需要登录**。评论者取 token 中的 `userId`。

请求体：

| 字段        | 类型     | 必填 | 校验            |
| --------- | ------ | -- | ------------- |
| articleId | number | 是  | 正整数           |
| content   | string | 是  | 1–500 字符，trim |

成功：HTTP 201

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "articleId": 1,
    "content": "写得好",
    "author": { "id": 1, "username": "demo", "nickname": "Demo", "avatar": null },
    "createdAt": "2026-09-29T14:05:00.000Z"
  }
}
```

失败：

| HTTP | code  | 场景            |
| ---- | ----- | ------------- |
| 400  | 40000 | zod 校验不通过     |
| 401  | 40100 | 未登录或 token 无效 |
| 404  | 40400 | 文章不存在或已软删除    |

---

### DELETE /api/comments/:id

删除评论。**需要登录**。软删除（设置 `deletedAt`）。

路径参数 `id` 为正整数，由新增的 `commentIdParamSchema`（zod）校验，非法返回 40000。

成功：HTTP 200，`data` 为 `null`。

失败：

| HTTP | code  | 场景                  |
| ---- | ----- | ------------------- |
| 400  | 40000 | id 非正整数             |
| 401  | 40100 | 未登录或 token 无效       |
| 403  | 40300 | 既不是评论作者，也不是文章作者  |
| 404  | 40400 | 评论不存在或已软删除（含重复删除） |

判断顺序：**先查评论是否存在（不存在或已软删除返回 404），再判断权限（无权限返回 403）**。不得先判断权限，避免通过 403 / 404 的差异枚举真实存在的评论 id。

权限规则：评论作者 **或** 文章作者（且文章未被软删除）可删除。即 `comment.authorId === userId` ∨ (`article.authorId === userId` ∧ `article.deletedAt === null`)。

**文章已软删时的边界**：文章被作者软删除后，其评论随之不可见，但评论数据仍然存在。此时只有**评论作者本人**可删除该评论；文章作者因文章已不可见、无法定位归属，不再拥有删除权。理由：若允许文章作者删除「已软删文章下的评论」，会暴露「该文章下存在某条评论」这一信息，违背软删除不可枚举的纪律；而评论作者删除自己的评论不泄露他人内容。

删除联动：
- 评论列表（`GET /api/articles/:id/comments`）中该条评论**自动消失**——列表查询自动过滤 `deletedAt`，无需前端额外处理。
- 作者主页的 `receivedCommentCount` **自动下降**——该计数只统计未软删文章下的未软删评论（见通用约定），评论软删除后自然不再计入。

---

### GET /api/articles/:id/comments

文章评论列表。**无需登录**。

路径参数：`id`，正整数。查询参数同 `GET /api/articles`（`page` / `pageSize` / `sortBy` / `order`），`sortBy` 白名单为 `createdAt` / `id`。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [
      {
        "id": 1,
        "content": "写得好",
        "author": { "id": 1, "username": "demo", "nickname": "Demo", "avatar": null },
        "createdAt": "2026-09-29T14:05:00.000Z"
      }
    ],
    "page": 1,
    "pageSize": 10,
    "total": 1,
    "totalPages": 1
  }
}
```


`total` 即该文章的评论数，详情页需要展示评论数时直接取它。

失败：

| HTTP | code | 场景 |
|---|---|---|
| 400 | 40000 | id 或分页参数非法 |
| 404 | 40400 | 文章不存在或已软删除 |

---

### PUT /api/users/me

修改当前登录用户的资料（头像 / 简介）。**需要登录**。身份完全取自 token。

路径用 `/me` 而非 `/:id`：本接口**只允许改自己**，不接受路径参数指定用户。用 `PUT /api/users/:id` 会把「用户管理」语义一并打开（未来要加管理员功能时容易混淆），且路径参数可枚举。本项目 MVP 不做用户管理，**这是本项目的 user 模块接口之一（该节只讲改资料；user 模块共 5 个已实现接口，完整清单见文末「已实现但不在上表内」一段）**。

请求头：

```text
Authorization: Bearer <token>
```

#### 请求体字段

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| avatar | string \| null | 否 | 1–255 字符；**必须以 `/uploads/` 开头**（`POST /api/users/me/avatar` 上传产生的站内路径）。**外链已被拒**（外链下线）。不校验文件是否真的存在 |
| bio | string \| null | 否 | 空串视为「清空」并转成 `null` 存储；非空时 1–200 字符 |

两个字段**都是可选的**，但**至少要传一个**（见下方「三态语义」与校验规则）。

```json
{
  "avatar": "/uploads/avatars/1/1759516800000-3f2a9c7e1b4d8065.png",
  "bio": "写点自我介绍"
}
```

只改简介、不动头像：

```json
{
  "bio": "换了个签名"
}
```

清空头像（注意与「不传」的区别）：

```json
{
  "avatar": null
}
```

#### avatar / bio 的三态语义

这两个字段都是「可选可空」，所以必须区分**没传**和**传了 null**。前端与探针都依赖这套语义：

| 请求体写法 | 含义 | 存储结果 |
|---|---|---|
| 字段**不出现**（`{ "bio": "x" }`） | **不改**这个字段 | 保持库中原值不变 |
| `"avatar": null` / `"bio": null` | **清空** | 该列写成 `NULL` |
| `"avatar": "/uploads/..."` / `"bio": "x"` | **设置** | 写入该字符串（`avatar` 只接受 `/uploads/` 前缀，见校验规则） |
| `"bio": ""`（空串） | 等价于清空 | 转成 `NULL` 存储（不接受「空字符串」这种状态） |

**为什么必须区分「不传」与「传 null」**：这是PATCH 语义的核心。如果只有一种写法，用户就没法「只改简介而保留头像」——而这恰恰是最常见的操作。前端表单提交时**只放用户实际改动过的字段**，否则会把未改动的项清掉。

实现上依赖 zod 的 `.optional()`：字段缺失时得到 `undefined`（跳过该字段），显式传 `null` 得到 `null`（写 `NULL`）。**不能用 `z.nullable()` 单独实现**——它会把「缺失」和「null」都当成 `null`，导致没传的字段被误清空。

> ⚠️ 实现时注意：项目里踩过 `z.undefined()` 的坑（zod 4 对「字段缺失」和「显式 undefined」都报 `expected nonoptional`），必须用 `.optional()` + `superRefine` 组合，不要用 `z.undefined()`。

#### 校验规则

| 规则 | code | 说明 |
|---|---|---|
| 禁传 `id` / `userId` / `username` / `password` | 40000 | 身份只能来自 token。携带即报错，**不做静默忽略**（沿用 `PUT /api/auth/password` 的口径） |
| 至少有一个键出现 | 40000 | **即使值是 `null` 也算有效操作**。见下方说明 |
| `avatar` 长度 1–255 | 40000 | 与 `VARCHAR(255)` 对齐 |
| `avatar` 必须是以 `/uploads/` 开头的站内路径 | 40000 | **形态要求**（外链下线后收紧）：只接受本站上传产生的路径，**外链与伪协议一律拒绝**。见下方说明 |
| `bio` 长度 1–200 | 40000 | 空串已在入口转 `null`，不参与长度校验 |

**`avatar` 为什么只放行 `/uploads/` 前缀**：前端会把它直接渲染进 `<img src>` / `background-image`，所以取值必须是**服务端能担保来源的**。`/uploads/` 路径由上传接口生成，来源可信；而 `javascript:` / `data:` 这类伪协议等于把 XSS 的执行权交给用户输入。

**外链为什么也被拒**：外链本身不构成 XSS，但**已无必要** —— 第十一批起头像可以直传，再留一条「用户自填 URL」的旁路，只会让「头像从哪来」有两个答案，并且这两条路的清理逻辑、渲染逻辑、验收断言都得各写一套。下线后**收紧规则反而更简单：不区分伪协议与正常外链，只认一个前缀**。

**为什么 `/uploads/` 站内路径同样安全**：它不是用户能自由填写的任意路径 ——

| 环节 | 约束 |
|---|---|
| 文件名 | 由**服务端**生成（时间戳 + 随机 hex），**不使用客户端的 `originalname`**，因此不可枚举、无法路径穿越 |
| 扩展名 | 由服务端按 mimetype 白名单映射（`.jpg` / `.png` / `.webp`），不接受客户端给的扩展名 |
| 目录 | 固定 `avatars/{userId}/`，`{userId}` 来自 token，改不了别人的目录 |
| 静态服务 | `express.static` 关闭目录列表（`index: false`）与点文件（`dotfiles: 'deny'`） |

也就是说，用户能控制的只有「哪张图」，控制不了「写到哪、叫什么、什么类型」。

> ⚠️ 外链下线后，**验收探针 `probe-profile-edit.mjs` 的 PE-A2 / PE-A5 / PE-B4a 已从「用外链」改成「用 `/uploads/` 路径」，PE-B3 的非法值列表新增了 `https://` 外链**（外链现在也是非法值）。这条与上方「校验规则」必须同时成立，改任一边都要同步另一边。

**「至少有一个键出现」的确切含义**：判断依据是**请求体对象的自有键数量**（`Object.keys(body).length > 0`），**不是「有没有非 null 的值」**。

| 请求体 | 是否有效 | 原因 |
|---|---|---|
| `{}` | ❌ 40000 | 一个键都没有，等价于空操作 |
| `{ "avatar": null }` | ✅ **有效** | 键出现了，值是 `null` → **清空头像**，这是一次真实操作 |
| `{ "bio": "" }` | ✅ **有效** | 键出现了，空串按「清空简介」处理 |
| `{ "avatar": "/uploads/avatars/1/x.png" }` | ✅ 有效 | 设置头像（必须是 `/uploads/` 前缀） |

> ⚠️ **实现时不要写成「至少有一个非 null 的值」**。那样 `{ "avatar": null }` 会被判为空操作而报 400，**用户将无法清空自己的头像**——清空是本接口必须支持的正常操作（头像 URL 会失效、用户换图想清掉旧的，都需要它）。
>
> 正确实现：先判断键是否存在（`Object.prototype.hasOwnProperty.call(body, 'avatar')` / `'bio'`），**再按三态语义决定写什么**，不要用「值是否为 null」来推断「用户是否想改这个字段」。

**为什么不校验「文件在磁盘上真的存在」**：本接口只校验**形态**（是不是 `/uploads/` 前缀），不读磁盘、不查库。代价是可能出现「DB 有路径、磁盘没文件」的悬空引用（例如手工删了文件），前端头像会加载失败 —— 前端按 `img` 的 `error` 事件回退文字头像，不会崩。这个取舍登记在 `docs/DB.md` 的「已知限制」。

#### 成功响应

HTTP 200，**返回完整的 public user**（比 `GET /api/auth/me` 多`avatar` / `bio` 两个字段）：

```json
{
  "code": 0,
  "message": "资料已更新",
  "data": {
    "id": 1,
    "username": "demo",
    "nickname": "Demo",
    "avatar": "/uploads/avatars/1/1759516800000-3f2a9c7e1b4d8065.png",
    "bio": "写点自我介绍",
    "createdAt": "2026-09-29T12:49:05.911Z"
  }
}
```

前端拿到这个对象后应**直接用它更新本地 store**，不必再发一次 `GET /api/auth/me`。`data` 中**永远不含 `password`**。

`data.avatar` 形如 `"/uploads/avatars/1/1759516800000-3f2a9c7e1b4d8065.png"` —— 前端渲染前要补上后端 origin，规则见「前端调用约定」。

> 本接口现在**正常只用于清空头像**（传 `avatar: null`）；**设置头像走 `POST /api/users/me/avatar`**（外链下线后，上传是唯一入口）。这里仍接受 `/uploads/` 前缀的字符串，是给探针与运维留的窄口，**前端不暴露**。

#### 失败

| HTTP | code | message | 场景 |
|---|---|---|---|
| 400 | 40000 | 依据具体字段 | 请求体为空（无任何键）/ avatar 超长 / avatar 不是 `/uploads/` 开头的站内路径（**含 http(s) 外链**）/ bio 超长 |
| 400 | 40000 | 不允许修改其他用户的资料 | 请求体携带 `id` / `userId` / `username` / `password` |
| 401 | 40100 | — | 未提供 token、token 格式错、token 过期或签名无效（`auth` 中间件既有行为） |
| 404 | 40400 | 用户不存在 | token 有效但用户不存在（已删除等），与 `GET /api/auth/me` 口径一致 |
| 500 | 50000 | — | 未预期错误 |

本接口**不新增业务码**，复用既有的 40000 / 40100 / 40400 / 50000。

> 中间件顺序必须是 `auth` 在前、`validate({ body })` 在后。未登录请求应先得到 401，而不是先拿到参数校验细节（否则不登录也能探测校验规则）。与 `PUT /api/auth/password` 同一口径。

#### 对 `author` 内嵌对象的影响

`avatar` 会**进入内嵌 `author` 对象**，因此以下接口的 `author` 从3 个字段变成 4 个：

| 受影响接口 | 变化 |
|---|---|
| `GET /api/articles` | `list[].author` 增加 `avatar` |
| `GET /api/articles/:id` | `author` 增加 `avatar` |
| `POST /api/articles` | `author` 增加 `avatar` |
| `PUT /api/articles/:id` | `author` 增加 `avatar` |
| `POST /api/comments` | `author` 增加 `avatar` |
| `GET /api/articles/:id/comments` | `list[].author` 增加 `avatar` |

`bio` **不进入** `author`：简介只在个人主页展示，塞进每条评论的 author 里是纯粹的响应体浪费（`bio` 可达 200 字符 × 每页20 条评论）。

> **`avatar` 在 `author` 里可能为 `null`，也可能「键不存在」**：调用方造出的对象（以及部分验收探针造假的数据）可能根本没有 `avatar` 键。**前端必须按「有值才渲染 `<img>`，否则回退文字头像」处理，不能无条件写 `<img :src="author.avatar">` 或 `<el-avatar :src="author.avatar">`** —— 那样 `null` / `undefined` 会渲染出破图。文字头像的回退逻辑用现有的 `frontend/src/utils/format.js` 的 `getAvatarText` / `getAvatarColor`。

---

### POST /api/users/me/avatar

上传头像文件（站内存储）。**需要登录**。身份完全取自 token，**不接受请求体里的任何身份字段**。

与 `PUT /api/users/me` 的分工（外链下线后定型）：**设置头像是本接口的专属职责** —— 直接收图片文件，落盘后把生成的站内路径写进 `avatar`，一步到位。`PUT /api/users/me` 的 `avatar` 现在**只用于清空**（传 `null`）；它虽仍接受 `/uploads/` 前缀的字符串（形态校验没变），但那是给探针与运维留的窄口，**前端不再暴露**（外链输入框已删）。

#### 为什么是 `/users/me/avatar` 而不是通用 `/api/upload`

| 对比项 | `POST /api/users/me/avatar`（本接口） | 通用 `POST /api/upload` |
|---|---|---|
| 步骤 | 一次请求完成：落盘 → 改库 → 清旧文件 | 两步：先上传拿 url，再调另一个接口改库 |
| 与 `PUT /api/users/me` 的关系 | **不依赖它**，自带写库 | **「拿 url 再 PUT /me」这条路已封死**（外链下线后 `/me` 只收 `/uploads/` 前缀且前端不暴露），通用接口必须自带写库步骤才可用 |
| 孤儿文件 | **不会**（写库失败会反向删掉刚落盘的文件） | **会**：上传完不保存，文件就永远留在磁盘上 |
| 权限 | 天然只能改自己 | 还要额外判断「谁能用这个 url」 |
| 通用性 | 只服务头像 | 将来文章插图可复用 |


MVP 只有头像一个上传场景，选专用的那个。将来真出现第二个场景（文章插图）时再抽通用 `/api/upload`，本接口保留为语义化的专用入口。

> 外链下线后，本接口是**设置头像的唯一入口**（`PUT /api/users/me` 只能把它清空）。上表「与 `PUT /me` 的关系」一行的意义正在于此：如果当初选了通用 `/api/upload`，外链一封，就必须额外给通用接口补一套「写库 + 清旧文件」的逻辑才能用。

#### 请求格式

`multipart/form-data`，字段名 **`avatar`**，单文件。

```text
POST /api/users/me/avatar
Authorization: Bearer <token>
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary...

------WebKitFormBoundary...
Content-Disposition: form-data; name="avatar"; filename="me.png"
Content-Type: image/png

<文件二进制内容>
------WebKitFormBoundary...--
```

> ⚠️ **前端不要手动设置 `Content-Type`**。boundary 必须由浏览器 / axios 自动生成；手写会把 boundary 弄丢，后端解析不到文件，表现为「接口说没收到文件」。用 `FormData` 配 `api/user.js` 的封装即可，axios 会自动处理。
>
> 同理，`request.js` 给所有请求默认设了 `Content-Type: application/json`，**上传接口必须覆盖掉**（传 `FormData` 时显式置空或让 axios 自行决定），否则 multipart 会被当成 JSON 解析。

#### 限制

| 限制项 | 值 | 超出时 |
|---|---|---|
| 文件大小 | 2 MB（`2 * 1024 * 1024` 字节） | 400 / 40000 |
| 文件个数 | 1，且字段名必须是 `avatar` | 400 / 40000 |
| 图片格式 | `image/jpeg` / `image/png` / `image/webp` | 400 / 40000 |

**不给 SVG**：SVG 可以内嵌 `<script>`，同源渲染下有 XSS 面，而头像场景也用不上矢量图的优势。

#### 服务端处理顺序

1. `auth` 中间件 —— 未登录直接 401，不进入文件解析
2. multer 解析，带 `limits`（大小 / 个数）与 `fileFilter`（mimetype 白名单）
3. 落盘到 `backend/uploads/avatars/{userId}/`，**文件名由服务端生成**
4. 写库：`users.avatar = '/uploads/avatars/{userId}/{filename}'`
5. 写库**成功** → 删掉旧头像文件；写库**失败** → 删掉刚落盘的文件（不留孤儿）

**文件名规则**：`{毫秒时间戳}-{16 位随机 hex}.{扩展名}`，随机值用 `node:crypto` 的 `randomBytes`（内置模块，不加依赖）。扩展名**由服务端按 mimetype 映射**：`image/jpeg`→`.jpg`、`image/png`→`.png`、`image/webp`→`.webp`。

> ⚠️ **绝不让 `file.originalname` 参与命名或路径拼接**。它完全由客户端控制，可以用来做路径穿越（`../../`）或伪造扩展名（`x.html`）。服务端只按 mimetype 白名单决定扩展名，随机名保证文件名不可枚举。

#### 成功响应

HTTP **201**，返回完整的 public user（与 `PUT /api/users/me` 完全同构）。上传得到的地址就是 `data.avatar`：

```json
{
  "code": 0,
  "message": "头像已更新",
  "data": {
    "id": 1,
    "username": "demo",
    "nickname": "Demo",
    "avatar": "/uploads/avatars/1/1759516800000-3f2a9c7e1b4d8065.png",
    "bio": "写点自我介绍",
    "createdAt": "2026-09-29T12:49:05.911Z"
  }
}
```

前端拿到后**直接用它更新本地 store**，不必再发 `GET /api/auth/me`。

#### 失败

| HTTP | code | message | 场景 |
|---|---|---|---|
| 400 | 40000 | 请选择要上传的图片 | 请求里没有文件，或字段名不是 `avatar` |
| 400 | 40000 | 只支持 JPG / PNG / WebP 格式 | mimetype 不在白名单 |
| 400 | 40000 | 图片不能超过 2MB | 超过 `limits.fileSize` |
| 401 | 40100 | — | 未提供 token、token 格式错、token 过期或签名无效 |
| 404 | 40400 | 用户不存在 | token 有效但用户不存在（与 `PUT /api/users/me` 同一口径） |
| 500 | 50000 | — | 未预期错误（含磁盘写入失败） |

本接口**不新增业务码**，复用既有的 40000 / 40100 / 40400 / 50000。

#### 旧头像文件的清理

外链下线后，**库里只要是合法值就一定是站内路径**（`/uploads/` 开头），判定因此变简单，但**判断条件本身不删**：

| 情形 | 是否删旧文件 |
|---|---|
| 本接口上传新头像（换图） | **删**旧文件 |
| `PUT /api/users/me` 传 `avatar: null` 清空头像 | **删**旧文件 |
| 旧值是 `null`（本来就没头像） | 不删（没有文件可删） |
| 旧值不是 `/uploads/` 开头（**历史脏值**，如第九批留下的外链） | **不删** —— 文件不在我们的磁盘上。前缀判断的作用正是「只删自己的文件」 |

> ⚠️ **`deleteLocalAvatar()` 的前缀判断要保留，不要顺手删掉。** 它现在的角色从「区分外链」变成了「脏值防御」：收紧校验只能保证**新的**脏值写不进来，读的时候仍要按同一条规则处理历史值。有人手工改库时，这是 `rm` 之前唯一的防线。

**顺序必须是「先写库，再删旧文件」**：反过来（先删后写）一旦写库失败，用户就彻底没有头像了；前者删失败只留一个垃圾文件，不影响正确性。删除失败只记日志，**不回滚、不报错**。

#### 已知取舍（MVP 不处理，登记在 `docs/DB.md`）

- **孤儿文件 / 悬空引用**：进程在「写库成功 → 删旧文件」之间崩溃会留下孤儿文件；手工清了磁盘而 DB 还指着它会渲染成破图（前端按 `img` 的 `error` 事件回退文字头像，不会崩）。两者都不做定时对账。
- **不做压缩 / 缩略图**：原图直出，显示尺寸由前端 CSS 控制。头像小、量级低，够用。
- **不校验 magic bytes**：只按 mimetype 白名单 + 服务端映射扩展名判断。mimetype 由客户端提供、理论上可伪造，但**不允许 SVG** 且 `express.static` 按扩展名回 `Content-Type: image/*`，浏览器不会把它当 HTML 执行，风险可接受。要收紧时读文件头 12 字节比对 JPEG `FF D8 FF` / PNG `89 50 4E 47` / WebP `RIFF....WEBP` 即可，零依赖。

---

### GET /api/users/:id

用户详情（公开只读）。**无需登录**。对应契约第 5 节的 `GET /api/users/:id`，本批把它从「未实现」转为已实现。

存在的理由：`UserProfile.vue` 原先靠「从该作者的文章里反推 `author`」拿昵称与头像，**该用户 0 篇文章时头部会退化成「用户 #id」**。有了本接口，头部信息不再依赖文章列表。

请求：无查询参数、无请求体。路径参数 `id` 必须是正整数，非法返回 `400 / 40000`。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "username": "demo",
    "nickname": "Demo",
    "avatar": "/uploads/avatars/1/1730000000000-ab12cd34.png",
    "bio": "写点东西，也看点东西。",
    "role": "USER",
    "createdAt": "2026-09-29T14:00:00.000Z",
    "articleCount": 11,
    "receivedLikeCount": 7,
    "receivedCommentCount": 3
  }
}
```

| 字段                | 类型              | 说明                                                                        |
| ----------------- | --------------- | ------------------------------------------------------------------------- |
| id                | number          | 用户 id                                                                     |
| username          | string          | 用户名                                                                       |
| nickname          | string \| null  | 昵称；未设置时为 `null`（前端按 `nickname \|\| username` 回退）                          |
| avatar            | string \| null  | 头像，语义与 `PUT /api/users/me` 一致：**只有 `/uploads/` 站内路径一种形态**（可能为 `null`）。前端渲染前必须补后端 origin，规则见「前端调用约定」 |
| bio               | string \| null  | 个人简介；未设置时为 `null`                                                         |
| role              | string          | 角色，第 5 批新增。枚举 `USER` / `ADMIN`；前端据此渲染管理员徽章与管理端入口                |
| createdAt         | string          | 注册时间，ISO 8601 UTC                                                         |
| articleCount      | number          | 该用户**未软删且已发布（`status = PUBLISHED`）**的文章数                                    |
| receivedLikeCount | number          | 该用户**未软删**文章收到的点赞总数（实时 `COUNT(*)`）                                       |
| receivedCommentCount | number | 该用户**未软删**文章下**未软删**的评论数（即「收到的评论数」，非他发出的评论数）                    |

**字段来源**：前 6 个字段与 `PUT /api/users/me` / `POST /api/users/me/avatar` 返回的 public user **逐字相同**（同一份 `PUBLIC_FIELDS`，见 `backend/src/services/user.service.js`）—— 三个接口返回同一个对象，前端可以无差别地用它更新 store。

**计数口径（四条，逐条都要写清）**：

- **全部实时 `COUNT(*)`，不加冗余列**：与文章 `likeCount` 同一纪律（本文件「通用约定」/ 契约 §11）。三个计数都不进 `users` 表，**本批零 schema 变更**。
- **只数未软删且已发布的内容**：`articleCount` 排除 `deletedAt IS NOT NULL` **且排除 `status = DRAFT`** 的文章（草稿不计入个人主页文章数）；`receivedLikeCount` / `receivedCommentCount` 也只统计未软删文章上的记录。作者删文后计数下降是**预期行为**，不是 bug。
- **`receivedLikeCount` 含本人给自己文章的赞**：`POST /api/articles/:id/like` 允许给自己的文章点赞（接口清单已注明），所以「获赞数」不排除自赞。与 `likeCount`（某篇文章的赞数）口径一致，都是 all-time 累计、不做时间窗衰减。
- **不含 `likeGivenCount`（我赞过多少篇）**：那个数字由 `GET /api/users/me/likes` 的 `total` 提供，本接口不重复给 —— 同一个数字两个来源，将来口径不一致时无法判断哪个对。

**刻意不含**：`password`（永不进 select）、`updatedAt`、`email`（表里没有）、关注数 / 粉丝数（第 4 批 `follows` 表的事）、`status`（第 5 批起表里有此列，但**刻意不透出**——封禁态只通过 401 / 40101 表现，不作为公开字段）。

失败：

| HTTP | code  | message    | 触发                                             |
| ---- | ----- | ---------- | ---------------------------------------------- |
| 400  | 40000 | `id 必须是正整数` | 路径参数非正整数                                        |
| 404  | 40400 | `用户不存在`    | id 不存在，**或该用户已软删**（`deletedAt IS NOT NULL`）    |

> 已软删的用户返回 **404** 而不是「返回基本信息」：与 `GET /api/articles/:id` 的软删口径一致（契约 §9）。他名下的文章仍留在广场、`author` 照常返回（通用约定最后一条），但**主页不可访问**。

---

### GET /api/users/:id/articles

该用户发布的文章列表，**真后端分页**（个人主页「文章」Tab）。**无需登录**。

> 第 6 批起：本列表**只返回 `status = PUBLISHED` 的文章**，草稿不出现（草稿只作者本人在「草稿箱」可见）。`total` 也只数已发布文章。

查询参数：

| 字段       | 类型     | 必填 | 校验                                                        |
| -------- | ------ | -- | --------------------------------------------------------- |
| page     | number | 否  | 默认 1                                                      |
| pageSize | number | 否  | 默认 10，最大 100                                               |
| sortBy   | string | 否  | 白名单 `createdAt` / `updatedAt` / `id` / `likeCount`，默认 `createdAt` |
| order    | string | 否  | `asc` 或 `desc`，默认 `desc`                                  |

- **不支持 `keyword` / `category`**：搜索与分类是「广场」维度的筛选，个人主页不叠加（将来要加再扩，不影响现有字段）。
- `sortBy` 语义、次级排序 `id`、非法值 `400 / 40000`，全部与 `GET /api/articles` 一致（见该节）。`likeCount` 同样是计算字段，走 `buildOrderBy` 的 `ARTICLE_SORT_MAP` 翻译，编译进单条 SQL。

成功：HTTP 200 —— 响应**与 `GET /api/articles` 完全同形**（`{ list, page, pageSize, total, totalPages }`），`list[]` 由同一个 `toArticleListItem()` 生成：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [
      {
        "id": 1,
        "title": "我的第一篇博客",
        "summary": "正文前 100 字……",
        "category": "技术",
        "author": { "id": 1, "username": "demo", "nickname": "Demo", "avatar": null },
        "likeCount": 3,
        "createdAt": "2026-09-29T14:00:00.000Z",
        "updatedAt": "2026-09-29T14:00:00.000Z"
      }
    ],
    "page": 1,
    "pageSize": 10,
    "total": 11,
    "totalPages": 2
  }
}
```

- `total` 是该作者**未软删文章的总数**（后端 `COUNT`），**不受 100 上限约束** —— 这正是它与旧实现（前端过滤 100 窗）的本质区别。
- `list[].author` 仍然内嵌返回：与广场列表同形，前端 `ArticleCard` 可原样复用。

失败：

| HTTP | code  | message | 触发                                    |
| ---- | ----- | ------- | ------------------------------------- |
| 400  | 40000 | 见 `GET /api/articles` | 分页参数 / `sortBy` 非法，或 `id` 非正整数     |
| 404  | 40400 | `用户不存在`  | 用户不存在或已软删                             |

> **用户存在但 0 篇文章 ≠ 404**：此时返回 `200`，`list: []`、`total: 0`、`totalPages: 0`。前端据此渲染空态，而不是把用户主页整页判成不存在。

---

### GET /api/users/me/likes

当前登录用户点赞过的文章列表（个人主页「点赞」Tab）。**需要登录**。

- 路径用 `/me/likes` 而**不是** `/:id/likes`：**只提供查自己**，不提供按 id 查他人点赞记录的能力 ——「谁赞过什么」属个人隐私维度，与 `PUT /api/users/me`（只能改自己）同一条原则。契约第 5 节没有这个路径，属本批新增。
- 与 `GET /api/users/:id` 不冲突：`/me/likes` 是两段路径、`/:id` 是一段，Express 不会误匹配；注册时仍把 `/me/likes` 放在 `/:id` **之前**（防御将来新增 `/:id/xxx` 时的歧义）。
- **`GET /api/users/me`（不带 `/likes`）会命中 `/:id` 并回 `400`** —— 实测 `z.coerce.number()` 对非数字字符串报 `Invalid input: expected number, received NaN`。**这是可接受的行为**，理由：① 前端不会发这个请求（头像与资料走 `PUT /me`、`POST /me/avatar`）；② 回 `400 / 40000` 而不是 `404`，语义上是「这个 id 不合法」而非「资源不存在」，不算误导；③ 为此专门加一条 `GET /me` 别名反而多一个入口、多一处将来要维护的行为。**明确记下来，免得将来有人当 bug 修**。
- method 不冲突：`PUT /me`（改资料）、`POST /me/avatar`（上传头像）、`GET /me/likes`（点赞列表）三者 path 相同但 method 不同，Express 按 method 分派，互不影响。

查询参数：

| 字段       | 类型     | 必填 | 校验                                            |
| -------- | ------ | -- | --------------------------------------------- |
| page     | number | 否  | 默认 1                                          |
| pageSize | number | 否  | 默认 10，最大 100                                   |
| sortBy   | string | 否  | 白名单 `likedAt` / `createdAt` / `likeCount`，默认 `likedAt` |
| order    | string | 否  | `asc` 或 `desc`，默认 `desc`                      |

`sortBy` 语义（三个都是 **API 层字段名**，需要翻译成 Prisma 的 orderBy）：

| sortBy       | 含义                            | Prisma orderBy|
| ------------ | ----------------------------- | ---------------------------------------------|
| `likedAt`    | **点赞时间**（`likes.createdAt`）    | `{ createdAt: order }`                        |
| `createdAt`  | 文章发布时间（`articles.createdAt`）  | `{ article: { createdAt: order } }`           |
| `likeCount`  | 文章的获赞数（`likes` 表聚合）           | `{ article: { likes: { _count: order } } }`   |


- 次级排序固定 `likes.id`（真实列，保证翻页稳定，见 `DEFAULT_SECONDARY_SORT`）。

> **次级排序为什么直接写 `{ id: order }` 就够，不需要（也不能）写 `{ likes: { id: order } }`**
>
> 这一条实测过两次（`prisma.like.findMany`，直接打库验证，不是推断）：
>
> | 写法                                | 结果                | 排的是谁                        |
> | --------------------------------- | ----------------- | --------------------------- |
> | `{ id: order }`                    | ✅ 接受             | **`likes.id`**（查询模型的 id）    |
> | `{ likes: { id: order } }`         | ❌ `Invalid ...`    | 报错——`Like` 模型上没有 `likes` 关系    |
> | `{ article: { id: order } }`       | ✅ 接受             | `articles.id`（**另一个东西**）    |
>
> 关键区别在于**查询的主模型是谁**：本接口从 `likes` 表出发（要拿到 `likes.createdAt` 当 `likedAt`），所以顶层 `{ id }` 解析成 `Like.id`。写成 `{ article: { id } }` 才会切到 `articles.id` —— 那是**另一个语义**（文章编号），恰好也能被 Prisma 接受，最容易混。
>
> 顺带确认 `buildOrderBy` 的 `secondary` 默认值 `'id'` 在这里正好对上：它走的是 `else` 分支 `{ [field]: order }`（`utils/query.js`），**不做 map 翻译** —— 这是对的，`likes.id` 是真实列而非计算字段。
>
> 另外实测：三种主排序写法（`{ createdAt }` / `{ article: { createdAt } }` / `{ article: { likes: { _count } } }`）**全部被 Prisma 接受**，与 `GET /api/articles` 的 `ARTICLE_SORT_MAP` 同一套机制，编译进单条 SQL，不需要拉全量在 JS 里排。
- 前端 Tab **不暴露排序控件**，只用默认 `likedAt desc`（最近点赞的在前）。白名单留三个是给探针与将来用，与 `GET /api/articles` 保留 `updatedAt` 的做法一致。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [
      {
        "id": 1,
        "title": "我的第一篇博客",
        "summary": "正文前 100 字……",
        "category": "技术",
        "author": { "id": 1, "username": "demo", "nickname": "Demo", "avatar": null },
        "likeCount": 3,
        "createdAt": "2026-09-29T14:00:00.000Z",
        "updatedAt": "2026-09-29T14:00:00.000Z",
        "likedAt": "2026-10-06T12:00:00.000Z"
      }
    ],
    "page": 1,
    "pageSize": 10,
    "total": 3,
    "totalPages": 1
  }
}
```

| 字段               | 类型     | 说明                                                              |
| ---------------- | ------ | --------------------------------------------------------------- |
| list[]           | object | 与 `GET /api/users/:id/articles` 的 `list[]` **逐字相同**（同一个 `toArticleListItem()`） |
| list[].likedAt   | string | **本接口多出的唯一字段**：当前用户点赞该文章的时间（`likes.createdAt`），ISO 8601 UTC     |

> **为什么把 `likedAt` 平铺进文章对象，而不是包一层 `{ likedAt, article }`**：前者让前端 `ArticleCard` 可以原样复用（`:article="item"`），两个 Tab 的渲染代码完全一致；后者每个列表项都要解包，且两个 Tab 的 `item` 形状不同，容易出错。代价是「文章字段」与「点赞字段」平级、靠字段名区分 —— 可接受。

**实现说明 · `likedAt` 怎么平铺进去（三条硬约束，照做别走样）**：

1. **禁止改 `toArticleListItem()`**。它是 `GET /api/articles`（广场）与 `GET /api/users/:id/articles` 共用的塑形函数，给它加 `likedAt` 会污染广场列表的响应（那三个接口都没有点赞记录，也拿不到）。
2. **在 `map` 之后单独附加**。正确写法是 `list.map((row) => ({ ...toArticleListItem(row.article), likedAt: row.createdAt }))` —— `row` 是 `Like` 行（带 `article` 关联），`row.createdAt` 即点赞时间、`toArticleListItem(row.article)` 拿到与另两个接口逐字相同的文章对象。
3. **`likedAt` 是虚拟字段，不是数据库列**。Prisma 侧没有 `likedAt` 列（直接写 `orderBy: { likedAt }` 实测报 `Invalid ...`），它是 API 层的名字，靠上表的 map 翻译成 `likes.createdAt`。写探针时断言响应体的 `likedAt`，不要去库里找列。

- **只返回未软删的文章**：我赞过、但作者后来删除的文章不出现在列表里，也不计入 `total`。
- `total` 是「当前用户已点赞 **且** 文章未软删」的条数；取消点赞后立即下降（`likes` 是物理 DELETE，无软删列）。

失败：

| HTTP | code  | message       | 触发                                                      |
| ---- | ----- | ------------- | ------------------------------------------------------- |
| 400  | 40000 | 见 `GET /api/articles` | 分页参数 / `sortBy` 非法                                    |
| 401  | 40100 | 未登录或 token 无效   | **未登录直接访问**（`auth` 中间件现行行为，本批不改中间件）                     |
| 404  | 40400 | `用户不存在`       | token 里的用户已软删（理论路径：软删后旧 token 在有效期内仍然可用）                |

#### 点赞 Tab 的可见性（只给自己看）

- 点赞 Tab **仅在「当前登录用户 id === 路由参数 `:id`」时渲染**；未登录或访问他人主页时**不渲染该 Tab，也不发** `GET /api/users/me/likes` 请求。
- 理由与 `GET /api/articles/:id/liked` 一致：匿名读者访问他人主页时若发这个请求，`auth` 会回 401，而 `request.js` 的 401 拦截器会**清 token 并跳登录页** —— 对一个只是路过的人来说等于被踢了一脚。不发请求就不会触发。

---

### 用户主页改造：`UserProfile.vue` 的分页语义变更（前端必读）

本批同时改前端：**从「无 Tab + 前端过滤 100 窗 + 假分页」改成「el-tabs + 真后端分页」**。这是行为级变更，不只是加接口：

| 项          | 改前                                                            | 改后                                                                |
| ---------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| 数据来源       | `listArticles({ page:1, pageSize:100 })` 拉窗，前端 `filter(a.author.id === id)` | 文章 Tab → `GET /api/users/:id/articles`；点赞 Tab → `GET /api/users/me/likes`；头部 → `GET /api/users/:id` |
| **分页语义**  | **前端切片**：`pagedList = filtered.slice(...)`，`total = filtered.length` | **后端分页**：列表本身就是当前页；`total` = 后端 `COUNT` 出的命中总数                     |
| **`total` 上限** | 受 100 窗约束（最多 100 篇），命中 100 时要显示「仅显示最近 100 篇」                  | **无上限**；「仅显示最近 100 篇」提示**删除**                                     |
| 翻页是否发请求    | 不发（数据已在内存）                                                    | **发**（只在 `Pagination` 的 `@change` 里发；遵守 `Pagination.vue` 顶部约定，不 watch 分页状态） |
| 头部作者信息     | 从命中的文章反推 `author`；**0 篇时退化成「用户 #id」**                         | 直接用 `GET /api/users/:id` 的响应；0 篇也正常显示昵称 / 头像 / 简介                |
| Tab        | 无                                                             | `el-tabs`：「文章」「点赞」（后者**仅本人**可见）                                   |
| 分页状态       | 一组 `page` / `pageSize`                                        | **每个 Tab 各自一组**；切 Tab 回到第 1 页（不重置会越界成空列表）                         |
| 空态         | 统一「还没有发布文章」                                                   | 文章 Tab「还没有发布文章」；点赞 Tab「还没有点赞过任何文章」                                |
| 骨架屏        | `loading && !initialized`                                     | 同；翻页沿用首页 B2 约定 —— **保留旧列表**，不清空                                   |

- **越界页沿用现有约定**：`page` 超过 `totalPages` 时后端返回空 `list` + 真实 `total`（**不报错**），前端不做自动回退，与 `GET /api/articles` / 首页一致。
- **切 Tab 与翻页的加载态**：首屏（第一次进页面）走骨架屏；之后翻页保留旧列表；**切 Tab 属于换了数据集**，要先清空该 Tab 的列表再加载，否则会短暂显示上一个 Tab 的内容。

---

### 用户接口（其余未实现）

契约第 5 节列出的 5 个用户管理接口中，**`GET /api/users/:id` 已实现**（第 2 批，只读公开详情，见「业务接口」一节）；**其余 4 个（列表 / 新增 / 更新 / 删除）全部未实现**。已实现的 user 接口共九个 —— `GET /api/users/:id`、`PUT /api/users/me`（改资料，第九批）、`POST /api/users/me/avatar`（上传头像，第十一批）、`GET /api/users/:id/articles`、`GET /api/users/me/likes`（后三个为第 2 批），以及第 4 批的 4 个关注接口（`POST` / `DELETE /api/users/:id/follow`、`GET /api/users/:id/followers`、`GET /api/users/:id/following`），都在「业务接口」一节，不在下表内。

MVP 不需要用户管理，文章与评论的作者信息通过内嵌 `author` 对象返回。

| 方法 | 路径 | 状态 |
|---|---|---|
| GET | /api/users | 未实现 |
| GET | /api/users/:id | **已实现**（第 2 批：只读公开详情，见「业务接口」一节 `GET /api/users/:id`） |
| POST | /api/users | 未实现 |
| PUT | /api/users/:id | 未实现（**注意：与已实现的 `PUT /api/users/me` 是两个不同路径**，本项目不提供按 id 改他人资料的能力） |
| DELETE | /api/users/:id | 未实现 |

> 将来若要做「查看他人资料」，优先考虑 `GET /api/users/:id`（只读），而不是开放 `PUT /api/users/:id`。写操作一律走 `/me`。


### POST /api/users/:id/follow

关注某用户。**需要登录**。关注者取 token 中的 `userId`（`followerId`），目标取路径 `:id`（`followingId`）。**无请求体**（传了也忽略，不校验、不报错）。

路径参数：`id`，正整数。

**判断顺序（5 步）**：

1. 校验路径参数：`id` 非正整数 → `400 / 40000`
2. 鉴权：`auth` 中间件先于 `validate`，未登录 / token 无效 → `401 / 40100`
3. 自操作校验：`:id === 当前登录用户` → `400 / 40000`（不能关注自己，见下方「不能关注自己」）
4. 目标存在性：用户不存在或已软删 → `404 / 40400`
5. 幂等 / 写入：已关注 → 直接返回成功（`200`，不报错）；否则写入（`follows` 表 `create`）

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "following": true,
    "followerCount": 12,
    "followingCount": 5
  }
}
```

| 字段                 | 类型      | 说明                                                          |
| ------------------ | ------- | ----------------------------------------------------------- |
| data.following     | boolean | 恒为 `true`（关注后的状态）                                         |
| data.followerCount | number  | **被关注者（`:id`）的粉丝数**，实时 `COUNT(*)`；见下方「计数口径」，只算未软删粉丝      |
| data.followingCount | number | **当前用户**的关注数，实时 `COUNT(*)`；见下方「计数口径」，只算未软删被关注者           |

> 两个计数均为实时 `COUNT(*)`，**不落 `users` 冗余列**（与 `articleCount` / `likeCount` 同一纪律）。前端拿到后直接更新本地「粉丝数 / 关注数」显示，不必重拉主页。

失败：

| HTTP | code  | message | 场景                                |
| ---- | ----- | ------- | --------------------------------- |
| 400  | 40000 | id 非正整数 | 路径参数非法                           |
| 400  | 40000 | 不能关注自己 | `:id` 等于当前登录用户                    |
| 401  | 40100 | —       | 未提供 token、token 格式错、token 过期或签名无效 |
| 404  | 40400 | 用户不存在  | 目标用户不存在**或已软删除**                 |

#### 幂等与并发：唯一约束是唯一真相

`follows` 表有唯一约束 `follows_follower_id_following_id_key (follower_id, following_id)`。**并发下的重复关注只能由数据库拦截**，应用层的「先查是否已关注再插入」存在竞态窗口 —— 两个并发请求都在对方写入前查到「未关注」，然后都会执行 INSERT。

因此实现必须是：

1. 直接 `create`，捕获 Prisma 的 `P2002`（底层是 MySQL `1062`）→ **转 `200` 幂等成功**（返回 `{ following: true }`），**不转 409**。
2. **不允许把「先查后写」当作正确性保障**。它最多用来给出更友好的提示，真正的拦截靠唯一约束。

> 该约束已在数据库层实测：重复插入报 `1062 Duplicate entry '1-2' for key 'follows.follows_follower_id_following_id_key'`（见 `docs/DB.md`「follows（关注表）」小节的「约束实测」）。本接口要把这个错误翻译成**幂等成功**（而非 409），与 `POST /api/articles/:id/like` 的「转 409」刻意相反。

#### 计数口径（与两个列表接口完全一致）

`followerCount` / `followingCount` 的口径，与 `GET /api/users/:id/followers` 的 `total`、`GET /api/users/:id/following` 的 `total` **四者完全一致**：都只 `COUNT` `follows` 行中**另一端用户未软删**的记录。

- 粉丝数 `followerCount`（`WHERE following_id = :id`）：只算 `follower` 端 `users.deleted_at IS NULL` 的。被软删的关注者不计入。
- 关注数 `followingCount`（`WHERE follower_id = :id`）：只算 `following` 端 `users.deleted_at IS NULL` 的。被软删的被关注者不计入。
- 实现：列表与计数**同源**（同一段 `JOIN users` + `users.deleted_at IS NULL` 过滤），避免「列表 `total=5`、POST 返回 `followerCount=6`（含一个软删用户）」的数字跳变。
- 与 `likeCount`（含已软删点赞者）**刻意不同**：粉丝列表本身排除了软删用户，计数若不排除会对不上（详见 `docs/DB.md`「follows（关注表）→ 计数口径」）。

#### 不能关注自己

`:id === 当前登录用户` 在第 3 步（存在性检查之前）就拦截，避免把「自己」误判成「不存在」，也避免写入一条 `follower_id = following_id` 的自关注记录（唯一约束虽能拦住，但语义上应直接 400）。`DELETE` 自己的关注态视为 no-op（见下方「DELETE /api/users/:id/follow」），不单独报 400。

---

### DELETE /api/users/:id/follow

取消关注。**需要登录**。物理 `DELETE`（与 `likes` 同构，无软删列）。**无请求体**。

路径参数：`id`，正整数。

**判断顺序（5 步）**：

1. 校验路径参数：`id` 非正整数 → `400 / 40000`
2. 鉴权：未登录 / token 无效 → `401 / 40100`
3. 目标存在性：用户不存在或已软删 → `404 / 40400`（注意：未关注本身**不算失败**，见下方语义分歧）
4. 查询是否已关注（`WHERE follower_id = me AND following_id = id`）
5. 已关注 → 物理删除，返回 `200 { following: false, followerCount, followingCount }`；未关注 → **仍返回 `200 { following: false }`**（no-op 成功，不报 404、不报 409）

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": { "following": false, "followerCount": 11, "followingCount": 4 }
}
```

| 字段                 | 类型      | 说明                                                   |
| ------------------ | ------- | ---------------------------------------------------- |
| data.following     | boolean | 恒为 `false`（取消关注后的状态）                                |
| data.followerCount | number  | **被关注者（`:id`）的粉丝数**，删除后实时 `COUNT(*)`，只算未软删粉丝    |
| data.followingCount | number | **当前用户**的关注数，删除后实时 `COUNT(*)`，只算未软删被关注者         |

失败：

| HTTP | code  | message | 场景                                |
| ---- | ----- | ------- | --------------------------------- |
| 400  | 40000 | id 非正整数 | 路径参数非法                           |
| 401  | 40100 | —       | 未提供 token、token 格式错、token 过期或签名无效 |
| 404  | 40400 | 用户不存在  | 目标用户不存在**或已软删除**（注意：未关注本身不算 404）    |

#### 与 DELETE /articles/:id/like 的语义分歧（幂等 200 vs 404）

这是 follow 与 like 两处**刻意不同**的语义：

| 操作                                    | 已处于目标状态再操作      | 返回                    |
| ------------------------------------- | --------------- | --------------------- |
| `DELETE /api/articles/:id/like`（取消没赞过的）     | 本来就没赞           | **404**（`likeCount` 语义：「取消一个动作」，重复是错误） |
| `DELETE /api/users/:id/follow`（取关没关注过的）   | 本来就没关注          | **200** `{ following: false }`（follows 语义：「确认关系不存在」，没关注本来就是这个状态，幂等成功） |

**理由（必须写进代码注释，否则将来读代码的人会以为是 bug）**：likes 的取消是「取消一个动作」（重复是错误），follows 的取消是「确认关系不存在」（没关注也是这个状态），语义不同，故回 200。

实现：用 `deleteMany({ where: { followerId: me, followingId: id } })`，`count === 0` 时仍返回 200（不抛 `P2025`），与 likes 的「用 `deleteMany` 而非 `delete`」同一手法。唯一约束仍是并发下的唯一真相（并发重复关注报 `1062`，但 `POST` 端捕获后转 200 幂等成功，不转 409）。

---

### GET /api/users/:id/followers

某用户的**粉丝列表**（谁关注了 `:id`）。**无需登录**。

路径参数：`id`，正整数。查询参数同 `GET /api/articles`（`page` / `pageSize` / `sortBy` / `order`）：

| 字段       | 类型     | 必填 | 校验                                             |
| -------- | ------ | -- | ---------------------------------------------- |
| page     | number | 否  | 默认 1                                           |
| pageSize | number | 否  | 默认 10，最大 100                                   |
| sortBy   | string | 否  | 白名单 `followedAt` / `id`，默认 `followedAt`         |
| order    | string | 否  | `asc` 或 `desc`，默认 `desc`                       |

- `followedAt` = 关注时间（`follows.created_at`），**虚拟字段**（API 层 `map` 后附加，不建列，与 `likedAt` 同机制）。
- **次级排序**：排序值并列时追加 `id`（同 `order` 方向）。这里的「次级 `id`」是 **`follows.id`**（关系行的代理主键），**不是 `users.id`** —— 见下方「次级排序用 follows.id」。
- 数据来自 `follows` 表 `WHERE following_id = :id`，`JOIN users` 取粉丝资料；粉丝用户被软删时**不出现在列表**（见「计数口径」）。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [
      { "id": 3, "username": "alice", "nickname": "Alice", "avatar": null,
        "followedAt": "2026-10-11T09:00:00.000Z" }
    ],
    "page": 1, "pageSize": 10, "total": 12, "totalPages": 2
  }
}
```

| 字段                 | 类型      | 说明                                                          |
| ------------------ | ------- | ----------------------------------------------------------- |
| list[].id          | number  | 粉丝用户 id                                                     |
| list[].username    | string  | 粉丝用户名                                                       |
| list[].nickname    | string  | 粉丝昵称（未设置时前端按 `nickname \|\| username` 回退）                |
| list[].avatar      | string  | 粉丝头像，语义与 `GET /api/users/:id` 一致（仅 `/uploads/` 站内路径一种形态，可能为 `null`） |
| list[].followedAt  | string  | 该粉丝**关注 `:id` 的时间**，虚拟字段 = `follows.created_at`，ISO 8601 UTC     |
| **total**          | number  | **`:id` 的粉丝数**，实时 `COUNT(*)`，**只算未软删粉丝**（见下方「计数口径」）       |

失败：

| HTTP | code  | message | 场景                       |
| ---- | ----- | ------- | ------------------------ |
| 400  | 40000 | 见 `GET /api/articles` | 分页参数 / `sortBy` 非法，或 `id` 非正整数 |
| 404  | 40400 | 用户不存在  | 用户不存在或已软删                |

> 用户存在但 0 粉丝 ≠ 404：返回 `200` + 空 `list` + `total: 0`（同 `GET /api/users/:id/articles` 口径）。

#### 计数口径（与 POST/DELETE 完全一致）

`total`（粉丝数）的口径，与 `POST /api/users/:id/follow` 的 `followerCount`、`DELETE` 的 `followerCount`、`GET /api/users/:id/following` 的 `total` **四者完全一致**：都只 `COUNT` `follows` 行中**另一端用户未软删**的记录。

- 本接口 `WHERE following_id = :id` `JOIN users` 带 `users.deleted_at IS NULL`：被软删的粉丝**不计入 `total`，也不出现在 `list`**。
- 列表与计数**同源**：同一个 `JOIN + 过滤` 既出 `list` 又出 `total`，杜绝「列表 `total=5`、POST 返回 `followerCount=6`」的数字跳变。
- 与 `likeCount`（含已软删点赞者）**刻意不同**：粉丝列表已排除软删用户，计数必须同步排除，否则两端对不上（详见 `docs/DB.md`「follows（关注表）→ 计数口径」）。

#### 次级排序用 follows.id（不是 users.id）

`sortBy: id` 与翻页并列时补的「次级 `id`」是 **`follows.id`**（关系行的代理主键），**不是 `users.id`**，也不是 `follows.follower_id` / `following_id`。与 `likes` 的「次级 `id` 是 `likes.id`」完全同构。

- 实现：Prisma `orderBy` 主排序翻成 `{ createdAt: order }`，次级补 `{ id: order }`（即 `follows.id`）。**不要**写成 `{ followedUserId: order }` 之类 —— 表里没有这个列。
- 本接口从 `follows` 表出发做分页（`follows.following_id = :id`），所以顶层 `{ id }` 解析成 `follows.id`；写成 `{ user: { id } }` 会切到 `users.id` —— 那是另一个语义（粉丝编号），恰好也能被 Prisma 接受，最容易混。
- 理由同 `GET /api/users/me/likes` 的 `likedAt` 排序实测：查询主模型是谁，顶层 `{ id }` 就解析成谁的 id。

---

### GET /api/users/:id/following

某用户**主动关注的列表**（`:id` 关注了谁）。**无需登录**。与 `followers` 完全对称，只是查询条件换成 `WHERE follower_id = :id`，`list[]` 是「被关注者」的摘要。

路径参数：`id`，正整数。查询参数同 `GET /api/users/:id/followers`（`page` / `pageSize` / `sortBy` 白名单 `followedAt` / `id` / `order`）。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [
      { "id": 5, "username": "bob", "nickname": "Bob", "avatar": null,
        "followedAt": "2026-10-10T08:00:00.000Z" }
    ],
    "page": 1, "pageSize": 10, "total": 4, "totalPages": 1
  }
}
```

| 字段                 | 类型      | 说明                                                   |
| ------------------ | ------- | ---------------------------------------------------- |
| list[].id          | number  | 被关注者用户 id                                            |
| list[].username    | string  | 被关注者用户名                                              |
| list[].nickname    | string  | 被关注者昵称                                               |
| list[].avatar      | string  | 被关注者头像，语义同上                                         |
| list[].followedAt  | string  | `:id` **关注该用户的时间**，虚拟字段 = `follows.created_at`         |
| **total**          | number  | **`:id` 的关注数**，实时 `COUNT(*)`，**只算未软删被关注者**            |

失败：

| HTTP | code  | message | 场景                       |
| ---- | ----- | ------- | ------------------------ |
| 400  | 40000 | 见 `GET /api/articles` | 分页参数 / `sortBy` 非法，或 `id` 非正整数 |
| 404  | 40400 | 用户不存在  | 用户不存在或已软删                |

> 用户存在但 0 关注 ≠ 404：返回 `200` + 空 `list` + `total: 0`。

#### 计数口径与次级排序

- **计数口径**：`total`（关注数）与 `followers` 的 `total`、`POST`/`DELETE` 的 `followingCount` **完全一致**，只 `COUNT` 未被软删被关注者之外的记录（见 `GET /api/users/:id/followers` 的「计数口径」小节，机制同源）。
- **次级排序**：同 `followers`，次级 `id` 是 **`follows.id`**（详见该节）。

---

### 管理端接口（第 5 批）

> 本批为管理员后台新增 7 个接口，前缀 `/api/admin`。schema 变更（`users` 加 `role` / `status` 两列）与依赖特批（marked / highlight.js / dompurify）的豁免登记见 `docs/AI_CONTRACT.md` §2 与 `docs/DB.md`「第 5 批」小节。

**统一约定**：

- 全部需要「已登录 + ADMIN」双条件：先过 `auth` 中间件（验签 + 封禁检查），再过 `requireAdmin` 中间件（查 `role`）。
- 未登录 / token 无效 → 401 / 40100；已登录但账号被封禁 → 401 / 40101（**旧 token 即刻失效**，不需要任何额外机制）；已登录非 ADMIN → 403 / 40300「需要管理员权限」。
- 分页、排序、keyword 沿用契约 §7 与本文「通用约定」；管理端列表的 `sortBy` 白名单与对应公开列表一致。
- 删除一律**软删**，与公开接口语义一致；**不提供物理硬删**（FK 全 RESTRICT，硬删需先清 `likes` → `comments`，超出 MVP，留 `?force` 查询参数作演进位）。
- 管理端列表**可以看到已软删的内容**（`articles` / `comments`），这是管理页的职责；公开广场永远只返回未软删。

#### GET /api/admin/stats

数据概览。**无需参数**。成功返回 6 个实时 `COUNT(*)`：

| 字段 | 口径 |
|---|---|
| users | 未软删用户数 |
| articles | 未软删文章数 |
| comments | 未软删评论数 |
| likes | `likes` 表总行数（点赞者软删不排除，同 `likeCount` 口径） |
| follows | `follows` 表总行数 |
| deletedArticles | 已软删文章数（管理端专属，公开接口不返回） |

> **不含「待办举报数」**：举报系统尚未建设（第 7 批储备项），此时返回该字段只能是假数据，等举报落地后再加，不预留占位。

失败：401 / 40100（未登录）、401 / 40101（已封禁）、403 / 40300（非 ADMIN）。

#### GET /api/admin/users

用户列表。需要「登录 + ADMIN」。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| page | number | 否 | 默认 1 |
| pageSize | number | 否 | 默认 20，上限 100 |
| sortBy | string | 否 | `createdAt` / `id`，默认 `createdAt` |
| order | string | 否 | `asc` / `desc`，默认 `desc` |
| keyword | string | 否 | 模糊匹配 `username` + `nickname` |
| status | string | 否 | `ACTIVE` / `BANNED`，不传 = 全部 |

`list[]` 字段：`id` / `username` / `nickname` / `avatar` / `role` / `status` / `createdAt`（**无 `password`**）。

- **不含软删用户**：与所有用户只读接口口径一致（软删用户对任何接口都是 404），`PATCH` 对软删用户同样 404。
- 分页 meta：`{ list, page, pageSize, total, totalPages }`。

失败：401 / 40100、401 / 40101、403 / 40300、400 / 40000（`status` 非法值）。

#### PATCH /api/admin/users/:id/status

封禁 / 解禁用户。请求体：

```json
{ "status": "BANNED" }
```

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| status | string | 是 | 枚举 `ACTIVE` / `BANNED`，非法值 400 / 40000 |

行为：

- **幂等 200**：目标已是该状态也返回 200（状态机 set，非动作计数，与「重复关注 200」同族）。
- 成功返回**更新后的 public user**（含 `role` / `status`）。
- **目标用户不存在或已软删 → 404 / 40400**。
- **目标用户是 ADMIN → 400 / 40000**「不能封禁或解禁管理员账号」（见下方「管理员不能被管理端操作」）。
- 封禁效果（`status` 置 `BANNED` 后立即生效）：该用户**所有已签发的 token 即刻失效**（`auth` 中间件实时查 `status`），登录接口对该账号返回 401 / 40101「账号已封禁」。解禁后同一枚旧 token**自动恢复有效**——拦截判据是 `status` 本身，不是 token 黑名单。

**管理员不能被管理端操作**（防呆规则，一刀切）：

> `PATCH /api/admin/users/:id/status` 的目标用户 `role = 'ADMIN'` 时直接拒绝，400 / 40000「不能封禁或解禁管理员账号」，**不计算「是不是最后一个管理员」**。理由：① 算「最后一个」要在封禁请求里做管理员计数，并发下仍有窗口；② 一刀切的规则简单、可预期、探针可断言；③ 管理员权限变更（任命 / 罢免 / 封禁管理员）只由开发者直接在数据库操作，不走管理端界面——这是有意的运维边界，不是功能缺失。

#### GET /api/admin/articles

文章列表（管理视角）。查询参数在广场列表基础上增加 `deleted`：

| 参数 | 类型 | 说明 |
|---|---|---|
| deleted | string | 不传 = **全部（含软删）**；`true` = 只要已软删；`false` = 只要未软删 |
| status | string | 不传 = **全部（含草稿）**；`PUBLISHED` = 只要已发布；`DRAFT` = 只要草稿 |
| keyword | string | 命中标题 + 正文（同广场） |
| sortBy | string | `createdAt` / `updatedAt` / `id` / `likeCount`（同广场） |

`list[]` 与广场列表**逐字同形**（同一份 `toArticleListItem` 塑形），**附加 `deletedAt` 字段**（map 之后单独附加，同 `likedAt` 机制，不污染公开塑形函数）。

失败：401 / 40100、401 / 40101、403 / 40300、400 / 40000。

#### DELETE /api/admin/articles/:id

删除文章（软删），**无视作者权限**。已软删或不存在 → 404 / 40400。成功 200，`data: null`（与 `DELETE /api/articles/:id` 响应一致）。

> 为什么不复用 `DELETE /api/articles/:id` 加 admin 分支：那是修改现有接口的权限语义（契约禁止），且会动到已全绿的公开接口探针回归面。管理端走独立路由，公开接口语义零改动。

#### GET /api/admin/comments

评论列表（管理视角）。查询参数：`page` / `pageSize` / `sortBy`（`createdAt` / `id`）/ `order` / `keyword`（命中 `content`）/ `deleted`（同管理端文章）。

`list[]` 字段：`id` / `content` / `author`（5 字段内嵌对象，含 `role`）/ `articleId` / `articleTitle` / `createdAt` / `deletedAt`。

> `articleTitle` 让管理端知道评论归属哪篇文章（一条关联查询，分页量级可接受）；公开评论列表不带它。

失败：401 / 40100、401 / 40101、403 / 40300、400 / 40000。

#### DELETE /api/admin/comments/:id

删除评论（软删），**无视作者权限**（公开接口的「评论作者 ∨ 文章作者」规则不适用）。已软删或不存在 → 404 / 40400。成功 200，`data: null`。

#### role / status 透出（第 5 批改动的现有响应体）

- `role` 进入三处形状（两份重复定义都改，不做重构）：
  - `toPublicUser`：`backend/src/services/auth.service.js` 与 `backend/src/services/user.service.js` 各一份；
  - `AUTHOR_SELECT`：`backend/src/services/article.service.js` 与 `backend/src/services/comment.service.js` 各一份。
- 影响面：`GET /api/auth/me`、`GET /api/users/:id`、登录 / 注册响应的 `user`、所有文章 / 评论列表项的内嵌 `author`。
- `status` **不透出**：封禁态只通过 401 / 40101 表现，不作为任何接口的公开字段。
- 模式同第九批 `avatar`：「只加字段、不做重构」，两份重复定义的抽取单独排批。

#### 封禁语义（为什么是 401 而不是 403）

封禁的本质是**凭证作废**，属 401 语义；403 是「凭证有效但没权限」。具体理由：

1. 前端 `request.js` 已有成熟的 401 链路（清 token → `AUTH_CLEARED_EVENT` → 跳登录），**零成本复用**；走 403 会把用户留在「每个请求都撞墙」的状态，还要给 403 新开清 token 分支。
2. 401 / **40101** 让登录页能提示「账号已封禁」，不把封禁和「没登录」混为一谈。
3. JWT payload **不放** `role` / `status`：放了能省一次查询，但改角色 / 封禁后旧 token 不失效——安全上不可接受。必须 DB 实时查，代价是每个已鉴权请求多一次主键查询，项目规模可接受。

---

---

### POST /api/articles/auto-save

自动保存草稿。**需要登录**。作者取 token 中的 `userId`。草稿是 `status = DRAFT` 的完整文章行，只在作者「草稿箱」可见，不进广场、不进公开详情。

请求体：

| 字段              | 类型     | 必填 | 校验                                                                               |
| --------------- | ------ | -- | -------------------------------------------------------------------------------- |
| title           | string | 否  | 字符串；更新时允许为空（清空草稿标题）；新建时若为空且 content 过短则不创建（见「建草稿门槛」）                               |
| content         | string | 否  | 字符串；允许为空                                                                        |
| category        | string | 否  | 枚举 `技术` / `生活` / `随笔` / `未分类`；省略默认 `未分类`；非法值 `400 / 40000`                         |
| draftId         | number | 否  | 已有草稿 id；传了就更新该草稿，不传则新建                                                          |
| sourceArticleId | number | 否  | 编辑已发布文章时的来源文章 id；仅作归属校验，**不落库**（见「编辑已发布文章的完整流程」）                                       |

行为分两种：

- **有 `draftId`（更新草稿）**：该 `draftId` 必须是 `status = DRAFT` 且 `authorId = 当前用户` 的文章，否则 `404 / 40400`（**坑 1：越权校验**，草稿不给他人碰）。更新其 `title` / `content` / `category`，`status` 保持 `DRAFT`。返回 `{ id: draftId, status: "DRAFT", saved: true }`。
- **无 `draftId`（新建草稿）**：先过「建草稿门槛」（**补丁 3 第一道闸**）——若 `title` 为空（或纯空白）**且** `content` 长度 `< 10`，**不创建任何草稿**，直接返回 `200 { id: null, status: "IDLE", saved: false }`（前端保持 idle 态，不再发更多请求）。门槛通过后再看 `sourceArticleId`：若传了，校验它指向 `status = PUBLISHED` 且 `authorId = 当前用户` 的文章，否则 `404 / 40400`（防越权编辑他人文章）；校验通过仅作放行，**不把 sourceArticleId 写进草稿**。然后新建 `status = DRAFT` 的文章，返回 `{ id: 新草稿id, status: "DRAFT", saved: true }`。

> 注意：新建草稿后，后续所有改动都走「有 draftId」分支。**补丁 3 第二道闸**：一旦进入草稿态（已持有 draftId），**任何内容变化都必须发请求**——包括把内容清空到 0 字——不再受建草稿门槛限制（保证「清空内容后保存」不丢）。

失败：

| HTTP | code  | 场景                                       |
| ---- | ----- | ---------------------------------------- |
| 400  | 40000 | `category` 非法，或 draftId / sourceArticleId 非正整数 |
| 401  | 40100 | 未登录或 token 无效                            |
| 404  | 40400 | draftId 指向非草稿 / 非本人草稿；或 sourceArticleId 不存在 / 非本人 / 非 PUBLISHED |

### 编辑已发布文章的完整流程（补丁 1）

前端编辑一篇 `PUBLISHED` 文章时，**绝不直接在线上文章上 auto-save**，而是走「独立草稿」隔离：

1. 进入编辑页，立刻 `POST /api/articles/auto-save` 带 `sourceArticleId = 原文章id`、不带 `draftId` → 后端新建一篇独立 `DRAFT`（归属当前用户），前端缓存 `draftId`。
2. 用户在编辑器里打字，每次触发防抖后 `auto-save` 带 `draftId` 更新这篇草稿（线上原文完全不受影响，广场上这篇文章内容不变）。
3. 用户点「发布」：前端 `PUT /api/articles/:原文章id`（带最终标题/正文/分类）→ 后端**先快照原文章当前版到 `article_revisions`，再覆盖更新**，状态保持 `PUBLISHED`（文章不掉广场、URL 不变）。随后 `DELETE /api/users/me/drafts/:draftId` 删掉临时草稿。
4. 用户点「存草稿 / 退出」：不触发 PUT，临时草稿留在「草稿箱」，下次可从草稿箱继续编辑。

> 新文章（从空白新建）则没有 `sourceArticleId`：auto-save 建草稿 → 编辑 → 发布时 `PUT /api/articles/:draftId` 带 `status = "PUBLISHED"` 把草稿翻成已发布（因目标是 DRAFT，后端**不快照**，草稿本身即文章）。

---

### GET /api/users/me/drafts

我的草稿箱。**需要登录，仅本人**。返回当前用户所有 `status = DRAFT` 的文章（不含已发布、不含已软删）。

查询参数：

| 字段       | 类型     | 必填 | 校验                                    |
| -------- | ------ | -- | ------------------------------------- |
| page     | number | 否  | 默认 1                                  |
| pageSize | number | 否  | 默认 10，最大 100                          |
| keyword  | string | 否  | 按 `title` 模糊搜索；空串 / 纯空白 / 不传 = 不过滤         |

成功：HTTP 200，结构与 `GET /api/articles` 同形（`{ list, page, pageSize, total, totalPages }`）。`list[]` 字段：`id` / `title` / `summary`（正文前 100 字）/ `content`（**全文**，供「继续编辑」回填——草稿无法通过公开详情获取，这是全文唯一来源）/ `category` / `createdAt` / `updatedAt`。

失败：401 / 40100（未登录）。

---

### DELETE /api/users/me/drafts/:id

删除指定草稿。**需要登录，仅作者**。物理删除（草稿无点赞 / 评论 / 版本记录，可安全硬删；其 `article_revisions` 若有也随 `ON DELETE CASCADE` 清理，但草稿本身不产版本）。

路径参数：`id`，正整数，必须是 `status = DRAFT` 且 `authorId = 当前用户` 的文章，否则 `404 / 40400`。

成功：HTTP 200，`data: null`。

失败：

| HTTP | code  | 场景                |
| ---- | ----- | ----------------- |
| 400  | 40000 | id 非正整数           |
| 401  | 40100 | 未登录或 token 无效     |
| 404  | 40400 | 文章不存在 / 非草稿 / 非本人 |

---

### GET /api/articles/:id/revisions

文章版本历史。**需要登录，仅作者本人**（管理员走管理端）。返回该文章历次「更新前快照」的全量列表（**方案 A：每条都带完整 `content`**，供前端抽屉直接预览，无需二次请求）。

路径参数：`id`，正整数。必须指向 `status = PUBLISHED` 且 `authorId = 当前用户` 的文章，否则 `404 / 40400`（非作者返回 `403 / 40300` 以区分「无权」与「不存在」——此处统一 `404` 与公开详情口径一致，简化前端）。

成功：HTTP 200

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "articleId": 1,
    "revisions": [
      {
        "id": 3,
        "articleId": 1,
        "title": "旧标题",
        "content": "这一版的正文全文……",
        "category": "技术",
        "authorId": 1,
        "createdAt": "2026-10-17T10:00:00.000Z"
      }
    ],
    "total": 1
  }
}
```

- `revisions` 按 `createdAt` **倒序**（最新快照在前）。
- 每条即一次「更新前」的快照；要回滚时选其中一条 `id` 调 `POST /api/articles/:id/restore`。
- 当前线上版本不在 `revisions` 里（它就是 `GET /api/articles/:id` 返回的内容）；抽屉里可把「当前版本」作为置顶对照展示。

失败：

| HTTP | code  | 场景                     |
| ---- | ----- | ---------------------- |
| 400  | 40000 | id 非正整数                |
| 401  | 40100 | 未登录或 token 无效            |
| 403  | 40300 | 文章存在但当前用户不是作者           |
| 404  | 40400 | 文章不存在 / 已软删 / 非 PUBLISHED |

> 注：草稿（`DRAFT`）没有版本历史，故非 PUBLISHED 一律 `404`。

---

### POST /api/articles/:id/restore

回滚到指定版本。**需要登录，仅作者本人**。

路径参数：`id`，正整数（目标文章，必须是 `PUBLISHED` 且作者本人）。请求体：

```json
{ "revisionId": 3 }
```

| 字段         | 类型     | 必填 | 校验                             |
| ---------- | ------ | -- | ------------------------------ |
| revisionId | number | 是  | 必须是该文章的版本 id，否则 `404 / 40400` |

行为（**先快照、后覆盖**，保证回滚本身也可再回滚）：

1. 先把目标文章**当前的** `title` / `content` / `category` 存入 `article_revisions`（生成一条新快照，记录「回滚前」的状态）。
2. 再把文章更新为 `revisionId` 对应快照的 `title` / `content` / `category`，`status` 保持 `PUBLISHED`。
3. 返回更新后的文章（结构同「文章详情」）。

失败：

| HTTP | code  | 场景                                         |
| ---- | ----- | ------------------------------------------ |
| 400  | 40000 | id / revisionId 非法，或 revisionId 缺失            |
| 401  | 40100 | 未登录或 token 无效                                |
| 403  | 40300 | 文章存在但当前用户不是作者                              |
| 404  | 40400 | 文章不存在 / 已软删 / 非 PUBLISHED；或 revisionId 不属于该文章 |

---

### MVP 范围外（明确不做）

收藏、标签、「只看我的文章」筛选。

> 说明 0：**点赞已实现**（第十批，`POST` / `DELETE /api/articles/:id/like`，列表与详情返回 `likeCount`），已从上表移出。原遗留项「`liked`（当前用户是否已赞）不在列表 / 详情返回，刷新详情页后按钮态会显示为『未赞』」**已解决**（第十四批）：新增需登录的 `GET /api/articles/:id/liked`，列表 / 详情的返回结构与 `auth` 中间件**均未改动**。
>
> 说明 1：「只看我的文章」不涉及表结构变更，将来做「我的博客」页时，在 `GET /api/articles` 加一个可选 `authorId` 查询参数即可。
>
> 说明 2：**搜索已实现**（`GET /api/articles` 的 `keyword` 参数，命中标题 + 正文），已从上表移出。搜索**不含作者昵称**，也不做标签 / 分类聚合搜索。
>
> 说明 3：**头像上传已实现**（第十一批，`POST /api/users/me/avatar`，文件落 `backend/uploads/`），已从上表移出。**图片外链已下线** —— `PUT /api/users/me` 的 `avatar` 不再接受 `http(s)://`，只接受 `/uploads/` 站内路径（正常只用于传 `null` 清空），**上传成为设置头像的唯一入口**。遗留项：不做图片压缩 / 缩略图、不做孤儿文件定时对账、不校验 magic bytes，均登记在 `docs/DB.md`。
>
> 说明 4：**文章分类已实现**（分类功能，`articles` 表新增 `category VARCHAR(20) NOT NULL DEFAULT '未分类'` 一列，经用户明确批准；豁免登记见 `docs/AI_CONTRACT.md` 第 2 节）。`POST` / `PUT` 文章可传可选 `category`（枚举 技术/生活/随笔/未分类），`GET /api/articles` 新增可选 `category` 筛选参数（与 `keyword` 正交、可叠加）。**未新增 `GET /api/categories` 接口**——前端枚举写死这 4 个字符串，无需后端枚举接口。遗留项：暂不为 `category` 建索引（低基数列，MVP 数据量下无需），理由见 `docs/DB.md`。
>
> 说明 5：**评论删除已实现**（第 3 批，`DELETE /api/comments/:id`，评论作者或文章作者，软删），已从上表移出。原清单中的「评论删除」是第 3 批之前的遗留文字，第 5 批顺手清理。

> 说明 6：**草稿 / 自动保存 / 版本历史 / 回滚（第 6 批）已实现**：`articles` 表新增 `status` 列（`DRAFT` / `PUBLISHED`，默认 `PUBLISHED`，INSTANT 回填），新增 `article_revisions` 表存版本快照；新增 5 个接口（`POST /api/articles/auto-save`、`GET /api/users/me/drafts`、`DELETE /api/users/me/drafts/:id`、`GET /api/articles/:id/revisions`、`POST /api/articles/:id/restore`）。公开列表 / 详情 / 个人主页默认只认 `PUBLISHED`。豁免登记见 `docs/AI_CONTRACT.md` §2 与 `docs/DB.md`「第 6 批」小节。

---

## 前端调用约定

- 所有请求走 `frontend/src/api/request.js` 导出的 axios 实例。
- 响应拦截器约定：`code === 0` 直接返回 `data`；`code !== 0` 抛出携带 `message` 的 Error；HTTP 401 清除本地 token 并跳转登录页。
- `frontend/src/api/auth.js` 封装本文件的 auth 接口，组件与 store 不直接写 URL。
- **`avatar` 的 URL 拼接规则**（第十一批引入，外链下线后简化）：库里的头像是**站内相对路径** `/uploads/avatars/1/xxx.png`，直接塞进 `<img src>` 会被浏览器解析成**前端自己的 origin**（`localhost:5173`）而 404，所以必须拼上后端 origin。
  - **以 `/uploads/` 开头** → **补上后端 origin** 再使用。
  - **其它值**（历史脏值，如第九批可能留下的外链）→ **原样返回**，不做拼接。
    - 为什么选「原样返回」而不是「硬拼 origin」：硬拼会得到 `http://localhost:3000https://cdn.example.com/a.png` 这种谁都不认识的 URL，**比破图更难排查**；原样返回的最坏情况是破图，而破图有 `@error` 回退文字头像兜底，是优雅降级。
  - ⚠️ 后端 origin 要**去掉 `VITE_API_BASE_URL` 末尾的 `/api`**：接口基址是 `http://localhost:3000/api`，而静态资源挂在 `http://localhost:3000/uploads/...`，**不带 `/api`**。
  - 拼接只在 `frontend/src/utils/format.js` 的 `resolveAvatarUrl()` 里做**一次**；`ArticleCard` / `AuthorCard` / `UserDropdown` / `CommentList` / `UserProfile` 五处渲染都走它，组件不用各自处理。
