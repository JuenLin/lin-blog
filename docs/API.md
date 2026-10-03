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
    "createdAt": "2026-09-29T12:49:05.911Z"
  }
}
```

`avatar` / `bio` 为第九批新增字段，**第九批之后本接口会返回这两个键**（示例中为 `null`）。首次实现该接口时若尚未加字段，可先不返回；加了字段后必须返回，否则前端无法在登录后立即拿到用户资料。

失败：

| HTTP | code  | 场景                                |
| ---- | ----- | --------------------------------- |
| 401  | 40100 | 未提供 token、token 格式错、token 过期或签名无效 |
| 404  | 40400 | token 有效但用户不存在（已删除等）              |

---

### PUT /api/auth/password

修改当前登录用户的密码。**需要登录**。身份完全取自 token。

放在 `/api/auth/` 下而非 `/api/users/`：这是**认证凭据变更**，不是资料编辑，与下方「用户接口（未实现）」是两类事。

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
- `sortBy` 白名单：文章 `createdAt` / `updatedAt` / `id`，默认 `createdAt desc`；评论 `createdAt` / `id`，默认 `createdAt desc`。
- 文章列表支持 `keyword` 模糊搜索，命中范围为**标题 + 正文**（不含作者昵称），详见 `GET /api/articles`。
- 时间字段返回 ISO 8601 UTC 字符串（契约 §9 时间小节）。
- 文章详情页需要显示评论数时，用 `GET /api/articles/:id/comments` 返回的 `total`；不额外开接口，不在文章表加冗余字段。
- **文章的点赞数 `likeCount` 由 `likes` 表实时 `COUNT(*)` 得出**（第十批），同样不在 `articles` 表加冗余列。列表与详情都返回它；**不返回 `liked`（当前用户是否已赞）**，原因见 `POST /api/articles/:id/like`。
- 作者信息以**内嵌 `author` 对象**（`id` / `username` / `nickname` / `avatar`）返回，不依赖用户接口。`avatar` 为第九批新增，语义与 `PUT /api/users/me` 的三态一致（可能为 `null`）；`bio` **不在** `author` 内，仅在 `PUT /api/users/me` 与个人主页相关位置返回。
- 作者被软删除时，MVP 阶段文章保留、`author` 正常返回；更细的处理策略（作者注销后文章是否可见）留到后续需求评估。

### 接口清单

| 方法     | 路径                         | 说明                         | 登录 |
| ------ | -------------------------- | -------------------------- | -- |
| PUT    | /api/auth/password         | 修改当前用户密码（详见通用接口一节）         | 是  |
| PUT    | /api/users/me              | 修改当前用户资料（头像 / 简介，详见业务接口一节） | 是  |
| POST   | /api/articles              | 发布文章                       | 是  |
| GET    | /api/articles              | 博客广场列表                     | 否  |
| GET    | /api/articles/:id          | 文章详情                       | 否  |
| PUT    | /api/articles/:id          | 编辑文章（仅作者）                  | 是  |
| DELETE | /api/articles/:id          | 删除文章（仅作者，软删除）              | 是  |
| POST   | /api/articles/:id/like     | 点赞文章（可对自己的文章点赞）             | 是  |
| DELETE | /api/articles/:id/like     | 取消点赞                        | 是  |
| POST   | /api/comments              | 发表评论                       | 是  |
| GET    | /api/articles/:id/comments | 文章评论列表                     | 否  |

---

### POST /api/articles

发布文章。**需要登录**。作者取 token 中的 `userId`。

请求体：

| 字段      | 类型     | 必填 | 校验                   |
| ------- | ------ | -- | -------------------- |
| title   | string | 是  | 1–100 字符，trim，不能为纯空格 |
| content | string | 是  | 1–20000 字符           |

> 备注：`content` 的数据库类型（`TEXT` 还是 `MEDIUMTEXT`）在 DB 阶段确定，见 `docs/DB.md`，不影响本接口契约。

```json
{
  "title": "我的第一篇博客",
  "content": "正文……"
}
```

成功：HTTP 201

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "title": "我的第一篇博客",
    "content": "正文……",
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
| sortBy   | string | 否  | 白名单 `createdAt` / `updatedAt` / `id`，默认 `createdAt` |
| order    | string | 否  | `asc` 或 `desc`，默认 `desc`                            |
| keyword  | string | 否  | 标题 + 正文模糊搜索；trim 后最长 50 字符，**空串或纯空白视为不搜索（等价于不传）**，返回全量列表       |

`keyword` 语义（三条，逐条都有验收断言）：

- **匹配范围**：对 `title` 与 `content` 做 `LIKE '%keyword%'` 模糊匹配，任一命中即返回该文章（`OR`）。**不匹配作者昵称 / 用户名** —— 作者维度筛选不在本期范围。
- **空串或纯空白视为不搜索**：`keyword=`（空串）、只含空白字符（如 `keyword=%20%20`）、或该参数完全不传，**三种情况等价**，都返回全量列表而非报错。前端清空搜索框时会发空串，不做这个容错会 400。
- **超长报错**：trim 后超过 50 字符返回 `400 / 40000`，message 为 `keyword 最多 50 个字符`。
- 与 `page` / `pageSize` / `sortBy` / `order` **正交**：搜索结果同样参与分页与排序，`total` 是命中总数而非全库总数。
- 已软删除的文章不参与搜索（与列表、详情口径一致）。

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
| list[].author    | object | 作者 `id` / `username` / `nickname`  |
| list[].likeCount | number | 该文章的点赞数（第十批新增），实时 `COUNT(*)`；不含 `liked` |

- `likeCount` 是**实时统计**而非冗余字段：由 `likes` 表 `COUNT(*)` 得出，不在 `articles` 表存列，因此永远不会与真实点赞数不一致。
- 列表**不返回 `liked`**（当前用户是否已赞）。这两个接口无需登录，若要在它们里区分「当前用户是否已赞」，就必须给 `auth` 中间件加「token 无效也不报错」的可选模式 —— 那会改动所有接口共用的中间件，影响面超出点赞功能本身。详见 `POST /api/articles/:id/like` 的「为什么不返回 `liked`」。

`summary` 为原始 `content` 截取，可能包含 Markdown 标记，前端负责渲染时清理。

失败：400 / 40000（分页参数非法，或 `keyword` 超长 / 格式非法）。

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
    "author": { "id": 1, "username": "demo", "nickname": "Demo", "avatar": null },
    "likeCount": 3,
    "createdAt": "2026-09-29T14:00:00.000Z",
    "updatedAt": "2026-09-29T14:00:00.000Z"
  }
}
```

