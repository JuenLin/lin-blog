import prisma from '../utils/prisma.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { parseKeyword, parseCategory, parseTag, TAG_NAME_MAX_LENGTH } from '../validators/article.validator.js';
import { CODE, httpError } from '../utils/response.js';
import { notifyOnMentions } from './notification.service.js';

// docs/API.md：文章列表 sortBy 白名单为 createdAt / updatedAt / id / likeCount / viewCount，
// 默认 createdAt desc。
// 「热门」Tab 用 likeCount（按点赞数倒序），「阅读最多」Tab 用 viewCount（第 9 批，
// 真实列直映射、无 JOIN 聚合），updatedAt 保留 —— 前端不再暴露该 Tab，
// 但接口不缩水（probe-search 的 S4-4 仍在用它验白名单）。
export const ARTICLE_SORT_FIELDS = ['createdAt', 'updatedAt', 'id', 'likeCount', 'viewCount'];

// likeCount 是**计算字段**（响应层由 `_count.likes` 折算），articles 表里没有这一列，
// 所以不能把它直接透传给 Prisma（会报 Unknown argument 'likeCount'）。
// 这里给出它在 Prisma 里的等价写法：关联计数排序。
// 实测（Prisma 6.19.3 + MySQL 8）会编成**单条 SQL** 的 SQL 层 ORDER BY，不是拉全量再排：
//   LEFT JOIN (SELECT article_id, COUNT(*) FROM likes GROUP BY article_id) ON articles.id = ...
//   ORDER BY COALESCE(..., 0) DESC, articles.id DESC
// 代价与取舍见 docs/DB.md「按点赞数排序」小节。
// 第 5 批起由 admin.service.js 复用（管理端文章列表的 sortBy 与广场一致），
// 走文件末尾的 export { } 块导出。
const ARTICLE_SORT_MAP = {
  likeCount: (order) => ({ likes: { _count: order } }),
};

// 列表的 summary 取正文前 100 个字符。
const SUMMARY_LENGTH = 100;

// 内嵌 author 的查询字段。
// avatar 为第九批新增（可空），role 为第 5 批新增（USER / ADMIN，供前端渲染
// 管理员徽章与管理端入口）。bio **刻意不加**：简介只在个人主页展示，
// 塞进每条列表项的 author 里是纯粹的响应体浪费。
// 注意：comment.service.js 里有一份**内容相同**的重复定义，
// 本期按「只加字段、不做重构」处理，抽取公共定义单独排一批。
const AUTHOR_SELECT = {
  id: true,
  username: true,
  nickname: true,
  avatar: true,
  role: true,
};

// 显式 select，不使用 SELECT *（契约第 11 节）。
// author 直接内嵌查询，作者即使被软删除也照常返回（docs/API.md 通用约定）。
// 第 5 批起由 admin.service.js 复用（管理端文章列表 = 本 select + deletedAt），
// 走文件末尾的 export { } 块导出。
const ARTICLE_DETAIL_SELECT = {
  id: true,
  title: true,
  content: true,
  category: true,
  createdAt: true,
  updatedAt: true,
  // 第 9 批：累计阅读量。真实列（不是计算字段），sortBy=viewCount 时
  // buildOrderBy 直映射 `{ viewCount: order }`，不需要进 ARTICLE_SORT_MAP。
  // 不建索引（高频写入列，理由见 docs/DB.md「第 9 批」）。
  viewCount: true,
  // 第 10 批：系列绑定两列。透出到详情响应（编辑器回填「加入系列」下拉与序号、
  // 详情页据此决定是否拉 GET /api/series/:id 渲染系列横幅）。
  // **列表（toArticleListItem）刻意不带**：横幅只在详情页，列表带这两列纯属浪费。
  seriesId: true,
  seriesOrder: true,
  author: {
    select: AUTHOR_SELECT,
  },
  // 第十批：点赞数。用 relation count 而不是单独发 COUNT 查询，
  // 否则列表接口每篇文章一次 COUNT 就是 N+1。Prisma 会把它编成一条
  // 关联子查询（或 join 后聚合），**列表接口只发一次 SQL**。
  // 不加 articles.like_count 冗余列（docs/API.md 通用约定）。
  _count: {
    select: { likes: true },
  },
  // 第 7 批：标签。与 _count.likes 同思路 —— select 内嵌关联，一次 SQL 拿全，
  // **不是每篇文章再查一次**（N+1 防坑，docs/API.md「tag 语义」）。
  // ArticleTag 中间表自身无名字，取 tag.name；orderBy 走关系列保证输出稳定（name asc）。
  tags: {
    select: { tag: { select: { name: true } } },
    orderBy: { tag: { name: 'asc' } },
  },
};

// 写入类操作只需要判断存在性与作者，不取正文。
const ARTICLE_OWNER_SELECT = {
  id: true,
  authorId: true,
};

/**
 * 截取正文前 100 个字符作为 summary。
 *
 * 必须用 [...content] 按码点展开再截取：String.prototype.slice 按 UTF-16 码元切，
 * 会把 emoji 等代理对拦腰截断，产生半个代理项（渲染为乱码或替换字符）。
 */
