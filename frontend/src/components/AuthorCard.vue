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
      <span class="author-avatar" :style="{ backgroundColor: avatarColor }">{{ avatarText }}</span>

      <span class="author-meta">
        <span class="author-name">{{ displayName }}</span>
        <span class="author-username">@{{ author.username }}</span>
      </span>
    </span>
  </span>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { getAvatarColor, getAvatarText } from '../utils/format.js';

const props = defineProps({
  author: {
    type: Object,
    required: true,
  },
});

const router = useRouter();

const displayName = computed(() => props.author.nickname || props.author.username || '匿名');
const avatarText = computed(() => getAvatarText(displayName.value));
const avatarColor = computed(() => getAvatarColor(displayName.value));

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

.author-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-strong);
}

.author-username {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