`likeCount` 与列表口径一致（实时 `COUNT(*)`），同样**不返回 `liked`**。

失败：

| HTTP | code  | 场景         |
| ---- | ----- | ---------- |
| 400  | 40000 | id 非正整数    |
| 404  | 40400 | 文章不存在或已软删除 |

---

### PUT /api/articles/:id

编辑文章。**需要登录，且必须是作者本人**。全量更新，`title` 与 `content` 都必填。

路径参数：`id`，正整数。请求体同 `POST /api/articles`。

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

给 `auth` 加可选模式能解决这个问题，但**改的是所有接口共用的中间件**，影响面超出点赞这一项功能，属于契约第 12 节「一个改动影响超过 3 个功能点需先确认」的情形。因此本批采用：

- 列表 / 详情**只返回 `likeCount`，不返回 `liked`**；
- `liked` 由本接口与 `DELETE` 接口的**响应**给出。

**已知代价（用户已确认，单独排一批改善）**：已点赞的用户刷新详情页后，按钮仍显示「未赞」态（`likeCount` 是对的，只有按钮态不准）。此时再点一次会收到 `409`。MVP 可接受。

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

路径用 `/me` 而非 `/:id`：本接口**只允许改自己**，不接受路径参数指定用户。用 `PUT /api/users/:id` 会把「用户管理」语义一并打开（未来要加管理员功能时容易混淆），且路径参数可枚举。本项目 MVP 不做用户管理，**这是第一个 user 模块**。

请求头：

```text
Authorization: Bearer <token>
```

#### 请求体字段

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| avatar | string \| null | 否 | 1–255 字符；**必须以 `http://` 或 `https://` 开头**。不校验 URL 可达性 |
| bio | string \| null | 否 | 空串视为「清空」并转成 `null` 存储；非空时 1–200 字符 |

两个字段**都是可选的**，但**至少要传一个**（见下方「三态语义」与校验规则）。

```json
{
  "avatar": "https://cdn.example.com/a/1.png",
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
| `"avatar": "https://..."` / `"bio": "x"` | **设置** | 写入该字符串 |
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
| `avatar` 必须 `http://` / `https://` 开头 | 40000 | **安全要求**，见下方说明 |
| `bio` 长度 1–200 | 40000 | 空串已在入口转 `null`，不参与长度校验 |

**`avatar` 为什么必须挡伪协议**：零依赖方案下服务端不上传图片，前端会把这个 URL 直接渲染进`<img src>` / `background-image`。如果允许 `javascript:` 或 `data:`，就等于把 XSS 的执行权交给用户输入。限定 `http` / `https` 两种协议即可挡住这两类伪协议，同时不影响正常的图床链接（`https://cdn...`、外链http 图床等）。

