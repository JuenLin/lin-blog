# 接口文档

> 前后端契约冲突时，以本文件为准（契约第 13 节第 15 条）。
> 通用约定见 `docs/AI_CONTRACT.md` 第 5、6 节；业务码、HTTP 状态码以契约第 6 节为准。

- 接口前缀：`/api`
- 数据格式：JSON，UTF-8
- 鉴权方式：`Authorization: Bearer <token>`
- 统一响应：成功 `{ code: 0, message: "ok", data: ... }`，失败 `{ code: 非0, message: "...", data: null }`

## 业务码

| code | 含义 |
|---|---|
| 0 | 成功 |
| 40000 | 参数错误 |
| 40100 | 未登录或 token 无效 |
| 40300 | 无权限 |
| 40400 | 资源不存在 |
| 40900 | 资源冲突 |
| 50000 | 服务器错误 |

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

| 字段 | 类型 | 说明 |
|---|---|---|
| status | string | 固定 `ok` |
| timestamp | string | 服务端当前时间，ISO 8601 UTC |
| uptime | number | 进程已运行秒数，取整 |

---

### POST /api/auth/register

注册。**无需登录**。

请求体：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| username | string | 是 | 3–50 字符，唯一 |
| password | string | 是 | 6–100 字符，bcryptjs 加密后入库 |
| nickname | string | 否 | 最多 50 字符 |

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

| HTTP | code | 场景 |
|---|---|---|
| 400 | 40000 | zod 校验不通过，`message` 为具体字段错误 |
| 409 | 40900 | 用户名已存在 |

---

### POST /api/auth/login

登录。**无需登录**。

请求体：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| username | string | 是 | 1–50 字符 |
| password | string | 是 | 1–100 字符 |

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
    "createdAt": "2026-09-29T12:49:05.911Z"
  }
}
```

失败：

| HTTP | code | 场景 |
|---|---|---|
| 401 | 40100 | 未提供 token、token 格式错、token 过期或签名无效 |
| 404 | 40400 | token 有效但用户不存在（已删除等） |

---

### PUT /api/auth/password

修改当前登录用户的密码。**需要登录**。身份完全取自 token。

放在 `/api/auth/` 下而非 `/api/users/`：这是**认证凭据变更**，不是资料编辑，与下方「用户接口（未实现）」是两类事。

请求头：

```text
Authorization: Bearer <token>
```

请求体：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| oldPassword | string | 是 | 1–100 字符，原样比对，不 trim（密码首尾空格有意义） |
| newPassword | string | 是 | 6–100 字符，不 trim；UTF-8 编码后不超过 72 字节；不得与 oldPassword 相同 |

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

| HTTP | code | message | 场景 |
|---|---|---|---|
| 400 | 40000 | 依据具体字段 | oldPassword 为空 / newPassword 少于 6 个字符 / newPassword 超过 100 个字符 / newPassword 超过 72 字节 / newPassword 与 oldPassword 相同 |
| 400 | 40000 | 不允许修改其他用户的密码 | 请求体携带 `userId` / `id` / `username` |
| 401 | 40100 | 用户名或密码错误 | oldPassword 与当前密码不匹配（含「用户不存在」，不区分以免成为账号枚举接口） |
| 401 | 40100 | — | 未提供 token、token 格式错、token 过期或签名无效（`auth` 中间件既有行为） |
| 404 | 40400 | 用户不存在 | token 有效但用户不存在（已删除等），与 `GET /api/auth/me` 口径一致 |
| 500 | 50000 | — | 未预期错误 |

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
- 作者信息以**内嵌 `author` 对象**（`id` / `username` / `nickname`）返回，不依赖用户接口。
- 作者被软删除时，MVP 阶段文章保留、`author` 正常返回；更细的处理策略（作者注销后文章是否可见）留到后续需求评估。

### 接口清单

| 方法 | 路径 | 说明 | 登录 |
|---|---|---|---|
| PUT | /api/auth/password | 修改当前用户密码（详见通用接口一节） | 是 |
| POST | /api/articles | 发布文章 | 是 |
| GET | /api/articles | 博客广场列表 | 否 |
| GET | /api/articles/:id | 文章详情 | 否 |
| PUT | /api/articles/:id | 编辑文章（仅作者） | 是 |
| DELETE | /api/articles/:id | 删除文章（仅作者，软删除） | 是 |
| POST | /api/comments | 发表评论 | 是 |
| GET | /api/articles/:id/comments | 文章评论列表 | 否 |

---

### POST /api/articles

发布文章。**需要登录**。作者取 token 中的 `userId`。

请求体：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| title | string | 是 | 1–100 字符，trim，不能为纯空格 |
| content | string | 是 | 1–20000 字符 |

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
    "author": { "id": 1, "username": "demo", "nickname": "Demo" },
    "createdAt": "2026-09-29T14:00:00.000Z",
    "updatedAt": "2026-09-29T14:00:00.000Z"
  }
}
```

失败：

| HTTP | code | 场景 |
|---|---|---|
| 400 | 40000 | zod 校验不通过，`message` 为具体字段错误 |
| 401 | 40100 | 未提供 token、token 无效或过期 |

---

### GET /api/articles

博客广场列表。**无需登录**。

