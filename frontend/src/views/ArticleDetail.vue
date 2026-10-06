<template>
  <div class="article-detail">
    <div class="article-detail-inner">
      <!-- B1：骨架屏贴形 —— 按「大标题 → 作者/时间 → 正文段落 → 作者卡片」的真实结构画，
           高度和间距跟真实内容接近，数据到位后页面基本不跳动。 -->
      <el-skeleton v-if="loading" animated>
        <template #template>
          <div class="el-skeleton__item sk-line-lg" style="width: 62%; height: 28px"></div>

          <div class="sk-row" style="margin: 16px 0 24px">
            <div class="el-skeleton__item sk-line" style="width: 72px"></div>
            <div class="el-skeleton__item sk-line" style="width: 104px"></div>
          </div>

          <div
            v-for="i in 5"
            :key="i"
            class="el-skeleton__item sk-line"
            :style="{ width: [100, 96, 100, 88, 54][i - 1] + '%', height: '14px', marginBottom: '12px' }"
          ></div>

          <div class="sk-card" style="margin-top: 32px">
            <div class="sk-row">
              <div class="el-skeleton__item sk-avatar" style="width: 40px; height: 40px"></div>
              <div class="el-skeleton__item sk-line" style="width: 120px"></div>
            </div>
            <div class="el-skeleton__item sk-line" style="width: 78%; margin-top: 12px"></div>
          </div>
        </template>
      </el-skeleton>

      <div v-else-if="notFound" class="article-detail-missing">
        <EmptyState description="文章不存在或已被删除" />
        <div class="article-detail-missing-foot">
          <el-button @click="goHome">返回首页</el-button>
        </div>
      </div>

      <template v-else>
        <h1 class="article-detail-title">{{ article.title }}</h1>

        <div class="article-detail-meta">
          <span>{{ authorName }}</span>
          <span class="article-detail-dot">·</span>

          <!-- 方案 D：时间显示相对时间，悬停给绝对时间。
               meta 是纯文本流（不是卡片的密集胶囊行），相对时间更短、更好扫读，
               绝对时间放 tooltip，需要精确引用时能拿到。 -->
          <el-tooltip
            :content="absoluteTime"
            placement="top"
          >
            <span class="article-detail-time">{{ relativeTime }}</span>
          </el-tooltip>

          <!-- ④ 阅读时长：这里有全文 content，是精确值（卡片只有 summary，是估算值），
               方案 D 后卡片已去掉该 chip，详情页是唯一展示它的地方。保留。
               tooltip 说明数字含义，避免被误读成发布时间。 -->
          <el-tooltip
            v-if="readingTime"
            content="预计阅读时长"
            placement="top"
          >
            <span class="article-detail-chip">{{ readingTime }}</span>
          </el-tooltip>

          <!-- 第十批：点赞。详情页不在 router-link 里（卡片才是），所以不需要 .prevent，
               只加 .stop 防止冒泡到外层容器。形态与卡片保持一致的胶囊按钮 + 心形。 -->
          <span
            class="article-detail-like"
            :class="{ 'is-liked': liked, 'is-busy': liking }"
            role="button"
            tabindex="0"
            :aria-pressed="liked"
            :aria-label="liked ? '取消点赞' : '点赞'"
            @click.stop="toggleLike"
            @keydown.enter.prevent.stop="toggleLike"
            @keydown.space.prevent.stop="toggleLike"
          >
            <span class="article-detail-like-icon" aria-hidden="true">{{ liked ? '♥' : '♡' }}</span>
            <span class="article-detail-like-count">{{ likeCount }}</span>
          </span>

          <!-- 编辑 / 删除只对作者本人显示，其余人看不到入口。 -->
          <template v-if="isAuthor">
            <el-button link type="primary" @click="goEdit">编辑</el-button>
            <el-button link type="danger" @click="handleDelete">删除</el-button>
          </template>
        </div>

        <ArticleContent :content="article.content" />

        <AuthorCard v-if="article.author" :author="article.author" class="article-detail-author" />

        <!-- ② 作者其他文章：复用 ③ 已拉的 100 篇窗口，前端过滤同作者（排除当前篇）取前 5 条，复用 ArticleCard。
             窗口内该作者仅当前篇 / 无其他篇时，整块不渲染。 -->
        <section v-if="otherArticles.length" class="author-others">
          <h3 class="author-others-title">作者其他文章</h3>
          <ArticleCard
            v-for="a in otherArticles"
            :key="a.id"
            :article="a"
            class="author-others-item"
          />
        </section>

        <el-divider />

        <CommentEditor :article-id="articleId" @created="handleCommentCreated" />

        <CommentList ref="commentListRef" :article-id="articleId" class="article-detail-comments" />

        <!-- ③ 上一篇/下一篇：拉 100 篇有序窗口（createdAt desc），定位当前篇取相邻两条。
             窗口内「上=更旧（下一条）、下=更新（上一条）」；边界时对应链接禁用；
             当前篇超出 100 篇窗口则两条都禁用。导航用 router-link 做客户端跳转。 -->
        <nav v-if="neighborWindow.length" class="article-nav" aria-label="文章导航">
          <router-link
            :to="prevArticle ? { name: 'article-detail', params: { id: prevArticle.id } } : route.fullPath"
            class="article-nav-link article-nav-prev"
            :class="{ 'is-disabled': !prevArticle }"
          >
            <span class="article-nav-dir">← 上一篇 · 更旧</span>
            <span class="article-nav-title">{{ prevLabel }}</span>
          </router-link>
          <router-link
            :to="nextArticle ? { name: 'article-detail', params: { id: nextArticle.id } } : route.fullPath"
            class="article-nav-link article-nav-next"
            :class="{ 'is-disabled': !nextArticle }"
          >
            <span class="article-nav-dir">下一篇 · 更新 →</span>
            <span class="article-nav-title">{{ nextLabel }}</span>
          </router-link>
        </nav>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { deleteArticle, getArticle, listArticles } from '../api/article.js';
