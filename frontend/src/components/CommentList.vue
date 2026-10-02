<template>
  <div class="comment-list">
    <h3 class="comment-title">评论 {{ total }}</h3>

    <!-- B1：骨架屏贴形 —— 按「头像 + 昵称/时间 + 一行正文」的评论结构画，跟真实评论同高。
         B2：骨架只在首次出现；翻页 / 发表后刷新时保留旧评论。 -->
    <el-skeleton v-if="loading && !initialized" animated>
      <template #template>
        <div v-for="i in 3" :key="i" class="comment-item">
          <div class="sk-row">
            <div class="el-skeleton__item sk-avatar"></div>
            <div class="el-skeleton__item sk-line" style="width: 88px"></div>
            <div class="el-skeleton__item sk-line" style="width: 68px"></div>
          </div>
          <div class="el-skeleton__item sk-line" style="width: 64%; margin-top: 10px"></div>
        </div>
      </template>
    </el-skeleton>

    <template v-else>
      <EmptyState v-if="!list.length" description="还没有评论，来说两句吧" />

      <template v-else>
        <!-- B2：刷新期间旧评论留在原地，变淡 + 不可交互 -->
        <div class="comment-items" :class="{ 'is-refreshing': loading }">
          <div v-for="item in list" :key="item.id" class="comment-item">
            <div class="comment-item-head">
              <!-- 入口：评论者头像+昵称可点进 /user/:id。评论区没有外层 router-link，
                   这里不用 @click.stop 也不会误触发跳转。author 缺失时退化为纯展示（不可点）。 -->
              <span
                class="comment-author-link"
                :class="{ 'is-clickable': commentAuthorId(item) != null }"
                :role="commentAuthorId(item) != null ? 'link' : null"
                :tabindex="commentAuthorId(item) != null ? 0 : null"
                @click="goToProfile(commentAuthorId(item))"
                @keydown.enter="goToProfile(commentAuthorId(item))"
              >
                <span class="comment-avatar" :style="{ backgroundColor: getAvatarColor(authorName(item)) }">
                  {{ getAvatarText(authorName(item)) }}
                </span>
                <span class="comment-author">{{ authorName(item) }}</span>
              </span>
              <span class="comment-time">{{ formatTime(item.createdAt) }}</span>
            </div>

            <div class="comment-content">{{ item.content }}</div>
          </div>
        </div>

        <Pagination
          v-if="total > 0"
          v-model:page="page"
          v-model:page-size="pageSize"
          :total="total"
          @change="handlePageChange"
        />
      </template>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { listComments } from '../api/comment.js';
import { formatTime, getAvatarColor, getAvatarText } from '../utils/format.js';
import EmptyState from './EmptyState.vue';
import Pagination from './Pagination.vue';

const props = defineProps({
  articleId: {
    type: Number,
    required: true,
  },
});

const router = useRouter();

const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const loading = ref(false);

// B2：区分「首次加载」和「刷新」—— 骨架屏只在首次出现。
const initialized = ref(false);

// 入口：取评论者展示名 / id。API 保证内嵌 author（docs/API.md），
// 这里仍做空值兜底，避免 author 缺失时整页报错。
function authorName(item) {
  const a = item && item.author;
  return (a && (a.nickname || a.username)) || '匿名';
}

function commentAuthorId(item) {
  const a = item && item.author;
  return a && a.id != null ? a.id : null;
}

function goToProfile(id) {
  if (id == null) return;
  router.push({ name: 'user-profile', params: { id } });
}

async function load() {
  loading.value = true;

  try {
    const data = await listComments(props.articleId, {
      page: page.value,
      pageSize: pageSize.value,
      // 评论 sortBy 白名单只有 createdAt / id（docs/API.md），默认 createdAt desc。
      sortBy: 'createdAt',
      order: 'desc',
    });

    list.value = data.list;
    total.value = data.total;
  } catch (error) {
    // 错误提示由 request.js 的拦截器统一抛出。
    // B2：刷新失败时保留旧评论，不清空（同 Home.vue 的处理）。
  } finally {
    loading.value = false;
    initialized.value = true;
  }
}

// 严格遵守 Pagination.vue 的约定：只在 @change 里发请求，不 watch 分页状态。
function handlePageChange({ page: nextPage, pageSize: nextPageSize }) {
  page.value = nextPage;
  pageSize.value = nextPageSize;
  load();
}

onMounted(load);

// 发表评论后由详情页调用，重新拉第一页。
defineExpose({
  reload() {
    page.value = 1;
    load();
  },
});
</script>

<style scoped>
.comment-list {
  text-align: left;
}

.comment-title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-strong);
}

.comment-item {
  padding: 14px 0;
  border-bottom: 1px solid var(--border-light);
}

/* 评论列表最后一条不画分隔线（同第一批 A2 的思路：列表末尾不留悬空线条）。
   注意：B2 把评论整体包进了 .comment-items，所以「最后一条」现在真的是最后一个 div ——
   之前 Pagination 和评论是同级，:last-of-type 命中的是分页条，这条规则其实没生效。 */
.comment-item:last-of-type {
  border-bottom: none;
}

/* B2：刷新中的旧评论，变淡 + 不可交互 */
.comment-items {
  transition: opacity var(--transition-base);
}

.comment-items.is-refreshing {
  opacity: 0.5;
  pointer-events: none;
}

.comment-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

/* 入口：评论者头像+昵称整体可点。只有 is-clickable（拿到 author.id）才给可点反馈，
   避免「看着能点却点了没反应」。 */
.comment-author-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: var(--chip-radius);
}

.comment-author-link.is-clickable {
  cursor: pointer;
  transition: background var(--transition-base);
}

.comment-author-link.is-clickable:hover,
.comment-author-link.is-clickable:focus-visible {
  background: rgba(var(--brand-rgb), 0.1);
  outline: none;
}

.comment-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-brand);
  font-size: 12px;
  font-weight: 600;
}

.comment-author {
  font-size: 13px;
  color: var(--text-regular);
}

.comment-time {
  font-size: 12px;
  color: var(--text-muted);
}

.comment-content {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-strong);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
