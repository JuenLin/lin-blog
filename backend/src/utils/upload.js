import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 上传相关的**常量**，纯数据、无副作用，供 app.js（挂静态目录）、
 * validators（校验 avatar 前缀）、services（落盘 / 删除）三处共用。
 *
 * 之所以单独拆一个文件而不是各处各写一份：`UPLOAD_DIR` 的推算逻辑
 * （按 __dirname 而不是 process.cwd()）若复制三遍，迟早有一处写成相对路径，
 * 然后「本地能跑、部署后 404」——这类 bug 极难定位，不值得省一个文件。
 */

// src/utils/upload.js → ../../ = backend/，故 UPLOAD_DIR = backend/uploads。
// 按文件位置推算而非 process.cwd()：从仓库根执行 `node backend/src/server.js` 时
// cwd 会变，只有 __dirname 稳定。
export const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');

/** uploads 下的一级子目录名：backend/uploads/avatars/{userId}/ */
export const AVATAR_SUBDIR = 'avatars';

/**
 * 第 10 批：文章配图子目录名：backend/uploads/articles/{userId}/ 。
 * 与 avatars 拆两个一级目录：头像与文章图的生命周期不同（头像随用户、文章图随文章），
 * 分开后将来做孤儿文件清理（ROADMAP 插队候选）可按目录定位，不用按路径前缀猜。
 */
export const ARTICLE_SUBDIR = 'articles';

/**
 * 存进 users.avatar 的**站内相对路径前缀**，也是 URL 前缀（静态目录就挂在 /uploads）。
 * 两者同值不是巧合：DB 存的就是可直接拼进 <img src> 的相对 URL。
 */
export const AVATAR_URL_PREFIX = '/uploads/';

/** multipart 里头像文件的字段名，前后端必须一致 */
export const AVATAR_FIELD = 'avatar';

/** 第 10 批：multipart 里文章配图文件的字段名，前后端必须一致 */
export const ARTICLE_FIELD = 'image';

/** 单文件大小上限：2 MB */
export const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

/**
 * mimetype 白名单。**不含 SVG** —— SVG 可内嵌 <script>，同源渲染下有 XSS 面。
 * 也不含 image/gif：动图头像在 MVP 无收益，且 GIF 体积容易失控。
 */
export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * mimetype → 扩展名的**服务端映射表**。
 *
 * 扩展名只能来自这张表，绝不能来自 file.originalname：后者完全由客户端控制，
 * 可以构造 `../../x.html` 做路径穿越，或伪装扩展名。这里只认三种 mimetype，
 * 映射结果也只有三个固定值，没有注入面。
 */
export const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