import { likeArticle, unlikeArticle, getArticleLiked } from '../api/like.js';
import { formatAbsoluteTime, formatRelativeTime, getReadingTime } from '../utils/format.js';
import { useUserStore } from '../stores/user.js';
import ArticleContent from '../components/ArticleContent.vue';
import AuthorCard from '../components/AuthorCard.vue';
import CommentEditor from '../components/CommentEditor.vue';
import CommentList from '../components/CommentList.vue';
import ArticleCard from '../components/ArticleCard.vue';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

const loading = ref(true);
const notFound = ref(false);
const article = ref(null);
const commentListRef = ref(null);

// ③ 上一篇/下一篇：拉最近 100 篇有序窗口（createdAt desc），前端定位当前篇取相邻两条。
// 窗口内「上=更旧（index+1）、下=更新（index-1）」；边界或超出窗口则对应链接禁用。
const neighborWindow = ref([]);
const currentIndex = computed(() =>
  neighborWindow.value.findIndex((a) => Number(a.id) === articleId.value)
);
const inWindow = computed(() => currentIndex.value >= 0);

const prevArticle = computed(() => {
  const i = currentIndex.value;
  if (i < 0 || i >= neighborWindow.value.length - 1) return null;
  return neighborWindow.value[i + 1];
});
const nextArticle = computed(() => {
  const i = currentIndex.value;
  if (i <= 0) return null;
  return neighborWindow.value[i - 1];
});

const prevLabel = computed(() => {
  if (prevArticle.value) return prevArticle.value.title;
  return inWindow.value ? '已是最旧（窗口内）' : '超出 100 篇窗口，不可用';
});
const nextLabel = computed(() => {
  if (nextArticle.value) return nextArticle.value.title;
  return inWindow.value ? '已是最新（窗口内）' : '超出 100 篇窗口，不可用';
});

// ② 作者其他文章：复用 ③ 已加载的 100 篇窗口，过滤同作者且排除当前篇，取前 5 条复用 ArticleCard。
// 窗口内该作者仅当前篇 / 无其他篇时返回空数组，区块 v-if 不渲染。
const otherArticles = computed(() => {
  const author = article.value && article.value.author;
  if (!author) return [];
  return neighborWindow.value
    .filter((a) => a.author && a.author.id === author.id && Number(a.id) !== articleId.value)
    .slice(0, 5);
});

async function loadNeighbors() {
  try {
    const res = await listArticles({ pageSize: 100, sortBy: 'createdAt', order: 'desc' });
    neighborWindow.value = (res && res.list) || [];
  } catch {
    // 邻居列表拉取失败时不影响正文阅读，只是不显示上一篇/下一篇。
    neighborWindow.value = [];
  }
}

// F7：页面标题随文章变化。详情页加载完把标题设成「文章标题 - 站点名」，
// 离开时复原（避免返回列表后浏览器标签还停在旧文章标题上）。
const baseTitle = document.title;

function setTitle(title) {
  document.title = title;
}

// 路由参数是字符串，接口路径用字符串即可，但 CommentList 的 articleId 是 Number prop。
const articleId = computed(() => Number(route.params.id));