**「至少有一个键出现」的确切含义**：判断依据是**请求体对象的自有键数量**（`Object.keys(body).length > 0`），**不是「有没有非 null 的值」**。

| 请求体 | 是否有效 | 原因 |
|---|---|---|
| `{}` | ❌ 40000 | 一个键都没有，等价于空操作 |
| `{ "avatar": null }` | ✅ **有效** | 键出现了，值是 `null` → **清空头像**，这是一次真实操作 |
| `{ "bio": "" }` | ✅ **有效** | 键出现了，空串按「清空简介」处理 |
| `{ "avatar": "https://..." }` | ✅ 有效 | 设置头像 |

> ⚠️ **实现时不要写成「至少有一个非 null 的值」**。那样 `{ "avatar": null }` 会被判为空操作而报 400，**用户将无法清空自己的头像**——清空是本接口必须支持的正常操作（头像 URL 会失效、用户换图想清掉旧的，都需要它）。
>
> 正确实现：先判断键是否存在（`Object.prototype.hasOwnProperty.call(body, 'avatar')` / `'bio'`），**再按三态语义决定写什么**，不要用「值是否为 null」来推断「用户是否想改这个字段」。

**为什么不校验 URL 可达性**：校验可达性需要发起外部 HTTP 请求，会让这个接口的耗时不可控（外部站点超时、慢速、挂掉都会拖住我们的接口），也违背「零依赖、不发额外网络请求」的约束。**代价是服务端不保证图片真实存在**，请调用方知悉：填一个不存在的 URL 时，接口会正常返回成功，但前端头像会加载失败（前端按 `img` 的 `error` 事件回退文字头像，见前端约定）。

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
    "avatar": "https://cdn.example.com/a/1.png",
    "bio": "写点自我介绍",
    "createdAt": "2026-09-29T12:49:05.911Z"
  }
}
```

前端拿到这个对象后应**直接用它更新本地 store**，不必再发一次 `GET /api/auth/me`。`data` 中**永远不含 `password`**。

#### 失败

| HTTP | code | message | 场景 |
|---|---|---|---|
| 400 | 40000 | 依据具体字段 | 请求体为空（无任何键）/ avatar 超长 / avatar 协议不合法 / bio 超长 |
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

### 用户接口（其余未实现）

契约第 5 节列出的用户类接口**保持未实现**：MVP 不需要用户管理，文章与评论的作者信息通过内嵌 `author` 对象返回。

第九批**只实现了 `PUT /api/users/me`**（修改自己的资料），这是本项目唯一的 user 接口。它位于「业务接口」一节，不在下表内。

| 方法 | 路径 | 状态 |
|---|---|---|
| GET | /api/users | 未实现 |
| GET | /api/users/:id | 未实现 |
| POST | /api/users | 未实现 |
| PUT | /api/users/:id | 未实现（**注意：与已实现的 `PUT /api/users/me` 是两个不同路径**，本项目不提供按 id 改他人资料的能力） |
| DELETE | /api/users/:id | 未实现 |

> 将来若要做「查看他人资料」，优先考虑 `GET /api/users/:id`（只读），而不是开放 `PUT /api/users/:id`。写操作一律走 `/me`。


### MVP 范围外（明确不做）

收藏、标签、评论删除、「只看我的文章」筛选。

> 说明 0：**点赞已实现**（第十批，`POST` / `DELETE /api/articles/:id/like`，列表与详情返回 `likeCount`），已从上表移出。遗留项：`liked`（当前用户是否已赞）不在列表 / 详情返回，刷新详情页后按钮态会显示为「未赞」，**单独排一批改善**。
>
> 说明 1：「只看我的文章」不涉及表结构变更，将来做「我的博客」页时，在 `GET /api/articles` 加一个可选 `authorId` 查询参数即可。
>
> 说明 2：**搜索已实现**（`GET /api/articles` 的 `keyword` 参数，命中标题 + 正文），已从上表移出。搜索**不含作者昵称**，也不做标签 / 分类聚合搜索。
>
> 说明 3：**头像文件上传明确不做**。第九批的 `avatar` 只存**外链 URL**（零依赖方案，见 `PUT /api/users/me`），用户需自行把图片传到图床再把链接填进来。若将来要做「站内上传」，需要引入文件上传中间件、对象存储与文件生命周期管理，属独立需求，届时本节重新论证。

---

## 前端调用约定

- 所有请求走 `frontend/src/api/request.js` 导出的 axios 实例。
- 响应拦截器约定：`code === 0` 直接返回 `data`；`code !== 0` 抛出携带 `message` 的 Error；HTTP 401 清除本地 token 并跳转登录页。
- `frontend/src/api/auth.js` 封装本文件的 auth 接口，组件与 store 不直接写 URL。
