# 数据库文档

> 表结构变更必须先更新本文件并取得确认（契约第 13 节第 5 条）。
> 命名、时间、软删除约定见 `docs/AI_CONTRACT.md` 第 9 节。

## 环境

| 项 | 值 |
|---|---|
| 数据库 | MySQL 8.0.46 |
| 端口 | 3306 |
| 字符集 / 排序规则 | utf8mb4 / utf8mb4_unicode_ci |
| 主库 | `workbuddy_dev` |
| Shadow 库 | `workbuddy_dev_shadow`（仅 Prisma Migrate 使用，业务不写入） |
| 项目账号 | `workbuddy_dev`（专用账号，不使用 root） |
| 账号权限 | `workbuddy_dev.*` 与 `workbuddy_dev_shadow.*` 的 ALL PRIVILEGES |

环境变量：

```env
DATABASE_URL="mysql://workbuddy_dev:你的密码@localhost:3306/workbuddy_dev"
SHADOW_DATABASE_URL="mysql://workbuddy_dev:你的密码@localhost:3306/workbuddy_dev_shadow"
```

---

## 表清单

| 表名 | 说明 | 状态 |
|---|---|---|
| `users` | 用户表 | 已建（迁移 `20260929123151_init`），第九批新增 `avatar` / `bio` 两列（迁移 `20261003080727_add_user_avatar_bio`） |
| `articles` | 文章表 | 已建（迁移 `20260929144738_blog_articles_comments`） |
| `comments` | 评论表 | 已建（迁移 `20260929144738_blog_articles_comments`） |
| `likes` | 文章点赞表（第十批） | **待迁移**（schema 已改，尚未执行 `migrate dev`） |
| `_prisma_migrations` | Prisma 迁移记录表，自动生成 | 已存在 |

---

## 外键命名规则

本项目**不采用「目标表名 + `_id`」一刀切**，而是按「业务角色」命名外键列：

| 规则 | 列名 | 说明 |
|---|---|---|
| 有明确业务角色 → 用角色名 | `author_id` | 作者。`articles` 与 `comments` 两张表**统一用 `author_id`**，不用 `user_id` |
| 用户本人（非作者角色） → `user_id` | `user_id` | 点赞者。`likes` 表用 `user_id`，见下方说明 |
| 无特殊角色 → 目标实体单数名 + `_id` | `article_id` | 评论所属文章 / 点赞所属文章，角色就是「所属对象」本身，无更具体的业务角色名 |

- 选 `author_id` 而非 `user_id` 的理由：`articles` / `comments` 里的这个外键表达的是「作者」这一业务角色，且 `docs/API.md` 的作者信息以 `author` 对象（`id` / `username` / `nickname`）返回，DB 列名与 API 字段名呼应，读代码时不用做心智转换。
- Prisma 侧字段名用 camelCase（`authorId` / `articleId`），关系字段名为 `author` / `article`；`User` 模型侧的反向关系为 `articles` / `comments`。
- 一致性要求：**凡是「作者」语义的外键一律 `author_id`**，即使指向 `users` 表也不写成 `user_id`；反过来，若某表的 `user_id` 表达的是「用户本人」而非「作者」则用 `user_id`。
- **`likes` 表用的是 `user_id`（第十批）**：点赞者是「用户本人」而非「作者」。本条是该规则写下时预留的两种情形之一（另一种是当时举例的收藏表 `favorites`），现由`likes` 落地。Prisma 侧字段名 `userId`、关系字段名 `user`，`User` 模型侧反向关系为 `likes`。
- 该规则是**设计变更**：初版 DB 设计草案写的是 `userId → user_id`，最终按上述理由改为 `authorId → author_id`，已在本书面登记。

---

## articles（文章表）

Prisma 模型名 `Article`，`@@map("articles")`。

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键 |
| title | title | VARCHAR(100) | 否 | 无 | 标题，API 校验 1–100 字符 |
| content | content | MEDIUMTEXT | 否 | 无 | 正文，API 校验 1–20000 字符 |
| authorId | author_id | INT | 否 | 无 | 作者 id，外键 → `users.id` |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 创建时间 |
| updatedAt | updated_at | DATETIME(3) | 否 | 无 | 更新时间，Prisma `@updatedAt` 应用层维护 |
| deletedAt | deleted_at | DATETIME(3) | 是 | NULL | 软删除时间，NULL 表示未删除 |

