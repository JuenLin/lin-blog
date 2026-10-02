<template>
  <div class="article-content">{{ content }}</div>
</template>

<script setup>
// 正文按纯文本展示：本期不引入 Markdown 渲染依赖（契约第 2 节锁定技术栈，
// 不擅自加包），用 white-space: pre-wrap 保留换行与空格，Markdown 标记原样显示。
defineProps({
  content: {
    type: String,
    default: '',
  },
});
</script>

<style scoped>
.article-content {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 16px;
  line-height: 1.8;
  color: #303133;
  text-align: left;
}
</style>
