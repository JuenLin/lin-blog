<!-- 文档：DB.md | 定位：数据模型契约 | 核心：数据表结构、字段约束、外键命名与硬删顺序。 -->

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
| `users` | 用户表 | 已建（迁移 `20260929123151_init`），第九批新增 `avatar` / `bio` 两列（迁移 `20261003080727_add_user_avatar_bio`），第 5 批新增 `role` / `status` 两列（迁移 `add_user_role_status`） |
| `articles` | 文章表 | 已建（迁移 `20260929144738_blog_articles_comments`），分类功能新增 `category` 一列（迁移 `20261004145107_add_article_category`），第 6 批新增 `status` 一列（迁移 `20261017125847_add_article_status`），第 9 批新增 `view_count` 一列（迁移 `20261018053624_add_bookmarks_and_view_count`），第 10 批新增 `series_id` / `series_order` 两列（迁移见「第 10 批」小节） |
| `comments` | 评论表 | 已建（迁移 `20260929144738_blog_articles_comments`），第 7 批新增 `parent_id` 一列（同批迁移 `20261018014846_add_tags_and_article_tags`），第 11 批新增 `like_count` 一列（迁移见「第 11 批」小节） |
| `likes` | 文章点赞表（第十批） | 已建（迁移 `20261003140221_add_user_likes`） |
| `comment_likes` | 评论点赞表（第 11 批） | 已建（迁移见「第 11 批」小节） |
| `notifications` | 通知表（第 8 批） | 已建（迁移见「第 8 批」小节），第 11 批 `type` 枚举追加 `MENTION` / `COMMENT_LIKE` 两值（同批迁移） |
| `bookmarks` | 文章收藏表（第 9 批） | 已建（迁移 `20261018053624_add_bookmarks_and_view_count`） |
| `series` | 文章系列表（第 10 批） | 已建（迁移见「第 10 批」小节） |
| `reports` | 举报表（第 12 批） | 已建（迁移见「第 12 批」小节） |
| `tags` | 标签表（第 7 批） | 已建（迁移 `add_tags_and_article_tags`） |
| `article_tags` | 文章-标签中间表（第 7 批） | 已建（迁移 `add_tags_and_article_tags`） |
| `follows` | 关注关系表（第 4 批） | 已建（迁移 `20261011083029_add_follows`） |
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
| category | category | VARCHAR(20) | 否 | '未分类' | 文章分类，枚举 `技术` / `生活` / `随笔` / `未分类`；后端白名单校验，非法值返回 400/40000；老文章由迁移 `NOT NULL DEFAULT '未分类'` 自动回填，零 NULL |
| status | status | ENUM('DRAFT','PUBLISHED') | 否 | 'PUBLISHED' | 发布状态；`DRAFT`=草稿（仅作者本人「草稿箱」可见，不进广场 / 不进公开详情）；`PUBLISHED`=已发布（进广场）。默认 PUBLISHED，INSTANT 回填零 NULL |
| viewCount | view_count | INT | 否 | 0 | 累计阅读量（第 9 批），只由 `POST /api/articles/:id/view` 原子 +1（`prisma increment`）；与 `likeCount`（likes 表实时 COUNT）是两种口径。**不建索引**（理由见「第 9 批」小节） |
| seriesId | series_id | INT | 是 | NULL | 所属系列 id（第 10 批），外键 → `series.id` `ON DELETE SET NULL`；NULL = 未加入任何系列。**只存不校验归属，归属校验在 API 层**（见「第 10 批」小节） |
| seriesOrder | series_order | INT | 是 | NULL | 系列内序号（第 10 批），正整数；同系列内唯一由**应用层**保证（409 冲突拒绝），**不建复合唯一索引**（可空列在 MySQL 下不可靠）；解绑 / 删系列时随 `series_id` 一同置 NULL |

### `category` 分类列（分类功能，经用户批准新增）

> **本节是一次「禁止修改数据库 schema」例外的书面登记。**
> 契约 §2 禁止事项里的「禁止修改数据库 schema」在本次**经用户明确批准后豁免**。
> 批准范围：**仅限 `articles` 表新增 `category VARCHAR(20) NOT NULL DEFAULT '未分类'` 一列**，
> 不含任何其他表结构变更、不含改列名/类型、不含删列、不含新增 `categories` 表 / 外键。
> 批准依据与决策过程见 `docs/API.md` 文章相关接口章节与 `docs/AI_CONTRACT.md` §2「已批准的例外」第 4 项。
>
> 注意：第九批、本次均是**独立的一次批准，不是援引既有例外**；其余 schema 变更仍需重新批准。

**设计选择：枚举白名单，不建 `categories` 表、不加外键**（闭合固定单值分类，贴合 avatar/bio 先例）：

| 理由 | 说明 |
|---|---|
| 分类是闭合固定集合 | 只有 技术/生活/随笔/未分类 四个值，不会由用户自由增删，不需要一张表来「存」分类本身 |
| 一致性靠后端白名单 | 拒绝自由字符串，非法值直接 400/40000，库里永远不会出现拼写不一致的值 |
| 不加外键 | 单列枚举无需引用另一张表；避免引入 categories 表 + 外键 + 级联的额外复杂度，也避免「删分类」这类本期不做的管理能力 |
| `VARCHAR(20)` 足够 | 4 个枚举值中最长「未分类」仅 3 字符，20 字符余量充足；与 `VarChar(50)` 的 nickname 等保持一致的字符串列风格 |

**为什么 `NOT NULL DEFAULT '未分类'` 而非 nullable + 读时归一**（本次拍板结论）：

- 迁移 `ALTER TABLE ... ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT '未分类'` 在 MySQL 8 下走 **INSTANT 算法**（仅改元数据、不重写数据），对已有 11 行**自动回填**为 `未分类`，**零 NULL、零回填脚本**。
- 相比 nullable + 读时归一：`NOT NULL` 让「未分类」是一个真实的、可参与筛选的值（例如「只看未分类文章」这类未来需求可直接 `WHERE category='未分类'`），且省掉应用层每次读都做的 `?? '未分类'` 归一逻辑。
- 前端枚举写死这 4 个字符串（不在前端抽常量文件），与后端白名单保持字面一致。

**迁移兼容性**：`ALTER TABLE` 是纯 `ADD COLUMN`，不含任何数据回填语句（默认值由 MySQL 在 INSTANT 阶段直接写入）。与第九批 `avatar`/`bio` 的 nullable 新增不同，本次是 `NOT NULL` + 默认，因此**必须带 `DEFAULT`**（否则 INSTANT 仍可用，但既有行需要填值；带 DEFAULT 是标准做法且零风险）。

> **不按 `category` 建索引，是刻意的**：分类是**低基数列**（只有 4 个值），B-tree 索引在这种列上选择性极低，过滤后再回表几乎等价于全表扫描；且 MVP 数据量（两位数文章）下按 `WHERE category = ?` 全表扫描完全无感。`GET /api/articles?category=技术` 的筛选在 service 层拼 `where.category = x` 即可，不引入索引。若将来分类成为高频筛选维度且数据量大，再评估（单列索引价值仍有限，更可能是「category + 其他维度」的复合索引，届时按第 6 节迁移流程登记）。

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
| articles_status_created_at_idx | 普通 | status, created_at | 已发布文章列表默认过滤 `status='PUBLISHED' ORDER BY created_at`，覆盖广场列表主查询 |