### `content` 为什么是 MEDIUMTEXT

- `TEXT` 上限是 65535 **字节**而非字符。utf8mb4 下中文 3 字节、emoji 4 字节：20000 纯中文 = 60000 字节放得下，20000 个 emoji = 80000 字节会溢出。
- `MEDIUMTEXT` 上限 16MB，相比 `TEXT` 只多 1 字节长度前缀。
- 结论：**接口上限维持 1–20000 字符不变，存储层用 `MEDIUMTEXT` 兜底**——接口不迁就存储，也不为了省 1 字节去压缩用户的表达空间。
- InnoDB DYNAMIC 行格式下大字段存 off-page，行内只留指针，MVP 阶段无性能影响。

### 索引

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | id | |
| articles_deleted_at_created_at_idx | 普通 | deleted_at, created_at | 广场列表默认 `createdAt desc` |
| articles_deleted_at_updated_at_idx | 普通 | deleted_at, updated_at | 列表 `sortBy=updatedAt`（不建会 filesort） |
| articles_author_id_fkey | 普通（外键自动创建） | author_id | 外键索引 |

> **搜索（`keyword`）没有索引，是刻意为之**：`GET /api/articles` 的 `keyword` 走 `LIKE '%kw%'`（前缀带 `%`），B-tree 索引在这种模式下用不上，加普通索引只会成为**死索引**（白白占写入开销却从不命中）。真正的提速方案是 MySQL `FULLTEXT` 全文索引（需 `ngram` 解析器支持中文分词），但那要先确认 MySQL 版本与分词器可用性，属独立需求。
>
> 当前 MVP 数据量（文章两位数）下全表扫描完全可接受，故**暂不建任何搜索索引**。若将来文章量增长到扫描变慢，再评估 `FULLTEXT` 并按第 6 节的迁移流程登记。

### 建表 SQL（迁移生成，未手工改写）

```sql
CREATE TABLE `articles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(100) NOT NULL,
    `content` MEDIUMTEXT NOT NULL,
    `author_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `articles_deleted_at_created_at_idx`(`deleted_at`, `created_at`),
    INDEX `articles_deleted_at_updated_at_idx`(`deleted_at`, `updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `articles` ADD CONSTRAINT `articles_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

---

## comments（评论表）

Prisma 模型名 `Comment`，`@@map("comments")`。

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键 |
| articleId | article_id | INT | 否 | 无 | 所属文章 id，外键 → `articles.id` |
| authorId | author_id | INT | 否 | 无 | 评论者 id，外键 → `users.id` |
| content | content | VARCHAR(500) | 否 | 无 | 评论内容，API 校验 1–500 字符 |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 创建时间 |
| updatedAt | updated_at | DATETIME(3) | 否 | 无 | 更新时间，Prisma `@updatedAt` 应用层维护 |
| deletedAt | deleted_at | DATETIME(3) | 是 | NULL | 软删除时间，NULL 表示未删除 |

`deletedAt` 保留的依据是契约 §9「每张业务表建议包含」的通用字段，且 `whereNotDeleted()` 统一覆盖可避免遗漏；MVP 无评论删除接口，该列当前恒为 NULL，成本可忽略。

### 索引

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | id | |
| comments_article_id_created_at_idx | 普通 | article_id, created_at | 「某篇文章的评论列表」主查询：`article_id = ?` + `created_at desc` + 分页 |
| comments_author_id_fkey | 普通（外键自动创建） | author_id | 外键索引 |

- `article_id` 的外键索引由 `comments_article_id_created_at_idx` 的**左前缀**承担，MySQL 未额外创建单列索引。
- **索引里没有 `deleted_at`，是刻意的**：MVP 没有评论删除接口，该列恒为 NULL，放进索引等于索引一个常量，不提供任何选择性，只让每条索引记录多出约 8 字节。若将来真做评论删除，加回 `(article_id, deleted_at, created_at)` 只需一条迁移。

### 建表 SQL（迁移生成，未手工改写）

```sql
CREATE TABLE `comments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `article_id` INTEGER NOT NULL,
    `author_id` INTEGER NOT NULL,
    `content` VARCHAR(500) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `comments_article_id_created_at_idx`(`article_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `comments` ADD CONSTRAINT `comments_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `comments` ADD CONSTRAINT `comments_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

---

## users（用户表）

