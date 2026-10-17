<template>
  <!-- 管理员徽章（第 5 批）。role === 'ADMIN' 才渲染，普通用户什么都不显示。
       挂点：AuthorCard / UserProfile 头部 / CommentList 作者名旁 /
       管理后台用户表格。role 来自第 5 批透出的 author.role 与 public user。 -->
  <el-tag v-if="role === 'ADMIN'" type="warning" size="small" effect="dark" class="user-badge">管理员</el-tag>
</template>

<script setup>
defineProps({
  role: {
    type: String,
    default: '',
  },
});
</script>
