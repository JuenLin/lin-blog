import prisma from '../utils/prisma.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { CODE, httpError } from '../utils/response.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { parseReportStatus } from '../validators/report.validator.js';
import { notifyOnReportResult } from './notification.service.js';

// 第 12 批：举报与审核。对应 docs/API.md「举报与审核（第 12 批）」的 3 个接口。
//
// 口径速记（均已获用户拍板，2026-10-18）：
//   - 防重复：唯一约束 reports_reporter_id_target_type_target_id_key 是唯一真相，
//     第二次举报（含上次已被处理的）P2002 → 409/40900，不新增行、不重置状态；
//   - 目标可见性 404 =「内容不存在或不可见」：文章必须未软删且 PUBLISHED（草稿不可
//     举报——外人根本看不到它）；评论必须未软删且所属文章可见（requireVisibleComment 同口径）；
//   - 不能举报自己：目标作者是举报人本人 → 400（作者删自己的内容走既有删除接口）；
//   - 管理员处理是**单事务**：软删目标（评论级联子评论）+ 该目标全部 PENDING 批转
//     RESOLVED 要么全成功要么全回滚；目标已被作者先行软删 → 幂等跳过（targetDeleted=false）；
//   - 通知在**事务提交后**发（REPORT_RESOLVED / REPORT_REJECTED），单条失败不影响其余、
//     绝不回滚业务（第 8 批纪律）。

const REPORT_SORT_FIELDS = ['createdAt', 'id'];

const REPORTER_SELECT = {
  id: true,
  username: true,
  nickname: true,
};

/**
 * 校验举报目标可见，返回目标作者 id（用于「不能举报自己」判定）。
 * 404 唯一语义 =「内容不存在或不可见」（软删目标 / 草稿文章一律 404，
 * 防坑 1：作者已自行软删的内容不能再被举报）。
 *
 * ⚠️ Prisma 不支持关系级 where 过滤（第 11 批实证）——文章可见性查回
 * status / deletedAt 后在应用层判定。
 *
 * @param {'ARTICLE'|'COMMENT'} targetType
 * @param {number} targetId
 * @returns {Promise<{authorId: number}>}
 */
async function requireVisibleTarget(targetType, targetId) {
  if (targetType === 'ARTICLE') {
    const article = await prisma.article.findFirst({
      where: whereNotDeleted({ id: targetId }),
      select: { authorId: true, status: true },
    });

    // 草稿不可举报：status 必须是 PUBLISHED（与文章详情的公开可见口径一致）。
    if (!article || article.status !== 'PUBLISHED') {
      throw httpError(404, CODE.NOT_FOUND, '内容不存在或不可见');
    }

    return { authorId: article.authorId };
  }

  const comment = await prisma.comment.findFirst({
    where: whereNotDeleted({ id: targetId }),
    select: {
      authorId: true,
      article: { select: { status: true, deletedAt: true } },
    },
  });

  const articleVisible = comment && comment.article && comment.article.deletedAt === null && comment.article.status === 'PUBLISHED';

  if (!articleVisible) {
    throw httpError(404, CODE.NOT_FOUND, '内容不存在或不可见');
  }

  return { authorId: comment.authorId };
}

/**
 * 提交举报（POST /api/reports）。
 *
 * 校验顺序（docs/API.md）：① 目标可见 → 404；② 举报自己是自己 → 400；
 * ③ 唯一约束 P2002 → 409（应用层「先查后写」有竞态窗口，DB 约束是唯一真相，
 * 与 like / bookmark 族的 P2002 兜底同款，只是这里转 409 不转幂等——防坑 3）。
 *
 * @param {number} reporterId
 * @param {{ targetType: 'ARTICLE'|'COMMENT', targetId: number, reason?: string }} body
 * @returns {Promise<{id: number, targetType: string, targetId: number, status: string}>}
 */
