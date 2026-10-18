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

          <!-- 第 9 批：阅读量 chip（被动展示，不可点）。口径是 articles.view_count
               真实列的 all-time 累计阅读；**不显示「是否已读」** ——
               阅读免登录、无用户维度（docs/API.md 第 9 批）。
               tooltip 说明这是累计值，避免被误读成「当前在线人数」。 -->
          <el-tooltip content="累计阅读量" placement="top">
            <span class="article-detail-view">阅读 {{ viewCount }}</span>
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

          <!-- 第 9 批：收藏星标。形态与点赞按钮一致（矮胶囊 + ☆/★），
               只换 --bookmark-* 琥珀色板；幂等 200，没有 409 / 404 分支
               （见 api/bookmark.js 顶部，与点赞刻意相反）。
               星标不带计数：全站收藏数对读者没有意义（与卡片同理）。 -->
          <span
            class="article-detail-bookmark"
            :class="{ 'is-bookmarked': bookmarked, 'is-busy': bookmarking }"
            role="button"
            tabindex="0"
            :aria-pressed="bookmarked"
            :aria-label="bookmarked ? '取消收藏' : '收藏'"
            @click.stop="toggleBookmark"
            @keydown.enter.prevent.stop="toggleBookmark"
            @keydown.space.prevent.stop="toggleBookmark"
          >
            <span class="article-detail-bookmark-icon" aria-hidden="true">{{ bookmarked ? '★' : '☆' }}</span>
          </span>

          <!-- 编辑 / 删除 / 历史版本只对作者本人显示，其余人看不到入口。
               第 6 批新增「历史版本」：打开版本抽屉（revisions 接口仅作者可用）。 -->
          <template v-if="isAuthor">
            <el-button link type="primary" @click="openRevisions">历史版本</el-button>
            <el-button link type="primary" @click="goEdit">编辑</el-button>
            <el-button link type="danger" @click="handleDelete">删除</el-button>
          </template>

          <!-- 第 12 批：举报入口。登录 + 非作者才显示（作者删自己的内容走上面的删除，
               不走举报；未登录不显示入口）。link 弱按钮不抢点赞 / 收藏的视觉。 -->
          <el-button v-if="canReport" link type="warning" data-testid="article-report-btn" @click="openReport">举报</el-button>
        </div>

        <!-- 第 7 批：标签行。无标签不渲染；chip 可点 → 广场 ?tag= 筛选。
             详情页不在 router-link 内，@click 直接跳即可（带 role=link + keydown 保键盘可达）。 -->
        <div v-if="articleTags.length" class="article-detail-tags" data-testid="article-tags">
          <span class="article-detail-tags-label">标签</span>
          <span
            v-for="t in articleTags"
            :key="t"
            class="article-detail-tag-chip"
            role="link"
            tabindex="0"
            @click="goTag(t)"
            @keydown.enter.prevent="goTag(t)"
          ># {{ t }}</span>
        </div>

        <!-- 第 10 批：系列横幅。文章绑定了系列（seriesId != null）且系列详情已拉到、
             当前篇在系列列表里时渲染。位置：meta 行/标签行下方、正文上方（用户拍板）。
             与底部全局 prev/next 语义正交（时间线维度 vs 系列内顺序），不混装。
             N = 系列列表下标 + 1，M = 系列文章总数（接口只返回已发布文章，
             草稿不在列表里 → seriesIndex < 0 时横幅不渲染，防止「第 0 篇」）。 -->
        <div
          v-if="seriesBannerVisible"
          class="series-banner"
          data-testid="series-banner"
        >
          <div class="series-banner-main">
            <span class="series-banner-tag">系列</span>
            <span class="series-banner-title">{{ seriesTitle }}</span>
            <span class="series-banner-pos">第 {{ seriesPosition }} 篇 / 共 {{ seriesTotal }} 篇</span>
          </div>
          <div class="series-banner-nav">
            <span
              class="series-banner-link"
              :class="{ 'is-disabled': !seriesPrev }"
              role="link"
              tabindex="0"
              :aria-disabled="!seriesPrev"
              @click="goSeriesNeighbor(seriesPrev)"
              @keydown.enter.prevent="goSeriesNeighbor(seriesPrev)"
            >← 上一篇</span>
            <span
              class="series-banner-link"
              :class="{ 'is-disabled': !seriesNext }"
              role="link"
              tabindex="0"
              :aria-disabled="!seriesNext"
              @click="goSeriesNeighbor(seriesNext)"
              @keydown.enter.prevent="goSeriesNeighbor(seriesNext)"
            >下一篇 →</span>
          </div>
        </div>

        <!-- 第 5 批：右侧悬浮目录（el-anchor，零新增依赖）。
             标题少于 2 个时组件自身不渲染。fixed 定位，DOM 位置不影响视觉。 -->
        <ArticleToc v-if="article.content" :content="article.content" />

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

        <CommentList ref="commentListRef" :article-id="articleId" :article-author-id="article?.author?.id" class="article-detail-comments" />

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

    <!-- 第 6 批：历史版本抽屉（仅作者入口，接口本身也仅作者可用，403 由接口兜底）。
         revisions 是「每次更新前」的快照（倒序），当前线上版本置顶作对照。
         每条带全量 content（方案 A），滚动预览，无需二次请求。 -->
    <el-drawer v-model="revisionsVisible" title="历史版本" size="520px" :append-to-body="true">
      <div v-if="revisionsLoading">
        <el-skeleton :rows="6" animated />
      </div>

      <EmptyState
        v-else-if="!revisions.length"
        description="还没有历史版本。编辑已发布文章并保存后，这里会出现每次更新前的快照"
      />

      <template v-else>
        <!-- 当前版本置顶对照（不是 revisions 成员，不可回滚到它自己） -->
        <div class="revision-item is-current">
          <div class="revision-head">
            <span class="revision-tag">当前版本</span>
            <span class="revision-title">{{ article.title }}</span>
          </div>
          <p class="revision-meta">{{ article.category }} · 线上正在展示的内容</p>
        </div>

        <div v-for="rev in revisions" :key="rev.id" class="revision-item">
          <div class="revision-head">
            <span class="revision-title">{{ rev.title || '（无标题）' }}</span>
            <el-tooltip :content="formatAbsoluteTime(rev.createdAt)" placement="top">
              <span class="revision-time">{{ formatRelativeTime(rev.createdAt) }}</span>
            </el-tooltip>
          </div>
          <p class="revision-meta">{{ rev.category }}</p>
          <pre class="revision-content">{{ rev.content }}</pre>
          <div class="revision-foot">
            <el-button
              size="small"
              type="warning"
              plain
              :loading="restoringId === rev.id"
              @click="handleRestore(rev)"
            >
              回滚到此版本
            </el-button>
          </div>
        </div>
      </template>
    </el-drawer>

    <!-- 第 12 批：举报 dialog。理由选填 ≤200（后端同校验）；提交成功只提示不关详情页。
         409（重复举报）/ 404（内容已不可见）走拦截器统一报错文案。 -->
    <el-dialog v-model="reportVisible" title="举报文章" width="420px" :append-to-body="true">
      <p class="report-tip">如果这篇文章存在违规内容，请告诉我们。理由选填，最多 200 字。</p>
      <el-input
        v-model="reportReason"
        type="textarea"
        :rows="4"
        maxlength="200"
        show-word-limit
        placeholder="填写举报理由（选填）"
        data-testid="article-report-reason"
      />
      <template #footer>
        <el-button @click="reportVisible = false">取消</el-button>
        <el-button type="primary" :loading="reporting" data-testid="article-report-submit" @click="submitReport">提交举报</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { deleteArticle, getArticle, listArticles, listRevisions, recordArticleView, restoreArticle } from '../api/article.js';
