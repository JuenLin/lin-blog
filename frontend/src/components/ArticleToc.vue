<template>
  <!-- 文章目录（第 5 批）。el-anchor 是 element-plus 自带组件（2.14.6 已装），
       零新增依赖。标题从 Markdown 原文提取（utils/markdown.js 的 extractHeadings），
       与 ArticleContent 渲染后补的标题 id 同源同序——el-anchor 靠 id 定位。 -->
  <nav v-if="headings.length >= 2" class="article-toc" aria-label="文章目录">
    <div class="article-toc-title">目录</div>
    <el-anchor :offset="80" class="article-toc-anchor">
      <el-anchor-link
        v-for="item in headings"
        :key="item.id"
        :href="`#${item.id}`"
        :title="item.text"
        :class="`article-toc-level-${item.level}`"
      />
    </el-anchor>
  </nav>
</template>

<script setup>
import { computed } from 'vue';
import { extractHeadings } from '../utils/markdown.js';

const props = defineProps({
  content: {
    type: String,
    default: '',
  },
});

// 少于 2 个标题不显示目录：一个标题的目录没有导航价值，
// 只会占地方（探针对此有「无标题文章不渲染目录」的负向断言空间）。
const headings = computed(() => extractHeadings(props.content));
</script>

<style scoped>
/* 右侧悬浮：只在大屏出现，小屏（正文都挤）时隐藏，不抢布局。 */
.article-toc {
  position: fixed;
  top: 96px;
  right: 24px;
  width: 200px;
  max-height: calc(100vh - 140px);
  overflow-y: auto;
  padding: 14px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-panel);
}

.article-toc-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-strong);
  margin-bottom: 8px;
}

/* 层级缩进：h1 顶格，h2/h3 递进。el-anchor-link 默认样式较重，这里压平。 */
.article-toc :deep(.el-anchor) {
  background: transparent;
}

.article-toc :deep(.el-anchor__item) {
  border-left: none;
}

.article-toc :deep(.el-anchor__link) {
  font-size: 13px;
  color: var(--text-regular);
  padding: 3px 0 3px 10px;
  line-height: 1.5;
}

.article-toc :deep(.el-anchor__link.is-active) {
  color: var(--chip-text);
  font-weight: 600;
}

.article-toc-level-2 :deep(.el-anchor__link) {
  padding-left: 20px;
}

.article-toc-level-3 :deep(.el-anchor__link) {
  padding-left: 30px;
}

@media (max-width: 1200px) {
  .article-toc {
    display: none;
  }
}
</style>
