import { z } from 'zod';
import { CODE, httpError } from './response.js';

// 契约第 7 节：page 默认 1，pageSize 默认 10 且最大 100，order 只能 asc / desc。
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_ORDER = 'desc';
export const DEFAULT_SORT_BY = 'createdAt';
export const ORDERS = ['asc', 'desc'];

const PAGINATION_KEYS = ['page', 'pageSize', 'sortBy', 'order'];

function badParam(message) {
  throw httpError(400, CODE.PARAM_ERROR, message);
}

// 只取分页相关的四个键，空字符串视为没传（走默认值）。
// 字符串统一 trim；order 额外容错大小写，归一化为小写后再交给 schema 判断。
function pickRaw(query) {
  const source = query && typeof query === 'object' ? query : {};
  const raw = {};

  for (const key of PAGINATION_KEYS) {
    const value = source[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      badParam(`${key} 不允许重复传值`);
    }

    const trimmed = typeof value === 'string' ? value.trim() : value;

    if (trimmed === '') {
      continue;
    }

    raw[key] = key === 'order' && typeof trimmed === 'string' ? trimmed.toLowerCase() : trimmed;
  }

  return raw;
}

function assertAllowedSort(allowedSort) {
  if (!Array.isArray(allowedSort) || allowedSort.length === 0) {
    throw httpError(500, CODE.SERVER_ERROR, 'pagination 配置错误：必须提供 sortBy 白名单数组');
  }
}

/**
 * 解析并校验分页参数。
 *
 * @param {object} query Express 的 req.query
 * @param {object} options
 * @param {string[]} options.allowedSort 允许排序的字段白名单（API 层的字段名，如 createdAt）
 * @param {string} [options.defaultSort] 未传 sortBy 时的默认值
 * @param {number} [options.maxPageSize] pageSize 上限，默认 MAX_PAGE_SIZE
 * @returns {{ page: number, pageSize: number, skip: number, take: number, sortBy: string, order: string }}
 */
export function parsePagination(query, options = {}) {
  assertAllowedSort(options.allowedSort);

  const maxPageSize = options.maxPageSize || MAX_PAGE_SIZE;
  const raw = pickRaw(query);

  const schema = z.object({
    page: z.coerce
      .number({ message: '必须是数字' })
      .int({ message: '必须是整数' })
      .min(DEFAULT_PAGE, { message: `不能小于 ${DEFAULT_PAGE}` })
      .default(DEFAULT_PAGE),
    pageSize: z.coerce
      .number({ message: '必须是数字' })
      .int({ message: '必须是整数' })
      .min(1, { message: '不能小于 1' })
      .max(maxPageSize, { message: `不能大于 ${maxPageSize}` })
      .default(DEFAULT_PAGE_SIZE),
    order: z
      .enum(ORDERS, { message: `只能是 ${ORDERS.join(' 或 ')}` })
      .default(DEFAULT_ORDER),
    sortBy: z.string().optional(),
  });

  const result = schema.safeParse(raw);

  if (!result.success) {
    const issue = result.error.issues[0];

    badParam(`${issue.path.join('.') || '参数'} ${issue.message}`);
  }

  const { page, pageSize, order } = result.data;
  const allowedSort = options.allowedSort;

  let sortBy = result.data.sortBy;

  if (sortBy === undefined) {
    sortBy = options.defaultSort || DEFAULT_SORT_BY;
  }

  if (!allowedSort.includes(sortBy)) {
    badParam(`sortBy 不合法，可选值：${allowedSort.join(', ')}`);
  }

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
    sortBy,
    order,
  };
}

/**
 * 生成契约第 7 节的响应 data 里的分页部分（不含 list，由业务自行塞入）。
 *
 * @param {number} page
 * @param {number} pageSize
 * @param {number} total
 * @returns {{ page: number, pageSize: number, total: number, totalPages: number }}
 */
export function buildPaginationMeta(page, pageSize, total) {
  const count = Number(total) || 0;

  return {
    page,
    pageSize,
    total: count,
    totalPages: pageSize > 0 ? Math.ceil(count / pageSize) : 0,
  };
}
