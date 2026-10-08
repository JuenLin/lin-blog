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

      <!-- 分类 chip：复用 .article-chip 基础样式（C1-5/6/7 探针依赖），
           仅叠加 .article-chip-category 配色变体；无交互（整卡可点进详情）。
           后端保证返回 category（未分类时即 '未分类'），这里再兜底一次空值。 -->
      <span class="article-chip article-chip-category">{{ article.category || '未分类' }}</span>
    </div>

    <h2 class="article-title">{{ article.title }}</h2>
    <p class="article-summary">{{ article.summary }}</p>

    <!-- 第十批：点赞。
         整张卡是 router-link（渲染成真实 <a href>），所以这里必须 @click.prevent.stop ——
         和作者头像入口是同一个坑：.stop 只拦冒泡，拦不住 <a> 的**原生导航**，
         不写 .prevent 点一下点赞就跳去详情页了。
         另外 <a> 里不能嵌 <button>（HTML 规范：<a> 内不允许交互内容），
         所以沿用作者入口的写法：<span role="button" tabindex="0"> + 键盘处理，
         既合法又可 Tab 聚焦、回车触发。 -->
    <div class="article-card-foot">
      <span
        class="article-like"
        :class="{ 'is-liked': liked, 'is-busy': liking }"
        role="button"
        tabindex="0"
        :aria-pressed="liked"
        :aria-label="liked ? '取消点赞' : '点赞'"
        @click.prevent.stop="toggleLike"
        @keydown.enter.prevent.stop="toggleLike"
        @keydown.space.prevent.stop="toggleLike"
      >
        <span class="article-like-icon" aria-hidden="true">{{ liked ? '♥' : '♡' }}</span>
        <span class="article-like-count">{{ likeCount }}</span>
      </span>
    </div>
  </router-link>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { formatAbsoluteTime, formatRelativeTime, resolveAvatar } from '../utils/format.js';
import { useUserStore } from '../stores/user.js';
import { useLikedStore } from '../stores/liked.js';
import { likeArticle, unlikeArticle } from '../api/like.js';

const props = defineProps({
  article: {
    type: Object,
    required: true,
  },
});

const router = useRouter();
const userStore = useUserStore();
const likedStore = useLikedStore();

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

/* --------------------------------------------------------------------------
 * 第十批：点赞
 * ------------------------------------------------------------------------ */

// 已点赞态：**唯一真相来源是 useLikedStore 的已赞集合**（登录后拉一次自己的点赞清单），
// 所以刷新页面、换页、从详情页退回来都认得出红色。
//
// 改成 computed 之后，换文章 / 换页时它跟着 props.article.id 自动重算，
// 不需要（也不允许）手动复位 —— 下面那个 watch 因此删掉了给 liked 赋值的那一行。
//
// 集合的三个边界都不表现为「显示错误」，而是退化为旧行为（空心 → 点了才纠正）：
//   1. 未登录访问：集合为空，全是空心；
//   2. 赞过的文章超过缓存上限（truncated）：未命中的卡片维持空心；
//   3. 跨设备 / 跨标签页点的赞：这个标签页不知道，同 2。
// 详见 src/stores/liked.js 顶部注释。
const liked = computed(() => likedStore.has(props.article.id));

// likeCount 的本地覆盖值。null = 还没本地改过，显示 props 里的值。
// 不能直接改 props.article（单向数据流），所以用一个 override，换页时 watch 复位。
const likeCountOverride = ref(null);

// 防连点：接口回来之前忽略后续点击，否则连点两下会打两发 POST 撞 409。
const liking = ref(false);

// 兼容探针造的假对象没有 likeCount 键（undefined）：按 0 显示。
// 与后端口径一致 —— 「接口没返回」和「确实是 0」对前端是同一个值。
const likeCount = computed(() => {
  if (likeCountOverride.value != null) {
    return likeCountOverride.value;
  }

  const count = props.article.likeCount;

  return typeof count === 'number' ? count : 0;
});