import { getSeries } from '../api/series.js';
import { likeArticle, unlikeArticle, getArticleLiked } from '../api/like.js';
import { bookmarkArticle, unbookmarkArticle, getArticleBookmarked } from '../api/bookmark.js';
import { createReport } from '../api/report.js';
import { formatAbsoluteTime, formatRelativeTime, getReadingTime } from '../utils/format.js';
import { useUserStore } from '../stores/user.js';
import ArticleContent from '../components/ArticleContent.vue';
import ArticleToc from '../components/ArticleToc.vue';
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

// 第 7 批：标签名数组（后端恒返回数组，无标签为 []；缺失兜底防探针造对象炸模板）。
const articleTags = computed(() =>
  article.value && Array.isArray(article.value.tags) ? article.value.tags : []
);

// 点击标签 → 广场按该标签筛选（整页跳转，详情页状态不保留）。
function goTag(name) {
  router.push({ name: 'home', query: { tag: name } });
}

// user 可能为 null（未登录，或刷新后 AppHeader 的 fetchMe 还没回来），此时不显示操作入口。
const isAuthor = computed(() => {
  const author = article.value && article.value.author;

  return Boolean(userStore.user && author && userStore.user.id === author.id);
});

// ── 第 12 批：举报文章 ──
const reportVisible = ref(false);
const reportReason = ref('');
const reporting = ref(false);

