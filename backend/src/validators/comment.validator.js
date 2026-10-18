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
  // 第 7 批：回复目标。省略 = 顶层评论；传了 = 回复该评论（存在性 / 同文章 /
  // 两层硬限制由 service 层校验链处理，这里只做格式校验）。
  parentId: z.coerce
    .number()
    .int('必须是整数')
    .positive('必须是正整数')
    .optional(),
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
