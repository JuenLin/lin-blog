import prisma from '../utils/prisma.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { CODE, httpError } from '../utils/response.js';
import { requireUserExists } from './user.service.js';
import { buildSummary } from './article.service.js';

/**
 * 专栏系列（第 10 批）。对应 docs/API.md「文章图片上传与专栏系列（第 10 批）」的
 * 5 个 series 接口。
 *
 * 与文章侧的分工：
 *   - 系列的元信息（title / description）CRUD 在本文件；
 *   - 文章绑不绑系列、序号多少是**文章侧**字段（articles.series_id / series_order），
 *     走 article.service.js 的 createArticle / updateArticle（本服务不改文章绑定）。
 *
 * 删除行为：系列**物理删**（无 deleted_at，纯组织容器），文章经外键
 * ON DELETE SET NULL 自动解绑；应用层同时显式清 series_order（双清，
 * 外键只管 series_id 一列，见 docs/DB.md「series（系列表）」）。
 */

// 系列自身字段（不含 author / articles）。
const SERIES_SELECT = {
  id: true,
  title: true,
  description: true,
  createdAt: true,
  updatedAt: true,
};

// 内嵌 author 的字段集。**刻意不带 role**（与文章的 AUTHOR_SELECT 不同）：
// 系列没有管理端徽章需求，4 个字段够用；响应体形状以 docs/API.md 为准。
const SERIES_AUTHOR_SELECT = {
  id: true,
  username: true,
  nickname: true,
  avatar: true,
};

const SERIES_WITH_AUTHOR_SELECT = {
  ...SERIES_SELECT,
  author: { select: SERIES_AUTHOR_SELECT },
};

function toAuthor(author) {
  return {
    id: author.id,
    username: author.username,
    nickname: author.nickname,
    avatar: author.avatar,
  };
}

/**
 * 描述归一：trim 后的空串与 null 等价，都存 NULL。
 * 「有 description 键但值是空串」和「没有 description」在库里是同一个状态，
 * 避免出现 description='' 与 NULL 两种「无描述」。
 */
function normalizeDescription(description) {
  if (description == null || description === '') return null;
  return description;
}

/**
 * 创建系列。作者取 token 中的 userId。
 *
 * @param {object} payload 已过 zod（createSeriesSchema）
 * @param {number} userId 来自 token
 */
export async function createSeries(payload, userId) {
  const series = await prisma.series.create({
    data: {
      title: payload.title,
      description: normalizeDescription(payload.description),
      authorId: userId,
    },
    select: SERIES_WITH_AUTHOR_SELECT,
  });

  return toSeriesWithAuthor(series, 0);
}

/**
 * 系列详情（含有序文章列表）。公开，无需登录。
 *
 * articles[] 只含 PUBLISHED 且未软删的文章，按 seriesOrder 升序（系列内阅读顺序），
 * 次级 id 保证 order 并列（含 NULL）时输出稳定。草稿不进列表——「共 N 篇」是读者口径。
 * 「第 N 篇」由前端按列表下标算，服务端不返回 N（草稿发布 / 软删时 N 会变）。
 *
 * @param {number} id 系列 id
 */
export async function getSeriesDetail(id) {
  const series = await prisma.series.findUnique({
    where: { id },
    select: {
      ...SERIES_WITH_AUTHOR_SELECT,
      articles: {
        where: whereNotDeleted({ status: 'PUBLISHED' }),
        select: {
          id: true,
          title: true,
          seriesOrder: true,
          content: true,
        },
        orderBy: [{ seriesOrder: 'asc' }, { id: 'asc' }],
      },
    },
  });

  if (!series) {
    throw httpError(404, CODE.NOT_FOUND, '系列不存在');
  }

  return {
    ...toSeriesWithAuthor(series, series.articles.length),
    articles: series.articles.map((article) => ({
      id: article.id,
      title: article.title,
      seriesOrder: article.seriesOrder,
      // summary 与广场列表同一函数（码点安全截断，见 article.service.js）。
      summary: buildSummary(article.content),
    })),
  };
}

/**
 * 更新系列元信息。**作者本人或 ADMIN**（第 5 批权限底座）。
 *
 * 部分更新：title 不传 = 保留；description 不传 = 保留、null = 清空。
 * 不改文章绑定（那走文章侧接口）。
 *
 * @param {number} id 系列 id
 * @param {object} payload 已过 zod（updateSeriesSchema）
 * @param {number} userId 来自 token
 */
export async function updateSeries(id, payload, userId) {
  await requireSeriesManagePermission(id, userId);

  const data = {};
  if (payload.title !== undefined) data.title = payload.title;
  if (payload.description !== undefined) {
    data.description = normalizeDescription(payload.description);
  }

  const updated = await prisma.series.update({
    where: { id },
    data,
    select: SERIES_WITH_AUTHOR_SELECT,
  });

  // 与创建响应同形：带 articleCount（只数 PUBLISHED 且未软删）。
  const articleCount = await countSeriesArticles(id);

  return toSeriesWithAuthor(updated, articleCount);
}