// 登录 + 非作者才显示入口（与评论侧同口径；未登录读者没有举报的身份落库，不显示）。
const canReport = computed(() => Boolean(article.value && userStore.isLogin && !isAuthor.value));

function openReport() {
  reportReason.value = '';
  reportVisible.value = true;
}

async function submitReport() {
  if (!article.value || reporting.value) return;
  reporting.value = true;

  try {
    await createReport({
      targetType: 'ARTICLE',
      targetId: article.value.id,
      reason: reportReason.value.trim() || undefined,
    });

    reportVisible.value = false;
    ElMessage.success('已收到举报，我们会尽快处理');
  } catch (error) {
    // 409 重复举报 / 404 内容已不可见 / 400 举报自己，统一走后端 message。
    ElMessage.error(error.message || '举报失败，请稍后重试');
  } finally {
    reporting.value = false;
  }
}

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

/* --------------------------------------------------------------------------
 * 第 9 批：收藏（星标）
 * ------------------------------------------------------------------------ */

// 与 liked 同构：公开接口不返回 bookmarked，默认 false，
// 由 fetchBookmarked()（已登录）拉真实值回填；换文章（load）时必须复位。
const bookmarked = ref(false);

// 防连点（收藏幂等，连点不会 409，但会多打请求）。
const bookmarking = ref(false);

/**
 * 第 9 批：拉取「当前用户是否已收藏」，还原星标按钮初始态。
 *
 * 与 fetchLiked 完全同构：只在已登录时调用（未登录发这个请求会吃 401
 * 被踢去登录页）、闭包比对防过期响应、失败静默保持 false。
 */
async function fetchBookmarked() {
  if (!userStore.isLogin || !article.value) return;

  const requestedId = articleId.value;

  try {
    const data = await getArticleBookmarked(articleId.value);

    if (requestedId !== articleId.value) return;

    bookmarked.value = Boolean(data && data.bookmarked);
  } catch {
    // 静默：真的收藏过时，用户点一下星标即进入目标态，下一次渲染由集合纠正。
  }
}

/**
 * 第 9 批：收藏 / 取消收藏。
 *
 * 与 toggleLike 的**刻意差异**（用户 2026-10-18 拍板，docs/API.md 第 9 批）：
 *   - **幂等 200**：重复收藏 / 取消没收藏过的都成功，没有 409 / 404 分支可纠正；
 *   - 响应 { bookmarked, bookmarkCount }：bookmarkCount 是**全站**总收藏数，
 *     不落到本页任何 UI（别跟 likeCount 的归属拿混）。
 */
