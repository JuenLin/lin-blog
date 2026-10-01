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
 * @param {{ sortBy: string, order: string }} pagination parsePagination() 的返回值
 * @param {object} [options]
 * @param {string|null} [options.secondary] 次级排序字段，默认 DEFAULT_SECONDARY_SORT；传 null 关闭
 * @returns {Array<Record<string, string>>}
 */
export function buildOrderBy(pagination, options = {}) {
  const { sortBy = DEFAULT_SORT_BY, order = DEFAULT_ORDER } = pagination || {};
  const secondary = options.secondary === undefined ? DEFAULT_SECONDARY_SORT : options.secondary;
  const orderBy = [{ [sortBy]: order }];

  // 主排序已经是该字段时不必重复。
  if (!secondary || secondary === sortBy) {
    return orderBy;
  }

  return [...orderBy, { [secondary]: order }];
}