Prisma 模型名 `User`，`@@map("users")`。

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键 |
| username | username | VARCHAR(50) | 否 | 无 | 用户名，唯一索引 |
| password | password | VARCHAR(255) | 否 | 无 | bcryptjs 哈希，禁止明文 |
| nickname | nickname | VARCHAR(50) | 是 | NULL | 昵称 |
| avatar | avatar | VARCHAR(255) | 是 | NULL | 头像 URL，第九批新增。零依赖方案：只存外链字符串，服务端不存文件、不校验可达性 |
| bio | bio | VARCHAR(200) | 是 | NULL | 个人简介，第九批新增 |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 创建时间 |
| updatedAt | updated_at | DATETIME(3) | 否 | 无 | 更新时间，Prisma `@updatedAt` 应用层维护 |
| deletedAt | deleted_at | DATETIME(3) | 是 | NULL | 软删除时间，NULL 表示未删除 |

`User` 模型上的 `articles Article[]` / `comments Comment[]` 是**反向关系字段，Prisma 虚拟字段，不产生任何列**，因此加它们不会ALTER `users` 表（已实测确认）。

### 第九批新增字段（avatar / bio）—— schema 变更已获批准，**迁移已执行**

> **本节是一次「禁止修改数据库 schema」例外的书面登记。**
> 契约第 5 节「禁止修改数据库 schema」在本次**经用户明确批准后豁免**。
> 批准范围：**仅限本次新增 `users.avatar` 与 `users.bio` 两列**，
> 不含任何其他表结构变更、不含改列名/类型、不含删列。
> 批准依据与决策过程见 `docs/API.md` 的 `PUT /api/users/me` 章节。
> **迁移已于 2026-10-03 执行**（`20261003080727_add_user_avatar_bio`），实际结构见本小节末尾与下方建表 SQL。

**为什么必须改 schema 而不能复用 `nickname`**（这是本次豁免的核心论证，登记备查）：

| 理由 | 说明 |
|---|---|
| 语义冲突 | `nickname` 被 `UserProfile` / `ArticleCard` / `AuthorCard` / `UserDropdown` 四处当作**显示名**使用，塞入 URL 或长文本会直接破坏这四处 UI |
| 长度不足 | `nickname` 是 `VARCHAR(50)`，而头像 URL 典型长度 100~200 字符，50 字符放不下 |
| 探针冲突 | `probe-search.mjs` 有一条「昵称不应被 keyword 搜到」的泄漏断言，往`nickname` 塞 URL 会让昵称变得像搜索关键词，污染该断言的语义 |

**为什么选`VARCHAR` 而不是 `TEXT`**：MySQL `VARCHAR` 长度受行大小限制但索引友好、`avatar` 未来可能加唯一性或排序需求；255 与 200 都在utf8mb4 下远低于行大小上限。排除 `TEXT` 的理由是 `TEXT` 上限按**字节**计（65535 字节），头像 URL 场景用不上却要付出 off-page 存储代价。

**头像为什么只存URL 而不上传文件**：本项目**不引入任何新依赖**（契约第 5 节「禁止擅自引入新依赖」），文件上传需要 `multer` 之类的中间件，且要配套对象存储。零依赖方案下用户自己把图片传到图床，把链接填进来。代价是**服务端不保证图片真实存在**，因此 API 层只做「必须以 `http://` 或 `https://` 开头」的格式校验（挡掉 `javascript:` / `data:` 这类会构成 XSS 的伪协议），**不发起任何网络请求校验可达性**——否则每次改资料都要等外部 HTTP 响应，接口会变得不可控。

**`avatar` / `bio` 均 nullable 的影响**：现有用户（`demo` / `admin`）迁移后这两个字段为 `NULL`，**无需回填数据**。前端渲染头像时 `NULL` 必须回退到基于昵称生成的头像首字（现有 `getAvatarText` 逻辑），不能直接渲染 `<img src="null">`。

**内嵌 author 对象的字段边界**：`avatar` 会进入文章与评论的内嵌 `author` 对象（两处 `AUTHOR_SELECT`，见 `docs/API.md`），`bio` **不会**——简介只在个人主页展示，塞进每条评论的 author 里是纯粹的响应体浪费。两处 `AUTHOR_SELECT` 当前是**重复定义**，本期按「只加字段、不做重构」处理，抽取公共定义单独排一批。


### 索引

