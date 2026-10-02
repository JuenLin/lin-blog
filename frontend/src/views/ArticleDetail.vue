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
          <span>{{ formatTime(article.createdAt) }}</span>

          <!-- 编辑 / 删除只对作者本人显示，其余人看不到入口。 -->
          <template v-if="isAuthor">
            <el-button link type="primary" @click="goEdit">编辑</el-button>
            <el-button link type="danger" @click="handleDelete">删除</el-button>
          </template>
        </div>

        <ArticleContent :content="article.content" />

        <AuthorCard v-if="article.author" :author="article.author" class="article-detail-author" />

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
import { formatTime } from '../utils/format.js';
import { useUserStore } from '../stores/user.js';
import ArticleContent from '../components/ArticleContent.vue';
import AuthorCard from '../components/AuthorCard.vue';
import CommentEditor from '../components/CommentEditor.vue';
import CommentList from '../components/CommentList.vue';
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

async function load() {
  loading.value = true;
  notFound.value = false;
  neighborWindow.value = []; // 重置，避免从上一篇/下一篇跳转时残留旧文章的邻居

  try {
    article.value = await getArticle(route.params.id);
    setTitle(`${article.value.title} - 博客广场`);
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