export async function createReport(reporterId, body) {
  const target = await requireVisibleTarget(body.targetType, body.targetId);

  if (target.authorId === reporterId) {
    throw httpError(400, CODE.PARAM_ERROR, '不能举报自己的内容');
  }

  // 空串 / 纯空白按「没填」处理，不给 DB 塞空串。
  const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : null;

  let row;
  try {
    row = await prisma.report.create({
      data: {
        reporterId,
        targetType: body.targetType,
        targetId: body.targetId,
        reason,
      },
    });
  } catch (error) {
    if (error && error.code === 'P2002') {
      throw httpError(409, CODE.CONFLICT, '已举报过该内容，请勿重复提交');
    }
    throw error;
  }

  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    status: row.status,
  };
}

/**
 * 管理端举报列表（GET /api/admin/reports）：分页 + status 筛选 + targetPreview 快照。
 *
 * targetPreview 是**批量**联查（按页收集 targetType/targetId，每类型一次 IN 查询），
 * 绝不逐行查（N+1 防坑，同 findLikedCommentIds 纪律）。目标已被软删 / 不存在 →
 * title / authorName 为 null + deleted: true（notifications「内容已删除」同款降级，
 * 管理员不跳页也能看出这条举报的对象已经没了）。
 *
 * @param {object} query
 */
