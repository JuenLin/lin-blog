import { z } from 'zod';

// PUT /api/notifications/read 请求体。ids 可空：不传 / 空数组都表示「全部已读」。
// 越权 id（不属于自己）由 service 层过滤，这里只约束形状。
export const markReadSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .optional(),
});

// PUT /api/notifications/:id/read 路径参数。id 来自 URL，用 coerce 转数字。
export const notificationIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
