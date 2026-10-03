<template>
  <!-- F2：从 div@click 改成 router-link，渲染成真正的 <a> —— 可 Tab 聚焦、回车进入，
       键盘可达。class 会合并到 <a> 上，原来挂 @click 的 openDetail 不再需要。 -->
  <router-link class="article-card" :to="{ name: 'article-detail', params: { id: article.id } }">
    <!-- ④ 元数据 chip 化：作者 / 时间两枚胶囊。
         chip 是对已有元数据的视觉强化，不是真标签（后端没有 tag 字段，不动 schema / 契约）。
         方案 D 起去掉了阅读时长 chip，改成时间 chip 显示相对时间。 -->
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
        <img
          v-if="avatarInfo.type === 'image' && !avatarBroken"
          class="article-avatar-img"
          :src="avatarInfo.src"
          :alt="authorName"
          @error="avatarBroken = true"
        />
        <span v-else class="article-avatar" :style="{ backgroundColor: avatarInfo.color }">{{ avatarInfo.text }}</span>
        <span class="article-author">{{ authorName }}</span>
      </span>
      <span v-else class="article-chip article-chip-author">
        <img
          v-if="avatarInfo.type === 'image' && !avatarBroken"
          class="article-avatar-img"
          :src="avatarInfo.src"
          :alt="authorName"
          @error="avatarBroken = true"
        />
        <span v-else class="article-avatar" :style="{ backgroundColor: avatarInfo.color }">{{ avatarInfo.text }}</span>
        <span class="article-author">{{ authorName }}</span>
      </span>

      <!-- 时间 chip（方案 D）：正文显示相对时间（「3 小时前」），悬停 tooltip 给绝对时间。
           卡片头是密集信息位，绝对时间（2026/10/3 01:49:50）太长会挤掉标题，
           所以绝对时间只在 hover / 聚焦时出现。 -->
      <el-tooltip
        :content="absoluteTime"
        placement="top"
      >
        <span class="article-chip article-chip-time">{{ relativeTime }}</span>
      </el-tooltip>
    </div>

    <h2 class="article-title">{{ article.title }}</h2>
    <p class="article-summary">{{ article.summary }}</p>
  </router-link>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { formatAbsoluteTime, formatRelativeTime, resolveAvatar } from '../utils/format.js';

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

// 头像形态（第九批）：有 avatar 外链渲染 <img>，否则回退色块 + 首字。
// resolveAvatar 内部用 truthy 检查，**avatar 键不存在时**（探针造的对象就没有这个键）
// 会自然落到 text 分支，不会因为 undefined 而破图。
// 注意：text 分支返回的是 { text, color }，image 分支返回的是 { src }，
// 所以模板里两种形态取的字段不一样，但都从同一个 avatarInfo 上读。
const avatarInfo = computed(() => {
  const info = resolveAvatar(props.article.author, authorName.value);

  if (info.type === 'image') {
    return info;
  }

  return { type: 'text', text: info.text, color: info.color };
});

// 外链图片加载失败时回退色块（服务端不保证 URL 可达，见 docs/API.md）。
// article 变化（含分页换页）时必须复位，否则会一直显示失败状态。
const avatarBroken = ref(false);

watch(
  () => (props.article.author ? props.article.author.avatar : null),
  () => {
    avatarBroken.value = false;
  },
);

// 方案 D：卡片不再显示阅读时长 chip（列表只有 summary，时长是估算值，参考价值低，
// 而且三枚 chip 并排在窄屏会换行）。改用相对时间 + hover 给绝对时间。
// 详情页有全文 content，那里保留精确的阅读时长。
const relativeTime = computed(() => formatRelativeTime(props.article.createdAt));
const absoluteTime = computed(() => formatAbsoluteTime(props.article.createdAt));

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

/* 时间 chip 带 tooltip（方案 D），补一条 cursor 让它看起来可解释。
   chip 的其余样式仍由 .article-chip 提供，这里只做鼠标形态。 */
.article-chip-time {
  cursor: help;
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

/* 图片头像（第九批）：与色块同尺寸，object-fit: cover 防变形 */
.article-avatar-img {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  flex-shrink: 0;
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
