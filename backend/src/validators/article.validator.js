import { z } from 'zod';
import { CODE, httpError } from '../utils/response.js';

// docs/API.md 的 POST / PUT /api/articles：
// title 1–100 字符（trim 后不能为空），content 1–20000 字符（不 trim，空白是有意义的正文）。
// 用 refine 而不是 min：refine 一定在 trim 之后执行，不依赖 zod 对「transform 与校验顺序」的实现细节。
const titleSchema = z
  .string()
  .trim()
  .refine((value) => value.length > 0, '不能为空')
  .refine((value) => value.length <= 100, '不能超过 100 个字符');

// 正文不 trim：Markdown 的缩进与空行是有意义的，trim 会破坏内容。
const contentSchema = z
  .string()
  .min(1, '不能为空')
  .max(20000, '不能超过 20000 个字符');

// 分类白名单（与 docs/API.md / DB.md 一致）。后端唯一真相；前端写死同样 4 个字符串，不做常量共享。
// 枚举保证库里永远不会出现拼写不一致的值（非法值直接 400 / 40000）。
export const ARTICLE_CATEGORIES = ['技术', '生活', '随笔', '未分类'];

// 第 6 批：发布状态枚举。DRAFT = 仅作者草稿箱可见；PUBLISHED = 公开。
export const ARTICLE_STATUSES = ['DRAFT', 'PUBLISHED'];

/* ---------- 第 7 批：标签 ---------- */

// 标签名上限（docs/API.md：trim 后 1–20 字符）与每篇标签数上限（≤5）。
// 后端唯一真相；前端写死同样两个数字，不做常量共享（同 ARTICLE_CATEGORIES 的先例）。
export const TAG_NAME_MAX_LENGTH = 20;
export const ARTICLE_TAGS_MAX = 5;

// 单个标签名：trim 后非空、≤20 字符。trim 在 zod 层完成（「 Vue 」入库为「Vue」）。
// 大小写不敏感是 DB 层行为：tags.name 列为 utf8mb4_unicode_ci，「Vue」与「vue」
// 在唯一约束判重、upsert 复用、?tag= 筛选时都是同一个标签（2026-10-18 探针实测确认）。
const tagNameSchema = z
  .string()
  .trim()
  .refine((value) => value.length > 0, '不能为空')
  .refine((value) => value.length <= TAG_NAME_MAX_LENGTH, `不能超过 ${TAG_NAME_MAX_LENGTH} 个字符`);

// 标签数组：每篇最多 5 个；整组校验，任一非法整体 400 / 40000（不做静默截断/过滤）。
export const tagsSchema = z
  .array(tagNameSchema)
  .max(ARTICLE_TAGS_MAX, `每篇文章最多 ${ARTICLE_TAGS_MAX} 个标签`);

export const createArticleSchema = z.object({
  title: titleSchema,
  content: contentSchema,
  // 可选；省略时由 .default 补成 '未分类'（与 DB 默认值一致）。
  category: z.enum(ARTICLE_CATEGORIES).optional().default('未分类'),
  // 第 6 批：省略或传 PUBLISHED 都是发布；传 DRAFT 创建草稿（仅作者草稿箱可见）。
  status: z.enum(ARTICLE_STATUSES).optional().default('PUBLISHED'),
  // 第 7 批：省略 = 空数组（新文章无标签）。
  tags: tagsSchema.optional().default([]),
});

// PUT 是全量更新，title 与 content 都必填，校验规则与创建一致。
export const updateArticleSchema = z.object({
  title: titleSchema,
  content: contentSchema,
  // 可选且**无 default**：不传 = 保留库中原有值（service 层据此跳过该字段）。
  category: z.enum(ARTICLE_CATEGORIES).optional(),
  // 第 6 批：省略 = 保留原 status；传 DRAFT/PUBLISHED 显式切换。
  status: z.enum(ARTICLE_STATUSES).optional(),
  // 第 7 批三态（与 category 一致）：不传 = 保留原关联；传（含 []）= 全量替换。
  tags: tagsSchema.optional(),
});

// 第 6 批：自动保存草稿请求体。
//
// title / content 都**可选且允许空串**：
//   - 更新草稿时允许把标题/正文清空（草稿就是「可半完成」的载体）；
//   - 新建草稿时若二者都接近空，由 service 的「建草稿门槛」拦截（不创建、返回 IDLE）。
// draftId：已有草稿 id，传了就走「更新分支」（越权校验 404）；不传走「新建分支」。
// sourceArticleId：编辑已发布文章时的来源文章 id，**仅作归属校验、不落库**（补丁 1 独立草稿隔离）。
//
// 不在这里做「建草稿门槛」判断（那是业务阈值，不是字段格式），只做字段格式与正整数校验。
export const autoSaveSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  category: z.enum(ARTICLE_CATEGORIES).optional(),
  // 第 7 批三态同 PUT：不传 = 不动草稿已有标签；传了 = 全量替换。
  tags: tagsSchema.optional(),
  draftId: z.coerce.number().int('必须是整数').positive('必须是正整数').optional(),
  sourceArticleId: z.coerce.number().int('必须是整数').positive('必须是正整数').optional(),
});

// 第 6 批：回滚到指定版本。revisionId 必填且必须为该文章的版本 id（归属校验在 service 层）。
export const restoreSchema = z.object({
  revisionId: z.coerce.number().int('必须是整数').positive('必须是正整数'),
});

