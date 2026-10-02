<template>
  <div class="article-card" @click="openDetail">
    <div class="article-card-head">
      <span class="article-avatar" :style="{ backgroundColor: avatarColor }">{{ avatarText }}</span>
      <span class="article-author">{{ authorName }}</span>
      <span class="article-time">{{ formatTime(article.createdAt) }}</span>
    </div>

    <h2 class="article-title">{{ article.title }}</h2>
    <p class="article-summary">{{ article.summary }}</p>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { formatTime, getAvatarColor, getAvatarText } from '../utils/format.js';

const props = defineProps({
  article: {
    type: Object,
    required: true,
  },
});

const router = useRouter();

const authorName = computed(() => {
  const author = props.article.author;

  if (!author) {
    return '匿名';
  }

  return author.nickname || author.username || '匿名';
});

const avatarText = computed(() => getAvatarText(authorName.value));
const avatarColor = computed(() => getAvatarColor(authorName.value));

function openDetail() {
  router.push({ name: 'article-detail', params: { id: props.article.id } });
}
</script>

<style scoped>
/* 优化第一批 A1 / A2：
 * A1 —— 从「横线分隔列表项」改成「白卡片 + 浅阴影」，hover 上浮 2px 并加深阴影；
 * A2 —— 卡片之间改用间距而非 border-bottom，列表最后一张自然不会有悬空边框。
 * 颜色全部取 style.css 里的设计令牌（A3），这里不出现裸色值。
 */
.article-card {
  position: relative;
  overflow: hidden;
  margin-bottom: 12px;
  padding: 18px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  text-align: left;
  transition:
    transform var(--transition-base),
    box-shadow var(--transition-base),
    border-color var(--transition-base);
}

/* hover 时左侧浮出一条品牌渐变竖条，是这一版科技感的主要辨识元素 */
.article-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--brand-gradient);
  opacity: 0;
  transition: opacity var(--transition-base);
}

.article-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-card-hover);
  border-color: rgba(79, 70, 229, 0.28);
}

.article-card:hover::before {
  opacity: 1;
}

.article-card:hover .article-title {
  color: var(--brand-start);
}

/* 列表最后一张：去掉下边距，避免容器的 padding 之外再多留一块空白 */
.article-card:last-child {
  margin-bottom: 0;
}

.article-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.article-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}

.article-author {
  font-size: 13px;
  color: var(--text-regular);
}

.article-time {
  font-size: 12px;
  color: var(--text-muted);
}

.article-title {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-strong);
  transition: color var(--transition-base);
}

.article-summary {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-regular);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