| 索引名 | 类型 | 列 |
|---|---|---|
| PRIMARY | 主键 | id |
| users_username_key | 唯一 | username |

### 建表 SQL（迁移生成，未手工改写）

> 下方是**迁移执行后** `SHOW CREATE TABLE users` 的实际输出（2026-10-03 第九批核对）。
> 注意 MySQL 把 `int` 归一化成了小写 `int`，并为每个字符串列显式补上了
> `COLLATE utf8mb4_unicode_ci`——这两处与 Prisma schema 的写法不同但属正常归一化，**不是差异**。
> 与迁移前相比仅新增 `avatar` / `bio` 两列，索引、字符集、外键均未变化。

```sql
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `nickname` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `deleted_at` datetime(3) DEFAULT NULL,
  `avatar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `bio` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_username_key` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
```

### 第九批的迁移 SQL（实际生成）

```sql
-- AlterTable
ALTER TABLE `users` ADD COLUMN `avatar` VARCHAR(255) NULL,
    ADD COLUMN `bio` VARCHAR(200) NULL;
```

**迁移是纯 `ADD COLUMN`，不含任何数据回填语句**。两列均 nullable 且无默认值，MySQL 对既有行直接填 `NULL`；已核对 `demo`（id=1）与 `admin`（id=2）迁移后 `avatar` / `bio` 均为 `NULL`，符合预期，**不需要回填脚本**。


---

## likes（点赞表）

Prisma 模型名 `Like`，`@@map("likes")`。**第十批新增，迁移尚未执行。**

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键（代理键，无业务含义） |
| userId | user_id | INT | 否 | 无 | 点赞人 id，外键 → `users.id` |
| articleId | article_id | INT | 否 | 无 | 被点赞文章 id，外键 → `articles.id` |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 点赞时间 |

**本表刻意不设 `updated_at` 与 `deleted_at`**，与 `articles` / `comments` 不同，原因见下方「为什么没有软删除列」。

### schema 变更已获批准（豁免登记）

> **本节是一次「禁止修改数据库 schema」例外的书面登记。**
> 契约第 5 节「禁止修改数据库 schema」在本次**经用户明确批准后豁免**。
> 批准范围：**仅限新建`likes` 一张表**（含其两条外键与两个索引），
> **不含修改 `users` / `articles` / `comments` 任何一列**。
> 批准依据与决策过程见 `docs/API.md` 的 `POST /api/articles/:id/like` 章节。
>
> 注意：第九批的豁免明确写了「仅限那两列，除此之外的任何 schema 变更仍需重新批准」，
> 因此**本次是独立的一次批准，不是援引第九批的例外**。
> 契约 `AI_CONTRACT.md` 第 69 行的例外说明**本批不修改**（按用户要求，豁免只登记在本书）。

### 为什么必须有独立表（不能复用现有表加列）

| 理由 | 说明 |
|---|---|
| 多对多 | 一篇文章被N 个用户点赞，一个用户点赞 M 篇文章，是标准的多对多关系，`users` / `articles` 两张表都放不下 |
| 不能在 `articles` 加冗余列存 id 列表 | 用 `VARCHAR` 存逗号分隔的 user_id 列表，无法索引、无法保证原子性、并发下必然错乱 |
| 不能靠 `comments.content` 标记 | 语义完全不同（点赞不是评论），且会让「评论数」统计掺入点赞 |

### 唯一约束是防重复点赞的唯一真相

`@@unique([userId, articleId])`（`likes_user_id_article_id_key`）。

应用层「先查 `findUnique` 再 `create`」**存在竞态窗口**：两个并发请求都在对方写入前查到「未赞过」，然后都执行 INSERT，产生两条重复记录。只有 DB 唯一约束能真正防住—— service 层捕获 Prisma 的 `P2002` 转成`409 /40900`（「已点赞过这篇文章」）。

**这意味着实现层不允许「先查后写」当作正确性保障**，它只能用来给出更友好的提示；真正的拦截靠唯一约束。

### 为什么 `article_id` 要单独建索引

`@@index([articleId])`（`likes_article_id_idx`）支撑两处高频查询：

1. **实时 `likeCount`**：`SELECT COUNT(*) FROM likes WHERE article_id = ?` —— 列表与详情接口都要用
2. 「某篇文章的点赞明细」（将来若做）

`user_id` 侧**不另建索引**：`likes_user_id_article_id_key` 的左前缀已承担 `WHERE user_id = ?`，MySQL 不会重复创建。迁移执行后需用 `SHOW INDEX FROM likes` 核实这一点。

