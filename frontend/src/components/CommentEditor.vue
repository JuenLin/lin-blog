<template>
  <div class="comment-editor">
    <template v-if="userStore.isLogin">
      <el-input
        v-model="content"
        type="textarea"
        :rows="3"
        maxlength="500"
        show-word-limit
        placeholder="写下你的评论（1–500 字）"
      />

      <div class="comment-editor-foot">
        <el-button type="primary" :loading="submitting" @click="handleSubmit">发表评论</el-button>
      </div>
    </template>

    <el-alert
      v-else
      type="info"
      :closable="false"
      show-icon
      title="登录后才能发表评论"
    >
      <template #default>
        <el-button link type="primary" @click="goLogin">去登录</el-button>
      </template>
    </el-alert>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { createComment } from '../api/comment.js';
import { useUserStore } from '../stores/user.js';

const props = defineProps({
  articleId: {
    type: Number,
    required: true,
  },
});

const emit = defineEmits(['created']);

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

const content = ref('');
const submitting = ref(false);

// 未登录点评论，提示并带 redirect 跳登录，登录后会回到当前文章。
function goLogin() {
  router.push({ name: 'login', query: { redirect: route.fullPath } });
}

// 表单必须有基本校验（契约第 10 节）：非空 + 长度上限，后端还会再校验一次。
async function handleSubmit() {
  const text = content.value.trim();

  if (!text) {
    ElMessage.warning('评论内容不能为空');
    return;
  }

  if (text.length > 500) {
    ElMessage.warning('评论最多 500 个字');
    return;
  }

  submitting.value = true;

  try {
    await createComment({ articleId: props.articleId, content: text });

    content.value = '';
    ElMessage.success('评论已发表');
    emit('created');
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.comment-editor {
  text-align: left;
}

.comment-editor-foot {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
</style>