> **搜索（`keyword`）没有索引，是刻意为之**：`GET /api/articles` 的 `keyword` 走 `LIKE '%kw%'`（前缀带 `%`），B-tree 索引在这种模式下用不上，加普通索引只会成为**死索引**（白白占写入开销却从不命中）。真正的提速方案是 MySQL `FULLTEXT` 全文索引（需 `ngram` 解析器支持中文分词），但那要先确认 MySQL 版本与分词器可用性，属独立需求。
>
> 当前 MVP 数据量（文章两位数）下全表扫描完全可接受，故**暂不建任何搜索索引**。若将来文章量增长到扫描变慢，再评估 `FULLTEXT` 并按第 6 节的迁移流程登记。
>
> **不按 `viewCount`（`view_count`）建索引，是刻意的（第 9 批）**：「阅读最多」排序 `ORDER BY view_count DESC` 在 MVP 数据量下 filesort 无感；`view_count` 是**高频写入列**（每次阅读 +1），索引会拖慢每一次写入，而读取收益在当前量级为零。若将来文章量上百且「阅读最多」成为高频入口，再评估（按第 6 节迁移流程登记）。

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
    `category` VARCHAR(20) NOT NULL DEFAULT '未分类',

    INDEX `articles_deleted_at_created_at_idx`(`deleted_at`, `created_at`),
    INDEX `articles_deleted_at_updated_at_idx`(`deleted_at`, `updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `articles` ADD CONSTRAINT `articles_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

> 第 6 批迁移 `add_article_status` 在上述表基础上新增 `status` 列（ENUM + 默认 PUBLISHED）与索引 `(status, created_at)`，INSTANT 回填。第 10 批迁移（见「第 10 批」小节）新增 `series_id` / `series_order` 两列（均可空）与外键 `articles_series_id_fkey`（→ `series.id`，`ON DELETE SET NULL`），既有行两列全部 `NULL`（零回填）。完整 DDL 见本文件「迁移记录」。

---

## article_revisions（文章版本历史表）

Prisma 模型名 `ArticleRevision`，`@@map("article_revisions")`。存文章每次「更新前」的快照，支撑版本历史与回滚（第 6 批）。

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键 |
| articleId | article_id | INT | 否 | 无 | 所属文章 id，外键 → `articles.id` |
| title | title | VARCHAR(100) | 否 | 无 | 快照时的标题 |
| content | content | MEDIUMTEXT | 否 | 无 | 快照时的正文 |
| category | category | VARCHAR(20) | 否 | '未分类' | 快照时的分类 |
| authorId | author_id | INT | 否 | 无 | 快照归属作者 id，外键 → `users.id` |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 快照时间 |

### 外键与级联

- `article_id` → `articles.id` `ON DELETE CASCADE`：文章被硬删（草稿删除、或未来管理端硬删）时，其版本记录一并清理。
- `author_id` → `users.id` `ON DELETE RESTRICT`（与 `articles.author_id` 一致，作者软删不影响快照可读性）。

> **为什么单独建表而不是给 articles 加 `version` 列**：版本历史是多对一（一篇文章多个历史版本），是独立实体；且快照要保留「被改掉之前的旧值」，无法用单表的几个列表达。单独表 + `article_id` 索引是标准做法。

### 索引

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | id | |
| article_revisions_article_id_created_at_idx | 普通 | article_id, created_at | 按文章拉版本历史，倒序取最新 |

### 建表 SQL（迁移生成，未手工改写）

```sql
CREATE TABLE `article_revisions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `article_id` INTEGER NOT NULL,
    `title` VARCHAR(100) NOT NULL,
    `content` MEDIUMTEXT NOT NULL,
    `category` VARCHAR(20) NOT NULL DEFAULT '未分类',
    `author_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `article_revisions_article_id_created_at_idx`(`article_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `article_revisions` ADD CONSTRAINT `article_revisions_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `article_revisions` ADD CONSTRAINT `article_revisions_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
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
| parentId | parent_id | INT | 是 | NULL | **第 7 批新增**：父评论 id，`NULL` = 顶层评论；非空 = 对该评论的回复（**两层硬限制**：只允许指向顶层评论，应用层校验）；外键 → `comments.id` `ON DELETE CASCADE ON UPDATE CASCADE` |
| likeCount | like_count | INT | 否 | 0 | **第 11 批新增**：评论点赞数（累加计数器，只增不减）。只由 `POST` / `DELETE /api/comments/:id/like` 以 `prisma increment` / `decrement` 原子维护；与 `comment_likes` 行数是同源两种口径（响应回显走本列，唯一真相是行存在性）。**不建索引**（高频写入列，同 `view_count` 纪律） |

`deletedAt` 保留的依据是契约 §9「每张业务表建议包含」的通用字段，且 `whereNotDeleted()` 统一覆盖可避免遗漏；MVP 无评论删除接口，该列当前恒为 NULL，成本可忽略。

### 索引

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | id | |
| comments_article_id_created_at_idx | 普通 | article_id, created_at | 「某篇文章的评论列表」主查询：`article_id = ?` + `created_at` + 分页 |
| comments_parent_id_idx | 普通 | parent_id | **第 7 批新增**：「某条父评论的直接回复」查询（级联软删的 `updateMany({ parentId })` 与「父必须是顶层」校验走它） |
| comments_author_id_fkey | 普通（外键自动创建） | author_id | 外键索引 |

- `article_id` 的外键索引由 `comments_article_id_created_at_idx` 的**左前缀**承担，MySQL 未额外创建单列索引。
- **索引是 `(article_id, created_at)`，不含 `deleted_at`**：建表迁移 `20260929144738` 曾建 `(article_id, deleted_at, created_at)`，但后续迁移 `20260929145244_comments_idx_article_created` 第 5 行 `DROP` 该索引、第 8 行重建为 `(article_id, created_at)`（该列恒为 NULL 时无选择性收益）；`SHOW INDEX FROM comments` 实测亦仅 `(article_id, created_at)`。软删过滤查询 `article_id = ? AND deleted_at IS NULL ORDER BY created_at` 需回表过滤 `deleted_at`，MVP 数据量小可接受；若将来评论量大，加回 `(article_id, deleted_at, created_at)` 只需一条迁移。

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
| avatar | avatar | VARCHAR(255) | 是 | NULL | 头像，第九批新增。**只有一种取值**：**站内相对路径**（`/uploads/` 开头，由上传接口产生）。外链形态已下线（接口层不再接受，列定义未变）。长度论证与文件存储见下方「第十一批：头像文件存储」 |
| bio | bio | VARCHAR(200) | 是 | NULL | 个人简介，第九批新增 |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 创建时间 |
| updatedAt | updated_at | DATETIME(3) | 否 | 无 | 更新时间，Prisma `@updatedAt` 应用层维护 |
| deletedAt | deleted_at | DATETIME(3) | 是 | NULL | 软删除时间，NULL 表示未删除 |
| role | role | ENUM('USER','ADMIN') | 否 | USER | 角色，第 5 批新增。管理端接口（`/api/admin/*`）与管理员徽章的判据 |
| status | status | ENUM('ACTIVE','BANNED') | 否 | ACTIVE | 账号状态，第 5 批新增。`BANNED` 时登录与 `auth` 中间件均返回 401 / 40101，旧 token 即刻失效 |

`User` 模型上的 `articles Article[]` / `comments Comment[]` 是**反向关系字段，Prisma 虚拟字段，不产生任何列**，因此加它们不会 ALTER `users` 表（已实测确认）。

### 第九批新增字段（avatar / bio）—— schema 变更已获批准，**迁移已执行**

> **本节是一次「禁止修改数据库 schema」例外的书面登记。**
> 契约 §2 禁止事项里的「禁止修改数据库 schema」在本次**经用户明确批准后豁免**。
> 批准范围：**仅限本次新增 `users.avatar` 与 `users.bio` 两列**，
> 不含任何其他表结构变更、不含改列名/类型、不含删列。
> 批准依据与决策过程见 `docs/API.md` 的 `PUT /api/users/me` 章节。
> **迁移已于 2026-10-03 执行**（`20261003080727_add_user_avatar_bio`），实际结构见本小节末尾与下方建表 SQL。

**为什么必须改 schema 而不能复用 `nickname`**（这是本次豁免的核心论证，登记备查）：

> **以下是第九批（2026-10-03）的论证快照。结论仍成立，个别论据已随第十一批（外链下线）更新**，已在下文标注。

| 理由 | 说明 |
|---|---|
| 语义冲突 | `nickname` 被 `UserProfile` / `ArticleCard` / `AuthorCard` / `UserDropdown` 四处当作**显示名**使用，塞入 URL 或长文本会直接破坏这四处 UI |
| 长度不足 | `nickname` 是 `VARCHAR(50)`，而头像的站内路径最坏约 **63** 字符（口径见下方「第十一批：头像文件存储」），50 字符放不下 |
| 探针冲突 | `probe-search.mjs` 有一条「昵称不应被 keyword 搜到」的泄漏断言，往`nickname` 塞 URL 会让昵称变得像搜索关键词，污染该断言的语义 |

**为什么选 `VARCHAR` 而不是 `TEXT`**：MySQL `VARCHAR` 长度受行大小限制但索引友好、`avatar` 未来可能加唯一性或排序需求；255 与 200 都在 utf8mb4 下远低于行大小上限。排除 `TEXT` 的理由是 `TEXT` 上限按**字节**计（65535 字节），站内路径（约 63 字符）用不上却要付出off-page 存储代价。

> ⚠️ **以下为第九批的历史设计，已被第十一批推翻，不可据此实现。**
> 其中「API 层只做 `http://` / `https://` 开头校验」这套逻辑**已在第十一批随外链下线一并移除**——`avatar` 现在**只接受 `/uploads/` 站内路径**，写入方唯一是 `POST /api/users/me/avatar`（`user.validator.js` 强制前缀校验）。
> 现状：头像支持**站内上传**（`POST /api/users/me/avatar`，multer ^2.4.0），且**外链已下线**。详见下方「第十一批：头像文件存储」与 `docs/API.md`。

**【历史 · 第九批】头像为什么只存URL 而不上传文件**：本项目**不引入任何新依赖**（契约 §2「禁止擅自引入新依赖」），文件上传需要 `multer` 之类的中间件，且要配套对象存储。零依赖方案下用户自己把图片传到图床，把链接填进来。代价是**服务端不保证图片真实存在**，因此 API 层只做「必须以 `http://` 或 `https://` 开头」的格式校验（挡掉 `javascript:` / `data:` 这类会构成 XSS 的伪协议），**不发起任何网络请求校验可达性**——否则每次改资料都要等外部 HTTP 响应，接口会变得不可控。

**`avatar` / `bio` 均 nullable 的影响**：现有用户（`demo` / `admin`）迁移后这两个字段为 `NULL`，**无需回填数据**。前端渲染头像时 `NULL` 必须回退到基于昵称生成的头像首字（现有 `getAvatarText` 逻辑），不能直接渲染 `<img src="null">`。

**内嵌 author 对象的字段边界**：`avatar` 会进入文章与评论的内嵌 `author` 对象（两处 `AUTHOR_SELECT`，见 `docs/API.md`），`bio` **不会**——简介只在个人主页展示，塞进每条评论的 author 里是纯粹的响应体浪费。两处 `AUTHOR_SELECT` 当前是**重复定义**，本期按「只加字段、不做重构」处理，抽取公共定义单独排一批。

### 第十一批：头像文件存储（uploads 目录）

第十一批起头像支持**站内上传**（`POST /api/users/me/avatar`，见 `docs/API.md`）。**本节不涉及任何表结构变更** —— 下面先说清楚「为什么不用改 schema」。

| 存的是什么 | 示例 | 长度 |
|---|---|---|
| **站内相对路径** | `/uploads/avatars/1/1759516800000-3f2a9c7e1b4d8065.png` | 约 **70** 字符 |
| ~~外链 URL~~（已下线） | ~~`https://cdn.example.com/a/1.png`~~ | 历史形态，第九批引入、现已不再写入 |

`VARCHAR(255)` 对站内路径绰绰有余（最坏情况：`/uploads/avatars/` 17 + userId 10 位 + `/` 1 + 时间戳 13 + `-` 1 + 随机 hex 16 + `.webp` 5 ≈ 63，留了 4 倍余量）。**因此本批不迁移、不动 `schema.prisma`** —— 外链下线时同样**没有**动过列定义，只是不再往里写外链了。

#### 磁盘上的目录结构

```text
backend/
└─ uploads/                      ← 不进 git（已加 .gitignore）
   └─ avatars/
      └─ {userId}/               ← 按用户 id 分目录
         └─ {时间戳}-{16位随机hex}.{扩展名}
```

- **按 `userId` 分目录**：便于按用户排查、迁移，以及将来做「用户注销时整个目录一起清」。文件名本身已是随机的，分目录不为了防枚举。
- **文件名 = 时间戳 + `randomBytes(8).toString('hex')`**：不可枚举；同一毫秒内上传也不会撞名。`node:crypto` 是 Node 内置模块，**不新增依赖**。
- **扩展名由服务端按 mimetype 映射**（`.jpg` / `.png` / `.webp`），**不使用 `file.originalname`** —— 后者客户端可控，会有路径穿越与伪扩展名风险。
- 目录按需 `fs.mkdirSync(dir, { recursive: true })` 创建：因为目录不进 git，clone 下来是不存在的。

#### 为什么不进 git

`backend/.gitignore` 增补 `uploads/`。原文件内容只有 `node_modules` / `.env` / `*.log`。

理由：上传的文件是**运行时数据**，不是代码。进 git 会导致 ① 用户上传的私人图片被提交进版本库；② 每次换头像都产生一条二进制变更，仓库体积无谓膨胀；③ 多环境（本地 / 生产）文件本就不该共享。

#### 生产部署提示 ⚠️

> **`backend/uploads/` 是本地磁盘目录，进程重启 / 重新部署会丢文件**（容器化部署尤其明显：镜像重建后目录回到空）。
> **生产部署时必须给它挂载持久卷**（Docker volume / K8s PVC / 宿主机目录 bind mount），否则用户头像会在每次发布后神秘消失，而数据库里的路径还好好地指着一个不存在的文件。
> MVP 本地开发不涉及，但**上线前必须处理**。将来若迁移到对象存储（OSS / S3），只需把「落盘 + 拼 `/uploads/` 路径」换成「上传 SDK + 存完整 URL」，`avatar` 列长度仍够（见上文长度论证）。

#### 与数据库的一致性（不保证强一致）

DB 存路径、磁盘存文件，两者**没有事务保护**：

| 情形 | 结果 | MVP 处理 |
|---|---|---|
| 写库成功、删旧文件前崩溃 | **孤儿文件**（磁盘上有，DB 不指向它） | 不处理，登记在「已知限制」第 4 条 |
| 手工删了磁盘文件、DB 还指着它 | **悬空引用**（前端渲染破图） | 前端按 `img` 的 `error` 回退文字头像，不崩 |
| 上传成功、写库失败 | 服务端**反向删除**刚落盘的文件 | 已处理（见 `docs/API.md` 的处理顺序） |

### 第 5 批：role / status 两列（schema 变更已获批准，迁移已执行）

> **本节是一次「禁止修改数据库 schema」例外的书面登记。**
> 契约 §2 禁止事项里的「禁止修改数据库 schema」在本次**经用户明确批准后豁免**。
> 批准范围：**仅限给 `users` 新增 `role` 与 `status` 两列**，
> 不含索引、不含其他表任何变更、不含改列名 / 类型 / 删列。
> 批准依据与决策过程见 `docs/API.md`「管理端接口（第 5 批）」章节；迁移与管理员赋值见下方「第 5 批」顶层小节与「迁移记录」。

**为什么用 Prisma enum 而不是 category 式的 String + zod 白名单**（与分类列的模式差异，登记备查）：

| | `role` / `status`（本批） | `category`（分类功能） |
|---|---|---|
| 值域 | `USER` / `ADMIN`、`ACTIVE` / `BANNED`——**机器判据的封闭集**，永远不需要新值 | 技术 / 生活 / 随笔 / 未分类——面向展示的中文串，未来可能加 |
| 强制层 | **DB 层**（MySQL ENUM），应用写不进去非法值 | 应用层 zod 白名单，DB 只是 VARCHAR(20) |
| 判定方 | 后端中间件 + 前端徽章，语义不能漂 | 前端展示 + 筛选 |

结论：封闭值域 + 机器判据 → enum 由 DB 层强制，比「应用层自觉」稳。`category` 保持原样，不回头改。

**加列机制**：两列均 `NOT NULL` + `DEFAULT`，MySQL 8 INSTANT 算法自动回填既有行（与 `category` 列同一先例，见「articles」小节的分类列说明），零 NULL、零回填脚本。存量 5 行全部回填 `USER` / `ACTIVE`。

**不建索引**：基数 2 + 表现存 5 行，管理端状态筛选全表扫描无压力。与 `category` 不建索引同一理由。

**管理员赋值不走迁移**：迁移文件保持纯净（只加列）。`admin` / `lin` 两个账号的 ADMIN 角色由迁移后手动 `UPDATE` 设置，SQL 与 SELECT 自证登记在下方「第 5 批」顶层小节。

**物理删序不变**：`users` 加两列不影响既有硬删顺序（likes → follows → comments → articles → users）。

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

> ⚠️ 这里的 `AUTO_INCREMENT=11` 是 **2026-10-03 核对时的快照值，不代表当前行数**（自增值只增不回，迁移过程与历史注册都会推高它）。看真实行数请用 `SELECT COUNT(*) FROM users`，不要拿这个数字当基线。

### 第九批的迁移 SQL（实际生成）

```sql
-- AlterTable
ALTER TABLE `users` ADD COLUMN `avatar` VARCHAR(255) NULL,
    ADD COLUMN `bio` VARCHAR(200) NULL;
```

**迁移是纯 `ADD COLUMN`，不含任何数据回填语句**。两列均 nullable 且无默认值，MySQL 对既有行直接填 `NULL`；已核对 `demo`（id=1）与 `admin`（id=2）迁移后 `avatar` / `bio` 均为 `NULL`，符合预期，**不需要回填脚本**。


---

## likes（点赞表）

Prisma 模型名 `Like`，`@@map("likes")`。**第十批新增，迁移已执行（`20261003140221_add_user_likes`）。**

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
> 契约 §2 禁止事项里的「禁止修改数据库 schema」在本次**经用户明确批准后豁免**。
> 批准范围：**仅限新建`likes` 一张表**（含其两条外键与两个索引），
> **不含修改 `users` / `articles` / `comments` 任何一列**。
> 批准依据与决策过程见 `docs/API.md` 的 `POST /api/articles/:id/like` 章节。
>
> 注意：第九批的豁免明确写了「仅限那两列，除此之外的任何 schema 变更仍需重新批准」，
> 因此**本次是独立的一次批准，不是援引第九批的例外**。
> 契约 `AI_CONTRACT.md` 第 2 节「禁止事项」里的 schema 禁令**本批不修改**（按用户要求，豁免只登记在本书）。

### 为什么必须有独立表（不能复用现有表加列）

| 理由 | 说明 |
|---|---|
| 多对多 | 一篇文章被 N 个用户点赞，一个用户点赞 M 篇文章，是标准的多对多关系，`users` / `articles` 两张表都放不下 |
| 不能在 `articles` 加冗余列存 id 列表 | 用 `VARCHAR` 存逗号分隔的 user_id 列表，无法索引、无法保证原子性、并发下必然错乱 |
| 不能靠 `comments.content` 标记 | 语义完全不同（点赞不是评论），且会让「评论数」统计掺入点赞 |

### 唯一约束是防重复点赞的唯一真相

`@@unique([userId, articleId])`（`likes_user_id_article_id_key`）。

应用层「先查 `findUnique` 再 `create`」**存在竞态窗口**：两个并发请求都在对方写入前查到「未赞过」，然后都执行 INSERT，产生两条重复记录。只有 DB 唯一约束能真正防住 —— service 层捕获 Prisma 的 `P2002` 转成 `409 / 40900`（「已点赞过这篇文章」）。

**这意味着实现层不允许「先查后写」当作正确性保障**，它只能用来给出更友好的提示；真正的拦截靠唯一约束。

### 为什么 `article_id` 要单独建索引

`@@index([articleId])`（`likes_article_id_idx`）支撑两处高频查询：

1. **实时 `likeCount`**：`SELECT COUNT(*) FROM likes WHERE article_id = ?` —— 列表与详情接口都要用
2. 「某篇文章的点赞明细」（将来若做）

`user_id` 侧**不另建索引**：`likes_user_id_article_id_key` 的左前缀已承担 `WHERE user_id = ?`，MySQL 不会重复创建。迁移执行后已用 `SHOW INDEX FROM likes` 核实：MySQL 未额外补单列索引（见下方「索引（实际核对结果）」）。

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
| 将来物理清理（硬删除） | 顺序必须是 `likes → follows → comments → articles → users`，`likes` 与 `follows` 是最上游（均可能被软删用户的残留行悬挂） |

**这与评论的现有处理完全一致**（`deleteArticle` 的注释原文：「只 UPDATE deleted_at，物理行保留，因此不触发外键」）。点赞行残留**不是 bug**，与评论行残留是同一个设计取舍。

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

### Prisma Client 生成历史（已解决）

> ⚠️ **以下为当时的过程记录，根因已查明、问题已解决，此节仅作归档。**
>
> 当时的 `migrate dev` 建表成功，但末尾的 `prisma generate` 失败（EPERM）。
> **根因**：跑着 `npm run dev` 的后端进程（`node --watch`）占用了引擎 DLL，
> Windows 不允许替换正在被加载的文件。**停掉后端再跑即成功**（实测 v6.19.3）。
> 当时的说法「可能是杀软实时扫描」是误判，已在 `README.md`「已知问题」里更正。
>
> 以下为当时的报错原文，仅为归档：
>
> ```text
> EPERM: operation not permitted, rename '.../query_engine-windows.dll.node.tmpNNNN' -> '.../query_engine-windows.dll.node'
> ```
>
> 当时的收尾动作（已完成）：让 3000 端口的后端进程释放后重跑 `npx prisma generate`，
> 残留的 `query_engine-windows.dll.node.tmp*` 已清理，`npx prisma migrate status` 显示 6 个迁移全部 applied。

### 按点赞数排序（「热门」Tab，本次引入）

`GET /api/articles` 的 `sortBy` 白名单新增 `likeCount`，前端「热门」Tab 按它倒序。**不改 schema、不加冗余列** —— 排序由 Prisma 的关联计数排序表达：

```js
orderBy: [{ likes: { _count: 'desc' } }, { id: 'desc' }]
```

`likeCount` 是**计算字段**（响应层由 `_count.likes` 折算），`articles` 表里没有这一列，**不能直接透传给 Prisma**（会报 `Unknown argument 'likeCount'`），所以在 `backend/src/services/article.service.js` 里用一张 `ARTICLE_SORT_MAP` 把 API 字段名翻成 orderBy 片段（见 `utils/query.js` 的 `options.map`）。

实测（Prisma 6.19.3 + MySQL 8）：**编译成单条 SQL**，排序与分页都在 SQL 层，不是拉全量再在应用层排：

```sql
SELECT articles.id, ..., COALESCE(aggr_selection_0_Like._aggr_count_likes, 0) AS _aggr_count_likes
FROM articles
LEFT JOIN (SELECT likes.article_id, COUNT(*) AS orderby_aggregator FROM likes GROUP BY likes.article_id) AS orderby_1_Like
     ON articles.id = orderby_1_Like.article_id
LEFT JOIN (SELECT likes.article_id, COUNT(*) AS _aggr_count_likes FROM likes GROUP BY likes.article_id) AS aggr_selection_0_Like
     ON articles.id = aggr_selection_0_Like.article_id
WHERE articles.deleted_at IS NULL
ORDER BY COALESCE(orderby_1_Like.orderby_aggregator, 0) DESC, articles.id DESC
LIMIT 10 OFFSET 0
```

#### EXPLAIN 实测的代价（两条，按聚合值排序的必然结果）

| 现象 | 说明 |
|---|---|
| `articles` 走 `Using temporary; Using filesort` | 排序列是**聚合结果**，无法走索引 |
| `likes` 被聚合**两次** | `_count` 选择（`aggr_selection_0_Like`）与 `orderBy` 聚合（`orderby_1_Like`）是两条独立派生表，Prisma **不复用** |

`GROUP BY` 本身有效命中我们建的 `likes_article_id_idx`（`Using index`）；`articles` 侧仍用 `articles_deleted_at_created_at_idx` 过滤软删除。

#### 为什么不在 `articles` 加 `like_count` 冗余列

冗余列能让排序走索引，但代价是：每次点赞 / 取消点赞都要额外 `UPDATE articles`，并引入「冗余列与真实计数不一致」这一新类 bug（并发、失败回滚、软删联动）。当前数据量下 filesort 完全无感，所以维持既定取舍：**`likeCount` 永远实时 `COUNT(*)`，不加冗余列**。量级上来后这里是第一个瓶颈，届时再评估（物化列 / 定时汇总 / 缓存各有代价）。

#### 并列与分页稳定

`likeCount` 大量并列（多数文章都是 0 赞）时，**次级排序 `id` 是必需的** —— 否则同一批数据在相邻两页可能重复出现或整行丢失。`buildOrderBy()` 的 `DEFAULT_SECONDARY_SORT = 'id'` 会自动补上，`sortBy=likeCount` 无需额外配置。

---

## bookmarks（收藏表）

Prisma 模型名 `Bookmark`，`@@map("bookmarks")`。**第 9 批新增，迁移待执行（`add_bookmarks_and_view_count`，与 `articles.view_count` 同批一次 migrate）。**

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键（代理键，无业务含义） |
| userId | user_id | INT | 否 | 无 | 收藏人 id，外键 → `users.id` |
| articleId | article_id | INT | 否 | 无 | 被收藏文章 id，外键 → `articles.id` |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 收藏时间（API 层平铺为虚拟字段 `bookmarkedAt`） |

**本表刻意不设 `updated_at` 与 `deleted_at`**，与 `likes` / `follows` 同族，原因见下方「为什么没有软删除列」。

### schema 变更已获批准（豁免登记）

> **本节是一次「禁止修改数据库 schema」例外的书面登记。**
> 契约 §2 禁止事项里的「禁止修改数据库 schema」在本次**经用户明确批准后豁免**。
> 批准范围：**仅限新建 `bookmarks` 一张表**（含两条外键与两个索引）
> **外加** `articles` 表新增 `view_count INT NOT NULL DEFAULT 0` 一列（两项同批但**独立登记**，见 `docs/AI_CONTRACT.md` §2「已批准的例外」第 13、14 项）。
> 不含修改 `users` / `articles`（`view_count` 除外）/ `comments` / `likes` / `follows` 任何其他一列。
> 批准依据与决策过程见 `docs/API.md`「收藏与阅读量（第 9 批）」章节。
>
> 注意：与第十批 `likes`、第 4 批 `follows` 一样，本次是**独立的一次批准**；其余 schema 变更仍需重新批准。

### 与 likes 的逐项对镜，以及一处刻意相反

| 维度 | likes（点赞） | bookmarks（收藏） |
|---|---|---|
| 表结构 | id / user_id / article_id / created_at | **同构** |
| 唯一约束 | `likes_user_id_article_id_key` | `bookmarks_user_id_article_id_key`（同规则） |
| 物理 DELETE（无 deleted_at） | 是 | **是（同族）** |
| 外键 | 双 RESTRICT | 双 RESTRICT |
| 重复 POST | **40900**（动作冲突，暴露给前端处理） | **200 幂等**（目标状态已达成，无冲突） |
| 取消未做过的 | **40400** | **200 幂等** |
| 通知（第 8 批） | 接 `LIKE` 通知 | **不产生通知**（纯个人整理） |

**为什么收藏是幂等 200 而点赞是 409 / 404**：点赞的重复 / 误取消被定义为「调用方的错误假设」（按钮点两次、状态不同步），用错误码把问题暴露给前端；收藏是「稍后看」的整理行为，重复收藏 / 重复取消都意味着目标状态已达成，没有冲突可言——与 `follows`（关注 / 取关均幂等 200）同一条设计线。`bookmarks` 与 `follows` 在数据层同族（唯一约束 + 物理 DELETE + RESTRICT 外键），错误码语义随家族，不随 likes。

### 唯一约束是防重复收藏的唯一真相

`@@unique([userId, articleId])`（`bookmarks_user_id_article_id_key`）。应用层「先查后写」存在竞态窗口，与 likes / follows 同一纪律：**直接 `create`，由 DB 唯一约束最终拦截**。区别只在拦截后的语义——`P2002` 在这里**不是错误**，转成「已收藏」的幂等成功（200）；而 likes 转 409、follows 直接幂等成功。

### 索引

- `bookmarks_user_id_article_id_key`（唯一约束）：防重复收藏；左前缀承担 `WHERE user_id = ?`（「我的收藏」按人查）。
- `bookmarks_article_id_idx`：支撑两处查询——①「某篇文章的收藏数」实时 `COUNT(*)`（`POST` / `DELETE` 响应的 `bookmarkCount`）；②`GET /api/users/me/bookmarks` 的 `articleId` 侧回表。
- `user_id` 侧**不另建索引**：唯一索引左前缀已承担，MySQL 不会重复创建（同 likes 纪律，迁移后用 `SHOW INDEX FROM bookmarks` 核实）。

### 为什么没有软删除列

与 `likes` 完全相同的三条理由（本项目第二、三张不做软删除的业务表，是刻意偏离契约第 9 节「每张业务表建议包含 `deleted_at`」的结果）：

- **收藏是关系状态，不是可隐藏的内容**：没有「隐藏但保留」的语义。
- **软删会与唯一约束直接冲突**：取消后再收藏会撞唯一约束，只能改成 `UPDATE ... SET deleted_at = NULL`，「收藏 = 该行存在」这个不变式不再直观。
- **物理 DELETE 让不变式始终成立**：表里存在一行 ⟺ 该用户收藏了这篇文章。计数只需 `COUNT(*)`，无需任何额外条件。

### 软删除联动：文章 / 用户软删后收藏行会残留

与其他表一致，**软删除不触发外键**，因此：

| 场景 | 行为 |
|---|---|
| 文章软删 | `bookmarks` 行**保留**。`GET /api/articles` / `/:id` 已按 `deleted_at IS NULL` 过滤，收藏列表（`/users/me/bookmarks`）也只返回未软删文章，收藏数不会因文章隐藏而外泄 |
| 对已软删 / 草稿文章调收藏三接口 | **404**。service 层先复用 `requireArticleForWrite(id)` 判定存在性（与点赞 / 评论完全同一条路径） |
| 用户软删 | 该用户的 `bookmarks` 行保留。当前 MVP 无用户删除功能故不触发，同 likes 登记在「已知限制」 |
| 将来物理清理（硬删除） | 顺序见「软删除与外键的交互」：`bookmarks → notifications → likes → follows → comments → articles → users` |

### 建表 SQL

迁移 `20261018053624_add_bookmarks_and_view_count` 实际执行（已核对）：

```sql
ALTER TABLE `articles` ADD COLUMN `view_count` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `bookmarks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `article_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `bookmarks_article_id_idx`(`article_id`),
    UNIQUE INDEX `bookmarks_user_id_article_id_key`(`user_id`, `article_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `bookmarks` ADD CONSTRAINT `bookmarks_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `bookmarks` ADD CONSTRAINT `bookmarks_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

迁移后已用 `SHOW INDEX FROM bookmarks` 核实：`bookmarks_user_id_article_id_key`（两列，唯一）+ `bookmarks_article_id_idx`（单列，非唯一）+ PRIMARY，**`user_id` 未被 MySQL 额外补单列索引**（唯一索引左前缀已承担，与 `likes` 同纪律）。

---

## comment_likes（评论点赞表）

Prisma 模型名 `CommentLike`，`@@map("comment_likes")`。**第 11 批新建**（迁移见「第 11 批」小节）。

与 `likes` / `bookmarks` / `follows` 同族：**刻意不设 `deleted_at` / `updated_at`**——点赞是关系状态而非可隐藏内容，取消点赞是物理 DELETE，「点赞 = 该行存在」。**错误码语义与文章点赞刻意相反**：重复赞 / 取消未赞都返回 **200 幂等**（与 bookmark / follow 一族，见 `docs/API.md`「评论点赞与 @提及」）。

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键 |
| userId | user_id | INT | 否 | 无 | 点赞者 id（「用户本人」而非作者角色，命名同 likes / bookmarks），外键 → `users.id` RESTRICT |
| commentId | comment_id | INT | 否 | 无 | 被赞的评论 id，外键 → `comments.id` RESTRICT（评论走软删、行不消失，RESTRICT 保证关联行永远有主） |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 创建时间 |

### 索引

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | id | |
| comment_likes_user_id_comment_id_key | **唯一** | user_id, comment_id | 防重复点赞的唯一真相（并发 P2002 → 应用层转幂等成功） |
| comment_likes_comment_id_idx | 普通 | comment_id | 「某条评论的点赞数」实时 count 与评论列表 liked 批量判定 |

- `user_id` 侧不另建索引：唯一索引左前缀已承担（likes / bookmarks 同纪律）。

### 建表 SQL（迁移生成）

```sql
CREATE TABLE `comment_likes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `comment_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `comment_likes_comment_id_idx`(`comment_id`),
    UNIQUE INDEX `comment_likes_user_id_comment_id_key`(`user_id`, `comment_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `comment_likes` ADD CONSTRAINT `comment_likes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `comment_likes` ADD CONSTRAINT `comment_likes_comment_id_fkey` FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

---

## follows（关注表）

Prisma 模型名 `Follow`，`@@map("follows")`。**第 4 批新建，迁移待执行（草案已确认，但 `migrate dev` 尚未跑）。**

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键（代理键，无业务含义） |
| followerId | follower_id | INT | 否 | 无 | **主动关注者** id，外键 → `users.id` |
| followingId | following_id | INT | 否 | 无 | **被关注者** id，外键 → `users.id` |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 关注时间 |

**本表刻意不设 `updated_at` 与 `deleted_at`**，与 `likes` 同构，原因见下方「为什么没有软删除列」。

### schema 变更已获批准（豁免登记 · 第 5 项）

> **本节是一次「禁止修改数据库 schema」例外的书面登记（契约 §2「已批准的例外」第 5 项）。**
> 契约 §2 禁止事项里的「禁止修改数据库 schema」在本次**经用户明确批准后豁免**。
> 批准范围：**仅限新建 `follows` 一张表**（含其两条外键与两个索引），
> **不含修改 `users` / `articles` / `comments` / `likes` 任何一列**。
> 批准依据与决策过程见 `docs/API.md` 的 4 个关注接口章节（`POST` / `DELETE` / `GET followers` / `GET following`）。
>
> 注意：本项是**独立的一次批准**，不是援引前面任何一项（第九批 / 第十批 / 第十一批 / 分类功能各自独立）。
> 契约 `AI_CONTRACT.md` 第 2 节「禁止事项」里的 schema 禁令**本批不修改其他条目**（按用户要求，豁免只登记在本书与契约 §2 第 5 项）。

### 为什么必须有独立表（不能复用现有表加列）

| 理由 | 说明 |
|---|---|
| 多对多 | 一个用户关注 N 个用户，一个用户被 M 个用户关注，是标准的多对多关系，`users` 表自己放不下 |
| 不能在 `users` 加冗余列存 id 列表 | 用 `VARCHAR` 存逗号分隔的 user_id 列表，无法索引、无法保证原子性、并发下必然错乱 |
| 不能靠 `comments` / `likes` 标记 | 语义完全不同（关注不是评论也不是点赞），混用会让「粉丝数」「关注数」统计掺入无关数据 |

### 唯一约束是防重复关注的唯一真相

`@@unique([followerId, followingId])`（`follows_follower_id_following_id_key`）。

应用层「先查 `findUnique` 再 `create`」**存在竞态窗口**：两个并发请求都在对方写入前查到「未关注」，然后都执行 INSERT，产生两条重复记录。只有 DB 唯一约束能真正防住 —— service 层捕获 Prisma 的 `P2002` 转成 **`200 { following: true }`（幂等成功）**，与 `likes` 的 `409 / 40900` 刻意**不同**（见下方「与 likes 的 DELETE 语义分歧」）。

**这意味着实现层不允许「先查后写」当作正确性保障**，它只能用来给出更友好的提示；真正的拦截靠唯一约束。

### 为什么 `following_id` 要单独建索引

`@@index([followingId])`（`follows_following_id_idx`）支撑两处高频查询：

1. **实时 `followerCount`**：`SELECT COUNT(*) FROM follows WHERE following_id = ?` —— 粉丝列表接口与「粉丝数」都要用
2. **粉丝列表**：`WHERE following_id = ?` 取某用户的粉丝
3. **关注列表**：`WHERE follower_id = ?` 取某用户关注了谁（由唯一约束左前缀承担，见下）

`follower_id` 侧**不另建索引**：`follows_follower_id_following_id_key` 的左前缀已承担 `WHERE follower_id = ?`，MySQL 不会重复创建（同 `likes` 的 `user_id` 处理）。

### 为什么没有软删除列

`follows` 与 `likes` 一样是**不做软删除的业务表**，理由同构：

- **关注是一个关系状态，不是一条可隐藏的内容**。`articles` / `comments` 软删是为了「从列表里消失但保留数据」，关注关系没有「隐藏但保留」的语义。
- **软删会与唯一约束直接冲突**：若取消关注时置 `deleted_at` 而保留行，那么同一 `(follower_id, following_id)` 取消后再关注会撞唯一约束，只能改成 `UPDATE ... SET deleted_at = NULL`。这样一来「关注 = 该行存在且未删除」这个不变式不再直观，且每次查询都要额外带 `deleted_at IS NULL` 条件 —— 为一个没有语义需求的场景付出复杂度，不值。
- **物理 DELETE 让不变式始终成立**：`follows` 表里存在一行 ⟺ A 关注了 B。计数只需 `COUNT(*)`，无需任何额外条件。

### 软删除联动：被关注者 / 关注者软删后 follows 行会残留

与其他表一致，**软删除不触发外键**，因此：

| 场景 | 行为 |
|---|---|
| 被关注者被软删 | 其 `follows` 行**保留**，不连带删除。粉丝列表 / 关注列表 `JOIN users` 时该用户被滤掉，**不出现在任何列表、不计入 `total` / `followerCount` / `followingCount`**（见下方「计数口径」） |
| 关注者被软删 | 其 `follows` 行**保留**；MVP 无用户删除功能故不触发 |
| 将来物理清理（硬删除） | 顺序必须是 `likes → follows → comments → articles → users`，`follows` 接在 `likes` 之后（见「软删除与外键的交互」） |

### 计数口径（与 API 一致：只统计未软删用户）

**核心纪律**：凡是「粉丝数 / 关注数」相关的计数，口径必须两端一致 ——

- `GET /api/users/:id/followers` 的 `total`（粉丝数）
- `GET /api/users/:id/following` 的 `total`（关注数）
- `POST /api/users/:id/follow` 返回的 `followerCount` / `followingCount`
- `DELETE /api/users/:id/follow` 返回的 `followerCount` / `followingCount`

**以上四者口径完全相同**：都只 `COUNT` `follows` 行中**另一端用户未软删**的记录。

- 粉丝数 `followerCount`（`WHERE following_id = :id`）：只算 `follower` 端 `users.deleted_at IS NULL` 的。被软删的关注者不计入。
- 关注数 `followingCount`（`WHERE follower_id = :id`）：只算 `following` 端 `users.deleted_at IS NULL` 的。被软删的被关注者不计入。
- 实现：`JOIN users` 后带 `users.deleted_at IS NULL`，或子查询过滤。列表与计数**同源**（同一段 JOIN + 过滤），避免「列表 `total=5`、POST 返回 `followerCount=6`（含一个软删用户）」的数字跳变。
- 与 `likeCount` 的已知限制第 3 条（点赞数含已软删点赞者）**刻意不同**：follows 的计数在 MVP 就要排除软删用户（因为粉丝列表已经排除了，计数若不排除会对不上）。`likeCount` 之所以不排，是因为文章软删后整篇不可见、不存在「列表与计数对不上」的展示场景；follows 则两端都暴露数字。

### 次级排序（sortBy 的 id 是 follows.id）

`GET /api/users/:id/followers|following` 的 `sortBy` 白名单仅 `followedAt`（`follows.created_at`）/ `id`，默认 `followedAt desc`，**次级补 `id`** 保证翻页稳定。

- 这里的「次级 `id`」是 **`follows.id`**（关系行的代理主键），不是 `users.id`，也不是 `follows.follower_id` / `following_id`。与 `likes` 的「次级 `id` 是 `likes.id`」完全同构（API 层 `{ id: order }` 解析为 `likes.id`，此处解析为 `follows.id`）。
- 实现：Prisma `orderBy` 主排序翻成 `{ createdAt: order }`，次级补 `{ id: order }`（即 `follows.id`）。**不要**写成 `{ followedUserId: order }` 之类 —— 表里没有这个列。

### 与 likes 的 DELETE 语义分歧（幂等 200 vs 404）

这是 follow 与 like 两处**刻意不同**的语义，写进 API.md 章节，DB 层只定性：

- `DELETE /api/articles/:id/like`（取消没赞过的）→ **404**（likes 语义：「取消一个动作」，重复是错误）。
- `DELETE /api/users/:id/follow`（取关没关注过的）→ **200 `{ following: false }`**（follows 语义：「确认关系不存在」，没关注本来就是这个状态，幂等成功）。
- 同样 `POST` 端：重复点赞 → 409；重复关注 → 200（已关注状态）。
- **唯一约束仍是并发下的唯一真相**：并发重复关注报 `1062`（Prisma `P2002`），但捕获后**转 200 幂等成功**，不转 409。
- 理由（API.md 会明写）：likes 的取消是「取消一个动作」（重复是错误），follows 的取消是「确认关系不存在」（没关注也是这个状态），语义不同，故回 200。否则将来读代码的人会以为是 bug。

### 建表 SQL（草案，待迁移生成后回填实际 DDL）

```sql
CREATE TABLE `follows` (
  `id` int NOT NULL AUTO_INCREMENT,
  `follower_id` int NOT NULL,
  `following_id` int NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `follows_follower_id_following_id_key` (`follower_id`,`following_id`),
  KEY `follows_following_id_idx` (`following_id`),
  CONSTRAINT `follows_follower_id_fkey` FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `follows_following_id_fkey` FOREIGN KEY (`following_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

> 外键命名：两个外键都指向 `users`，但角色分明（`follower_id` = 关注者、`following_id` = 被关注者），故用角色名而非笼统 `user_id`（见「外键命名规则」）。这与 `likes` 用 `user_id`（只有「点赞者」单一角色）是同一规则的两种合法情形，不是特例。

### 索引（草案）

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | id | |
| follows_follower_id_following_id_key | **唯一** | follower_id, following_id | **防重复关注的唯一真相**，并发下由 MySQL 最终拦截（重复插入报 `1062`） |
| follows_following_id_idx | 普通 | following_id | 支撑 `followerCount` 的实时 `COUNT(*)` 与粉丝列表查询 |

- 预期 MySQL **不会为 `follower_id` 额外补单列索引** —— 唯一索引左前缀已承担（与 `likes` 同，待迁移后 `SHOW INDEX FROM follows` 实测核实）。

### 第 4 批的迁移 SQL（实际生成，已执行 `20261011083029_add_follows`）

```sql
-- CreateTable
CREATE TABLE `follows` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `follower_id` INTEGER NOT NULL,
    `following_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `follows_following_id_idx`(`following_id`),
    UNIQUE INDEX `follows_follower_id_following_id_key`(`follower_id`, `following_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `follows` ADD CONSTRAINT `follows_follower_id_fkey` FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `follows` ADD CONSTRAINT `follows_following_id_fkey` FOREIGN KEY (`following_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

> 下方为**实际生成并已应用**的 `migration.sql` 内容。`SHOW CREATE TABLE follows` / `SHOW INDEX FROM follows` 已核对：`UNIQUE KEY follows_follower_id_following_id_key`（`follower_id`, `following_id`）、`KEY follows_following_id_idx`（`following_id`）、两条外键均 `ON DELETE RESTRICT ON UPDATE CASCADE` —— 与本块及「建表 SQL」小节一致。**新表无既有数据，不涉及任何回填**。

---

## tags（标签表）

Prisma 模型名 `Tag`，`@@map("tags")`。**第 7 批新建，迁移 `add_tags_and_article_tags`**。

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键 |
| name | name | VARCHAR(20) | 否 | 无 | 标签名；API 校验 trim 后 1–20 字符；**大小写不敏感**（列继承表默认 `utf8mb4_unicode_ci`，`Vue` 与 `vue` 在 DB 层是同一个值：唯一约束判重、upsert 复用、`?tag=` 筛选全部按 ci 判等。2026-10-18 探针实测确认，文档从「不折叠」修正为 ci 语义——与「不为英文大小写折叠费劲」的拍板意图一致） |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 创建时间 |

### 唯一约束是防重复标签的唯一真相

`tags.name` 有 **DB 唯一约束**（`tags_name_key`）。应用层「先查后建」存在竞态窗口（两个并发请求都查到「不存在」→ 都创建），与 likes 的 `(user_id, article_id)`、follows 的 `(follower_id, following_id)` 同一纪律：**由 DB 唯一约束最终拦截**，应用层捕获 P2002 回 `400 / 40000`，绝不裸抛 500。service 层实际用 `upsert`（语义即「存在则复用，不存在则创建」），竞态兜底交给约束。

### 索引

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | id | |
| tags_name_key | 唯一 | name | 防重复标签（唯一真相）+ 按名字精确查找（`?tag=` 筛选、upsert 定位） |

---

## article_tags（文章-标签中间表）

Prisma 模型名 `ArticleTag`，`@@map("article_tags")`。**第 7 批新建，迁移 `add_tags_and_article_tags`**。多对多关联表，与 likes / follows 同构：**无 `deleted_at` / `updated_at`**（关联的存在即事实，解除关联是物理 DELETE）。

### 字段与约束

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| articleId | article_id | INT | 否 | 无 | 联合主键之一，外键 → `articles.id` **`ON DELETE CASCADE`** |
| tagId | tag_id | INT | 否 | 无 | 联合主键之一，外键 → `tags.id` **`ON DELETE CASCADE`** |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 建立关联时间 |

- **联合主键 `PRIMARY KEY (article_id, tag_id)`**：防重复关联的唯一真相（一篇文章同一标签只有一行）。
- **两条外键均 `ON DELETE CASCADE`**：硬删文章 / 硬删标签时中间表自动清理。本项目删文章走**软删**（行不消失，关联保留），所有公开出口都过滤了软删与草稿，**无泄露**；Cascade 只在未来出现硬删路径时兜底。

### 索引

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | article_id, tag_id | 防重复关联 + 「某篇文章的全部标签」查询（左前缀 `article_id`） |
| article_tags_tag_id_idx | 普通 | tag_id | 「某标签下的全部文章」反查（`?tag=` 筛选、热门榜计数） |

### 为什么不用 articles 表加 tags 列（JSON / 逗号分隔）

同 follows「为什么必须有独立表」的论证：逗号分隔无法索引、无法约束、并发下必然错乱；JSON 列 MySQL 8 能索引但无法用外键保证引用完整性，且 Prisma 对 JSON 数组的关系查询（`some` / 关联计数排序）表达不了。多对多是标准解法，成本仅一张中间表。

---

## notifications（通知表）

Prisma 模型名 `Notification`，`@@map("notifications")`。**第 8 批新建，迁移（见「迁移记录」末条）**。通知中心的数据源：评论 / 关注 / 点赞三类动作成功后，由业务层**自动写入**一条通知（自通知抑制：`actorId !== 接收者`）。

### 字段与约束

| Prisma 字段 | 数据库列   | 类型                          | 空   | 默认                | 说明                                                                                     |
| ----------- | ---------- | ----------------------------- | ---- | ------------------- | ---------------------------------------------------------------------------------------- |
| id          | id         | INT                           | 否   | AUTO_INCREMENT      | 主键                                                                                     |
| userId      | user_id    | INT                           | 否   | 无                  | **接收者** id（被通知的人），外键 → `users.id` `ON DELETE RESTRICT`                       |
| actorId     | actor_id   | INT                           | 否   | 无                  | **触发者** id（做动作的人），外键 → `users.id` `ON DELETE RESTRICT`                       |
| type        | type       | ENUM('COMMENT','REPLY','FOLLOW','LIKE') | 否   | 无                  | 通知类型                                                                                 |
| articleId   | article_id | INT                           | 可   | 无                  | 目标文章 id（`FOLLOW` 为 `null`），外键 → `articles.id` `ON DELETE RESTRICT`             |
| commentId   | comment_id | INT                           | 可   | 无                  | 触发的评论 id（`COMMENT`/`REPLY` 有值；`FOLLOW`/`LIKE` 为 `null`），**无外键**（只用于将来深链） |
| readAt      | read_at    | DATETIME(3)                   | 可   | NULL                | 软已读标记：`null` = 未读，赋值 = 已读。**不做物理删除**                                |
| createdAt   | created_at | DATETIME(3)                   | 否   | CURRENT_TIMESTAMP(3)| 创建时间                                                                                 |

- **`read_at` 而非 `is_read`**：已读是「打时间戳」语义，用 `NULL` 区分未读，天然支持「未读数 = COUNT WHERE read_at IS NULL」，且将来要记「已读时间」也直接复用。
- **不做物理删除**：通知永久保留（MVP 不做定时清理），已读只置 `read_at`，符合契约第 9 节「默认软删除」精神（此处以 `read_at` 充当软态，无需 `deleted_at`）。
- **`comment_id` 不建外键**：评论是软删，行不消失；通知只存 id 供将来深链，不引用完整性。若评论被删，前端按 `article_id` 跳文章详情即可（且 `targetTitle` 已降级为 `内容已删除` 时不跳）。

### 索引

| 索引名                        | 类型 | 列                | 用途                                                                       |
| ----------------------------- | ---- | ----------------- | -------------------------------------------------------------------------- |
| PRIMARY                       | 主键 | id                | 单条通知定位                                                               |
| notifications_user_id_read_at_idx | 普通 | user_id, read_at  | 「我的通知列表」按 `user_id` 过滤 + `created_at` 倒序；「未读数」`WHERE user_id = ? AND read_at IS NULL` |

### 外键为什么 RESTRICT 而不是 CASCADE / SET NULL

本项目 `users` / `articles` 都是**软删除**（行不消失），生产环境永远不会触发物理删除，所以 `RESTRICT` 在生产等价于「无副作用」。它只在「将来真要物理删用户 / 文章」时兜底拦一下，避免通知变成孤儿。测试夹具清理顺序（先删通知 `id: in [...]` → 再删文章 / 账号）也兼容 `RESTRICT`，不会撞约束。

### join + 空值降级（被删处理，防坑 2）

`actorId` / `articleId` 都是软删实体（不物理删），所以查询时 `include` 总能拿到行；是否「已注销 / 已删除」靠 `deleted_at IS NOT NULL` 判定：

- actor 软删 → `actorName` 返回 `已注销用户`、`actorAvatar` 返回 `null`；
- article 软删 / 不存在 → `targetTitle` 返回 `内容已删除`。

**不冗余存储快照**（不把 nickname / title 拷进通知表）：join 拿到实时昵称 / 标题，被删才降级。这样用户改了昵称，历史通知也跟着新昵称显示。

### 自通知抑制（防坑 3）

写入通知前业务层比对 `actorId !== userId`（接收者）：自己评论自己的文章、自己关注自己、自己赞自己的文章 → 一条都不发。判定集中在三个 service（`comment` / `follow` / `like`）的钩子里，不分散到接口层。

---

## series（系列表）

Prisma 模型名 `Series`，`@@map("series")`。文章系列（专栏），把多篇连载文章组织成一个有序容器（第 10 批）。

### 字段

| Prisma 字段 | 数据库列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| id | id | INT | 否 | AUTO_INCREMENT | 主键 |
| title | title | VARCHAR(50) | 否 | 无 | 系列标题，API 校验 1–50 字符 |
| description | description | VARCHAR(200) | 是 | NULL | 系列描述；传 `null` = 清空 |
| authorId | author_id | INT | 否 | 无 | 系列作者 id，外键 → `users.id` |
| createdAt | created_at | DATETIME(3) | 否 | CURRENT_TIMESTAMP(3) | 创建时间 |
| updatedAt | updated_at | DATETIME(3) | 否 | 无 | 更新时间，Prisma `@updatedAt` 应用层维护 |

**无 `deleted_at` / `updated_at` 之外任何列**：系列是纯组织容器，删除即物理删除（`DELETE /api/series/:id`，与文章的软删刻意不同）；无 `deleted_at`、无软删恢复流程。

### `articles.series_id` 外键为什么是 SET NULL（本表最重要的一条设计）

`articles.series_id → series.id` 选 `ON DELETE SET NULL` 而非 `CASCADE` 或 `RESTRICT`（用户拍板 2026-10-18）：

| 候选 | 行为 | 排除理由 |
|---|---|---|
| **SET NULL（采用）** | 删系列 → 文章全部回到「无系列」 | 符合需求语义：系列是「组织方式」，删容器不该毁内容 |
| CASCADE | 删系列 → 文章一起没 | 一篇篇写出来的文章因「换个栏目名」被删，数据损失不可接受 |
| RESTRICT | 有文章绑着就不让删系列 | 与 SET NULL 语义相反；「必须先逐篇解绑才能删系列」是反人类的操作流 |

MySQL 的 `SET NULL` 要求列可空——`articles.series_id` 正是 `INT NULL`，天然满足。**应用层同时显式清 `series_order`**：外键 SET NULL 只清 `series_id` 一列，`series_order` 不在外键管辖内，靠 `DELETE /api/series/:id` 的显式 `UPDATE ... SET series_id = NULL, series_order = NULL` 双清（不留孤儿序号）。

### 同系列序号唯一：应用层保证，不建复合唯一索引

`seriesOrder` 同系列内唯一（`series_id, series_order` 逻辑唯一）由**应用层**保证，**刻意不建数据库复合唯一索引**：

- 两列都可空（未绑系列的文章 `series_id` / `series_order` 均为 NULL），MySQL 唯一索引**不阻拦多个全 NULL 行**——「唯一」实际只对两列都非 NULL 的行生效，语义与直觉有偏差。
- 序号冲突的产品决策是 **`409 / 40900` 拒绝**（让用户明确选择下一个序号），不是数据库报错；冲突检测放在 service 层，错误码语义更贴合前端交互（自动重排会打乱用户「插到中间」的预期，已排除）。
- 自动分配（新建时省略 `seriesOrder` → `max + 1`）同样在应用层完成，与冲突检测同一段逻辑。

### 索引

| 索引名 | 类型 | 列 | 用途 |
|---|---|---|---|
| PRIMARY | 主键 | id | |
| series_author_id_fkey | 普通（外键自动创建） | author_id | 外键索引；`GET /api/users/:id/series` 按作者查 |

**不按 `(author_id, created_at)` 建复合索引**：`GET /api/users/:id/series` 固定 `createdAt desc` 且用户的系列量级为个位数，外键自动索引 + filesort 无感；与「category 不建索引」同口径，数据量上来再评估。

### 建表 SQL（迁移生成，未手工改写）

```sql
CREATE TABLE `series` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(50) NOT NULL,
    `description` VARCHAR(200) NULL,
    `author_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `series` ADD CONSTRAINT `series_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

### schema 变更已获批准（豁免登记 · 第 15 项）

> 契约 §2「禁止修改数据库 schema」在本批**经用户明确批准后豁免**：批准范围 = **新建 `series` 一张表 + `articles` 新增 `series_id` / `series_order` 两列（含一条 SET NULL 外键）**，不含其他表任何变更、不含改列名/类型、不含删列、不含复合唯一索引。登记见 `docs/AI_CONTRACT.md` §2 第 15 项，决策过程见 `docs/API.md`「文章图片上传与专栏系列（第 10 批）」。

---

## reports（举报表）

第 12 批新建。用户举报违规的文章 / 评论，管理员在后台处理，处理结果经通知中心反馈举报人。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INT | PK, AUTO_INCREMENT | |
| `reporter_id` | INT | NOT NULL, FK → `users.id` **ON DELETE RESTRICT** | 举报人。业务角色是「举报者本人」，与 `likes.user_id` 同族用 `user_id` 语义，但按角色命名用 `reporter_id`（Prisma 字段 `reporterId`，关系字段 `reporter`；`User` 侧反向关系 `reports`） |
| `target_type` | ENUM('ARTICLE','COMMENT') | NOT NULL | 举报目标类型（Prisma 枚举 `ReportTargetType`） |
| `target_id` | INT | NOT NULL | 举报目标 id。**多态、不建外键**（同 `notifications.commentId` 先例——一列指向两种表，外键无法表达；目标可见性 / 存在性校验完全在应用层做） |
| `reason` | VARCHAR(200) | NULL | 举报理由，选填（接口层 zod 校验 ≤200） |
| `status` | ENUM('PENDING','RESOLVED','REJECTED') | NOT NULL DEFAULT 'PENDING' | 待处理 / 违规成立已处理 / 核实未违规（Prisma 枚举 `ReportStatus`） |
| `resolved_at` | DATETIME(3) | NULL | 处理时间；未处理为 NULL（2026-10-18 用户拍板：加，管理列表展示处理时间） |
| `created_at` | DATETIME(3) | NOT NULL DEFAULT CURRENT_TIMESTAMP(3) | |

**唯一约束**：`reports_reporter_id_target_type_target_id_key`（`reporter_id` + `target_type` + `target_id`，Prisma 默认命名）——同一用户对同一对象只有一行举报，重复举报由应用层转 `409/40900`，不新增行、不重置状态（即使上次已被处理仍 409，处理结果走通知告知）。

**索引**：`reports_target_type_target_id_idx`（`target_type` + `target_id`，管理员处理时按目标批转 PENDING 用）+ `reports_status_idx`（`status`，后台列表筛选用）；`reporter_id` 由唯一约束左前缀覆盖，不额外建索引。

**无 `deleted_at` / `updated_at`**：举报行不软删（处理即终态，status 表达一切），updated_at 无业务读取方（`resolved_at` 已承担时间语义）。

建表 SQL（迁移 `add_reports`）：

```sql
-- CreateTable
CREATE TABLE `reports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reporter_id` INTEGER NOT NULL,
    `target_type` ENUM('ARTICLE', 'COMMENT') NOT NULL,
    `target_id` INTEGER NOT NULL,
    `reason` VARCHAR(200) NULL,
    `status` ENUM('PENDING', 'RESOLVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `resolved_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `reports_reporter_id_target_type_target_id_key`(`reporter_id`, `target_type`, `target_id`),
    INDEX `reports_target_type_target_id_idx`(`target_type`, `target_id`),
    INDEX `reports_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `reports` ADD CONSTRAINT `reports_reporter_id_fkey` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

### schema 变更已获批准（豁免登记 · 第 17 项）

> 契约 §2「禁止修改数据库 schema」在本批**经用户明确批准后豁免**：批准范围 = **新建 `reports` 一张表（含 2 个新枚举 `ReportTargetType` / `ReportStatus` 与一条 RESTRICT 外键）+ `NotificationType` 枚举追加 `REPORT_RESOLVED` / `REPORT_REJECTED` 两值**。登记见 `docs/AI_CONTRACT.md` §2 第 17 项，决策过程见 `docs/API.md`「举报与审核（第 12 批）」。

---

## 第 2 批：用户主页接口（零 schema 变更）

新增三个接口（`docs/API.md` 有完整规格）：

| 接口                              | 用途                    | schema 影响                    |
| -------------------------------- | --------------------- | --------------------------- |
| `GET /api/users/:id`             | 用户详情 + 三个计数          | **无**（只读现有 `users` / `articles` / `likes`） |
| `GET /api/users/:id/articles`     | 用户文章 Tab，真后端分页         | **无**（复用 `articles` 现有查询与唯一索引）        |
| `GET /api/users/me/likes`         | 当前用户点赞过的文章 Tab        | **无**（复用 `likes` 现有查询与 `likes_user_id_article_id_key`） |

### 三条登记（本批唯一的 DB 侧内容）

**① 不新增表、不加列、不建索引、不做迁移。**

三个接口全部只读既有表：`users`、`articles`、`likes`、`comments`。没有 `CREATE TABLE`、没有 `ALTER TABLE`，所以**「迁移记录」表本批不新增行**，`prisma migrate status` 应仍显示 6 个迁移全部 applied、无 pending。写实现时**不需要跑 `migrate dev`** —— 如果发现需要，那说明实现走偏了，回头查是不是把接口字段当成了列。

**② 三个计数一律实时 `COUNT(*)`，不落冗余列。**

`GET /api/users/:id` 返回的 `articleCount` / `receivedLikeCount` / `receivedCommentCount`：

- **不往 `users` 表加列**。三个数字全部实时查，与文章 `likeCount` 是同一纪律（`likeCount` 也没有 `articles.like_count` 冗余列，见「likes」小节「按点赞数排序」）。
- **理由**：三个数字都随软删实时变化（作者删文后立即下降）。冗余列要么每次写路径维护（漏一处就长期不一致），要么加定时任务对账，两者复杂度都高于实时 `COUNT(*)` 的成本 —— 当前数据量下单次 `COUNT` 是毫秒级。
- **口径必须与列表接口对齐**：`articleCount` 排除 `deletedAt IS NOT NULL` 的文章；`receivedLikeCount` / `receivedCommentCount` 也只统计**未软删文章**上的记录。三者都走 `whereNotDeleted()`，**禁止手写 `deletedAt: null`**（见「查询约定」）。
- **`receivedLikeCount` 含自赞**：`POST /api/articles/:id/like` 允许给自己的文章点赞，所以「获赞数」不排除本人点赞，与 `likeCount` 同为 all-time 累计、不做时间窗衰减。
- 探针不要断言这三个数字的绝对值 —— 它们随测试数据变动。断言「用户 A 有 N 篇未软删文章时 `articleCount` 为 N」这种**关系**，不要断言具体数字。

**③ `likedAt` 是响应层虚拟字段，不建列。**

`GET /api/users/me/likes` 的 `list[].likedAt` = 点赞时间：

- **数据库里没有 `liked_at` 列，也不需要有** —— 这个值就是 `likes.created_at` 本身（`Like` 模型的自带列），API 层起名叫 `likedAt` 只是为了和 `articles.createdAt`（文章发布时间）在同一个响应对象里区分语义。
- **Prisma 侧不存在 `likedAt` 字段**：直接写 `orderBy: { likedAt: 'desc' }` 会报 `Invalid ...`（实测）。必须由 `buildOrderBy()` 的 `map` 翻译成 `{ createdAt: order }`（`likes.createdAt`），与 `ARTICLE_SORT_MAP` 同一机制。
- **如果将来真的要「点赞时间可单独排序 / 独立于创建时间」，那才需要加列**；现在不需要 —— 加了就是冗余，与 ② 同一条纪律。

### 为什么不加冗余列（通用原则，跨批适用）

本批三个接口一个列都不加，但结论不止适用于本批：**凡是「可由既有列实时算出」的展示型数字，一律不加冗余列。**

判断标准：加冗余列的收益是省一次查询，代价是多一处写路径维护 + 一处对账逻辑。`COUNT(*)` 在 MySQL 上走索引，成本足够低，收益远小于维护成本。真正该加列的是「算不出来」的数据（比如「最后登录时间」这种外部事件写入的值）。

**推论：将来第 4 批的 `follows` 表是这张表的少数例外** —— 关注数虽然也能 `COUNT` 出来，但 `follows` 表本身是业务必需（关注关系要存），不是为省查询而加的冗余。

### 与「已批准的例外」的关系（**本批不新增条目**）

契约第 2 节的「已批准的例外」目前是 **4 项**，本批**不新增、不改动**其中任何一项：

| # | 批次   | 例外内容                          | 归属禁令    |
|---|------|------------------------------|-----------|
| 1 | 第九批  | 新增 `users.avatar` / `users.bio`   | schema 禁令   |
| 2 | 第十批  | 新建 `likes` 表                    | schema 禁令   |
| 3 | 第十一批 | 引入 `multer` 依赖                 | 依赖禁令     |
| 4 | 分类功能 | 新增 `articles.category`           | schema 禁令   |

**本批零 schema 变更、零新依赖，因此不构成例外** —— 不需要审批，也不需要改契约。例外数已在**第 4 批（`follows` 新建表）**变成 5 项（见契约第 2 节第 5 项）。

---

## 第 3 批：删除评论（零 schema 变更）

新增一个接口 `DELETE /api/comments/:id`（`docs/API.md` 有完整规格）：

| 接口 | 用途 | schema 影响 |
| --- | --- | --- |
| `DELETE /api/comments/:id` | 删除评论（评论作者或文章作者，软删） | **无**（复用既有 `comments.deleted_at`） |

### 四条登记（本批唯一的 DB 侧内容）

**① 不新增表、不加列、不建索引、不做迁移。**

- `comments.deleted_at` 列已在迁移 `20260929144738_blog_articles_comments` 建好（`DATETIME(3) NULL`，见「comments（评论表）」字段表），本批直接复用做软删，**不 ALTER 任何表**。
- 「迁移记录」表本批不新增行：实测 `backend/prisma/migrations/` 现有 **6** 个迁移目录，本批不新增；`prisma migrate status` 应仍显示 6 个全部 applied、无 pending。写实现时**不需要跑 `migrate dev`** —— 若发现需要，说明实现走偏了（把接口字段当成了列）。
- **本批不新增索引（选项 B）**：现有 `comments_article_id_created_at_idx(article_id, created_at)` 不含 `deleted_at`，软删查询 `article_id = ? AND deleted_at IS NULL` 需回表过滤；但 MVP 评论量极小（当前库仅 1 条），回表成本可忽略，故不为此加索引。若将来评论量大，加回 `(article_id, deleted_at, created_at)` 只需一条迁移（见「comments（评论表）→ 索引」段）。

**② 软删纪律与现有接口完全一致，自动生效、无需改。**

- 评论列表 `GET /api/articles/:id/comments`（`comment.service.js:107`）走 `whereNotDeleted({ articleId })`，软删后该评论**自动从列表消失**，无需改该接口。
- `receivedCommentCount`（`user.service.js:246-251`）的 `comment.count` where 同时带 `article.deletedAt: null` 与 `comment.deletedAt: null` 两层过滤 —— **删评论后该计数自动下降，本批零 service 改动**。
- 与文章软删（`DELETE /api/articles/:id`）同构：已软删评论再删 → `whereNotDeleted` 过滤后查不到 → 返回 40400，不会重复置时间戳。

**③ 软删行物理保留，与全仓软删纪律一致。**

`deleted_at` 置为非 NULL 而非 `DELETE`，符合契约 §9 的通用软删约定。`comments` 表无 `parentId`（平铺、无嵌套回复），删除单条无级联，也不影响其它评论。

**④ 与「已批准的例外」关系：本批不新增条目。**

- 本批零 schema 变更、零新依赖，不构成例外，不需要审批、不需要改契约。例外数保持 4 项，直到第 4 批（`follows` 新建表）才变 5。

### 边界与前端交互（跨文档登记，DB 层只定性）

- **文章已软删时**：权限判定的"文章作者"分支走 `whereNotDeleted({ id: comment.articleId })`，文章不可见则查不到 → 文章作者失去删除权；只有**评论作者**仍可删。这是预期行为（文章都不可见了，评论也不该允许文章作者再操作），API.md 草案会明写，避免将来读代码误以为漏判。DB 层无影响。
- **前端二次确认**：沿用文章删除的 `ElMessageBox.confirm`（不可逆操作一致性），属 `CommentList.vue` / API.md / 探针范畴，不改变 DB 结构。`probe-comment-delete.mjs` 会断言"点了确认才发 DELETE、取消不发"。
- **撤销/恢复删除**：本批不含（MVP 范围），与文章删除一致。

### 待办核对（非本批改动，供用户决策）

- **①** `user.service.js:246-251` 的 `receivedCommentCount` 实际**手写** `deletedAt: null`，与第 2 批「② 三个计数」段"三者都走 `whereNotDeleted()`、禁止手写 `deletedAt: null`"的描述口径不一致。功能正确（计数已过滤软删），属历史遗留，是否统一写法留待用户裁决，不纳入本批。
- **②（已复核·原描述正确）** 「comments（评论表）→ 索引」段称"索引是 `(article_id, created_at)`，不含 `deleted_at`"经实测确认正确：建表迁移 `20260929144738` 曾建 `(article_id, deleted_at, created_at)`，但后续迁移 `20260929145244_comments_idx_article_created` 第 5 行 `DROP`、第 8 行重建为 `(article_id, created_at)`；`SHOW INDEX FROM comments` 实测亦仅 `(article_id, created_at)`。故本批对该段**无改动**；`6229c03` 仅读了建表迁移、漏看后续修改迁移而误改，已在本批改回。

---

## 第 4 批：关注（follows 表）

新增四个接口（规格见 `docs/API.md` 第 4 批关注章节，按本批流程在写后端前落地）：

| 接口 | 用途 | schema 影响 |
| --- | --- | --- |
| `POST /api/users/:id/follow` | 关注某用户（幂等） | **新建 `follows` 表**（本批唯一 schema 变更） |
| `DELETE /api/users/:id/follow` | 取消关注（幂等） | **无**（物理 DELETE `follows` 行） |
| `GET /api/users/:id/followers` | 某用户的粉丝列表（公开、分页） | **无**（只读 `follows` + `users`） |
| `GET /api/users/:id/following` | 某用户关注的列表（公开、分页） | **无**（只读 `follows` + `users`） |

### 与「已批准的例外」的关系（**本批新增第 5 项**）

契约第 2 节的「已批准的例外」由 **4 项升为 5 项**，新增的第 5 项即本批的 `follows` 表（`docs/AI_CONTRACT.md` §2 已登记）：

| # | 批次 | 例外内容 | 归属禁令 |
|---|------|----------|---------|
| 1 | 第九批 | 新增 `users.avatar` / `users.bio` | schema 禁令 |
| 2 | 第十批 | 新建 `likes` 表 | schema 禁令 |
| 3 | 第十一批 | 引入 `multer` 依赖 | 依赖禁令 |
| 4 | 分类功能 | 新增 `articles.category` | schema 禁令 |
| 5 | 第 4 批 | 新建 `follows` 表（两条外键 + 两个索引，无软删列） | schema 禁令 |

**本批唯一的 schema 变更就是新建 `follows` 一张表**，不含修改任何已建表；不构成依赖禁令（B 方案：存记录不推送，不引入 notifications / 未读数 / 轮询 / SSE 相关任何新依赖）。

### 计数口径（本批核心纪律，两端一致）

`followerCount` / `followingCount`（POST/DELETE 返回）与 `followers` / `following` 列表的 `total` **必须同口径**：都只统计**未软删**用户。详见「follows（关注表）→ 计数口径」。这是与 `likeCount`（含已软删点赞者）刻意不同的取舍，理由是该数字两端都暴露给用户，必须对得上。

### 次级排序的 id 是 follows.id

`sortBy` 次级补 `id` = `follows.id`（关系行代理主键），不是 `users.id`。详见「follows（关注表）→ 次级排序」。

### 与 likes 的 DELETE 语义分歧（幂等 200）

`DELETE /api/users/:id/follow` 取关未关注者返回 **200**（幂等），与 `DELETE /api/articles/:id/like` 返回 **404** 刻意不同。理由与 API.md 章节须明写，详见「follows（关注表）→ 与 likes 的 DELETE 语义分歧」。

### 边界与交互（跨文档登记，DB 层只定性）

- **不能关注自己**：`POST /api/users/:id/follow` 且 `:id === 当前用户` → `400 / 40000`（判断顺序在存在性检查之前）。`DELETE` 自己的关注态视为 no-op，返回 200。
- **软删用户不出现在列表、不计入计数**：粉丝 / 关注列表 `JOIN users` 过滤软删，`total` 与返回计数同步排除。
- **B 方案（用户已裁决）**：只写 `follows` 一行，不建 `notifications` 表、不加未读数、不做铃铛 UI、不做轮询 / SSE。粉丝列表能查到、粉丝数会 +1，但被关注者收不到任何提示。

---

## 第 5 批：role / status（users 表加两列）

管理端接口 7 个（规格见 `docs/API.md`「管理端接口（第 5 批）」章节）：

| 接口 | 用途 | schema 影响 |
| --- | --- | --- |
| `GET /api/admin/stats` | 数据概览（6 个实时 COUNT） | **无** |
| `GET /api/admin/users` | 用户列表（分页 / 搜索 / 状态筛选） | **无** |
| `PATCH /api/admin/users/:id/status` | 封禁 / 解禁（幂等；ADMIN 不可操作） | **无** |
| `GET /api/admin/articles` | 文章列表（含软删） | **无** |
| `DELETE /api/admin/articles/:id` | 删文章（软删，无视作者） | **无** |
| `GET /api/admin/comments` | 评论列表（含软删） | **无** |
| `DELETE /api/admin/comments/:id` | 删评论（软删，无视作者） | **无** |

**本批唯一的 schema 变更 = `users` 加 `role` / `status` 两列**；7 个接口本身零 schema 影响（计数全部实时 `COUNT(*)`，不加冗余列，与 `likeCount` / 用户主页计数同一纪律）。

### 与「已批准的例外」的关系（例外现共 9 项：schema 7 + 依赖 2）

契约第 2 节的「已批准的例外」现共 **9 项（schema 七项 + 依赖两项）**（`docs/AI_CONTRACT.md` §2 已同步登记）：

| # | 批次 | 例外内容 | 归属禁令 |
|---|------|----------|---------|
| 1 | 第九批 | 新增 `users.avatar` / `users.bio` | schema 禁令 |
| 2 | 第十批 | 新建 `likes` 表 | schema 禁令 |
| 3 | 第十一批 | 引入 `multer` 依赖 | 依赖禁令 |
| 4 | 分类功能 | 新增 `articles.category` | schema 禁令 |
| 5 | 第 4 批 | 新建 `follows` 表（两条外键 + 两个索引，无软删列） | schema 禁令 |
| 6 | **第 5 批** | 新增 `users.role` / `users.status` 两列（enum，均带默认值） | schema 禁令 |
| 7 | **第 5 批** | 引入 `marked` / `highlight.js` / `dompurify` 三包（前端，一组，仅用于文章详情页渲染 / 高亮 / 净化） | 依赖禁令 |
| 8 | **第 6 批** | 新增 `articles.status` 列（enum，默认 PUBLISHED） | schema 禁令 |
| 9 | **第 6 批** | 新建 `article_revisions` 表（版本快照，两条外键 + 索引） | schema 禁令 |

> 第 4 批小节里的 5 项表是当时的历史快照，保持不动；**以本表与 `docs/AI_CONTRACT.md` §2 为准**。

### 迁移与管理员赋值

1. 迁移 `add_user_role_status`：`users` 加 `role` / `status` 两列，`NOT NULL DEFAULT`，INSTANT 自动回填既有行。
2. 迁移后手动执行（**不写进迁移文件**，保持迁移纯净）：

```sql
UPDATE users SET role = 'ADMIN' WHERE username IN ('admin', 'lin');
```

3. SELECT 自证：`admin`（id=2）与 `lin`（id=167）迁移后 `role = 'ADMIN'`，其余用户 `role = 'USER'`、全部用户 `status = 'ACTIVE'`。
4. 赋值用 `username IN (...)` **不写死 id**：id 是环境相关值（不同库自增进度不同），username 是稳定业务键。

### 封禁语义（DB 侧只定性）

- DB 只存 `status` 一列，**拦截逻辑全在应用层**：登录接口（密码比对后查一次）与 `auth` 中间件（验签后查一次）双拦截。
- 封禁即「所有旧 token 即刻失效」：JWT payload **不放** `role` / `status`（放了则封禁 / 改角色后旧 token 不失效，安全上不可接受），代价是每个已鉴权请求多一次主键查询。
- **ADMIN 不能被管理端操作**：`PATCH /api/admin/users/:id/status` 目标为 ADMIN 时 service 层直接 400 / 40000「不能封禁或解禁管理员账号」，规则全文见 `docs/API.md`「管理员不能被管理端操作」。

---

## 第 6 批：草稿 / 自动保存 / 版本历史 / 回滚（articles 加 status 列 + article_revisions 表）

### schema 变更

1. `articles` 表新增 `status` 列：`ArticleStatus` enum（`DRAFT` / `PUBLISHED`），`NOT NULL DEFAULT PUBLISHED`，迁移 `add_article_status`；INSTANT 自动回填既有文章为 `PUBLISHED`，零 NULL。并新增索引 `(status, created_at)` 覆盖广场列表主查询。
2. 新建 `article_revisions` 表（`id` / `article_id` / `title` / `content` / `category` / `author_id` / `created_at`），存文章「更新前」快照，迁移 `add_article_revisions`；含 `article_id → articles.id ON DELETE CASCADE` 与 `author_id → users.id ON DELETE RESTRICT` 两条外键，及索引 `(article_id, created_at)`。

### 设计要点（详见 `docs/API.md` 对应接口）

- **草稿是完整的 articles 行**：`status = DRAFT` 的文章仅在作者「草稿箱」可见，不进广场列表、不进公开详情（详情遇 DRAFT 返回 404，与软删同口径）、不计入个人主页计数。
- **公开面默认只认 PUBLISHED**：`GET /api/articles`（广场）、`GET /api/articles/:id`（详情）、`GET /api/users/:id`（articleCount）、`GET /api/users/:id/articles`（文章 Tab）全部过滤 / 计数 `status = PUBLISHED`。
- **自动保存**走 `POST /api/articles/auto-save`：无 `draftId` 新建、有 `draftId` 更新；编辑已发布文章时前端先建独立草稿（`sourceArticleId` 仅校验不落库），发布时 `PUT /:原id` 覆盖并快照、再删临时草稿（补丁 1）。
- **版本快照**：`PUT /api/articles/:id` 在目标当前为 PUBLISHED 时，先把它当前版存入 `article_revisions` 再应用更新；草稿翻成发布不快照。**回滚**（`POST /api/articles/:id/restore`）先快照当前版、再覆盖为目标版本，保证回滚本身可再回滚。
- **防脏草稿**：建草稿有「门槛」——`title` 为空且 `content < 10` 字时不创建（补丁 3 第一道闸）；进入草稿态后任何变化都必须保存（含清空到 0 字，补丁 3 第二道闸）；草稿可被 `DELETE /api/users/me/drafts/:id` 物理删除（坑 2）。

### 与「已批准的例外」的关系（例外现共 9 项：schema 7 + 依赖 2）

| # | 批次 | 例外内容 | 归属禁令 |
|---|------|----------|---------|
| 1 | 第九批 | 新增 `users.avatar` / `users.bio` | schema 禁令 |
| 2 | 第十批 | 新建 `likes` 表 | schema 禁令 |
| 3 | 第十一批 | 引入 `multer` 依赖 | 依赖禁令 |
| 4 | 分类功能 | 新增 `articles.category` | schema 禁令 |
| 5 | 第 4 批 | 新建 `follows` 表 | schema 禁令 |
| 6 | 第 5 批 | 新增 `users.role` / `users.status` 两列 | schema 禁令 |
| 7 | 第 5 批 | 引入 `marked` / `highlight.js` / `dompurify` 三包 | 依赖禁令 |
| 8 | **第 6 批** | 新增 `articles.status` 列（enum，默认 PUBLISHED） | schema 禁令 |
| 9 | **第 6 批** | 新建 `article_revisions` 表（版本快照，两条外键 + 索引） | schema 禁令 |

> 以本表与 `docs/AI_CONTRACT.md` §2 为准；第 4 / 5 批小节里的历史快照表保持不动。

---

## 第 7 批：标签 + 评论嵌套（tags / article_tags 两张表 + comments.parent_id）

### schema 变更

| 变更 | 内容 |
|---|---|
| 新建 `tags` 表 | `id` / `name VARCHAR(20)`（**唯一约束**）/ `created_at`；无软删列（标签没有「删了但留痕」的需求，无关联后即无意义） |
| 新建 `article_tags` 表 | 联合主键 `(article_id, tag_id)` + 两条外键（均 `ON DELETE CASCADE`）+ `tag_id` 单列索引；无软删列（与 likes / follows 同构） |
| `comments` 加 `parent_id` | `INT NULL`，外键 → `comments.id` `ON DELETE CASCADE ON UPDATE CASCADE`，索引 `comments_parent_id_idx`；既有行回填 `NULL`（全部是顶层评论，**无需回填脚本**） |

### 设计要点（详见 `docs/API.md` 对应接口）

- **标签写入是事务**：upsert 全部传入标签 → 删该文章全部旧关联 → 建新关联，三步同事务，失败整体回滚。
- **两层硬限制**：`parent_id` 只允许指向 `parent_id IS NULL` 的评论（应用层校验，违规 40000）；DB 层无法表达「自引用只能指向顶层」，靠应用层校验链。
- **删父级联软删子**：应用层 `updateMany({ where: { parentId: id, deletedAt: null } })`，与父评论软删**同事务**。两层结构下一条语句覆盖整个子树——这是选硬两层的一大收益（无限层需要递归 CTE 或应用层递归）。
- **草稿评论封闭（存量洞修复）**：`requireArticle` 加 `status = 'PUBLISHED'` 过滤——此前草稿可被发评论 / 拉评论列表，第 7 批与公开详情同口径 404。**行为变更**：修复前已存在的「草稿下评论」不可再新建/浏览，属预期。
- **计数口径**：`GET /api/tags` 的 `articleCount` 只数 `PUBLISHED` 且未软删（坑 4 同口径）；`receivedCommentCount` 不需改（级联软删的子评论未删时照旧计入，删后自然下降）。
- **快照不含标签**：`article_revisions` 只存 title/content/category，回滚不恢复标签（检索元数据不是内容）。

### 与「已批准的例外」的关系（例外现共 11 项：schema 9 + 依赖 2）

本批新增两项 schema 例外（第 8 项 `tags` + `article_tags` 中间表、第 9 项 `comments.parent_id`），已登记 `docs/AI_CONTRACT.md` §2。零新依赖。

---

## 第 8 批：通知中心（notifications 表）

### schema 变更

| 变更 | 内容 |
|---|---|
| 新建 `notifications` 表 | `id` / `user_id`（接收者）/ `actor_id`（触发者）/ `type` ENUM(`COMMENT`,`REPLY`,`FOLLOW`,`LIKE`) / `article_id` 可空 / `comment_id` 可空 / `read_at` 可空（软已读）/ `created_at`；索引 `(user_id, read_at)`；`actor_id` / `article_id` 两条外键均 `ON DELETE RESTRICT` |
| 触发器 | 评论 / 关注 / 点赞三个 service 成功后**自动** `createNotification`，业务层比对 `actorId !== 接收者` 做自通知抑制 |

### 设计要点（详见 `docs/API.md`「通知中心接口」）

- **后端拼文案**：`actorName` / `targetTitle` 由 API 返回，前端只渲染（防坑 1）。`actorName` 取 nickname 回退 username，actor 软删 → `已注销用户`；`targetTitle` 文章软删 / 不存在 → `内容已删除`（join + 空值降级，防坑 2）。
- **已读用 `read_at` 时间戳**：未读数 = `COUNT WHERE read_at IS NULL`；批量已读支持「空数组 = 全部」，单条已读幂等（200，不报 404）。
- **永久保留**：通知不做物理删除、不做定时清理，已读只置 `read_at`。
- **未读数轮询**：前端登录后 30s 轮询 `GET /api/notifications/unread-count`，登出 / 卸载 `clearInterval`。

### 与「已批准的例外」的关系（例外现共 12 项：schema 10 + 依赖 2）

本批新增一项 schema 例外（第 12 项 `notifications` 表 + `NotificationType` 枚举），已登记 `docs/AI_CONTRACT.md` §2。零新依赖。

---

## 第 9 批：收藏夹 + 阅读量（bookmarks 表 + articles.view_count 列）

### schema 变更

| 变更 | 内容 |
|---|---|
| 新建 `bookmarks` 表 | `id` / `user_id` / `article_id` / `created_at`；唯一约束 `bookmarks_user_id_article_id_key` + 索引 `bookmarks_article_id_idx`；两条外键（`user_id` → `users.id`、`article_id` → `articles.id`）均 `ON DELETE RESTRICT`；无 `deleted_at` / `updated_at` |
| `articles` 新增 `view_count` 列 | `INT NOT NULL DEFAULT 0`，INSTANT 算法回填既有行为 0，零 NULL、零回填脚本；**不建索引** |

### 设计要点（详见 `docs/API.md`「收藏与阅读量（第 9 批）」）

- **幂等 200 与点赞刻意相反**：`POST` / `DELETE` bookmark 均幂等（重复收藏 / 取消未收藏都 200），与 like 的 40900 / 40400 相反、与 follow 一致；`bookmarks` 与 `follows` 数据层同族，错误码语义随家族。并发拦截同纪律：直接 `create` 靠唯一约束，`P2002` 在收藏侧转幂等成功。
- **阅读量是累加计数器，不是实时 COUNT**：`viewCount` 落 `articles.view_count` 真实列，`prisma increment` 原子 +1；与 `likeCount`（likes 表实时 COUNT）是两种口径，API 层同名风格（都返回 number）。
- **防刷最简**：内存 Map 同 IP + 同文章 5 分钟判重，不建明细表、不做 CSRF / WAF；重启丢窗口是已知代价（API.md 已写明「尽力而为，重启不保证连续性」）。
- **`bookmarkedAt` 平铺三约束**（照 `likedAt`）：不改 `toArticleListItem`、map 后单独附加、虚拟名排序靠 map 翻译成 `bookmarks.createdAt`。
- **前端对镜**：bookmarksStore 仿 likedStore（100 条/页 × 10 页、truncated 降级、setToken reset）；星标按钮复用 `--like-*` 令牌与 `span role=button` 范式；UserProfile「收藏」Tab 仅本人；Home「阅读最多」Tab 走 `sortBy=viewCount`。

### 加权热度排序挂账

「综合热度」（`viewCount*0.3 + likeCount*0.7`）**本批不做**：Prisma `orderBy` 不支持表达式排序，要么 `$queryRaw` 重写分页全链，要么维护 `hot_score` 冗余列（写路径 +2 处），MVP 不值。已挂 `docs/ROADMAP.md` 远期储备；「阅读最多」Tab 先用 `viewCount` 纯列排序。

### 与「已批准的例外」的关系（例外现共 14 项：schema 12 + 依赖 2）

本批新增两项 schema 例外（第 13 项 `bookmarks` 表、第 14 项 `articles.view_count` 列），已登记 `docs/AI_CONTRACT.md` §2。零新依赖。

---

## 第 10 批：专栏系列（series 表 + articles.series_id / series_order 两列）

### schema 变更

| 变更 | 内容 |
|---|---|
| 新建 `series` 表 | `id` / `title VARCHAR(50)` / `description VARCHAR(200) NULL` / `author_id` / `created_at` / `updated_at`；一条外键（`author_id` → `users.id`，`ON DELETE RESTRICT`）；无 `deleted_at` / `updated_at` 之外的列（物理删，无软删） |
| `articles` 新增 `series_id` 列 | `INT NULL`，外键 → `series.id` `ON DELETE SET NULL`；既有行回填 `NULL`（零回填脚本，本来就该是空） |
| `articles` 新增 `series_order` 列 | `INT NULL`，正整数；**不在外键管辖内**，解绑时由应用层显式双清；**不建索引、不建复合唯一索引** |

### 设计要点（详见 `docs/API.md`「文章图片上传与专栏系列（第 10 批）」）

- **SET NULL 选型**：删系列 = 解绑文章，不删文章（CASCADE 会毁内容、RESTRICT 操作流反人类），推导见「series（系列表）」小节。
- **序号唯一应用层保证**：冲突 `409 / 40900` 拒绝（不自动重排）；新建省略 → `max + 1`；解绑双清（`series_id` 与 `series_order` 同时 NULL）。
- **图片上传零 schema 变更**：`POST /api/articles/upload-image` 只落盘 `/uploads/articles/{userId}/`，URL 进正文 Markdown；`articles` 不加图片列。孤儿文件清理挂 ROADMAP 插队候选。
- **绑定侧归属无 ADMIN 例外**：文章绑系列必须 `series.authorId === 当前用户`（403/404）；系列元信息修改才是「作者或 ADMIN」。两者刻意不同，防 ADMIN 把别人文章绑进自己系列。
- **硬删序新增一环**：`series.author_id` 是 RESTRICT，硬删用户前必须先删他的 series；又因 `articles.series_id` 指向 series，删 series 前articles 已先被删（或靠 SET NULL 解绑）。新硬删序：`bookmarks → notifications → likes → follows → comments → articles → series → users`（`lib/tmp-account.mjs` / `lib/fixtures.mjs` 已同步，第 8/9 批教训：新 RESTRICT 表必须当天过一遍所有探针清理）。

### 与「已批准的例外」的关系（例外现共 15 项：schema 13 + 依赖 2）

本批新增一项 schema 例外（第 15 项：`series` 表 + `articles.series_id` / `series_order` 两列），已登记 `docs/AI_CONTRACT.md` §2。零新依赖（multer 复用第 11 批批准项）。

---

## 第 11 批：评论点赞 + @提及（comment_likes 表 + comments.like_count 列 + NotificationType 追加两值）

### schema 变更

| 变更 | 内容 |
|---|---|
| 新建 `comment_likes` 表 | `id` / `user_id` / `comment_id` / `created_at`；唯一约束 `comment_likes_user_id_comment_id_key` + 索引 `comment_likes_comment_id_idx`；两条外键（`user_id` → `users.id`、`comment_id` → `comments.id`）均 `ON DELETE RESTRICT`；无 `deleted_at` / `updated_at`（likes 族纪律） |
| `comments` 新增 `like_count` 列 | `INT NOT NULL DEFAULT 0`，INSTANT 算法回填既有行为 0；**不建索引**（高频写入列，同 `view_count` 纪律） |
| `NotificationType` 枚举追加两值 | `MENTION`（@提及）、`COMMENT_LIKE`（评论被赞）；MySQL 8 追加 ENUM 末尾成员走 INSTANT，零回填 |

### 设计要点（详见 `docs/API.md`「评论点赞与 @提及（第 11 批）」）

- **幂等 200 与文章点赞刻意相反**：对镜 bookmark / follow 族（P2002 → 幂等成功），探针显式对照文章 like 的 409/404，防止将来被「统一」。
- **计数双口径**：`comments.like_count` 是响应回显用的累加计数器（`prisma increment` / `decrement` 原子维护）；`comment_likes` 行是唯一真相（幂等判定 / liked 批量判定走行存在性）。取消赞只在**确实删掉了行**时才 decrement，计数永不因幂等重放而变负。
- **MENTION 提取规则**：正则 `/@(\w+)/g`，仅发布评论 / 发布文章时触发（编辑 / 回滚 / 自动保存不补发）；去重 + 查库过滤（存在且未软删）+ 过滤自己；每篇每人一条。
- **COMMENT_LIKE 自赞抑制**：允许自赞（计数口径与文章 like 一致），但 `actorId === 评论作者` 时不写通知。
- **硬删序新增一环**：`comment_likes` 双 RESTRICT 且挂在 comments/users 上，排最上游：`notifications → bookmarks → likes → follows → comment_likes → comments → articles → series → users`（`lib/tmp-account.mjs` / `lib/fixtures.mjs` 已同步）。
- **评论列表可选鉴权**：新增 `optionalAuth` 中间件（验签失败静默当匿名，不拦请求），带合法 token 时列表项附加 `liked` 布尔；未登录 / token 非法省略键。

### 与「已批准的例外」的关系（例外现共 16 项：schema 14 + 依赖 2）

本批新增一项 schema 例外（第 16 项：`comment_likes` 表 + `comments.like_count` 列 + `NotificationType` 追加 `MENTION` / `COMMENT_LIKE`），已登记 `docs/AI_CONTRACT.md` §2。零新依赖。

---

## 第 12 批：举报与审核（reports 表 + NotificationType 追加两值）

### schema 变更

| 变更 | 内容 |
|---|---|
| 新建 `reports` 表 | `id` / `reporter_id` / `target_type` / `target_id` / `reason` / `status` / `resolved_at` / `created_at`；唯一约束 `reports_reporter_target_key`（防同一用户重复举报同一对象）+ `reports_target_idx` + `reports_status_idx` 两个索引；一条外键（`reporter_id` → `users.id`，`ON DELETE RESTRICT`）；`target_id` 多态无外键（同 `notifications.commentId` 先例）；无 `deleted_at` / `updated_at` |
| 新增 2 个枚举 | `ReportTargetType` { ARTICLE, COMMENT }、`ReportStatus` { PENDING, RESOLVED, REJECTED } |
| `NotificationType` 枚举追加两值 | `REPORT_RESOLVED`（举报的违规内容已处理）、`REPORT_REJECTED`（核实未违规）；**拆两值不拆一值**（2026-10-18 用户拍板：通知中心 buildText 按 type 组句，单值无法区分「删了」和「没删」两种结果）；MySQL 8 追加 ENUM 末尾走 INSTANT，零回填 |

### 设计要点（详见 `docs/API.md`「举报与审核（第 12 批）」）

- **防重复**：同一用户 × 同一对象唯一；第二次举报（含上次已处理的）一律 `409/40900`，不新增行、不重置状态。
- **目标可见性**（2026-10-18 用户拍板防坑）：文章必须 `deletedAt IS NULL` **且 `status = PUBLISHED`**（草稿不可举报）；评论必须未软删且所属文章可见。作者已自行软删的内容 404，不能再被举报。
- **不能举报自己**：目标作者是举报人本人 → `400/40000`（作者删自己的内容走既有删除接口）。
- **管理员处理是单事务**（2026-10-18 用户拍板防坑）：`deleteTarget: true` 时「软删目标（评论级联子评论，对齐用户侧口径）」与「该目标全部 PENDING 举报批转 RESOLVED」在同一个 `$transaction`，要么全成功要么全回滚；管理员不自己拼删除接口。目标已被作者先行软删 → 软删幂等跳过（`targetDeleted: false`），状态照常流转。
- **通知在事务提交后发**：RESOLVED → `REPORT_RESOLVED`、REJECTED → `REPORT_REJECTED`，按举报行每行一条（同一举报人对同一对象只有一行，天然去重）；通知失败不回滚业务（第 8 批纪律）。
- **顺带修挂账**：admin 版 `deleteComment` 原先不级联软删子评论（与用户侧口径不一致的历史遗留），本批对齐用户侧 `$transaction` + `updateMany` 子树实现（用户拍板并入本批后端 commit）。
- **硬删序新增一环**：`reports.reporter_id` 是 RESTRICT，排 `comment_likes` 之后、`comments` 之前：`notifications → bookmarks → likes → follows → comment_likes → reports → comments → articles → series → users`（`lib/tmp-account.mjs` / `lib/fixtures.mjs` 已同步；`target_id` 无外键，清理时按 `reporter_id` + 目标 id 双侧删）。

### 与「已批准的例外」的关系（例外现共 17 项：schema 15 + 依赖 2）

本批新增一项 schema 例外（第 17 项：`reports` 表 + `ReportTargetType` / `ReportStatus` 两枚举 + `NotificationType` 追加 `REPORT_RESOLVED` / `REPORT_REJECTED`），已登记 `docs/AI_CONTRACT.md` §2。零新依赖。

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

> 全库外键现共**十六条**（原有五条 + `follows` 两条 + `notifications` 两条 + `bookmarks` 两条 + 第 10 批 `series` 两条 + 第 11 批 `comment_likes` 两条 + 第 12 批 `reports` 一条）。删除行为从此有三种：`RESTRICT`（绝大多数）、`CASCADE`（`article_revisions.article_id` / `article_tags` 两条 / `comments.parent_id`）、`SET NULL`（`articles.series_id`，第 10 批新增的第一条）。
> 其中 `follows` 的两条是 Prisma 默认值（schema 未显式声明 `onDelete`）；`notifications` 与 `bookmarks` 的外键在 schema 中**显式声明** `onDelete: Restrict`（第 8 批起为醒目起见改为显式），行为与默认值一致；`series.author_id` 同为显式 Restrict，`articles.series_id` 是显式 **SetNull**；`comment_likes` 两条与 `reports.reporter_id` 同为显式 Restrict。

- **软删除不触发外键**：删除文章是 `UPDATE articles SET deleted_at = ...`，物理行仍在，`comments.article_id` 与 `likes.article_id` 的引用依然有效，因此**评论与点赞都不被连带删除、不被连带置为删除**，也不需要任何 CASCADE 配置。
- 这正是「文章软删、评论保留但随文章不可见」的实现基础：评论数据原样保留，接口层先校验文章存在且未软删除（返回 404），评论列表随文章一起不可见。点赞同理。
- **将来若要物理清理**（硬删除），顺序必须是：

```text
notifications → bookmarks → likes → follows → comment_likes → reports → comments → articles → series → users
```

  RESTRICT 会在顺序错误时直接拒绝：`DELETE FROM users` 若该用户还有文章 / 评论 / 点赞 / 关注 / 收藏 / 通知 / **系列** / **评论赞** / **举报**会报错；`DELETE FROM articles` 若还有评论 / 点赞 / 收藏 / 通知挂载也会报错；`DELETE FROM comments` 若还有评论赞挂载也会报错。这个报错是保护，不是 bug——发现报错说明漏了上游清理步骤。
  特别注意**必须先清 `reports` / `comment_likes` / `bookmarks` / `notifications` / `likes` / `follows`**：这六张表都可能「悬挂」在被软删对象上（`reports` 挂举报人用户、`comment_likes` / `notifications` 挂评论与用户、`bookmarks` / `likes` / `notifications` 挂文章与用户、`follows` 挂用户），是硬删顺序的最上游（`reports.target_id` 是多态无外键，还须按目标 id 双侧补删，见「第 12 批」）。
  **`series` 排在 `articles` 之后、`users` 之前**（第 10 批）：`series.author_id → users.id` 是 RESTRICT，删用户前必须先删他的系列；而 `articles.series_id → series.id` 是 **SET NULL**——若先删 series，被绑文章会被自动解绑（此时文章往往也要删，无副作用），但**顺序上 articles 先删能顺带清掉 revisions（CASCADE）**，仍是 articles → series 更稳。

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

5. **`backend/uploads/` 必须挂载持久卷**（第十一批起）：本目录存放用户上传的头像与**文章配图**（第 10 批 `uploads/articles/{userId}/`），是运行时数据、不进 git。**生产部署时若不做持久化，重启 / 重新部署会丢文件**，而 `users.avatar` 仍指向不存在的路径、文章正文里的图片全部破图。详见「users」小节的「第十一批：头像文件存储」与「series（系列表）」所属的第 10 批小节。**孤儿图片文件（磁盘上有、无文章正文引用）本批不清理**，推荐方案挂 `docs/ROADMAP.md`「插队候选」。

---

## 已知限制

以下五条是本阶段刻意不处理的，登记在此，将来不用重新论证。

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

4. **`users.avatar` 与磁盘文件不保证强一致**（第十一批上传引入）：DB 存路径、磁盘存文件，两者之间没有事务。
   - **孤儿文件**（磁盘上有、DB 不指向）：进程在「写库成功 → 删旧头像」之间崩溃时产生。**悬空引用**（DB 指向、磁盘上没有）：手工删了文件、或直接改库时产生。
   - **当前可接受**：MVP 无用户注销功能、无定时清理，量级极低；悬空引用在前端表现为破图，已有 `img` 的 `error` 回退兜底，不会崩。
   - ⚠️ 外链下线**没有消除**这条限制：它治理的是「DB 与磁盘的一致性」，与 avatar 取什么形态无关。反而去掉外链后，**库里只要是非 `null` 就一定有对应文件**（除非被手工删），这条限制的触发面更小了。
   - 触发条件：上传量上来、或出现用户注销功能。
   - 处理方向：定时对账任务（扫 `users.avatar` 的站内路径、与磁盘比对），或在用户注销流程里连目录一起清。**不做强一致** —— 那需要跨「文件系统 + 数据库」的分布式事务，代价远超收益。

5. **按点赞数排序（`sortBy=likeCount`）无法走索引，且 `likes` 被聚合两次**：`ORDER BY` 的目标是**聚合结果**，MySQL 必然走 `Using temporary; Using filesort`；同时 Prisma 为 `_count` 选择与 `orderBy` 各生成一条派生表，`likes` 被扫两遍（实测 EXPLAIN 见「按点赞数排序」小节）。
   - **当前可接受**：数据量小（11 篇 / 个位数点赞），耗时无感。这是「不加 `articles.like_count` 冗余列」的**既定取舍**，不是遗漏。
   - 触发条件：文章数 / 点赞数上量，或「热门」成为默认 Tab（首页入口流量集中到这里）。
   - 处理方向：加 `articles.like_count` 冗余列（代价见「按点赞数排序」小节末段），或做定时汇总表 / 缓存。**在数据量真的大到需要之前不优化** —— 冗余列会带来「计数与真实数据不一致」这一新类 bug。

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
| `20261004145107_add_article_category` | `articles` 表新增 `category VARCHAR(20) NOT NULL DEFAULT '未分类'` 一列（枚举 技术/生活/随笔/未分类）；INSTANT 算法自动回填既有 11 行，零 NULL、零回填脚本；**不含新增表 / 外键 / 索引**（MVP 阶段不按 category 建索引，理由见对应小节） | **已应用** |
| `20261011083029_add_follows` | 新建 `follows` 表（`id` / `follower_id` / `following_id` / `created_at`）+ 两条外键（`follower_id` → `users.id`、`following_id` → `users.id`，均 `ON DELETE RESTRICT ON UPDATE CASCADE`）+ `follows_follower_id_following_id_key` 唯一约束 + `follows_following_id_idx` 索引；**不含数据回填**（新表无既有数据）。本表**无 `deleted_at` / `updated_at` 两列**（刻意设计，与 likes 同构，理由见「follows（关注表）」小节） | **已应用** |
| `20261017063642_add_user_role_status` | `users` 表新增 `role` 与 `status` 两列（Prisma enum `UserRole` { USER, ADMIN } / `UserStatus` { ACTIVE, BANNED }，均 `NOT NULL DEFAULT`）；INSTANT 算法自动回填既有行，零 NULL、零回填脚本；**不含索引**（低基数，理由见「users」小节「第 5 批」）。迁移后手工执行 `UPDATE users SET role = 'ADMIN' WHERE username IN ('admin', 'lin')`（不写进迁移文件，见「第 5 批」顶层小节） | **已应用** |
| `20261017125847_add_article_status` | `articles` 表新增 `status` 列（`ENUM('DRAFT','PUBLISHED') NOT NULL DEFAULT 'PUBLISHED'`）；INSTANT 算法自动回填既有 17 行（第 5 批后文章数）为 `PUBLISHED`，零 NULL、零回填脚本；**不含索引 / 新增表 / 外键**（索引见下条） | **已应用** |
| `20261017130010_add_article_revisions` | 新建 `article_revisions` 表（版本快照）+ `article_id` 外键（`ON DELETE CASCADE`）+ `author_id` 外键（`ON DELETE RESTRICT`）+ 索引 `(article_id, created_at)`；**不含数据回填**（新表无既有数据） | **已应用** |
| `20261017130223_add_article_status_idx` | `articles` 表新增索引 `(status, created_at)`（命名 `articles_status_created_at_idx`），覆盖广场列表主查询（`WHERE status='PUBLISHED' ORDER BY created_at`）；**独立小迁移**，与 `status` 列分离以便回滚 | **已应用** |
| `add_tags_and_article_tags`（第 7 批，实际名 `20261018014846_add_tags_and_article_tags`） | **一次迁移包含全部三项变更**（改 schema 一次跑 migrate 时 Prisma 将变更合并打包）：① 新建 `tags` 表（`name VARCHAR(20)` + **唯一约束** `tags_name_key`）；② 新建 `article_tags` 中间表（联合主键 `(article_id, tag_id)` + 两条外键均 `ON DELETE CASCADE` + `article_tags_tag_id_idx` 索引）；③ `comments` 表新增 `parent_id INT NULL` + 外键 `comments_parent_id_fkey`（→ `comments.id`，`ON DELETE CASCADE ON UPDATE CASCADE`）+ 索引 `comments_parent_id_idx`，既有行 `parent_id` 全部为 `NULL`（全是顶层评论，零回填）。**不含数据回填**（新表无既有数据） | **已应用** |
| `add_bookmarks_and_view_count`（第 9 批，实际名 `20261018053624_add_bookmarks_and_view_count`） | 新建 `bookmarks` 表（`id` / `user_id` / `article_id` / `created_at`）+ 两条外键（`user_id` → `users.id`、`article_id` → `articles.id`，均 `ON DELETE RESTRICT`）+ 唯一约束 `bookmarks_user_id_article_id_key` + 索引 `bookmarks_article_id_idx`；`articles` 表新增 `view_count INT NOT NULL DEFAULT 0`（INSTANT 回填既有行为 0）。**不含数据回填**（新表无既有数据） | **已应用**（2026-10-18，`SHOW INDEX` 核实：唯一约束两列 + article_id 单列索引，`user_id` 未被额外补索引） |
| `add_series`（第 10 批，实际名 `20261018082357_add_series`） | 新建 `series` 表（`id` / `title VARCHAR(50)` / `description VARCHAR(200) NULL` / `author_id` / `created_at` / `updated_at`）+ 一条外键（`author_id` → `users.id`，`ON DELETE RESTRICT`，外键自动索引 `series_author_id_fkey`）；`articles` 表新增 `series_id INT NULL`（外键 `articles_series_id_fkey` → `series.id`，**`ON DELETE SET NULL`，全库第一条 SET NULL 外键**）与 `series_order INT NULL` 两列。**不含数据回填**：series 新表无既有数据；articles 既有 17 行两列全部 `NULL`（`SHOW CREATE TABLE` + `information_schema.REFERENTIAL_CONSTRAINTS` 已核实 SET NULL / RESTRICT 两条规则） | **已应用**（2026-10-18） |
| `add_comment_likes_and_mention`（第 11 批，实际名 `20261018093952_add_comment_likes_and_mention`） | **一次迁移包含全部三项变更**：① `comments` 表新增 `like_count INT NOT NULL DEFAULT 0`（INSTANT 回填既有行为 0，不建索引）；② `notifications.type` 枚举追加 `MENTION` / `COMMENT_LIKE` 两值（MODIFY ENUM，追加末尾零数据变更）；③ 新建 `comment_likes` 表（`id` / `user_id` / `comment_id` / `created_at`）+ 唯一约束 `comment_likes_user_id_comment_id_key` + 索引 `comment_likes_comment_id_idx` + 两条外键（→ `users.id` / `comments.id`，均 `ON DELETE RESTRICT`）。**不含数据回填**（新表无既有数据；migration.sql 已逐行核对） | **已应用**（2026-10-18） |
| `add_reports`（第 12 批，实际名 `20261018114103_add_reports`） | **一次迁移包含全部三项变更**：① `notifications.type` 枚举追加 `REPORT_RESOLVED` / `REPORT_REJECTED` 两值（MODIFY ENUM，追加末尾零数据变更）；② 新建 `reports` 表（`id` / `reporter_id` / `target_type` / `target_id` / `reason` / `status` / `resolved_at` / `created_at`）+ 唯一约束 `reports_reporter_id_target_type_target_id_key` + 索引 `reports_target_type_target_id_idx` / `reports_status_idx` + 一条外键（`reporter_id` → `users.id`，`ON DELETE RESTRICT`）；③ 新增枚举 `ReportTargetType` { ARTICLE, COMMENT } / `ReportStatus` { PENDING, RESOLVED, REJECTED }（落在 reports 两列上）。**不含数据回填**（新表无既有数据；migration.sql 已逐行核对） | **已应用**（2026-10-18） |

> 第九批迁移**已于 2026-10-03 执行完成**，迁移名 `20261003080727_add_user_avatar_bio`。
> 已用 `SHOW CREATE TABLE users` 与 `information_schema.COLUMNS` 核对：两列均为 `DEFAULT NULL`，
> `PRIMARY KEY (id)` 与 `UNIQUE KEY users_username_key (username)` 未受影响，
> `demo` / `admin` 两行新列均为 `NULL`。实际 DDL 与迁移 SQL 已回填到「users」小节。
> `AUTO_INCREMENT=11` 说明迁移过程未插入任何新行（纯 `ADD COLUMN`，无回填）。

> 第十批（点赞）迁移**已于 2026-10-03 执行完成**，迁移名 `20261003140221_add_user_likes`。
> 已用 `SHOW CREATE TABLE likes`、`information_schema.COLUMNS` 与 `SHOW INDEX FROM likes` 核对：
> 4 列齐全（**确认无 `deleted_at` / `updated_at`**）、两条外键均为 `ON DELETE RESTRICT ON UPDATE CASCADE`、
> **`user_id` 未被 MySQL 额外补单列索引**（唯一索引左前缀已承担）。实际 DDL 与迁移 SQL 已回填到「likes」小节。
> `_prisma_migrations` 共 **6 条**全部 `finished=Y / rolled_back=N`。
> 唯一约束与外键已用**真实插入**实测通过：重复插入报 `1062`、不存在的文章报 `1452`，测试数据已回收（`likes` 行数 0）。
> 基线未受影响：可见文章=11、评论=1、users=3。
>
> ⚠️ **第十批这次 `migrate dev` 建表成功，但末尾的 `prisma generate` 失败**：
> `EPERM: operation not permitted, rename '.../query_engine-windows.dll.node.tmpNNNN' -> '.../query_engine-windows.dll.node'`。
> 根因是**当时有 node 进程占着这个 DLL**（本机 3000 端口的后端 dev server，PID 15136），Windows 不允许替换正在被加载的文件。
> **影响**：`node_modules/.prisma/client/` 下的引擎 DLL 仍是旧文件；但 Prisma 6 的引擎 DLL **不内嵌 schema**
> （schema 在生成的 JS 里），本次实测 `prisma.article` 的 typed `findMany({ select: { category: true } })` 与 `$queryRawUnsafe` 读 `category` 均正常返回，故功能不受影响。
> **收尾动作（已完成）**：已让 3000 端口的后端进程释放并重跑 `npx prisma generate`，残留的 `.tmp*` 已清理。

> 第十一批（头像上传）**不涉及表结构变更，没有迁移**：`avatar` 列不动、`VARCHAR(255)` 长度对站内路径够用（论证见「users」小节的「第十一批：头像文件存储」）。文件落在 `backend/uploads/`，不进数据库，故本表不新增行。

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
├─ 20261004145107_add_article_category/
│  └─ migration.sql
├─ 20261018014846_add_tags_and_article_tags/（第 7 批，含 tags / article_tags / comments.parent_id 三项变更）
│  └─ migration.sql
├─ 20261011083029_add_follows/
│  └─ migration.sql
├─ 20261017125847_add_article_status/
│  └─ migration.sql
├─ 20261017130010_add_article_revisions/
│  └─ migration.sql
├─ 20261017130223_add_article_status_idx/
│  └─ migration.sql
└─ migration_lock.toml
```

### 分类功能的迁移 SQL（实际生成，已执行 `20261004145107_add_article_category`）

> 下方为**实际生成并已应用**的 `migration.sql` 内容。`SHOW CREATE TABLE articles` 已核对：含 `category varchar(20) NOT NULL DEFAULT '未分类'`，与「建表 SQL」小节一致。
>
> 注：`category` 在真实表中的**物理列序在最后**（`deleted_at` 之后）——因为它是后续用 `ALTER TABLE ADD COLUMN` 追加的，`information_schema` 实际列序为 `id, title, content, author_id, created_at, updated_at, deleted_at, category`。上方「建表 SQL」小节已按实际列序书写。

```sql
-- AlterTable
ALTER TABLE `articles` ADD COLUMN `category` VARCHAR(20) NOT NULL DEFAULT '未分类';
```

**迁移是纯 `ADD COLUMN` + `DEFAULT`**：MySQL 8 对在**表尾追加 NOT NULL 且带 DEFAULT 的列**走 INSTANT 算法（仅改元数据、不重写既有行），11 行既有文章在元数据层直接获得 `未分类` 默认值，无需任何回填语句。

**执行后核对结果（2026-10-04 实测）**：

| 核对项 | 实际 |
|---|---|
| `SHOW CREATE TABLE articles` 含 `category varchar(20) NOT NULL DEFAULT '未分类'` | ✅ 已核对，与建表 SQL 小节一致 |
| 既有 11 行 `category` 值 | 全部为 `未分类`（INSTANT 自动回填，零 NULL） |
| `_prisma_migrations` 新增一行 `finished=Y` | ✅ `migrate status` 显示 6 个迁移全部 applied |
| `prisma generate` 是否成功 | ⚠️ 引擎 DLL 被 3000 端口后端进程占用报 EPERM；但实测 `prisma.article.findMany({ select: { category: true } })` 已能正常返回 category，DMMF 已更新、功能不受影响，generate 可暂缓至后端释放后补跑 |

### 第 6 批的迁移 SQL（实际生成，已执行 3 个迁移：`20261017125847_add_article_status` / `20261017130010_add_article_revisions` / `20261017130223_add_article_status_idx`）

> 下方为**实际生成并已应用**的迁移 SQL（`migrate dev` 生成，未手工改写）。`SHOW CREATE TABLE` 已核对：列 / 索引 / 外键与下方一致。

**`20261017125847_add_article_status`**（在既有 `articles` 表追加 `status` 列）：

```sql
-- AlterTable
ALTER TABLE `articles` ADD COLUMN `status` ENUM('DRAFT', 'PUBLISHED') NOT NULL DEFAULT 'PUBLISHED';
```

**`20261017130010_add_article_revisions`**（新建版本历史表）：

```sql
-- CreateTable
CREATE TABLE `article_revisions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `article_id` INTEGER NOT NULL,
    `title` VARCHAR(100) NOT NULL,
    `content` MEDIUMTEXT NOT NULL,
    `category` VARCHAR(20) NOT NULL DEFAULT '未分类',
    `author_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `article_revisions_article_id_created_at_idx`(`article_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `article_revisions` ADD CONSTRAINT `article_revisions_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `article_revisions` ADD CONSTRAINT `article_revisions_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```

**`20261017130223_add_article_status_idx`**（补建 `status` 索引，独立迁移便于回滚）：

```sql
-- CreateIndex
CREATE INDEX `articles_status_created_at_idx` ON `articles`(`status`, `created_at`);
```

**执行后核对（2026-10-17 实测）**：

| 核对项 | 实际 |
|---|---|
| `articles` 含 `status` 列（`ENUM('DRAFT','PUBLISHED') NOT NULL DEFAULT 'PUBLISHED'`） | ✅ 已核对 |
| `articles` 含索引 `articles_status_created_at_idx`(`status`, `created_at`) | ✅ 已核对 |
| `article_revisions` 含两外键（`ON DELETE CASCADE` / `ON DELETE RESTRICT`）与索引 | ✅ 已核对 |
| 既有 17 篇文章 `status` 全部为 `PUBLISHED` | ✅ INSTANT 自动回填，零 NULL |
| `_prisma_migrations` 新增 3 行 `finished=Y` | ✅ `migrate status` 显示全部 applied |

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
