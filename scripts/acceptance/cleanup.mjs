/**
 * 单独清理一次验收留下的临时数据（给「脚本被中断」这种意外兜底）。
 *   node scripts/acceptance/cleanup.mjs
 *
 * 清理范围只限于脚本自己造的东西：
 *   - 清单里记录的 id（scripts/acceptance 运行时落在系统临时目录）
 *   - 标题包含「验收占位」的文章及其评论
 *   - 内容为脚本标记的评论
 * 用户的文章一行不动。
 */
import { cleanupKnownArtifacts } from './lib/fixtures.mjs';

const r = await cleanupKnownArtifacts();
if (r.cleaned) {
  console.log(`已清理临时文章 ${r.count} 篇`);
  console.log(`当前库：users=${r.final.users} 文章(总/可见)=${r.final.totalArticles}/${r.final.visibleArticles} 评论=${r.final.totalComments}`);
} else {
  console.log('没有需要清理的临时数据');
}