// 路径参数在 Express 里是字符串，统一 coerce 成正整数。
export const articleIdParamSchema = z.object({
  id: z.coerce
    .number()
    .int('必须是整数')
    .positive('必须是正整数'),
});

/* ---------- 列表 keyword（搜索） ---------- */

// docs/API.md：GET /api/articles 的 keyword，trim 后最长 50 字符。
export const KEYWORD_MAX_LENGTH = 50;

/**
 * 解析列表查询里的 keyword。
 *
 * 为什么不走 validate({ query }) 中间件：现有查询参数（page / pageSize / sortBy / order）
 * 全部由 utils/pagination.js 的 parsePagination 在 service 层解析，且已处理「重复传值」「空串」
 * 「order 大小写」等 Express query 的脏输入。keyword 与它们同源同层，沿用同一套处理方式，
 * 不引入第二种查询参数解析风格。
 *
 * 语义（与 docs/API.md 一致）：
 * - **空串 / 纯空白 = 视为不传**，返回 null（不报错）。前端清空搜索框时会发空串。
 * - **超长报错**：trim 后超过 50 字符抛 400 / 40000。
 * - **重复传值报错**：与 parsePagination 的 PAGINATION_KEYS 口径一致，避免 `?keyword=a&keyword=b`
 *   被静默取第一个。
 * - 不传 / undefined 返回 null。
 *
 * @param {object} query Express 的 req.query
 * @returns {string|null} 规范化后的 keyword，未传或为空则 null
 * @throws {Error} 400 / 40000（超长或重复传值）
 */
export function parseKeyword(query) {
  const source = query && typeof query === 'object' ? query : {};
  const value = source.keyword;

  if (value === undefined || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    throw httpError(400, CODE.PARAM_ERROR, 'keyword 不允许重复传值');
  }

  if (typeof value !== 'string') {
    throw httpError(400, CODE.PARAM_ERROR, 'keyword 必须是字符串');
  }

  // 空串与纯空白都视为不传：前端清空搜索框时会发 keyword=
  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  if (trimmed.length > KEYWORD_MAX_LENGTH) {
    throw httpError(400, CODE.PARAM_ERROR, `keyword 最多 ${KEYWORD_MAX_LENGTH} 个字符`);
  }

  return trimmed;
}

/* ---------- 列表 category（分类筛选） ---------- */

// 与 parseKeyword 同源同层：由 service 层的 listArticles 调用，不引入第二种查询参数解析风格。
// 语义（与 docs/API.md 一致）：
// - 不传 / 空串 / 纯空白 = 视为不传，返回 null（不过滤）。
// - 重复传值 / 非字符串 / 非法枚举值 = 抛 400 / 40000（与 sortBy 报错风格一致）。
// - 合法枚举值（技术 / 生活 / 随笔 / 未分类）= 精确相等筛选。
// - 与 keyword 正交：调用方把结果作为 AND 条件叠加到关键词 OR 条件上。
//
// @param {object} query Express 的 req.query
// @returns {string|null} 规范化后的 category，未传或为空则 null
// @throws {Error} 400 / 40000（重复传值 / 非法值）
export function parseCategory(query) {
  const source = query && typeof query === 'object' ? query : {};
  const value = source.category;

  if (value === undefined || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    throw httpError(400, CODE.PARAM_ERROR, 'category 不允许重复传值');
  }

  if (typeof value !== 'string') {
    throw httpError(400, CODE.PARAM_ERROR, 'category 必须是字符串');
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  if (!ARTICLE_CATEGORIES.includes(trimmed)) {
    throw httpError(400, CODE.PARAM_ERROR, `category 只能是 ${ARTICLE_CATEGORIES.join(' / ')} 之一`);
  }

  return trimmed;
}

/* ---------- 列表 tag（标签筛选，第 7 批） ---------- */

// 与 parseCategory 同款同层：由 service 层的 listArticles 调用。
// 语义（与 docs/API.md 一致）：
// - 不传 / 空串 / 纯空白 = 视为不传，返回 null（不过滤）。
// - 重复传值 / 非字符串 = 抛 400 / 40000。
// - trim 后超 20 字符（与创建侧 TAG_NAME_MAX_LENGTH 同一口径）= 400 / 40000。
// - 合法值 = 精确标签名匹配（大小写不敏感：tags.name 列为 ci 排序规则，与创建侧同行为）。
// - 标签不存在是合法筛选结果（空列表），这里只做**格式**校验，不做存在性校验。
//
// @param {object} query Express 的 req.query
// @returns {string|null} 规范化后的标签名，未传或为空则 null
// @throws {Error} 400 / 40000（重复传值 / 非字符串 / 超长）
export function parseTag(query) {
  const source = query && typeof query === 'object' ? query : {};
  const value = source.tag;

  if (value === undefined || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    throw httpError(400, CODE.PARAM_ERROR, 'tag 不允许重复传值');
  }

  if (typeof value !== 'string') {
    throw httpError(400, CODE.PARAM_ERROR, 'tag 必须是字符串');
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  if (trimmed.length > TAG_NAME_MAX_LENGTH) {
    throw httpError(400, CODE.PARAM_ERROR, `tag 最多 ${TAG_NAME_MAX_LENGTH} 个字符`);
  }

  return trimmed;
}
