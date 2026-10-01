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
| `users` | 用户表 | 已建（迁移 `20260929123151_init`） |
| `articles` | 文章表 | 已建（迁移 `20260929144738_blog_articles_comments`） |
| `comments` | 评论表 | 已建（迁移 `20260929144738_blog_articles_comments`） |
| `_prisma_migrations` | Prisma 迁移记录表，自动生成 | 已存在 |

---

## 外键命名规则

本项目**不采用「目标表名 + `_id`」一刀切**，而是按「业务角色」命名外键列：

| 规则 | 列名 | 说明 |
|---|---|---|
| 有明确业务角色 → 用角色名 | `author_id` | 作者。`articles` 与 `comments` 两张表**统一用 `author_id`**，不用 `user_id` |
| 无特殊角色 → 目标实体单数名 + `_id` | `article_id` | 评论所属文章，角色就是「所属对象」本身，无更具体的业务角色名 |

- 选 `author_id` 而非 `user_id` 的理由：`articles` / `comments` 里的这个外键表达的是「作者」这一业务角色，且 `docs/API.md` 的作者信息以 `author` 对象（`id` / `username` / `nickname`）返回，DB 列名与 API 字段名呼应，读代码时不用做心智转换。
- Prisma 侧字段名用 camelCase（`authorId` / `articleId`），关系字段名为 `author` / `article`；`User` 模型侧的反向关系为 `articles` / `comments`。
- 一致性要求：**凡是「作者」语义的外键一律 `author_id`**，即使指向 `users` 表也不写成 `user_id`；反过来，若某表的 `user_id` 表达的是「用户本人」而非「作者」（例如将来做收藏表 `favorites`），则用 `user_id`。
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
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 创建时间 |
| updatedAt | updated_at | DATETIME(3) | 否 | 无 | 更新时间，Prisma `@updatedAt` 应用层维护 |
| deletedAt | deleted_at | DATETIME(3) | 是 | NULL | 软删除时间，NULL 表示未删除 |

`User` 模型上的 `articles Article[]` / `comments Comment[]` 是**反向关系字段，Prisma 虚拟字段，不产生任何列**，因此加它们不会 ALTER `users` 表（已实测确认）。

### 索引

| 索引名 | 类型 | 列 |
|---|---|---|
| PRIMARY | 主键 | id |
| users_username_key | 唯一 | username |

### 建表 SQL（迁移生成，未手工改写）

```sql
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(50) NOT NULL,
    `password` VARCHAR(255) NOT NULL,
    `nickname` VARCHAR(50) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `users_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
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

三条外键全部是 `ON DELETE RESTRICT ON UPDATE CASCADE`（Prisma 默认值，schema 中未显式声明 `onDelete`，已在迁移 SQL 中核对确认）。

- **软删除不触发外键**：删除文章是 `UPDATE articles SET deleted_at = ...`，物理行仍在，`comments.article_id` 的引用依然有效，因此**评论不被连带删除、不被连带置为删除**，也不需要任何 CASCADE 配置。
- 这正是「文章软删、评论保留但随文章不可见」的实现基础：评论数据原样保留，接口层先校验文章存在且未软删除（返回 404），评论列表随文章一起不可见。
- **将来若要物理清理**（硬删除），顺序必须是：

```text
comments → articles → users
```

  RESTRICT 会在顺序错误时直接拒绝：`DELETE FROM users` 若该用户还有文章或评论会报错；`DELETE FROM articles` 若还有评论挂载也会报错。这个报错是保护，不是 bug——发现报错说明漏了上游清理步骤。

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

---

## 新增业务表流程

将来加点赞、收藏、标签等表时，按这四步走，不用重新想流程：

1. **先写接口**：在 `docs/API.md` 里定义路径、请求参数、返回结构、鉴权要求、失败码。**接口先行，表结构跟着接口走。**
2. **反推表结构并写进本书**：按接口需要的字段推导列、类型、索引、外键。字段与索引登记到本文档对应小节，外键命名遵守「外键命名规则」。
3. **改 schema 并迁移**：改 `backend/prisma/schema.prisma` → `npx prisma migrate dev --name <名字>`。
4. **核对后登记迁移记录**：核对生成的 `migration.sql` 与 `SHOW CREATE TABLE` / `SHOW INDEX` 的实际输出（外键行为、索引是否由 MySQL 自动补、字符集），确认一致后再把迁移写进本文档的「迁移记录」表，并把实际建表 SQL 补到对应表小节。

前置检查：`users` / `articles` / `comments` 的现有约定（软删除列、UTC 时间、`DATETIME(3)`、`utf8mb4_unicode_ci`、外键 Restrict）一律沿用，不要为新表开特例。

---

## 迁移记录

| 迁移名 | 说明 | 状态 |
|---|---|---|
| `20260929123151_init` | 创建 `users` 表 | 已应用 |
| `20260929144738_blog_articles_comments` | 创建 `articles`、`comments` 表及三条外键 | 已应用 |
| `20260929145244_comments_idx_article_created` | `comments` 索引由 `(article_id, deleted_at, created_at)` 调整为 `(article_id, created_at)`；因外键依赖该索引，迁移内先 DROP 再 ADD 外键 | 已应用 |

迁移文件位于 `backend/prisma/migrations/`：

```text
prisma/migrations/
├─ 20260929123151_init/
│  └─ migration.sql
├─ 20260929144738_blog_articles_comments/
│  └─ migration.sql
├─ 20260929145244_comments_idx_article_created/
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