// 换页 / 换文章（含详情页「作者其他文章」复用同一组件）时复位**本地覆盖值**，
// 否则上一篇文章的点赞数会串到下一篇上。
//
// ⚠️ 这里原先还有一行 `liked.value = false`，已随 liked 改成 computed 一起删掉：
// computed 随 props.article.id 自动重算，再手动赋值会抛
// 「Write operation failed: computed value is readonly」。
// 删掉之后「从已赞文章切到未赞文章，爱心跟着变灰」由 computed 天然保证
// （探针 probe-card-liked.mjs 有专门断言覆盖，不靠推理）。
watch(
  () => props.article.id,
  () => {
    likeCountOverride.value = null;
  },
);

async function toggleLike() {
  // 未登录：点赞必须登录，跳登录页并带 redirect，登录后能回到原来那一屏。
  // 这一支同时兜住 token 已过期但 store 里还有值的情况。
  if (!userStore.isLogin) {
    router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } });

    return;
  }

  if (liking.value) return;

  liking.value = true;

  try {
    const data = liked.value
      ? await unlikeArticle(props.article.id)
      : await likeArticle(props.article.id);

    // 等响应回来之后才动集合 —— 这里是**刻意的设计，不是漏写乐观更新**：
    // 集合的任务是「下次渲染时知道已赞」，点击手感由下面的 likeCountOverride 负责。
    // 乐观更新要处理网络超时 / 409 / 404 三种回滚，容易漏；而收益已经被 override 拿走。
    // 分工细节见 src/stores/liked.js 顶部「两条职责边界」。
    if (data && data.liked) {
      likedStore.add(props.article.id);
    } else {
      likedStore.remove(props.article.id);
    }

    if (data && typeof data.likeCount === 'number') {
      likeCountOverride.value = data.likeCount;
    }
  } catch (error) {
    // 409「已点赞过这篇文章」：说明集合漏了这一篇（未登录期间点的 / 跨设备点的 /
    // 缓存被 truncated），顺手补进去，避免每次点都报错。
    // 404「还没有点赞过这篇文章」同理反向剔除。
    if (error.httpStatus === 409) {
      likedStore.add(props.article.id);
    } else if (error.httpStatus === 404) {
      likedStore.remove(props.article.id);
    }

    ElMessage.error(error.message || '操作失败，请稍后重试');
  } finally {
    liking.value = false;
  }
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

/* 分类 chip：琥珀色系，与作者/时间（靛蓝）、阅读时长（青）都不撞色，一眼区分。
   仅覆盖底/边/字三色，形状仍由 .article-chip 提供；浅色 / 暗色令牌成对切换（见 style.css）。 */
.article-chip-category {
  background: var(--chip-bg-category);
  border-color: var(--chip-border-category);
  color: var(--chip-text-category);
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

/* 第十批：卡片底栏。摘要上方是标题 / 摘要，点赞单独一行放右下，
   不与正文抢视觉重心。 */
.article-card-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

/* 点赞按钮：胶囊形，未点赞是弱化灰（只显示计数），点赞后点亮成暖红。
   颜色全部走 style.css 的 --like-* 令牌，浅色 / 暗色自动成对切换。
   用 span[role=button] 而非 <button>：整卡是 <a>，HTML 规范不允许 <a> 内嵌交互元素。 */
.article-like {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-light);
  border-radius: var(--chip-radius);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  transition:
    background var(--transition-base),
    border-color var(--transition-base),
    color var(--transition-base);
}

.article-like:hover {
  border-color: var(--like-border);
  background: var(--like-bg);
  color: var(--like-color);
}

/* 键盘可达（tabindex=0），聚焦要有轮廓 —— 否则 Tab 用户看不出这里能按 */
.article-like:focus-visible {
  outline: 2px solid var(--like-color);
  outline-offset: 2px;
}

/* 已点赞：实心心形 + 点亮底色。aria-pressed 同步给读屏软件。 */
.article-like.is-liked {
  border-color: var(--like-border);
  background: var(--like-bg-active);
  color: var(--like-color);
}

/* 请求进行中：压低透明度 + 禁用指针，避免用户以为没点上而连点 */
.article-like.is-busy {
  opacity: 0.6;
  pointer-events: none;
}

.article-like-icon {
  font-size: 13px;
}

.article-like-count {
  font-variant-numeric: tabular-nums; /* 数字等宽，计数变化时宽度不跳 */
}
</style>
