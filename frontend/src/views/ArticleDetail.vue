<template>
  <div class="article-detail">
    <div class="article-detail-inner">
      <el-skeleton v-if="loading" :rows="6" animated />

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
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { deleteArticle, getArticle } from '../api/article.js';
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

  try {
    article.value = await getArticle(route.params.id);
  } catch (error) {
    // 文章不存在 / 已被软删除，后端返回 40400；详情页不抛红，按空态处理。
    article.value = null;
    notFound.value = true;
  } finally {
    loading.value = false;
  }
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
  color: #303133;
  word-break: break-word;
}

.article-detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 24px;
  font-size: 13px;
  color: #909399;
}

.article-detail-dot {
  color: #c0c4cc;
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
</style>