function buildSummary(content) {
  return [...content].slice(0, SUMMARY_LENGTH).join('');
}

function toAuthor(author) {
  return {
    id: author.id,
    username: author.username,
    nickname: author.nickname,
    avatar: author.avatar,
    role: author.role,
  };
}

// 第 7 批：从 select 出来的 ArticleTag[] 提取标签名数组。
// select 已按 tag.name asc 排序（SQL 层），映射只是取字段；无标签时为 []（不是省略键）。
function toTagNames(article) {
  return (article.tags || []).map((item) => item.tag.name);
}

function toArticleDetail(article) {
  return {
    id: article.id,
    title: article.title,
    content: article.content,
    category: article.category,
    tags: toTagNames(article),
    author: toAuthor(article.author),
    likeCount: article._count ? article._count.likes : 0,
    viewCount: article.viewCount,
    // 第 10 批：系列绑定态。null = 未加入任何系列（前端据此跳过系列横幅请求）。
    // seriesOrder 可能为 null（未绑系列时）；绑定时恒为正整数（自动分配也填值）。
    seriesId: article.seriesId ?? null,
    seriesOrder: article.seriesOrder ?? null,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

function toArticleListItem(article) {
  return {
    id: article.id,
    title: article.title,
    summary: buildSummary(article.content),
    category: article.category,
    // 第 7 批：标签名数组（name asc）。与详情同口径，前端 chip 直接渲染。
    tags: toTagNames(article),
    author: toAuthor(article.author),
    // 与详情口径一致：实时 COUNT(*)。_count 缺失时降级为 0 而不是 undefined，
    // 这样「接口没返回」和「确实是 0」对前端是同一个值（docs/API.md 的约定）。
    likeCount: article._count ? article._count.likes : 0,
    viewCount: article.viewCount,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

/**
 * 发布文章。作者取 token 中的 userId，不接受请求体里的作者字段。
 *
 * 第 7 批：tags 处理（upsert 标签 + 建关联）与文章创建同事务，失败整体回滚。
 * 第 10 批：seriesId/seriesOrder 绑定（归属校验 + 自动 max+1）同事务。
 */
export async function createArticle(payload, authorId) {
  // 先算系列绑定再开事务：归属校验（404/403）与序号冲突（409）都要在写文章前拦下，
  // 失败了整篇不创建（与 title 校验失败同口径，不留半篇文章）。
  const binding = await resolveSeriesBindingForCreate(payload, authorId);

  // 第 6 批：status 省略或 PUBLISHED 都是发布；DRAFT 创建草稿。
  const status = payload.status ?? 'PUBLISHED';

  const article = await prisma.$transaction(async (tx) => {
    const created = await tx.article.create({
      data: {
        title: payload.title,
        content: payload.content,
        category: payload.category ?? '未分类',
        status,
        authorId,
        // 第 10 批：未传 seriesId 时两列都是 null（不加入系列）。
        seriesId: binding.seriesId,
        seriesOrder: binding.seriesOrder,
      },
      select: { id: true },
    });

    // 第 7 批：空数组 = 无标签（跳过中间表写入，省一次空 deleteMany）。
    if (payload.tags.length > 0) {
      await applyTags(tx, created.id, payload.tags);
    }

    // create 的返回发生在关联写入之前，重新查一次拿完整对象（含 tags 与 likeCount）。
    const full = await tx.article.findUnique({
      where: { id: created.id },
      select: ARTICLE_DETAIL_SELECT,
    });

    return toArticleDetail(full);
  });

  // 第 11 批：@提及通知——**只在发布动作触发**（DRAFT 草稿没有读者，不通知；
  // 编辑 / 回滚 / 自动保存不补发，避免每次编辑重复骚扰，docs/API.md 第 11 批）。
  // 通知在事务提交后发：失败只打日志，绝不影响文章本身（对镜 createComment 纪律）。
  if (status === 'PUBLISHED') {
    try {
      await notifyOnMentions({
        articleId: article.id,
        commentId: null,
        content: payload.content,
        authorId,
      });
    } catch (notifyError) {
      console.error('[notify] 文章 @提及通知发送失败（不影响文章创建）:', notifyError);
    }
  }

  return article;
}

/**
 * 第 7 批：把 tagNames 全量应用到 articleId（全量替换语义）。
 *
 * 必须在事务（tx）内调用——upsert / 删旧 / 建新三步必须原子，否则中途失败
 * 会留下「旧关联已删、新关联未建」的空窗。
 *
 * upsert 的并发语义：同名标签两个并发请求同时 upsert，由 `tags.name` 的
 * DB 唯一约束兜底（Prisma upsert 在唯一键冲突时走 update 分支），不会产生重复行。
 *
 * @param {object} tx Prisma 事务客户端
 * @param {number} articleId
 * @param {string[]} tagNames 已过 zod 校验的标签名数组（trim 后非空、≤20 字、≤5 个）
 */
async function applyTags(tx, articleId, tagNames) {
  const tags = await Promise.all(
    tagNames.map((name) =>
      tx.tag.upsert({
        where: { name },
        update: {},
        create: { name },
      }),
    ),
  );

  // 全量替换：先清空旧关联再建新的。联合主键 (article_id, tag_id) 防重复关联。
  await tx.articleTag.deleteMany({ where: { articleId } });

  if (tags.length > 0) {
    await tx.articleTag.createMany({
      data: tags.map((tag) => ({ articleId, tagId: tag.id })),
    });
  }
}

/* ---------- 第 10 批：系列绑定（seriesId / seriesOrder） ---------- */

/**
 * 系列归属校验：系列必须存在（404）且是本人创建的（403）。
 *
 * **绑定侧 ADMIN 无例外**（与 PUT /api/series/:id 的「作者或 ADMIN」刻意不同）——
 * ADMIN 能改任何系列的元信息，但不能把别人的文章绑进自己的系列。
 * 先查存在再判归属：不通过 403/404 的差异枚举系列 id。
 *
 * @param {object} tx Prisma 客户端或事务客户端
 * @param {number} seriesId 已过 zod 校验的正整数
 * @param {number} userId 来自 token
 * @returns {Promise<{id: number}>} 校验通过的系列
 */
async function requireOwnSeries(tx, seriesId, userId) {
  const series = await tx.series.findUnique({
    where: { id: seriesId },
    select: { id: true, authorId: true },
  });

  if (!series) {
    throw httpError(404, CODE.NOT_FOUND, '系列不存在');
  }
  if (series.authorId !== userId) {
    throw httpError(403, CODE.FORBIDDEN, '只能加入自己的系列');
  }

  return series;
}

/**
 * 序号冲突校验：同系列内 seriesOrder 唯一（应用层保证，不建复合唯一索引）。
 *
 * `excludeArticleId`：改序号时必须排除自己（否则「设成自己当前的序号」也报冲突）。
 * 软删文章同样占位（deleteMany 不过滤 deletedAt）——「槽位被占」按行存在判定，
 * 不区分文章状态，行为可预期；软删文章空出的槽位不自动回收，挂 ROADMAP 不管。
 *
 * @param {object} tx Prisma 客户端或事务客户端
 * @param {number} seriesId
 * @param {number} seriesOrder
 * @param {number|null} excludeArticleId 冲突判定时排除的文章 id（改序号场景传自己）
 * @returns {Promise<boolean>} true = 无冲突可写入
 */
async function isSeriesOrderFree(tx, seriesId, seriesOrder, excludeArticleId = null) {
  const taken = await tx.article.findFirst({
    where: {
      seriesId,
      seriesOrder,
      ...(excludeArticleId != null ? { id: { not: excludeArticleId } } : {}),
    },
    select: { id: true },
  });

  return taken == null;
}

/**
 * 取某系列当前最大序号（含软删行占位），+1 即自动分配值。
 * 空系列（或全未绑文章）→ 1。
 */
async function nextSeriesOrder(tx, seriesId) {
  const aggregated = await tx.article.aggregate({
    where: { seriesId },
    _max: { seriesOrder: true },
  });

  return (aggregated._max.seriesOrder ?? 0) + 1;
}

/**
 * 新建文章时的系列绑定解析（createArticle 调用，事务外）。
 *
 * - seriesId 缺省 / null → { null, null }（不加入系列）
 * - seriesId 有值 → 归属校验（404/403）→ seriesOrder 缺省/null 时自动 max+1，
 *   显式传值时查冲突（409）
 *
 * @param {object} payload 已过 zod 的请求体
 * @param {number} userId 来自 token
 * @returns {Promise<{seriesId: number|null, seriesOrder: number|null}>}
 */
async function resolveSeriesBindingForCreate(payload, userId) {
  const { seriesId, seriesOrder } = payload;

  if (seriesId == null) {
    return { seriesId: null, seriesOrder: null };
  }

  await requireOwnSeries(prisma, seriesId, userId);

  if (seriesOrder == null) {
    return { seriesId, seriesOrder: await nextSeriesOrder(prisma, seriesId) };
  }

  if (!(await isSeriesOrderFree(prisma, seriesId, seriesOrder))) {
    throw httpError(409, CODE.CONFLICT, '系列内序号已被占用，请换一个序号');
  }

  return { seriesId, seriesOrder };
}

/**
 * 编辑文章时的系列绑定解析（updateArticle 在事务内调用）。
 *
 * 三态矩阵（docs/API.md 第 10 批节，两字段是一个逻辑单元）：
 *
 * | seriesId | seriesOrder | 行为 |
 * |---|---|---|
 * | 不传 | 不传 | 保留原绑定（data 里两列都不写） |
 * | null | （任意） | 解绑：两列同时置 NULL（zod 已拦「null + 非 null 组合」） |
 * | 值 | 不传/null | 换系列/新绑定：校验归属后，序号自动 max+1（旧序号不随迁） |
 * | 值 | 值 | 绑定并指定序号：冲突 409 |
 * | 不传 | 值 | 改序号（系列内重排）：文章未绑系列 → 400；冲突 409 |
 * | 不传 | null | 不指定序号：自动排到当前系列末尾 |
 *
 * @param {object} tx 事务客户端（与文章更新同事务，任一步失败整体回滚）
 * @param {object} payload 已过 zod 的请求体
 * @param {{id: number, seriesId: number|null, seriesOrder: number|null}} current 文章当前绑定态
 * @param {number} userId 来自 token
 * @returns {Promise<{seriesId?: number|null, seriesOrder?: number|null}>} 要写进 article.update 的字段（空对象 = 不动）
 */
async function resolveSeriesBindingForUpdate(tx, payload, current, userId) {
  const { seriesId, seriesOrder } = payload;
  const hasSeriesId = seriesId !== undefined;
  const hasSeriesOrder = seriesOrder !== undefined;

  // 都不传：保留原绑定。
  if (!hasSeriesId && !hasSeriesOrder) {
    return {};
  }

  // 解绑：双清（series_id 与 series_order 同时 NULL，不留孤儿序号）。
  // zod 已保证 seriesId=null 时 seriesOrder 不同时传值，这里直接双清即可。
  if (hasSeriesId && seriesId === null) {
    return { seriesId: null, seriesOrder: null };
  }

  // 绑定 / 换系列。
  if (hasSeriesId) {
    await requireOwnSeries(tx, seriesId, userId);

    // 显式序号：冲突 409（排除自己——「换到别的系列」时自己不在新系列里，无排除必要；
    // 但「留在原系列改序号」走下面的分支，这里对换系列场景做统一排除也无副作用）。
    if (seriesOrder != null) {
      if (!(await isSeriesOrderFree(tx, seriesId, seriesOrder, current.id))) {
        throw httpError(409, CODE.CONFLICT, '系列内序号已被占用，请换一个序号');
      }
      return { seriesId, seriesOrder };
    }

    // 省略序号：留在原系列 → 保留原序号（缺 null 时补自动）；换系列 → 新系列 max+1
    // （旧序号属于旧系列，不迁移）。
    if (seriesId === current.seriesId) {
      return { seriesId, seriesOrder: current.seriesOrder ?? (await nextSeriesOrder(tx, seriesId)) };
    }

    return { seriesId, seriesOrder: await nextSeriesOrder(tx, seriesId) };
  }

  // 只剩 seriesOrder 单独出现（seriesId 不传）。
  if (current.seriesId == null) {
    throw httpError(400, CODE.PARAM_ERROR, '文章未加入任何系列，不能单独设置序号');
  }

  // seriesOrder = null：不指定序号 → 自动排到当前系列末尾。
  if (seriesOrder === null) {
    return { seriesOrder: await nextSeriesOrder(tx, current.seriesId) };
  }

  // 改序号：冲突 409（排除自己）。
  if (!(await isSeriesOrderFree(tx, current.seriesId, seriesOrder, current.id))) {
    throw httpError(409, CODE.CONFLICT, '系列内序号已被占用，请换一个序号');
  }

  return { seriesOrder };
}

/**
 * 博客广场列表，无需登录。
 *
 * @param {object} query Express 的 req.query，分页与排序由 parsePagination 校验，
 *                      keyword（搜索）由 parseKeyword 解析
 */
export async function listArticles(query) {
  const pagination = parsePagination(query, {
    allowedSort: ARTICLE_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  // 搜索：标题 OR 正文 命中即返回（docs/API.md）。空串在 parseKeyword 里已转成 null，
  // 即「不传」，所以这里只在真有 keyword 时才叠加 OR 条件。
  // 不搜作者昵称 —— 作者维度筛选不在本期范围。
  const keyword = parseKeyword(query);
  const searchWhere = keyword
    ? {
        OR: [{ title: { contains: keyword } }, { content: { contains: keyword } }],
      }
    : {};

  // 分类筛选：与 keyword 正交，作为 AND 条件叠加（切分类保留 keyword、切 keyword 保留分类）。
  // parseCategory 对非法值直接抛 400 / 40000（与 sortBy 风格一致）。
  const category = parseCategory(query);
  const categoryWhere = category ? { category } : {};

  // 第 7 批：标签筛选，与 keyword / category 三者正交可叠加。
  // some + 关联导航编译成 EXISTS 子查询，仍在同一条 SQL 里（N+1 防坑）。
  // 标签不存在是合法筛选结果（空列表），parseTag 只做格式校验，不做存在性校验。
  const tag = parseTag(query);
  const tagWhere = tag ? { tags: { some: { tag: { name: tag } } } } : {};

  // whereNotDeleted 内部是 { ...where, deletedAt: null }，
  // 所以 OR 条件与软删除过滤是 AND 关系：软删除的文章搜不到（docs/API.md 语义第 5 条）。
  // searchWhere(OR...) 与 categoryWhere 平铺合并 → 二者也是 AND 关系，实现「正交可叠加」。
  // 第 6 批：公开广场只认 PUBLISHED，草稿（DRAFT）与已软删都不出现（docs/API.md 该节）。
  const where = whereNotDeleted({
    ...searchWhere,
    ...categoryWhere,
    ...tagWhere,
    status: 'PUBLISHED',
  });

  // 列表要生成 summary，必须取 content。pageSize 上限 100，100 条 MEDIUMTEXT 对 MVP 可接受。
  const [rows, total] = await Promise.all([
    prisma.article.findMany({
      where,
      select: ARTICLE_DETAIL_SELECT,
      // sortBy=likeCount 时由 ARTICLE_SORT_MAP 翻成关联计数排序；排序与 skip/take
      // 全在 SQL 层完成（不是拉全量再在 JS 里排），并且次级排序 id 自动生效。
      orderBy: buildOrderBy(pagination, { map: ARTICLE_SORT_MAP }),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.article.count({ where }),
  ]);

  return {
    list: rows.map(toArticleListItem),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/**
 * 文章详情，返回全文。
 *
 * @param {number} id
 */
export async function getArticleDetail(id) {
  // 第 6 批：公开详情只认 PUBLISHED。草稿（DRAFT）走这里会自然 404（与「不存在」同口径），
  // 不区分请求者是否为作者——草稿只通过 GET /api/users/me/drafts 暴露给作者本人（docs/API.md）。
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id, status: 'PUBLISHED' }),
    select: ARTICLE_DETAIL_SELECT,
  });

  if (!article) {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在');
  }

  return toArticleDetail(article);
}

/**
 * 取文章用于「存在性 / 权限」判断。不存在或已软删除一律 404。
 */
// 导出供 like.service.js 复用：点赞/取消点赞要的是同一套「文章存在且未软删」判定，
// 与其在 like.service 里再写一遍，不如共用一处，避免两边口径漂移。
export async function requireArticleForWrite(id) {
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id }),
    select: ARTICLE_OWNER_SELECT,
  });

  if (!article) {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在');
  }

  return article;
}

/**
 * 非作者一律 403。403 直接在这里抛，controller 不做二次翻译。
 */
function assertAuthor(article, userId) {
  if (article.authorId !== userId) {
    throw httpError(403, CODE.FORBIDDEN, '无权限，只能操作自己的文章');
  }
}

/**
 * 编辑文章（全量更新）。
 *
 * 判断顺序固定为「先存在（404）后作者（403）」：
 * 反过来会让非作者通过 403 / 404 的差异枚举出真实存在的文章 id。
 *
 * 第 6 批：版本快照。更新前若文章是 `PUBLISHED`，先把当前 title/content/category
 * 存入 article_revisions（生成一条「更新前快照」），再应用本次更新——这是
 * GET /api/articles/:id/revisions 与 /restore 的数据来源。若目标是 DRAFT（例如
 * 把草稿 PUT 成 PUBLISHED 来「发布」），则**不快照**（草稿本身不进版本历史）。
 */
export async function updateArticle(id, payload, userId) {
  // 复用 requireArticleForWrite 的存在性判定，再单独取快照所需字段。
  const exists = await requireArticleForWrite(id);
  assertAuthor(exists, userId);

  // 取更新前的完整内容用于快照（requireArticleForWrite 只回 {id, authorId}）。
  const current = await prisma.article.findFirst({
    where: whereNotDeleted({ id }),
    select: {
      id: true,
      title: true,
      content: true,
      category: true,
      authorId: true,
      status: true,
      // 第 10 批：系列绑定三态的判定基准（当前绑在哪个系列、序号多少）。
      seriesId: true,
      seriesOrder: true,
    },
  });

  // 第 7 批：快照 + 更新 + 标签全量替换放进同一事务——任一步失败整体回滚，
  // 不会出现「快照已写、正文没更新」或「正文已更新、标签替换失败留下旧关联」的中间态。
  return prisma.$transaction(async (tx) => {
    // 仅当更新前是 PUBLISHED 才快照；DRAFT 不进版本历史。
    if (current && current.status === 'PUBLISHED') {
      await tx.articleRevision.create({
        data: {
          articleId: id,
          title: current.title,
          content: current.content,
          category: current.category,
          authorId: current.authorId,
        },
      });
    }

    // category 三态：不传（undefined）→ 保留原值（不写该字段）；传了合法值 → 更新。
    const data = {
      title: payload.title,
      content: payload.content,
    };
    if (payload.category !== undefined) {
      data.category = payload.category;
    }
    // status 三态：不传（undefined）→ 保留原值；传了 DRAFT/PUBLISHED → 显式切换。
    if (payload.status !== undefined) {
      data.status = payload.status;
    }

    // 第 10 批：系列绑定三态（与 category / status / tags 同范式，两字段一个逻辑单元）。
    // 归属校验（404/403）与序号冲突（409）都在事务内、写文章之前抛，
    // 失败整体回滚——不会出现「正文更新了、系列绑定失败」的半态。
    const seriesBinding = await resolveSeriesBindingForUpdate(tx, payload, current, userId);
    Object.assign(data, seriesBinding);

    await tx.article.update({ where: { id }, data });

    // tags 三态（第 7 批，与 category 一致）：不传 = 保留原关联（不动中间表）；
    // 传了（含 []）= 全量替换（applyTags 内先删旧再建新）。
    if (payload.tags !== undefined) {
      await applyTags(tx, id, payload.tags);
    }

    const updated = await tx.article.findUnique({
      where: { id },
      select: ARTICLE_DETAIL_SELECT,
    });

    return toArticleDetail(updated);
  });
}

/**
 * 删除文章（软删除）。判断顺序同 updateArticle。
 *
 * 只 UPDATE deleted_at，物理行保留，因此不触发外键：评论不被连带删除，
 * 之后由接口层保证它们随文章一起不可见（docs/DB.md「软删除与外键的交互」）。
 */
export async function deleteArticle(id, userId) {
  const article = await requireArticleForWrite(id);

  assertAuthor(article, userId);

  await prisma.article.update({
    where: { id },
    data: {
      deletedAt: new Date(),
    },
  });

  return null;
}

/* ---------- 第 6 批：草稿 / 自动保存 / 版本历史 / 回滚 ---------- */

/**
 * 自动保存草稿。对应 docs/API.md 的 POST /api/articles/auto-save。
 *
 * 行为分两支（与 API.md 完全一致）：
 *   ① 有 draftId → 更新该草稿（必须 DRAFT 且 authorId=本人，否则 404，坑 1 越权校验）；
 *      status 保持 DRAFT，返回 { id, status:"DRAFT", saved:true }。
 *   ② 无 draftId → 先过「建草稿门槛」（补丁 3 第一道闸）：title 空或纯空白 且 content 字符数 < 10
 *      时不创建，返回 { id:null, status:"IDLE", saved:false }（前端保持 idle、不再发请求）；
 *      门槛通过后再看 sourceArticleId：若传了，校验它指向 PUBLISHED 且作者本人，否则 404
 *      （防越权编辑他人文章）；校验仅作放行，**不把 sourceArticleId 落库**（补丁 1 独立草稿隔离）。
 *      然后新建一篇 DRAFT，返回 { id, status:"DRAFT", saved:true }。
 *
 * 注意：进入草稿态（已持有 draftId）后，任何内容变化（含清空到 0 字）都走「有 draftId」分支，
 * 不再受建草稿门槛限制（补丁 3 第二道闸，保证「清空内容后保存」不丢）。
 *
 * @param {object} payload 已校验请求体（autoSaveSchema）
 * @param {number} userId 来自 token
 */
export async function autoSaveArticle(payload, userId) {
  const { title, content, category, tags, draftId, sourceArticleId } = payload;

  // ① 有 draftId：更新已有草稿。
  if (draftId !== undefined && draftId !== null) {
    const draft = await prisma.article.findFirst({
      where: whereNotDeleted({ id: draftId, authorId: userId, status: 'DRAFT' }),
      select: { id: true },
    });
    if (!draft) {
      throw httpError(404, CODE.NOT_FOUND, '草稿不存在');
    }

    const data = {};
    if (title !== undefined) data.title = title;
    if (content !== undefined) data.content = content;
    if (category !== undefined) data.category = category;
    // status 保持 DRAFT，不在此处被改。

    // tags 三态（第 7 批同 PUT）：不传 = 不动草稿已有标签；传了 = 全量替换。
    // 与内容更新同事务，防止「正文存了、标签没存」的半保存态。
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.article.update({
        where: { id: draftId },
        data,
        select: { id: true, status: true },
      });
      if (tags !== undefined) {
        await applyTags(tx, draftId, tags);
      }
      return u;
    });

    return { id: updated.id, status: updated.status, saved: true };
  }

  // ② 无 draftId：新建草稿，先过「建草稿门槛」。
  const titleStr = title ?? '';
  const contentStr = content ?? '';
  // 按字符数（码点）计，与 buildSummary 一致，避免代理对被截断后误判长度。
  const contentLen = [...contentStr].length;
  if (titleStr.trim() === '' && contentLen < 10) {
    return { id: null, status: 'IDLE', saved: false };
  }

  // sourceArticleId 归属校验：必须 PUBLISHED 且本人，否则 404。仅校验，不落库。
  if (sourceArticleId !== undefined && sourceArticleId !== null) {
    const source = await prisma.article.findFirst({
      where: whereNotDeleted({ id: sourceArticleId, authorId: userId, status: 'PUBLISHED' }),
      select: { id: true },
    });
    if (!source) {
      throw httpError(404, CODE.NOT_FOUND, '来源文章不存在或无权编辑');
    }
  }

  // 第 7 批：新建草稿也接收 tags（用户在首 keystroke 就打了标签的场景）。
  // create 与建关联同事务；空数组跳过。
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.article.create({
      data: {
        title: titleStr,
        content: contentStr,
        category: category ?? '未分类',
        status: 'DRAFT',
        authorId: userId,
      },
      select: { id: true, status: true },
    });
    if (tags !== undefined && tags.length > 0) {
      await applyTags(tx, row.id, tags);
    }
    return row;
  });

  return { id: created.id, status: created.status, saved: true };
}