const authorName = computed(() => {
  const author = article.value && article.value.author;

  if (!author) {
    return '匿名';
  }

  return author.nickname || author.username || '匿名';
});

// user 可能为 null（未登录，或刷新后 AppHeader 的 fetchMe 还没回来），此时不显示操作入口。
const isAuthor = computed(() => {
  const author = article.value && article.value.author;

  return Boolean(userStore.user && author && userStore.user.id === author.id);
});

// ④ + 方案 D：阅读时长（详情页拿全文 content，是精确值）+ 相对/绝对时间。
const readingTime = computed(() => getReadingTime(article.value && article.value.content));
const relativeTime = computed(() => formatRelativeTime(article.value && article.value.createdAt));
const absoluteTime = computed(() => formatAbsoluteTime(article.value && article.value.createdAt));

/* --------------------------------------------------------------------------
 * 第十批：点赞
 * ------------------------------------------------------------------------ */

// 第十批：公开接口不返回 liked，默认 false，由下面两处修正：
//   1. 已登录时调 fetchLiked() 拉真实值（第十四批）；
//   2. 点赞 / 取消的响应，以及 409 / 404 的兜底纠正。
// 换文章（load）时必须复位，否则上一篇的已赞态会串到下一篇。
const liked = ref(false);

// 防连点。
const liking = ref(false);

// 兼容探针造的假对象没有 likeCount 键：按 0 显示，与后端口径一致。
const likeCount = computed(() => {
  const count = article.value && article.value.likeCount;

  return typeof count === 'number' ? count : 0;
});

/**
 * 第十四批：拉取「当前用户是否已点赞」，还原按钮初始态。
 *
 * 只在已登录时调用 —— 未登录发这个请求必然拿到 401，而 request.js 的 401
 * 拦截器会清 token 并跳登录页，等于把匿名读者从文章页踢走。
 *
 * 非关键路径：失败时保持 liked = false 且不弹提示。真的赞过时，用户点一下
 * 会收到 409，toggleLike 的兜底分支会把它纠正为 true（自愈）。
 */
async function fetchLiked() {
  if (!userStore.isLogin || !article.value) return;

  // 闭包比对：请求期间若切换到别的文章（watch 已触发新一轮 load），这份响应就过期了。
  const requestedId = articleId.value;

  try {
    const data = await getArticleLiked(articleId.value);

    if (requestedId !== articleId.value) return;

    liked.value = Boolean(data && data.liked);
  } catch {
    // 静默：见上方说明。
  }
}

async function toggleLike() {
  // 未登录：跳登录页并带 redirect，登录后能回到这篇文章。
  if (!userStore.isLogin) {
    router.push({ name: 'login', query: { redirect: route.fullPath } });

    return;
  }

  if (liking.value || !article.value) return;

  liking.value = true;

  try {
    const data = liked.value
      ? await unlikeArticle(articleId.value)
      : await likeArticle(articleId.value);

    liked.value = Boolean(data && data.liked);

    // 详情页的 article 是本组件的 ref（不是父组件的 prop），可以直接改，
    // 不像 ArticleCard 那样得用本地 override 绕开单向数据流。
    // **已知限制（本批不处理）**：只改这一处，列表页（Home）那份数据不会同步 ——
    // 点完赞返回列表看到的还是旧数字，刷新列表后才更新。
    // 要修得把点赞态提到全局 store 或让列表重新拉取，属于另一批的改动。
    if (data && typeof data.likeCount === 'number') {
      article.value.likeCount = data.likeCount;
    }
  } catch (error) {
    // 409 = 已经赞过了（例如刷新丢状态），404 = 本来就没赞过，都顺手纠正本地态。
    if (error.httpStatus === 409) {
      liked.value = true;
    } else if (error.httpStatus === 404) {
      liked.value = false;
    }

    ElMessage.error(error.message || '操作失败，请稍后重试');
  } finally {
    liking.value = false;
  }
}

async function load() {
  loading.value = true;
  notFound.value = false;
  neighborWindow.value = []; // 重置，避免从上一篇/下一篇跳转时残留旧文章的邻居
  liked.value = false; // 换文章先复位，已登录时由下面的 fetchLiked() 拉真实值回填

  try {
    article.value = await getArticle(route.params.id);
    setTitle(`${article.value.title} - 博客广场`);

    // 还原点赞按钮态（已登录才有意义）。不 await：它不是阅读正文的前置条件，
    // 慢了也不该拖住渲染，与下面的 loadNeighbors 同口径。
    fetchLiked();
  } catch (error) {
    // 文章不存在 / 已被软删除，后端返回 40400；详情页不抛红，按空态处理。
    article.value = null;
    notFound.value = true;
    setTitle('文章不存在 - 博客广场');
  } finally {
    loading.value = false;
  }

  // 邻居列表独立拉取（100 篇窗口），失败不影响正文。
  loadNeighbors();
}

