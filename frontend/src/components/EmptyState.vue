<template>
  <el-empty :description="description" :image-size="80" />
</template>

<script setup>
// 列表为空时的统一占位：文章列表、评论列表共用。
defineProps({
  description: {
    type: String,
    default: '暂无数据',
  },
});
</script>

<style scoped>
/* 空状态本身不需要额外样式，占位容器由父级控制间距。 */
</style>