### 为什么没有软删除列

`likes` 是本项目**第一张不做软删除的业务表**，这是刻意偏离契约第 9 节「每张业务表建议包含 `deleted_at`」的结果，理由：

- **点赞是一个动作，不是一条可隐藏的内容**。`articles` / `comments` 软删是为了「从列表里消失但保留数据」，点赞没有「隐藏但保留」的语义。
- **软删会与唯一约束直接冲突**：若取消点赞时置 `deleted_at` 而保留行，那么同一 `(user_id, article_id)` 取消后再点赞会撞唯一约束，只能改成 `UPDATE ... SET deleted_at = NULL` 而不是 `INSERT`。这样一来「点赞 = 该行存在且未删除」这个不变式就不再直观，且每次查询都要额外带 `deleted_at IS NULL` 条件 —— 为一个没有语义需求的场景付出复杂度，不值。
- **物理 DELETE 让不变式始终成立**：`likes` 表里存在一行 ⟺ 该用户赞了这篇文章。计数只需 `COUNT(*)`，无需任何额外条件。

### 软删除联动：文章/ 用户软删后点赞行会残留

与其他表一致，**软删除不触发外键**，因此：

| 场景 | 行为 |
|---|---|
| 文章软删 | `likes` 行**保留**，不连带删除。`GET /api/articles` / `/:id` 已按 `deleted_at IS NULL` 过滤，文章不可见→ `likeCount` 不会外泄 |
| 对已软删的文章调 `POST /like` | **404**。service 层先复用 `requireArticleForWrite(id)` 判定存在性（与发表评论完全同一条路径） |
| 用户软删 | 该用户的 `likes` 行保留。**注意：仍会计入 `likeCount`** —— 计数只按 `article_id` 过滤，不过滤点赞者。当前 MVP 无用户删除功能故不触发，已登记在「已知限制」第 3 条 |
| 将来物理清理（硬删除） | 顺序必须是 `likes → comments → articles → users`，`likes` 是最上游 |

**这与评论的现有处理完全一致**（`deleteArticle` 的注释原文：「只 UPDATE deleted_at，物理行保留，因此不触发外键」）。点赞行残留**不是bug**，与评论行残留是同一个设计取舍。

### 建表 SQL

下方是**迁移执行后** `SHOW CREATE TABLE likes` 的实际输出（2026-10-03 第十批核对）。
与 Prisma schema 一致：无 `deleted_at` / `updated_at` 两列，`user_id` 未被额外补索引。

```sql
CREATE TABLE `likes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `article_id` int NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `likes_user_id_article_id_key` (`user_id`,`article_id`),
  KEY `likes_article_id_idx` (`article_id`),
  CONSTRAINT `likes_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `articles` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `likes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
