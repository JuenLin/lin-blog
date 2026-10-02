<template>
  <!-- F2：从 div@click 改成 router-link，渲染成真正的 <a> —— 可 Tab 聚焦、回车进入，
       键盘可达。class 会合并到 <a> 上，原来挂 @click 的 openDetail 不再需要。 -->
  <router-link class="article-card" :to="{ name: 'article-detail', params: { id: article.id } }">
    <!-- ④ 元数据 chip 化：作者 / 时间 / 阅读时长三枚胶囊。
         chip 是对已有元数据的视觉强化，不是真标签（后端没有 tag 字段，不动 schema / 契约）。 -->
    <div class="article-card-head">
      <!-- 入口：作者头像+名可点进 /user/:id。
           整张卡是 router-link（渲染成真实 <a href>），所以这里必须同时做两件事：
           @click.prevent —— 阻止 <a> 的**原生跳转**（stopPropagation 只拦冒泡，拦不住默认导航，
                            只写 .stop 的话浏览器仍会跳去 href，即整卡的详情页）；
           @click.stop    —— 阻止事件冒泡到 <a> 上绑定的 router-link 处理器。
           也不用 router-link 包一层（<a> 套 <a> 是非法嵌套）。 -->
      <span
        v-if="authorId"
        class="article-chip article-chip-author article-author-link"
        role="link"
        tabindex="0"
        @click.prevent.stop="goToAuthor"
        @keydown.enter.prevent.stop="goToAuthor"
      >
        <span class="article-avatar" :style="{ backgroundColor: avatarColor }">{{ avatarText }}</span>
        <span class="article-author">{{ authorName }}</span>
      </span>
      <span v-else class="article-chip article-chip-author">
        <span class="article-avatar" :style="{ backgroundColor: avatarColor }">{{ avatarText }}</span>
        <span class="article-author">{{ authorName }}</span>
      </span>

      <span class="article-chip">{{ formatTime(article.createdAt) }}</span>

      <!-- 阅读时长按列表接口给的 summary 估算（详情页才有全文，那里是精确值） -->
      <span v-if="readingTime" class="article-chip article-chip-accent">{{ readingTime }}</span>
    </div>

    <h2 class="article-title">{{ article.title }}</h2>
    <p class="article-summary">{{ article.summary }}</p>
  </router-link>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { formatTime, getAvatarColor, getAvatarText, getReadingTime } from '../utils/format.js';

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

// ④ 阅读时长：列表接口只给 summary，这里是估算值；详情页用全文 content 算精确值。
const readingTime = computed(() => getReadingTime(props.article.summary));

// 入口：进该作者的个人主页。author 缺失（不该发生，API 保证内嵌 author）时不渲染入口。
const authorId = computed(() => {
  const author = props.article.author;
  return author && author.id != null ? author.id : null;
});

function goToAuthor() {
  if (authorId.value == null) return;
  router.push({ name: 'user-profile', params: { id: authorId.value } });
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
  display: block;
  overflow: hidden;
  margin-bottom: 12px;
  padding: 18px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  text-align: left;
  text-decoration: none;
  color: inherit;
  transition:
    transform var(--transition-base),
    box-shadow var(--transition-base),
    border-color var(--transition-base);
}

/* F2：键盘聚焦时给出明显轮廓，让 Tab 用户知道卡片当前可进入 */
.article-card:focus-visible {
  outline: 2px solid var(--brand-start);
  outline-offset: 2px;
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
  border-color: rgba(var(--brand-rgb), 0.28);
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
  flex-wrap: wrap; /* 窄屏时 chip 换行，不挤压标题 */
  gap: var(--chip-gap);
  margin-bottom: 12px;
}

/* ④ 元数据 chip：胶囊底 + 细边 + 深于正文的文字色。
 * 底/边/字全部走 style.css 的 --chip-* 令牌，浅色 / 暗色自动成对切换。 */
.article-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--chip-border);
  border-radius: var(--chip-radius);
  background: var(--chip-bg);
  color: var(--chip-text);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}

/* 阅读时长用青色系，与作者/时间的主色系区分开，一眼能扫到 */
.article-chip-accent {
  background: var(--chip-bg-accent);
  border-color: var(--chip-border-accent);
  color: var(--chip-text-accent);
}

.article-avatar {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-brand);
  font-size: 11px;
  font-weight: 600;
}

.article-author {
  font-size: 12px;
  color: var(--chip-text);
  font-weight: 500;
}

/* 入口：作者 chip 可点进个人主页。给出 hover / 聚焦反馈，
   否则用户看不出这一小块能点（整卡都能点进详情，容易忽略）。 */
.article-author-link {
  cursor: pointer;
  transition:
    background var(--transition-base),
    border-color var(--transition-base);
}

.article-author-link:hover,
.article-author-link:focus-visible {
  background: rgba(var(--brand-rgb), 0.14);
  border-color: rgba(var(--brand-rgb), 0.4);
  outline: none;
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