查询参数：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| page | number | 否 | 默认 1 |
| pageSize | number | 否 | 默认 10，最大 100 |
| sortBy | string | 否 | 白名单 `createdAt` / `updatedAt` / `id`，默认 `createdAt` |
| order | string | 否 | `asc` 或 `desc`，默认 `desc` |
| keyword | string | 否 | 标题 + 正文模糊搜索；trim 后最长 50 字符，**空串视为不传**（等价于不搜索） |

`keyword` 语义（三条，逐条都有验收断言）：

- **匹配范围**：对 `title` 与 `content` 做 `LIKE '%keyword%'` 模糊匹配，任一命中即返回该文章（`OR`）。**不匹配作者昵称 / 用户名** —— 作者维度筛选不在本期范围。
- **空串视为不传**：`keyword=`（空串）或只含空白字符时，等价于不传该参数，返回全量列表而非报错。前端清空搜索框时会发空串，不做这个容错会 400。
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
        "author": { "id": 1, "username": "demo", "nickname": "Demo" },
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

| 字段 | 类型 | 说明 |
|---|---|---|
| list[].summary | string | 后端截取 `content` 前 100 字符，列表不返回全文 |
| list[].author | object | 作者 `id` / `username` / `nickname` |

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
    "author": { "id": 1, "username": "demo", "nickname": "Demo" },
    "createdAt": "2026-09-29T14:00:00.000Z",
    "updatedAt": "2026-09-29T14:00:00.000Z"
  }
}
```

失败：

| HTTP | code | 场景 |
|---|---|---|
| 400 | 40000 | id 非正整数 |
| 404 | 40400 | 文章不存在或已软删除 |

---

### PUT /api/articles/:id

编辑文章。**需要登录，且必须是作者本人**。全量更新，`title` 与 `content` 都必填。

路径参数：`id`，正整数。请求体同 `POST /api/articles`。

成功：HTTP 200，`data` 结构同「文章详情」（更新后的内容）。

失败：

| HTTP | code | 场景 |
|---|---|---|
| 400 | 40000 | id 非法或 zod 校验不通过 |
| 401 | 40100 | 未登录或 token 无效 |
| 403 | 40300 | 不是作者本人 |
| 404 | 40400 | 文章不存在或已软删除 |

判断顺序：**先查文章是否存在（不存在返回 404），再判断是否为作者（非作者返回 403）**。不得先判断作者，避免通过 403 / 404 的差异枚举真实存在的文章 id。

---

### DELETE /api/articles/:id

删除文章。**需要登录，且必须是作者本人**。软删除（设置 `deletedAt`）。

成功：HTTP 200，`data` 为 `null`。

失败：

| HTTP | code | 场景 |
|---|---|---|
| 400 | 40000 | id 非正整数 |
| 401 | 40100 | 未登录或 token 无效 |
| 403 | 40300 | 不是作者本人 |
| 404 | 40400 | 文章不存在或已软删除（含重复删除） |

判断顺序：**先查文章是否存在（不存在返回 404），再判断是否为作者（非作者返回 403）**。不得先判断作者，避免通过 403 / 404 的差异枚举真实存在的文章 id。

删除后，该文章的评论数据保留，但随文章一起不可见。

---

### POST /api/comments

发表评论。**需要登录**。评论者取 token 中的 `userId`。

请求体：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| articleId | number | 是 | 正整数 |
| content | string | 是 | 1–500 字符，trim |

成功：HTTP 201

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "articleId": 1,
    "content": "写得好",
    "author": { "id": 1, "username": "demo", "nickname": "Demo" },
    "createdAt": "2026-09-29T14:05:00.000Z"
  }
}
```

失败：

| HTTP | code | 场景 |
|---|---|---|
| 400 | 40000 | zod 校验不通过 |
| 401 | 40100 | 未登录或 token 无效 |
| 404 | 40400 | 文章不存在或已软删除 |

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
        "author": { "id": 1, "username": "demo", "nickname": "Demo" },
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

### 用户接口（未实现）

契约第 5 节列出的用户类接口**保持未实现**：MVP 不需要用户管理，文章与评论的作者信息通过内嵌 `author` 对象返回。

| 方法 | 路径 | 状态 |
|---|---|---|
| GET | /api/users | 未实现 |
| GET | /api/users/:id | 未实现 |
| POST | /api/users | 未实现 |
| PUT | /api/users/:id | 未实现 |
| DELETE | /api/users/:id | 未实现 |

### MVP 范围外（明确不做）

点赞、收藏、标签、评论删除、「只看我的文章」筛选。

> 说明 1：「只看我的文章」不涉及表结构变更，将来做「我的博客」页时，在 `GET /api/articles` 加一个可选 `authorId` 查询参数即可。
>
> 说明 2：**搜索已实现**（`GET /api/articles` 的 `keyword` 参数，命中标题 + 正文），已从上表移出。搜索**不含作者昵称**，也不做标签 / 分类聚合搜索。

---

## 前端调用约定

- 所有请求走 `frontend/src/api/request.js` 导出的 axios 实例。
- 响应拦截器约定：`code === 0` 直接返回 `data`；`code !== 0` 抛出携带 `message` 的 Error；HTTP 401 清除本地 token 并跳转登录页。
- `frontend/src/api/auth.js` 封装本文件的 auth 接口，组件与 store 不直接写 URL。
