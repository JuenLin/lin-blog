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

export const createArticleSchema = z.object({
  title: titleSchema,
  content: contentSchema,
});

// PUT 是全量更新，title 与 content 都必填，校验规则与创建一致。
export const updateArticleSchema = z.object({
  title: titleSchema,
  content: contentSchema,
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