async function toggleBookmark() {
  // 未登录：跳登录页并带 redirect，登录后能回到这篇文章。
  if (!userStore.isLogin) {
    router.push({ name: 'login', query: { redirect: route.fullPath } });

    return;
  }

  if (bookmarking.value || !article.value) return;

  bookmarking.value = true;

  try {
    const data = bookmarked.value
      ? await unbookmarkArticle(articleId.value)
      : await bookmarkArticle(articleId.value);

    bookmarked.value = Boolean(data && data.bookmarked);
  } catch (error) {
    ElMessage.error(error.message || '操作失败，请稍后重试');
  } finally {
    bookmarking.value = false;
  }
}

/* --------------------------------------------------------------------------
 * 第 9 批：阅读量（展示 + 计数上报）
 * ------------------------------------------------------------------------ */

// 累计阅读量：articles.view_count 真实列，all-time 口径。
// 兼容探针造的假对象没有这个键：按 0 显示，与后端口径一致。
const viewCount = computed(() => {
  const count = article.value && article.value.viewCount;

  return typeof count === 'number' ? count : 0;
});

/**
 * 第 9 批：记录一次阅读（load 成功后调，每篇文章一次）。
 *
 * 三条纪律（docs/API.md「POST /view 防刷」小节 + 前端调用约定）：
 *   1. **免登录**：匿名阅读也要计数，所以不判断 isLogin；
 *   2. **不 await**：不是阅读正文的前置条件，失败（网络抖动 / 404）静默，
 *      最坏情况是少计一次阅读，不影响渲染；
 *   3. **闭包比对**：请求期间切换到别的文章时这份响应就过期了，丢弃。
 *
 * 判重在后端（同 IP 同文章 5 分钟一次，尽力而为、重启丢窗口），
 * 前端只负责「每篇文章调一次」，不做任何本地去重（刷新页面即重新计时是预期行为）。
 */
async function recordView() {
  if (!article.value) return;

  const requestedId = articleId.value;

  try {
    const data = await recordArticleView(articleId.value);

    if (requestedId !== articleId.value) return;

    // 同步 +1 后的最新值进本地 article，让 meta 行「阅读 N」即时反映本次阅读
    // （与点赞成功后改本地 article.likeCount 同一做法）。
    if (data && typeof data.viewCount === 'number' && article.value) {
      article.value.viewCount = data.viewCount;
    }
  } catch {
    // 静默：见上方说明。
  }
}

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

/* --------------------------------------------------------------------------
 * 第 10 批：系列横幅（系列内上/下篇）
 * ------------------------------------------------------------------------ */

// 系列详情（getSeries 的 data：{ id, title, articles: [{id,title,seriesOrder,summary}] }）。
// 文章未绑定系列时恒为 null；换文章（load）时复位防串。
const series = ref(null);

// 只在 article.seriesId != null 时拉一次系列详情。闭包比对防过期响应
// （请求期间切到另一篇文章，这份系列数据就作废了）——与 fetchLiked 同口径。
// 失败静默：横幅不渲染，不影响正文阅读。
async function fetchSeries() {
  const target = article.value;

  if (!target || target.seriesId == null) {
    series.value = null;
    return;
  }

  const requestedId = articleId.value;

  try {
    const data = await getSeries(target.seriesId);

    if (requestedId !== articleId.value) return;

    series.value = data && typeof data === 'object' ? data : null;
  } catch {
    if (requestedId === articleId.value) series.value = null;
  }
}

// 当前篇在系列列表（已发布、seriesOrder 升序）里的下标。-1 = 不在列表
// （典型：作者后来把文章改成草稿/软删后从详情页旧标签页进来）→ 横幅不渲染。
const seriesIndex = computed(() => {
  if (!series.value || !Array.isArray(series.value.articles)) return -1;
  return series.value.articles.findIndex((a) => Number(a.id) === articleId.value);
});

const seriesBannerVisible = computed(
  () => Boolean(article.value && article.value.seriesId != null && seriesIndex.value >= 0)
);

const seriesTitle = computed(() => (series.value && series.value.title) || '');

// 「第 N 篇 / 共 M 篇」：N = 下标 + 1，M = 系列文章总数（接口只返回已发布文章）。
const seriesPosition = computed(() => seriesIndex.value + 1);
const seriesTotal = computed(() =>
  series.value && Array.isArray(series.value.articles) ? series.value.articles.length : 0
);

