import { DEFAULT_SORT_BY, DEFAULT_ORDER } from './pagination.js';

// 契约第 9 节：默认软删除，查询必须过滤 deletedAt = null。
// 不采用 Prisma $extends 全局注入：那会对 $allModels 生效，
// 将来出现不需要软删除的表反而麻烦，且隐式过滤排查困难。
export function whereNotDeleted(where = {}) {
  return {
    ...where,
    deletedAt: null,
  };
}

// 次级排序字段：MySQL 对排序值相同的行不保证返回顺序稳定，
// 只有单一排序条件时，同一批数据在相邻两页可能重复出现或整行丢失。
// 这类问题本地通常复现不了，所以默认开启。
export const DEFAULT_SECONDARY_SORT = 'id';

/**
 * 把 parsePagination() 的返回值转成 Prisma 的 orderBy 数组。
 * 入参刻意设计为「parsePagination 的返回值整体」而不是散装的 sortBy / order，
 * 这样调用方无法绕过上游的字段白名单校验，因此这里不需要再做二次校验。
 *
 * ## options.map：API 字段名 → Prisma orderBy 片段
 *
 * 默认情况下 Prisma 字段名与 API 字段名同名，直接映射即可（`{ createdAt: 'desc' }`）。
 * 但**计算字段**没有对应的真实列 —— 典型的是文章的 `likeCount`：它是响应层由
 * `_count.likes` 折算出来的，Prisma 里要写成关联计数排序 `{ likes: { _count: order } }`。
 * 这类字段由调用方在 map 里给一个构造函数，**order 由本函数注入**：
 *
 *   buildOrderBy(pagination, { map: { likeCount: (order) => ({ likes: { _count: order } }) } })
 *
 * 为什么不把 `likeCount` 直接透传给 Prisma：Prisma 会报
 * `Unknown argument 'likeCount'`（它不是 Article 的字段）。所以这层翻译是必需的。
 * 不传 map、或 map 里没有该字段时，**行为与加 map 之前完全一致**。
 *
 * @param {{ sortBy: string, order: string }} pagination parsePagination() 的返回值
 * @param {object} [options]
 * @param {string|null} [options.secondary] 次级排序字段，默认 DEFAULT_SECONDARY_SORT；传 null 关闭
 * @param {Record<string, (order: string) => object>} [options.map] 计算字段的 orderBy 构造器
 * @returns {Array<Record<string, unknown>>}
 */
export function buildOrderBy(pagination, options = {}) {
  const { sortBy = DEFAULT_SORT_BY, order = DEFAULT_ORDER } = pagination || {};
  const secondary = options.secondary === undefined ? DEFAULT_SECONDARY_SORT : options.secondary;
  const map = options.map || {};

  // 单个字段 → orderBy 片段。map 里有构造器就用它（计算字段），否则同名直映射（真实列）。
  // 注意次级排序**必须用真实列**（id），所以它天然走 else 分支。
  const toOrderBy = (field) =>
    typeof map[field] === 'function' ? map[field](order) : { [field]: order };

  const orderBy = [toOrderBy(sortBy)];

  // 主排序已经是该字段时不必重复。
  if (!secondary || secondary === sortBy) {
    return orderBy;
  }

  return [...orderBy, toOrderBy(secondary)];
}