export async function listReports(query) {
  const pagination = parsePagination(query, {
    allowedSort: REPORT_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  const status = parseReportStatus(query);
  const where = { ...(status ? { status } : {}) };

  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      include: { reporter: { select: REPORTER_SELECT } },
      orderBy: buildOrderBy(pagination),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.report.count({ where }),
  ]);

  // 批量取两类目标的预览快照（含软删行——preview 就是要如实展示 deleted）。
  const articleIds = rows.filter((r) => r.targetType === 'ARTICLE').map((r) => r.targetId);
  const commentIds = rows.filter((r) => r.targetType === 'COMMENT').map((r) => r.targetId);

  const [articles, comments] = await Promise.all([
    articleIds.length
      ? prisma.article.findMany({
          where: { id: { in: articleIds } },
          select: { id: true, title: true, deletedAt: true, author: { select: { nickname: true, username: true } } },
        })
      : Promise.resolve([]),
    commentIds.length
      ? prisma.comment.findMany({
          where: { id: { in: commentIds } },
          select: { id: true, content: true, deletedAt: true, author: { select: { nickname: true, username: true } } },
        })
      : Promise.resolve([]),
  ]);

  const articleMap = new Map(articles.map((a) => [a.id, a]));
  const commentMap = new Map(comments.map((c) => [c.id, c]));

  return {
    list: rows.map((row) => toReportListItem(row, articleMap, commentMap)),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/** 评论预览截 50 字，必须 Unicode 安全（summary 同款纪律，防腰斩 emoji 代理对）。 */
function previewContent(content) {
  return [...content].slice(0, 50).join('');
}

function toReportListItem(row, articleMap, commentMap) {
  let title = null;
  let authorName = null;
  let deleted = true;

  if (row.targetType === 'ARTICLE') {
    const article = articleMap.get(row.targetId);
    if (article && article.deletedAt === null) {
      deleted = false;
      title = article.title;
      authorName = article.author ? article.author.nickname || article.author.username : null;
    }
  } else {
    const comment = commentMap.get(row.targetId);
    if (comment && comment.deletedAt === null) {
      deleted = false;
      title = previewContent(comment.content);
      authorName = comment.author ? comment.author.nickname || comment.author.username : null;
    }
  }

  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    reporter: {
      id: row.reporter.id,
      username: row.reporter.username,
      nickname: row.reporter.nickname,
    },
    targetPreview: { title, authorName, deleted },
  };
}

/**
 * 管理端处理举报（PUT /api/admin/reports/:id）。**单事务**（防坑 2）。
 *
 * 事务内：
 *   1. deleteTarget=true → 软删目标：文章软删本身；评论软删 + 级联软删子评论
 *      （两层硬限制下一条 updateMany 覆盖子树，对齐用户侧 deleteComment 口径）。
 *      目标已不在（作者先行软删）→ 幂等跳过，targetDeleted=false，状态照常流转。
 *   2. RESOLVED → 该目标**全部** PENDING 举报 updateMany 转 RESOLVED（不限当前这条，
 *      多人举报同一违规内容一并闭环，处理行数记 resolvedCount）；REJECTED → 只改当前一条。
 *
 * 事务提交**后**：给每个被闭环举报的举报人发 REPORT_RESOLVED / REPORT_REJECTED
 * 通知（同一举报人对同一对象只有一行，天然按行去重；管理员本人恰是举报人 → 自通知抑制；
 * 单条失败继续其余，绝不回滚已提交的业务）。
 *
 * @param {number} resolverId 管理员 userId（通知 actor）
 * @param {number} reportId
 * @param {{ status: 'RESOLVED'|'REJECTED', deleteTarget?: boolean }} body
 * @returns {Promise<{id: number, status: string, resolvedAt: Date, resolvedCount: number, targetDeleted: boolean}>}
 */
export async function resolveReport(resolverId, reportId, body) {
  const { status, deleteTarget = false } = body;

  if (status === 'REJECTED' && deleteTarget) {
    throw httpError(400, CODE.PARAM_ERROR, 'REJECTED（未违规）不能同时删除内容');
  }

  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // 不过滤软删：已处理过的举报也能被再次读到（重复处理不报错，走幂等语义）。
    const report = await tx.report.findUnique({
      where: { id: reportId },
      select: { id: true, targetType: true, targetId: true, reporterId: true, status: true },
    });

    if (!report) {
      throw httpError(404, CODE.NOT_FOUND, '举报不存在');
    }

    let articleId = null;
    let targetDeleted = false;

    if (report.targetType === 'ARTICLE') {
      const article = await tx.article.findUnique({
        where: { id: report.targetId },
        select: { deletedAt: true },
      });
      articleId = report.targetId;

      // 软删幂等：目标本就不在（作者已删）→ 跳过，不报错卡住管理员。
      if (deleteTarget && article && article.deletedAt === null) {
        await tx.article.update({
          where: { id: report.targetId },
          data: { deletedAt: now },
        });
        targetDeleted = true;
      }
    } else {
      const comment = await tx.comment.findUnique({
        where: { id: report.targetId },
        select: { deletedAt: true, articleId: true },
      });
      articleId = comment ? comment.articleId : null;

      if (deleteTarget && comment && comment.deletedAt === null) {
        await tx.comment.update({
          where: { id: report.targetId },
          data: { deletedAt: now },
        });
        // 级联软删子评论（对齐用户侧 deleteComment：两层硬限制下 parentId 直接
        // 指向本评论，一条 updateMany 覆盖子树；deletedAt:null 条件防重复置时间戳）。
        await tx.comment.updateMany({
          where: { parentId: report.targetId, deletedAt: null },
          data: { deletedAt: now },
        });
        targetDeleted = true;
      }
    }

    let resolvedCount = 0;
    let notifiedReporterIds = [];

    if (status === 'RESOLVED') {
      const pending = await tx.report.findMany({
        where: { targetType: report.targetType, targetId: report.targetId, status: 'PENDING' },
        select: { id: true, reporterId: true },
      });

      if (pending.length) {
        const updated = await tx.report.updateMany({
          where: { id: { in: pending.map((p) => p.id) }, status: 'PENDING' },
          data: { status: 'RESOLVED', resolvedAt: now },
        });
        resolvedCount = updated.count;
        notifiedReporterIds = pending.map((p) => p.reporterId);
      }
    } else {
      await tx.report.update({
        where: { id: reportId },
        data: { status: 'REJECTED', resolvedAt: now },
      });
      resolvedCount = 1;
      notifiedReporterIds = [report.reporterId];
    }

    return { targetType: report.targetType, targetId: report.targetId, articleId, targetDeleted, resolvedCount, notifiedReporterIds };
  });

  // —— 事务已提交，以下通知失败绝不影响响应 ——

  const notifyType = status === 'RESOLVED' ? 'REPORT_RESOLVED' : 'REPORT_REJECTED';

  for (const reporterId of result.notifiedReporterIds) {
    try {
      await notifyOnReportResult({
        reporterId,
        resolverId,
        type: notifyType,
        articleId: result.articleId,
      });
    } catch (notifyError) {
      console.error(`[notify] 举报结果通知失败（reporterId=${reporterId}，继续处理其余举报人）:`, notifyError.message);
    }
  }

  return {
    id: reportId,
    status,
    resolvedAt: now,
    resolvedCount: result.resolvedCount,
    targetDeleted: result.targetDeleted,
  };
}
