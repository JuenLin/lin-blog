<template>
  <div class="author-card">
    <div class="author-card-head">
      <span class="author-avatar" :style="{ backgroundColor: avatarColor }">{{ avatarText }}</span>

      <div class="author-meta">
        <div class="author-name">{{ displayName }}</div>
        <div class="author-username">@{{ author.username }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { getAvatarColor, getAvatarText } from '../utils/format.js';

const props = defineProps({
  author: {
    type: Object,
    required: true,
  },
});

const displayName = computed(() => props.author.nickname || props.author.username || '匿名');
const avatarText = computed(() => getAvatarText(displayName.value));
const avatarColor = computed(() => getAvatarColor(displayName.value));
</script>

<style scoped>
.author-card {
  padding: 16px 18px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-panel);
}

.author-card-head {
  display: flex;
  align-items: center;
  gap: 12px;
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
