import { z } from 'zod';
import { articleIdParamSchema } from './article.validator.js';

// docs/API.md 的 POST /api/comments：
// articleId 正整数，content 1–500 字符（trim，不能为纯空格）。
// 复用 article.validator.js 的路径参数 schema，保证「文章 id」只有一处定义。
export const createCommentSchema = z.object({
  articleId: z.coerce
    .number()
    .int('必须是整数')
    .positive('必须是正整数'),
  content: z
    .string()
    .trim()
    .refine((value) => value.length > 0, '不能为空')
    .refine((value) => value.length <= 500, '不能超过 500 个字符'),
});

// 路径参数在 Express 里是字符串，统一 coerce 成正整数（与 articleIdParamSchema 同构）。
// docs/API.md 的 DELETE /api/comments/:id：id 非法返回 40000。
export const commentIdParamSchema = z.object({
  id: z.coerce
    .number()
    .int('必须是整数')
    .positive('必须是正整数'),
});

export { articleIdParamSchema };
