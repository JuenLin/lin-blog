<template>
  <div class="comment-editor">
    <template v-if="userStore.isLogin">
      <el-input
        ref="editorInput"
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
import { nextTick, ref } from 'vue';
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

// 主评论输入框 ref。虽然这里不在 v-for 里（不会变数组），仍按 CommentList.startReply
// 同款做「数组归一化 + 类型守卫」，养成习惯：将来谁把输入框挪进循环不至于静默丢焦点。
const editorInput = ref(null);

// 聚焦主评论输入框：归一化取实例 → 调 focus() → 把 textarea 滚进可视区。
// 用于「空内容校验失败后光标不丢」：提示归提示，光标必须留在输入框，省得用户再点一次。
function focusEditor() {
  nextTick(() => {
    const raw = editorInput.value;
    const input = Array.isArray(raw) ? raw[0] : raw;
    if (!input || typeof input.focus !== 'function') return;
    input.focus();
    const textarea = input.textarea;
    if (textarea && typeof textarea.scrollIntoView === 'function') {
      textarea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

// 未登录点评论，提示并带 redirect 跳登录，登录后会回到当前文章。
function goLogin() {
  router.push({ name: 'login', query: { redirect: route.fullPath } });
}

// 表单必须有基本校验（契约第 10 节）：非空 + 长度上限，后端还会再校验一次。
async function handleSubmit() {
  const text = content.value.trim();

  if (!text) {
    ElMessage.warning('评论内容不能为空');
    // 空内容：提示后光标不能丢，立刻聚焦回主输入框（体验优化）。
    focusEditor();
    return;
  }

  if (text.length > 500) {
    ElMessage.warning('评论最多 500 个字');
    focusEditor();
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