/**
 * 当前用户的草稿箱列表。对应 docs/API.md 的 GET /api/users/me/drafts。
 *
 * 只返回 status=DRAFT 且本人才有的文章（不含已发布、不含已软删）。
 * 结构与 GET /api/articles 同形（list[] 走 toArticleListItem，含 summary 截取）。
 * 默认按 updatedAt 倒序（最近编辑的草稿在前）。
 *
 * @param {number} userId 来自 token
 * @param {object} query Express 的 req.query（page / pageSize / keyword）
 */
export async function listDrafts(userId, query) {
  const pagination = parsePagination(query, {
    allowedSort: ARTICLE_SORT_FIELDS,
    defaultSort: 'updatedAt',
  });

  const where = whereNotDeleted({ authorId: userId, status: 'DRAFT' });

  // keyword 仅按 title 模糊匹配（草稿箱是作者私域，不搜正文）。parseKeyword 复用
  // 广场的校验（空串/纯空白=不过滤、超长 50 报错、重复传值报错），返回已 trim 关键字。
  const keyword = parseKeyword(query);
  if (keyword) {
    where.title = { contains: keyword };
  }

  const [rows, total] = await Promise.all([
    prisma.article.findMany({
      where,
      select: ARTICLE_DETAIL_SELECT,
      orderBy: buildOrderBy(pagination, { map: ARTICLE_SORT_MAP }),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.article.count({ where }),
  ]);

  return {
    // 与广场列表项同形（toArticleListItem），但**额外透出 content 全文**：
    // 草稿拿不到公开详情（DRAFT 详情一律 404，坑 3），「从草稿箱继续编辑」
    // 的全文回填只有这一个数据来源。接口本身就是作者私域，不泄露。
    list: rows.map((row) => ({ ...toArticleListItem(row), content: row.content })),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/**
 * 热门标签列表。对应 docs/API.md 的 GET /api/tags（第 7 批新增）。
 *
 * N+1 防坑：groupBy 一次聚合 + 一次 findMany(where id in) 补名字，
 * 固定两步查询，不随标签数量增长（docs/API.md 该节「性能口径」）。
 *
 * 口径：
 * - articleCount 只数 PUBLISHED 且未软删的文章（坑 4 同口径）——groupBy 的 where
 *   下钻到 article 关系，用 whereNotDeleted({ status: 'PUBLISHED' }) 复用统一软删过滤。
 * - 0 篇文章的标签不出现在列表里（groupBy 只产出有行的分组）。
 * - 排序 articleCount desc → name asc：groupBy 原生只支持按 _count 排，
 *   name 次级排序在 JS 侧做（标签总量有限，内存排序可控）。
 *
 * @param {object} query Express 的 req.query（limit，默认 20，上限 100）
 */
export async function listHotTags(query) {
  const source = query && typeof query === 'object' ? query : {};

  let limit = 20;
  if (source.limit !== undefined) {
    if (Array.isArray(source.limit)) {
      throw httpError(400, CODE.PARAM_ERROR, 'limit 不允许重复传值');
    }
    const parsed = Number(source.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw httpError(400, CODE.PARAM_ERROR, 'limit 必须是 1-100 的整数');
    }
    limit = parsed;
  }

  const grouped = await prisma.articleTag.groupBy({
    by: ['tagId'],
    _count: { _all: true },
    where: { article: whereNotDeleted({ status: 'PUBLISHED' }) },
    orderBy: { _count: { tagId: 'desc' } },
  });

  if (grouped.length === 0) {
    return { list: [] };
  }

  const tags = await prisma.tag.findMany({
    where: { id: { in: grouped.map((row) => row.tagId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(tags.map((tag) => [tag.id, tag.name]));

  const list = grouped
    .map((row) => ({ id: row.tagId, name: nameById.get(row.tagId), articleCount: row._count._all }))
    // 次级排序 name asc（并列计数时输出稳定，探针可断言）。
    .sort((a, b) => b.articleCount - a.articleCount || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .slice(0, limit);

  return { list };
}

/**
 * 删除指定草稿（物理删除）。对应 docs/API.md 的 DELETE /api/users/me/drafts/:id。
 *
 * 必须是 DRAFT 且本人，否则 404 / 40400。草稿无点赞/评论/版本记录，可安全硬删。
 *
 * @param {number} id 路径参数
 * @param {number} userId 来自 token
 */
export async function deleteDraft(id, userId) {
  const draft = await prisma.article.findFirst({
    where: whereNotDeleted({ id, authorId: userId, status: 'DRAFT' }),
    select: { id: true },
  });

  if (!draft) {
    throw httpError(404, CODE.NOT_FOUND, '草稿不存在');
  }

  await prisma.article.delete({ where: { id } });

  return null;
}

/**
 * 文章版本历史（全量 content，方案 A）。对应 docs/API.md 的 GET /api/articles/:id/revisions。
 *
 * 必须是 PUBLISHED 且本人，否则按失败表区分：
 *   - 不存在 / 已软删 / 非 PUBLISHED → 404 / 40400
 *   - 存在但非作者 → 403 / 40300（与失败表一致，便于前端区分「无权」与「不存在」）
 * 草稿（DRAFT）没有版本历史，故非 PUBLISHED 一律 404。
 *
 * @param {number} id 路径参数
 * @param {number} userId 来自 token
 */
export async function listRevisions(id, userId) {
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id }),
    select: { id: true, authorId: true, status: true },
  });

  if (!article || article.status !== 'PUBLISHED') {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在或非已发布');
  }
  if (article.authorId !== userId) {
    throw httpError(403, CODE.FORBIDDEN, '无权访问');
  }

  // 按 createdAt 倒序：最新快照在前。每条都带完整 content（方案 A）。
  const revisions = await prisma.articleRevision.findMany({
    where: { articleId: id },
    orderBy: { createdAt: 'desc' },
  });

  return {
    articleId: id,
    revisions: revisions.map((r) => ({
      id: r.id,
      articleId: r.articleId,
      title: r.title,
      content: r.content,
      category: r.category,
      authorId: r.authorId,
      createdAt: r.createdAt,
    })),
    total: revisions.length,
  };
}

/**
 * 回滚到指定版本（先快照、后覆盖）。对应 docs/API.md 的 POST /api/articles/:id/restore。
 *
 * 必须是 PUBLISHED 且本人（与 listRevisions 同口径）。revisionId 必须属于该文章，否则 404。
 * 行为：
 *   1. 先把目标文章「当前」的 title/content/category 存入 article_revisions（记录「回滚前」状态）；
 *   2. 再把文章覆盖为 revisionId 对应快照的内容，status 保持 PUBLISHED；
 *   3. 返回更新后的文章（结构同详情）。
 *
 * @param {number} id 路径参数（目标文章）
 * @param {number} revisionId 请求体（restoreSchema 已校验为正整数）
 * @param {number} userId 来自 token
 */
export async function restoreArticle(id, revisionId, userId) {
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id }),
    select: {
      id: true,
      authorId: true,
      status: true,
      title: true,
      content: true,
      category: true,
    },
  });

  if (!article || article.status !== 'PUBLISHED') {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在或非已发布');
  }
  if (article.authorId !== userId) {
    throw httpError(403, CODE.FORBIDDEN, '无权访问');
  }

  // revisionId 必须属于该文章，否则 404（防止跨文章回滚）。
  const revision = await prisma.articleRevision.findFirst({
    where: { id: revisionId, articleId: id },
  });
  if (!revision) {
    throw httpError(404, CODE.NOT_FOUND, '版本不存在');
  }

  // 1. 先快照当前版（保证回滚本身也可再回滚）。
  await prisma.articleRevision.create({
    data: {
      articleId: id,
      title: article.title,
      content: article.content,
      category: article.category,
      authorId: article.authorId,
    },
  });

  // 2. 覆盖为选定版本的内容。status 保持 PUBLISHED。
  const updated = await prisma.article.update({
    where: { id },
    data: {
      title: revision.title,
      content: revision.content,
      category: revision.category,
    },
    select: ARTICLE_DETAIL_SELECT,
  });

  return toArticleDetail(updated);
}

/* ---------- 供user.service.js 复用的内部件（第 2 批导出） ---------- */

/**
 * 第2 批（用户主页接口）复用这三个内部件，让「按用户列文章」与「博客广场列表」
 * 的list[] **逐字同形**。
 *
 * ## 导出的是「塑形与查询常量」，不是业务函数
 *
 * 这三样都**不含独立业务语义**，离开article.service.js 单独用反而会漂移：
 *   - toArticleListItem：summary 长度、author 字段集、likeCount 折算全在这里，
 *    复制一份必然出现两个列表接口的summary 长度不一样这种问题；
 *   - ARTICLE_DETAIL_SELECT：广场列表与用户文章列表要**完全一致**的 select，
 *    包含 author 内嵌与 _count.likes；
 *   - ARTICLE_SORT_MAP：likeCount 的关联计数排序翻译（真实列 vs 计算字段的处理）。
 *
 * ## 为什么不抽到公共文件
 * 现阶段只有一个复用方，抽出 `article-shape.js` 会多一层间接。
 * 出现第三个复用方时再抽（DB.md / API.md 已登记这条演进路径）。
 *
 * 注意：这三个名字**不要当成对外接口的稳定契约**，它们只在后端内部使用，
 * 不影响 docs/API.md 定义的任何响应结构。
 */
export { toArticleListItem, ARTICLE_DETAIL_SELECT, ARTICLE_SORT_MAP, AUTHOR_SELECT, buildSummary };
