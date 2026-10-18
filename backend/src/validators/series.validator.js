import { z } from 'zod';

// docs/API.md「文章图片上传与专栏系列（第 10 批）」的 series 接口校验。
// 系列标题 1–50 字符（trim 后非空），描述 ≤200 字符、可空（null = 清空）。
// 序号（seriesOrder）不在本文件校验——它是文章侧的字段（article.validator.js），
// 同系列唯一与自动分配都在 series / article service 层。

// 标题：trim 后非空、≤50 字符。refine 而不是 min：保证 trim 之后再判长度
// （与 article.validator.js 的 titleSchema 同一纪律，纯空格标题过不了）。
const titleSchema = z
  .string()
  .trim()
  .refine((value) => value.length > 0, '不能为空')
  .refine((value) => value.length <= 50, '不能超过 50 个字符');

// 描述：可空。PUT 传 null = 清空描述；省略 = 保留原值（三态，service 层判 undefined）。
const descriptionSchema = z
  .string()
  .trim()
  .max(200, '不能超过 200 个字符')
  .nullable()
  .optional();

export const createSeriesSchema = z.object({
  title: titleSchema,
  // 省略或 null → 存 NULL（空描述不如没有描述，见 service 的归一）。
  description: descriptionSchema,
});

export const updateSeriesSchema = z.object({
  // 部分更新：不传 = 保留原值。
  title: titleSchema.optional(),
  description: descriptionSchema,
});

// 路径参数在 Express 里是字符串，统一 coerce 成正整数（同 articleIdParamSchema）。
export const seriesIdParamSchema = z.object({
  id: z.coerce
    .number()
    .int('必须是整数')
    .positive('必须是正整数'),
});