// 系列内邻居：上 = seriesOrder 更早（下标 -1），下 = 更晚（下标 +1）。
// 与全局 prev/next（时间线：上=更旧）语义不同，两套 computed 各自独立，不共用。
const seriesPrev = computed(() => {
  const i = seriesIndex.value;
  if (i <= 0 || !series.value) return null;
  return series.value.articles[i - 1];
});
const seriesNext = computed(() => {
  const i = seriesIndex.value;
  if (i < 0 || !series.value || i >= series.value.articles.length - 1) return null;
  return series.value.articles[i + 1];
});

// 系列内跳转（客户端路由跳转，同组件复用，watch route.params.id 会触发 load）。
function goSeriesNeighbor(target) {
  if (!target) return;
  router.push({ name: 'article-detail', params: { id: target.id } });
}

async function load() {
  loading.value = true;
  notFound.value = false;
  neighborWindow.value = []; // 重置，避免从上一篇/下一篇跳转时残留旧文章的邻居
  liked.value = false; // 换文章先复位，已登录时由下面的 fetchLiked() 拉真实值回填
  bookmarked.value = false; // 第 9 批：星标同理，由下面的 fetchBookmarked() 回填
  series.value = null; // 第 10 批：系列横幅同理，复位后按新文章的 seriesId 重新拉

  try {
    article.value = await getArticle(route.params.id);
    setTitle(`${article.value.title} - 博客广场`);

    // 还原点赞按钮态（已登录才有意义）。不 await：它不是阅读正文的前置条件，
    // 慢了也不该拖住渲染，与下面的 loadNeighbors 同口径。
    fetchLiked();

    // 第 9 批：还原星标初始态（同 fetchLiked 口径，不 await）。
    fetchBookmarked();

    // 第 9 批：记录一次阅读（免登录，不 await 阻塞渲染；判重在后端）。
    recordView();

    // 第 10 批：文章绑定了系列时拉系列详情（不 await，横幅慢点出现没关系）。
    fetchSeries();
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

/* --------------------------------------------------------------------------
 * 第 6 批：历史版本 / 回滚
 * ------------------------------------------------------------------------ */

const revisionsVisible = ref(false);
const revisionsLoading = ref(false);
const revisions = ref([]);
const restoringId = ref(null);

/** 打开抽屉并拉取版本历史。每次打开都重拉（刚保存过的话列表会变）。 */
async function openRevisions() {
  revisionsVisible.value = true;
  revisionsLoading.value = true;

  try {
    const data = await listRevisions(articleId.value);
    revisions.value = (data && data.revisions) || [];
  } catch (error) {
    ElMessage.error(error.message || '版本历史加载失败');
    revisionsVisible.value = false;
  } finally {
    revisionsLoading.value = false;
  }
}

/**
 * 回滚到指定版本。后端「先快照当前版、后覆盖」，回滚本身也可再回滚，
 * 所以确认框不用吓唬用户 —— 说清「当前内容会存为新版本」即可。
 * 成功后关闭抽屉并整页重载（正文 / 阅读时长 / TOC 都要跟着变）。
 */
async function handleRestore(rev) {
  try {
    await ElMessageBox.confirm('回滚后当前内容会先存为一个新版本，确认回滚到所选版本？', '提示', {
      type: 'warning',
      confirmButtonText: '回滚',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 用户取消
  }

  restoringId.value = rev.id;

  try {
    await restoreArticle(articleId.value, rev.id);

    ElMessage.success('已回滚到所选版本');
    revisionsVisible.value = false;
    load();
  } catch (error) {
    ElMessage.error(error.message || '回滚失败，请稍后重试');
  } finally {
    restoringId.value = null;
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
/* 第 12 批：举报 dialog 顶部说明文字。 */
.report-tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-muted);
}

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

/* 第 7 批：标签行。与卡片 chip 同视觉语言（# 前缀胶囊），hover 给品牌色反馈；
   负 margin 让标签行与 meta 行贴紧（meta 自带 24px 下边距）。 */
.article-detail-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: -14px 0 20px;
}

.article-detail-tags-label {
  font-size: 12px;
  color: var(--text-faint);
}

.article-detail-tag-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border: 1px solid var(--border-light);
  border-radius: var(--chip-radius);
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--transition-base), border-color var(--transition-base), background var(--transition-base);
}

.article-detail-tag-chip:hover,
.article-detail-tag-chip:focus-visible {
  color: var(--brand-start);
  border-color: rgba(var(--brand-rgb), 0.4);
  background: rgba(var(--brand-rgb), 0.06);
  outline: none;
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

/* 第 9 批：阅读量 chip。被动展示（cursor: help 只因外层带 tooltip），
   与阅读时长 chip 同款式但用中性弱化色 —— 阅读量是统计数据，不是内容属性，
   不该和「预计阅读时长」抢同一个强调色。 */
.article-detail-view {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--border-light);
  border-radius: var(--chip-radius);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: help;
  font-variant-numeric: tabular-nums;
}

/* 第 9 批：收藏星标。与点赞按钮同形（22px 矮胶囊，meta 行不抢标题视觉重心），
   换 --bookmark-* 琥珀色板；星标不带计数（全站收藏数对读者没有意义）。 */
.article-detail-bookmark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
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

.article-detail-bookmark:hover {
  border-color: var(--bookmark-border);
  background: var(--bookmark-bg);
  color: var(--bookmark-color);
}

.article-detail-bookmark:focus-visible {
  outline: 2px solid var(--bookmark-color);
  outline-offset: 2px;
}

.article-detail-bookmark.is-bookmarked {
  border-color: var(--bookmark-border);
  background: var(--bookmark-bg-active);
  color: var(--bookmark-color);
}

.article-detail-bookmark.is-busy {
  opacity: 0.6;
  pointer-events: none;
}

.article-detail-bookmark-icon {
  font-size: 13px;
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

/* 第 6 批：历史版本抽屉内部 */
.revision-item {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

.revision-item.is-current {
  background: var(--bg-subtle);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  border-bottom: none;
}

.revision-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.revision-tag {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--chip-radius);
  background: var(--chip-bg-accent);
  border: 1px solid var(--chip-border-accent);
  color: var(--chip-text-accent);
  font-size: 12px;
  line-height: 1;
}

.revision-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.revision-time {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-faint);
  cursor: help;
}

.revision-meta {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

/* 全量 content 滚动预览（方案 A：响应里就带全文，不再二次请求）。
   pre 保留换行与空格；max-height 兜住超长正文，避免一条版本撑爆抽屉。 */
.revision-content {
  margin: 8px 0 0;
  padding: 10px 12px;
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-subtle);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-regular);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.revision-foot {
  margin-top: 8px;
  text-align: right;
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

/* 第 10 批：系列横幅。位于标签行下、正文上（用户拍板），琥珀色系呼应收藏星标
   （同属「内容组织」类元素，不抢品牌色）。 */
.series-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: -6px 0 20px;
  padding: 10px 14px;
  border: 1px solid var(--bookmark-border);
  border-radius: 10px;
  background: var(--bookmark-bg);
}

.series-banner-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.series-banner-tag {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--chip-radius);
  background: var(--bookmark-bg-active);
  color: var(--bookmark-color);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.series-banner-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.series-banner-pos {
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.series-banner-nav {
  display: flex;
  align-items: center;
  gap: 12px;
}

.series-banner-link {
  font-size: 13px;
  color: var(--bookmark-color);
  cursor: pointer;
  user-select: none;
  transition: opacity var(--transition-base);
}

.series-banner-link:hover,
.series-banner-link:focus-visible {
  text-decoration: underline;
  outline: none;
}

.series-banner-link.is-disabled {
  color: var(--text-faint);
  cursor: not-allowed;
  text-decoration: none;
}
</style>
