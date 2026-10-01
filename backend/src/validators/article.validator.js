import { z } from 'zod';

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