/**
 * 删除系列。**作者本人或 ADMIN**。
 *
 * 行为（一个事务，原子）：
 *   ① 先把该系列下所有文章的 series_id / series_order 双清（显式 UPDATE——
 *      外键 SET NULL 只清 series_id，series_order 不在外键管辖内）；
 *   ② 再物理删系列行。
 * 文章本身不删（软删的文章若还绑着也一并解绑，updateMany 不过滤 deletedAt）。
 *
 * @param {number} id 系列 id
 * @param {number} userId 来自 token
 * @returns {Promise<{unboundCount: number}>} 被解绑的文章数
 */
export async function deleteSeries(id, userId) {
  await requireSeriesManagePermission(id, userId);

  return prisma.$transaction(async (tx) => {
    const unbound = await tx.article.updateMany({
      where: { seriesId: id },
      data: { seriesId: null, seriesOrder: null },
    });

    await tx.series.delete({ where: { id } });

    return { unboundCount: unbound.count };
  });
}

/**
 * 某用户的系列列表（编辑器「加入系列」下拉、个人主页「系列」Tab）。公开。
 *
 * 分页同广场范式（page 默认 1、pageSize 默认 10 上限 100）；**无排序参数**，
 * 固定 createdAt desc——传 sortBy 会因白名单只有 createdAt 而 400（docs/API.md）。
 * list[] 不带 author：路径已指定用户，作者恒为该用户（同 /users/:id/articles 口径）。
 *
 * @param {number} id 用户 id
 * @param {object} query Express 的 req.query
 */
export async function listSeriesByUser(id, query) {
  await requireUserExists(id);

  const pagination = parsePagination(query, {
    allowedSort: ['createdAt'],
    defaultSort: 'createdAt',
  });

  const where = { authorId: id };

  const [rows, total] = await Promise.all([
    prisma.series.findMany({
      where,
      select: SERIES_SELECT,
      orderBy: buildOrderBy(pagination),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.series.count({ where }),
  ]);

  // articleCount：groupBy 一次聚合拿本页所有系列的已发布文章数（不是每系列一次 COUNT，
  // N+1 防坑，同 listHotTags 的两步查询范式）。空页跳过聚合。
  const countBySeriesId = new Map();
  if (rows.length > 0) {
    const grouped = await prisma.article.groupBy({
      by: ['seriesId'],
      _count: { _all: true },
      where: {
        seriesId: { in: rows.map((row) => row.id) },
        ...whereNotDeleted({ status: 'PUBLISHED' }),
      },
    });

    for (const row of grouped) {
      countBySeriesId.set(row.seriesId, row._count._all);
    }
  }

  return {
    list: rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      // 0 篇的系列显式返回 0（不是省略键）——与文章列表 likeCount 同口径。
      articleCount: countBySeriesId.get(row.id) ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/* ---------- 内部 helpers ---------- */

/**
 * 系列管理权限：作者本人或 ADMIN。
 *
 * 与文章侧绑定校验（requireOwnSeries，在 article.service.js 内）刻意不同：
 * 那里**只允许本人**（ADMIN 不能把别人文章绑进自己系列），这里允许 ADMIN
 * 代管任何系列的元信息（第 5 批权限底座的口径）。
 *
 * 判断顺序固定「先存在（404）再权限（403）」：不通过 403/404 差异枚举系列 id。
 *
 * @returns {Promise<{id: number, authorId: number}>} 校验通过的系列
 */
async function requireSeriesManagePermission(id, userId) {
  const series = await prisma.series.findUnique({
    where: { id },
    select: { id: true, authorId: true },
  });

  if (!series) {
    throw httpError(404, CODE.NOT_FOUND, '系列不存在');
  }

  if (series.authorId === userId) {
    return series;
  }

  // 非作者：查一次 role（auth 中间件的 req.user 不带 role，与 requireAdmin 同因）。
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user || user.role !== 'ADMIN') {
    throw httpError(403, CODE.FORBIDDEN, '无权限，只能操作自己的系列');
  }

  return series;
}

/** 某系列的已发布且未软删文章数（create / update 响应的 articleCount）。 */
async function countSeriesArticles(seriesId) {
  return prisma.article.count({
    where: whereNotDeleted({ seriesId, status: 'PUBLISHED' }),
  });
}

/** 带 author 的系列对象塑形（create / update / detail 三处响应同形）。 */
function toSeriesWithAuthor(series, articleCount) {
  return {
    id: series.id,
    title: series.title,
    description: series.description,
    author: toAuthor(series.author),
    articleCount,
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
  };
}