```

### 索引（实际核对结果）

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | id | |
| likes_user_id_article_id_key | **唯一** | user_id, article_id | **防重复点赞的唯一真相**，并发下由 MySQL 最终拦截（重复插入报 `1062`） |
| likes_article_id_idx | 普通 | article_id | 支撑 `likeCount` 的实时 `COUNT(*)` |

- ✅ **MySQL 没有为 `user_id` 额外补单列索引** —— 唯一索引的左前缀已承担，符合设计预期（已用 `SHOW INDEX FROM likes` 实测）。

### 第十批的迁移 SQL（实际生成）

```sql
-- CreateTable
CREATE TABLE `likes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `article_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `likes_article_id_idx`(`article_id`),
    UNIQUE INDEX `likes_user_id_article_id_key`(`user_id`, `article_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `likes` ADD CONSTRAINT `likes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `likes` ADD CONSTRAINT `likes_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

**新表无既有数据，不涉及任何回填。**

### 约束实测（迁移后当场验证）

唯一约束与外键都用**真实插入**证过，不依赖后端代码：

| 用例 | 结果 |
|---|---|
| 插入 `(user_id=1, article_id=7)` | 成功 |
| 再插入完全相同的一条 | **被拒** —— MySQL `1062 Duplicate entry '1-7' for key 'likes.likes_user_id_article_id_key'` |
| 给不存在的文章（id=999999）点赞 | **被拒** —— MySQL `1452` 外键 `likes_article_id_fkey` 失败 |
| 清理后 `likes` 行数 | **0**（测试数据已回收，基线未变） |

> 这证明了「DB 唯一约束是唯一真相」这条设计**在数据库层面确实成立**。
> 后续后端代码要做的只是把这份 `1062`（Prisma 侧即 `P2002`）翻译成 `409 / 40900`。

### Prisma Client 生成状态（待知会用户）

> ⚠️ **本次 `migrate dev` 建表成功，但末尾的 `prisma generate` 失败（EPERM）**。
> 详见迁移记录小节末尾的说明，**不影响本步结论**（表结构已确认正确）。DL
```

---

## 查询约定

- 软删除：删除操作设置 `deletedAt`，不做物理删除；如需硬删除必须明确说明。
- 所有查询默认带 `deletedAt: null`，统一走 `backend/src/utils/query.js` 的 `whereNotDeleted()`，**禁止在业务代码里手写 `deletedAt: null`**。
- 排序统一走 `buildOrderBy()`，主排序来自 `parsePagination()` 的白名单，次级默认加 `id` 保证顺序稳定。
- 不使用 `SELECT *`，查询时显式 `select` 所需字段。
- 对外接口不返回 `password` 字段。
- 时间字段数据库存 UTC，接口返回 ISO 8601（带 `Z`），由前端转本地时间显示。

---

## 软删除与外键的交互

> 第十批起共**五条**外键（原有三条 + `likes` 表的两条），全部是 `ON DELETE RESTRICT ON UPDATE CASCADE`（Prisma 默认值，schema 中未显式声明 `onDelete`，已在迁移 SQL 中核对确认）。

- **软删除不触发外键**：删除文章是 `UPDATE articles SET deleted_at = ...`，物理行仍在，`comments.article_id` 与 `likes.article_id` 的引用依然有效，因此**评论与点赞都不被连带删除、不被连带置为删除**，也不需要任何 CASCADE 配置。
- 这正是「文章软删、评论保留但随文章不可见」的实现基础：评论数据原样保留，接口层先校验文章存在且未软删除（返回 404），评论列表随文章一起不可见。点赞同理。
- **将来若要物理清理**（硬删除），顺序必须是：

```text
likes → comments → articles → users
```

  RESTRICT 会在顺序错误时直接拒绝：`DELETE FROM users` 若该用户还有文章 / 评论 / 点赞会报错；`DELETE FROM articles` 若还有评论或点赞挂载也会报错。这个报错是保护，不是 bug——发现报错说明漏了上游清理步骤。
  特别注意**必须先清 `likes`**：它是唯一一张上游可能「悬挂」在被软删对象上的表。

---

## summary 来源（列表接口）

`GET /api/articles` 的 `list[].summary` 由后端截取 `content` 前 100 个字符得到，不在表里存冗余列。

**截取必须 Unicode 安全**：JS 的 `content.slice(0, 100)` 按 UTF-16 码元切，会拦腰截断 emoji 等代理对，产生半个代理项（渲染成乱码或替换字符）。实现用：

```js
const summary = [...content].slice(0, 100).join('');
```

`[...content]` 按码点展开，代理对不会被拆开。这是 **service 层实现细节**，不属于表结构。

补充：`summary` 是原始 `content` 截取，可能包含 Markdown 标记，前端负责渲染时清理。

---

## 注意事项

1. **`updated_at` 是 `NOT NULL` 且无 DEFAULT**。这是 Prisma `@updatedAt` 的正常行为——值由 Prisma Client 在应用层维护（创建时写入当前时间，更新时自动刷新），不是数据库层。副作用：**用 SQL 客户端裸 INSERT 且不指定 `updated_at` 会失败**（MySQL 严格模式下报 `Error 1364: Field 'updated_at' doesn't have a default value`）。手工插数据必须显式给值：

   ```sql
   INSERT INTO articles (title, content, author_id, created_at, updated_at)
   VALUES ('标题', '正文', 1, NOW(3), NOW(3));
   ```

   已存在的 `users` 表同样是这个行为，不是新表特有。

2. **外键索引由 MySQL 自动创建**，Prisma 的 `migration.sql` 里不写。若某外键列已被某复合索引作为左前缀覆盖（如 `comments.article_id`），MySQL 不会再建重复索引。写复合索引时可以利用这一点，但不要指望它——改索引前先 `SHOW CREATE TABLE` 确认。

3. **`content` 是 `MEDIUMTEXT`**，接口层仍按 1–20000 字符校验；不要用 SQL 客户端插入超大正文绕开校验，Prisma Client 写入时会受 zod 校验保护，裸 SQL 不会。

4. **表结构变更流程**：改 `backend/prisma/schema.prisma` → 更新本文档 → `npx prisma migrate dev --name <名字>` → 核对生成的 `migration.sql` 与 `SHOW CREATE TABLE` 实际输出。

---

## 已知限制

以下两条是本阶段刻意不处理的，登记在此，将来不用重新论证。

1. **更新 / 删除的并发缺口**：`updateArticle` / `deleteArticle` 的写入语句是 `prisma.article.update({ where: { id } })`，where 只按主键。「校验文章存在且是作者」与「写入」分两步，不是原子操作，极端时序下会出现 last-write-wins（覆盖掉另一条并发请求刚写入的内容，或对已被软删的文章再次软删）。
   - MVP 阶段不处理。触发条件：出现真实的竞态 bug，或将来出现多人协作编辑同一篇文章的需求。
   - 处理方向：把 where 收紧为 `{ id, authorId, deletedAt: null }`，越权或已删除时命中 0 行（Prisma 抛 `P2025` → 转 404）；需要更强保证时再上事务或乐观锁（`version` 列）。

2. **列表查询拉取全文**：`GET /api/articles` 要生成 summary，必须 select `content`（MEDIUMTEXT），`pageSize` 拉满 100 时一次取 100 条全文。
   - MVP 阶段不处理。触发条件：真实数据量上升，列表接口耗时不可接受。
   - 处理方向：① 把截取下沉到 SQL（`SUBSTRING(content, 1, 100)`，MySQL 按字符计数、天然安全，但会把截取逻辑从 service 层挪进 SQL，可测试性变差）② 写入时把 summary 落成真实列（与「列表不存冗余字段」的当前约定冲突，需重新评估）③ 收紧 `pageSize` 上限。

3. **`likeCount` 包含已软删用户投出的赞**：`likeCount` 是 `SELECT COUNT(*) FROM likes WHERE article_id = ?`，**只按文章过滤，不过滤点赞者**。因此某个用户被软删后，他此前投出的赞**仍然计入**该文章的 `likeCount`。
   - **当前可接受**：MVP 没有用户删除功能（`DELETE /api/users/:id` 未实现），`users.deleted_at` 恒为 NULL，实际不会出现这种数据。
   - 触发条件：将来做了用户注销 / 禁用功能。
   - 处理方向：把计数改成 `JOIN users u ON u.id = l.user_id AND u.deleted_at IS NULL`，代价是每次计数都要 JOIN（列表接口每篇文章一次）。
   - ⚠️ 与「文章软删」不要混淆：**文章**软删后该文**整体不可见**（`articles.deleted_at IS NULL` 过滤在前），其 `likeCount` 不会外泄；本条说的是**点赞者**被软删的情形，两者不同。

---

## 新增业务表流程

将来加点赞、收藏、标签等表时，按这四步走，不用重新想流程：

1. **先写接口**：在 `docs/API.md` 里定义路径、请求参数、返回结构、鉴权要求、失败码。**接口先行，表结构跟着接口走。**
2. **反推表结构并写进本书**：按接口需要的字段推导列、类型、索引、外键。字段与索引登记到本文档对应小节，外键命名遵守「外键命名规则」。
3. **改 schema 并迁移**：改 `backend/prisma/schema.prisma` → `npx prisma migrate dev --name <名字>`。
4. **核对后登记迁移记录**：核对生成的 `migration.sql` 与 `SHOW CREATE TABLE` / `SHOW INDEX` 的实际输出（外键行为、索引是否由 MySQL 自动补、字符集），确认一致后再把迁移写进本文档的「迁移记录」表，并把实际建表 SQL 补到对应表小节。

前置检查：`users` / `articles` / `comments` 的现有约定（软删除列、UTC 时间、`DATETIME(3)`、`utf8mb4_unicode_ci`、外键 Restrict）一律沿用，不要为新表开特例。

**唯一的已知例外**：`likes` 表**不含 `deleted_at` / `updated_at`**，是经论证后刻意偏离的（理由见「likes」小节），不是可以随手复制的模板。

---

## 迁移记录

| 迁移名 | 说明 | 状态 |
|---|---|---|
| `20260929123151_init` | 创建 `users` 表 | 已应用 |
| `20260929144738_blog_articles_comments` | 创建 `articles`、`comments` 表及三条外键 | 已应用 |
| `20260929145244_comments_idx_article_created` | `comments` 索引由 `(article_id, deleted_at, created_at)` 调整为 `(article_id, created_at)`；因外键依赖该索引，迁移内先 DROP 再 ADD 外键 | 已应用 |
| `20261003080727_add_user_avatar_bio` | `users` 表新增 `avatar VARCHAR(255) NULL` 与 `bio VARCHAR(200) NULL` 两列，均 nullable、无默认、不需回填 | 已应用 |
| `20261003140221_add_user_likes` | 新建 `likes` 表（`id` / `user_id` / `article_id` / `created_at`）+ 两条外键 + `likes_user_id_article_id_key` 唯一约束 + `likes_article_id_idx` 索引；**不含数据回填**（新表无既有数据）。本表**无 `deleted_at` / `updated_at` 两列**（刻意设计，理由见「likes」小节） | **已应用** |

> 第十批（点赞）迁移**已于 2026-10-03 执行完成**，迁移名 `20261003140221_add_user_likes`。
> 已用 `SHOW CREATE TABLE likes`、`information_schema.COLUMNS` 与 `SHOW INDEX FROM likes` 核对：
> 4 列齐全（**确认无 `deleted_at` / `updated_at`**）、两条外键均为 `ON DELETE RESTRICT ON UPDATE CASCADE`、
> **`user_id` 未被 MySQL 额外补单列索引**（唯一索引左前缀已承担）。实际 DDL 与迁移 SQL 已回填到「likes」小节。
> `_prisma_migrations` 共 **5 条**全部 `finished=Y / rolled_back=N`。
> 唯一约束与外键已用**真实插入**实测通过：重复插入报 `1062`、不存在的文章报 `1452`，测试数据已回收（`likes` 行数 0）。
> 基线未受影响：可见文章=11、评论=1、users=2。

> ⚠️ **本次 `migrate dev` 的建表成功，但末尾的 `prisma generate` 失败**：
> `EPERM: operation not permitted, rename '.../query_engine-windows.dll.node.tmpNNNN' -> '.../query_engine-windows.dll.node'`。
> 根因是**当时有 node 进程占着这个 DLL**（本机 3000 端口的后端 dev server，PID 15136），Windows 不允许替换正在被加载的文件。
> **影响**：`node_modules/.prisma/client/` 下的引擎 DLL 仍是旧文件；但 Prisma 6 的引擎 DLL **不内嵌 schema**
> （schema 在生成的 JS 里），实测 `prisma.like` 的 `count` / `create` / `delete` 均正常，故功能不受影响。
> **收尾动作**：后续让 3000 端口的后端进程释放后，重跑一次 `npx prisma generate` 即可补齐（`npm run prisma:generate`）。

> 第九批迁移**已于 2026-10-03 执行完成**，迁移名 `20261003080727_add_user_avatar_bio`。
> 已用 `SHOW CREATE TABLE users` 与 `information_schema.COLUMNS` 核对：两列均为 `DEFAULT NULL`，
> `PRIMARY KEY (id)` 与 `UNIQUE KEY users_username_key (username)` 未受影响，
> `demo` / `admin` 两行新列均为 `NULL`。实际 DDL 与迁移 SQL 已回填到「users」小节。
> `AUTO_INCREMENT=11` 说明迁移过程未插入任何新行（纯 `ADD COLUMN`，无回填）。

迁移文件位于 `backend/prisma/migrations/`：

```text
prisma/migrations/
├─ 20260929123151_init/
│  └─ migration.sql
├─ 20260929144738_blog_articles_comments/
│  └─ migration.sql
├─ 20260929145244_comments_idx_article_created/
│  └─ migration.sql
├─ 20261003080727_add_user_avatar_bio/
│  └─ migration.sql
├─ 20261003140221_add_user_likes/
│  └─ migration.sql
└─ migration_lock.toml
```

### 常用命令

```bash
cd backend
npm run prisma:generate   # 改 schema 后重新生成 Client
npm run prisma:migrate    # 创建新迁移并应用
npm run prisma:studio     # 可视化查看数据
```

查看当前迁移状态：

```bash
npx prisma migrate status
```

Prisma 版本锁定 **6.19.3**，CLI 与 `@prisma/client` 必须同版本升级。
