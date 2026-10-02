<template>
  <div class="comment-list">
    <h3 class="comment-title">评论 {{ total }}</h3>

    <el-skeleton v-if="loading" :rows="3" animated />

    <template v-else>
      <EmptyState v-if="!list.length" description="还没有评论，来说两句吧" />

      <template v-else>
        <div v-for="item in list" :key="item.id" class="comment-item">
          <div class="comment-item-head">
            <span class="comment-avatar" :style="{ backgroundColor: getAvatarColor(item.author.nickname || item.author.username) }">
              {{ getAvatarText(item.author.nickname || item.author.username) }}
            </span>
            <span class="comment-author">{{ item.author.nickname || item.author.username }}</span>
            <span class="comment-time">{{ formatTime(item.createdAt) }}</span>
          </div>

          <div class="comment-content">{{ item.content }}</div>
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

const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const loading = ref(false);

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
    // 错误提示由 request.js 的拦截器统一抛出，这里只保证列表停在空态而不是卡在 loading。
    list.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
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
  color: #303133;
}

.comment-item {
  padding: 12px 0;
  border-bottom: 1px solid #f5f5f5;
}

.comment-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.comment-avatar {
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

.comment-author {
  font-size: 13px;
  color: #606266;
}

.comment-time {
  font-size: 12px;
  color: #c0c4cc;
}

.comment-content {
  font-size: 14px;
  line-height: 1.6;
  color: #303133;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
