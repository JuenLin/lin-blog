<template>
  <!-- 第 5 批：改 v-html 渲染 Markdown（marked + DOMPurify 特批依赖）。
       渲染管线：marked.parse → DOMPurify.sanitize → v-html；挂载后补标题 id
       （ArticleToc 的 el-anchor 定位用）并跑 highlight.js 高亮。
       旧版是纯文本 pre-wrap（Markdown 标记原样显示），已废弃。 -->
  <div ref="rootRef" class="article-content" v-html="html"></div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { decorateRenderedContent, renderMarkdown } from '../utils/markdown.js';

const props = defineProps({
  content: {
    type: String,
    default: '',
  },
});

const rootRef = ref(null);

// sanitize 在 renderMarkdown 内部完成（marked 不转义 HTML，v-html 前必须净化）。
const html = computed(() => renderMarkdown(props.content));

// 渲染后补两样 marked 不给的东西：标题 id 与代码高亮。
// 换文章（content 变）时重跑——路由复用同组件，watch 是必须的。
async function decorate() {
  await nextTick();
  decorateRenderedContent(rootRef.value, props.content);
}

onMounted(decorate);
watch(() => props.content, decorate);
</script>

<style scoped>
/* 代码块微调：圆角与内边距归一到项目令牌，背景与文字色交给
   hljs 主题（github / github-dark 双主题，utils/hljsTheme.js 切换）。 */
.article-content :deep(pre) {
  border-radius: var(--radius-panel);
  padding: 14px 16px;
  overflow-x: auto;
  font-size: 14px;
  line-height: 1.6;
}

.article-content :deep(pre code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* 暗色下 hljs 主题自带的背景已就位，这里只补段落与标题的间距，
   不碰 .hljs 的颜色（那是主题的地盘）。 */
.article-content :deep(h1),
.article-content :deep(h2),
.article-content :deep(h3) {
  margin: 1.4em 0 0.6em;
  color: var(--text-strong);
  line-height: 1.4;
  scroll-margin-top: 80px;
}

.article-content :deep(h1) {
  font-size: 22px;
}

.article-content :deep(h2) {
  font-size: 19px;
}

.article-content :deep(h3) {
  font-size: 17px;
}

.article-content :deep(p) {
  margin: 0.8em 0;
}

.article-content :deep(ul),
.article-content :deep(ol) {
  padding-left: 1.4em;
  margin: 0.8em 0;
}

.article-content :deep(blockquote) {
  margin: 0.8em 0;
  padding: 4px 14px;
  border-left: 3px solid var(--chip-border);
  background: var(--bg-subtle);
  border-radius: 0 var(--radius-panel) var(--radius-panel) 0;
  color: var(--text-regular);
}

.article-content :deep(a) {
  color: var(--chip-text);
}

.article-content :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-panel);
}

.article-content :deep(table) {
  border-collapse: collapse;
  margin: 0.8em 0;
}

.article-content :deep(th),
.article-content :deep(td) {
  border: 1px solid var(--border-light);
  padding: 6px 12px;
}
</style>