function goHome() {
  router.push({ name: 'home' });
}

function goEdit() {
  router.push({ name: 'editor-edit', params: { id: articleId.value } });
}

// 删除是软删除（docs/DB.md），确认框必须写清后果：删完评论也一起看不到了。
async function handleDelete() {
  try {
    await ElMessageBox.confirm('删除后文章及其评论将不再可见，确认删除？', '提示', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch (error) {
    // 用户点取消，ElMessageBox 以 reject 结束，这里直接返回。
    return;
  }

  try {
    await deleteArticle(articleId.value);

    ElMessage.success('文章已删除');
    router.push({ name: 'home' });
  } catch (error) {
    ElMessage.error(error.message);
  }
}

// 发表评论后刷新评论列表（CommentList 暴露 reload，内部会回到第一页）。
function handleCommentCreated() {
  if (commentListRef.value) {
    commentListRef.value.reload();
  }
}

onMounted(load);

// ③：从上一篇/下一篇用 router-link 客户端跳转时，同组件被复用，必须重新加载。
watch(
  () => route.params.id,
  () => load()
);

// F7：离开详情页时把标题复原，避免浏览器标签残留旧文章标题。
onBeforeUnmount(() => {
  document.title = baseTitle;
});
</script>

<style scoped>
.article-detail {
  padding: 24px 16px 48px;
}

.article-detail-inner {
  max-width: 800px;
  margin: 0 auto;
  text-align: left;
}

.article-detail-title {
  margin: 0 0 12px;
  font-size: 28px;
  font-weight: 600;
  color: var(--text-strong);
  word-break: break-word;
}

.article-detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 24px;
  font-size: 13px;
  color: var(--text-muted);
}

.article-detail-dot {
  color: var(--text-faint);
}

/* 方案 D：时间 chip 走 tooltip，补cursor 表明可悬停看绝对时间。
   只改鼠标形态，字色/字号继承 .article-detail-meta，不重复定义。 */
.article-detail-time {
  cursor: help;
}

/* ④ 阅读时长 chip：与 ArticleCard 用同一套 --chip-* 令牌，保证两处观感一致 */
.article-detail-chip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--chip-border-accent);
  border-radius: var(--chip-radius);
  background: var(--chip-bg-accent);
  color: var(--chip-text-accent);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: help;
}

/* 第十批：点赞按钮。与 ArticleCard 用同一套 --like-* 令牌，两处观感一致。
   meta 行是纯文本流，所以它比卡片那颗稍矮一点（22px），不抢标题视觉重心。 */
.article-detail-like {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
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

.article-detail-like:hover {
  border-color: var(--like-border);
  background: var(--like-bg);
  color: var(--like-color);
}

.article-detail-like:focus-visible {
  outline: 2px solid var(--like-color);
  outline-offset: 2px;
}

.article-detail-like.is-liked {
  border-color: var(--like-border);
  background: var(--like-bg-active);
  color: var(--like-color);
}

.article-detail-like.is-busy {
  opacity: 0.6;
  pointer-events: none;
}

.article-detail-like-count {
  font-variant-numeric: tabular-nums;
}

.article-detail-author {
  margin-top: 32px;
}

.article-detail-comments {
  margin-top: 24px;
}

.article-detail-missing-foot {
  margin-top: 16px;
  text-align: center;
}

/* ② 作者其他文章 */
.author-others {
  margin-top: 24px;
}

.author-others-title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-strong);
}

/* ③ 上一篇/下一篇导航 */
.article-nav {
  display: flex;
  gap: 16px;
  margin-top: 32px;
}

.article-nav-link {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--bg-subtle);
  border-radius: 12px;
  background: var(--bg-card);
  text-decoration: none;
  color: var(--text-regular);
  transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s;
  min-width: 0;
}

.article-nav-link:hover:not(.is-disabled) {
  border-color: var(--el-color-primary);
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(var(--brand-rgb), 0.18);
}

.article-nav-link.is-disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.article-nav-next {
  text-align: right;
  align-items: flex-end;
}

.article-nav-dir {
  font-size: 12px;
  color: var(--text-muted);
}

.article-nav-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.article-nav-link.is-disabled .article-nav-title {
  color: var(--text-faint);
  font-weight: 400;
}
</style>
