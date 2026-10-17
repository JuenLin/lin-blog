<template>
  <!-- 入口：整张卡可点进 /user/:id。组件在详情页里、外层没有 router-link，
       所以这里用 span + role/tabindex 手写可点语义，不用 <a> 也不用 router-link。 -->
  <span
    class="author-card"
    role="link"
    tabindex="0"
    @click="goToProfile"
    @keydown.enter="goToProfile"
  >
    <span class="author-card-head">
      <!-- 头像两种形态（第九批）：有 avatar 外链渲染 <img>，否则回退色块 + 首字。
           用 v-if 分支而不是只写 :src —— avatar 为 null 或键不存在时会破图。 -->
      <img
        v-if="avatarInfo.type === 'image' && !avatarBroken"
        class="author-avatar-img"
        :src="avatarInfo.src"
        :alt="displayName"
        @error="avatarBroken = true"
      />
      <span v-else class="author-avatar" :style="{ backgroundColor: avatarInfo.color }">{{ avatarInfo.text }}</span>

      <span class="author-meta">
        <span class="author-name">
          {{ displayName }}
          <!-- 第 5 批：管理员徽章。role 由 author.role 透出（AUTHOR_SELECT 已加）。 -->
          <UserBadge :role="author.role" />
        </span>
        <span class="author-username">@{{ author.username }}</span>
      </span>
    </span>
  </span>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { resolveAvatar } from '../utils/format.js';
import UserBadge from './UserBadge.vue';

const props = defineProps({
  author: {
    type: Object,
    required: true,
  },
});

const router = useRouter();

const displayName = computed(() => props.author.nickname || props.author.username || '匿名');

// 头像形态（第九批）。resolveAvatar 用 truthy 检查，avatar 键不存在时自然回退文字头像。
// text 分支返回 { text, color }，image 分支返回 { src }。
const avatarInfo = computed(() => {
  const info = resolveAvatar(props.author, displayName.value);

  if (info.type === 'image') {
    return info;
  }

  return { type: 'text', text: info.text, color: info.color };
});

// 外链加载失败回退色块（服务端不保证 URL 可达，见 docs/API.md）。
const avatarBroken = ref(false);

watch(
  () => props.author.avatar,
  () => {
    avatarBroken.value = false;
  },
);

function goToProfile() {
  const id = props.author && props.author.id;
  if (id == null) return;
  router.push({ name: 'user-profile', params: { id } });
}
</script>

<style scoped>
.author-card {
  display: block; /* 外层是 span（为了不与详情页里其他块级元素产生非法嵌套），补回原 div 的块级性 */
  padding: 16px 18px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-panel);
  cursor: pointer;
  transition:
    border-color var(--transition-base),
    box-shadow var(--transition-base);
}

.author-card:hover,
.author-card:focus-visible {
  border-color: rgba(var(--brand-rgb), 0.32);
  box-shadow: 0 4px 14px rgba(var(--brand-rgb), 0.1);
  outline: none;
}

.author-card-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.author-meta {
  display: block; /* 同上：span 需显式块级 */
}

.author-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-brand);
  font-size: 18px;
  font-weight: 600;
}

/* 图片头像（第九批）：与色块同尺寸，object-fit: cover 防变形 */
.author-avatar-img {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  flex-shrink: 0;
}

.author-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-strong);
}

/* 徽章与名字同一行：名字是 span，徽章（el-tag）垂直居中贴合。 */
.author-name :deep(.user-badge) {
  margin-left: 6px;
  vertical-align: middle;
}

.author-username {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
