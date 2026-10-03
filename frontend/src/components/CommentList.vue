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
                <!-- 头像两种形态（第九批）：有 avatar 外链渲染 <img>，否则回退色块 + 首字。
                     列表里每个作者是独立一条，所以失败状态按评论 id 记在 brokenAvatars 里，
                     不能用单个 ref ——否则一个作者的图片加载失败会让整页都显示成色块。 -->
                <img
                  v-if="commentAvatar(item).type === 'image' && !brokenAvatars[item.id]"
                  class="comment-avatar-img"
                  :src="commentAvatar(item).src"
                  :alt="authorName(item)"
                  @error="markAvatarBroken(item)"
                />
                <span
                  v-else
                  class="comment-avatar"
                  :style="{ backgroundColor: commentAvatar(item).color }"
                >
                  {{ commentAvatar(item).text }}
                </span>
                <span class="comment-author">{{ authorName(item) }}</span>
              </span>
              <!-- 方案 D：评论时间同样改相对时间（列表里绝对时间又长又占位），
                   悬停 tooltip 给绝对时间。 -->
              <el-tooltip
                :content="formatAbsoluteTime(item.createdAt)"
                placement="top"
              >
                <span class="comment-time">{{ formatRelativeTime(item.createdAt) }}</span>
              </el-tooltip>
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
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { listComments } from '../api/comment.js';
import { formatAbsoluteTime, formatRelativeTime, resolveAvatar } from '../utils/format.js';
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

// 头像形态（第九批）。resolveAvatar 用 truthy 检查，**author 没有 avatar 键时**
// （探针造的对象就是这种）会自然落到 text 分支。
// image 分支返回 { src }，text 分支返回 { text, color }，模板按type 取对应字段。
function commentAvatar(item) {
  const a = item && item.author;
  const info = resolveAvatar(a, authorName(item));

  if (info.type === 'image') {
    return info;
  }

  return { type: 'text', text: info.text, color: info.color };
}

// 外链图片加载失败的记录：key 是评论 id。
// 为什么按评论 id 而不是作者 id：同一个人可能评论多条，用评论 id 粒度最简单，
// 且一条评论的图片失败不影响同作者的其他评论。
// 换页/刷新时整体清空（见 load 的 finally）。
const brokenAvatars = reactive({});

function markAvatarBroken(item) {
  brokenAvatars[item.id] = true;
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
    // 换页/ 刷新后重置图片失败记录：新一页的头像重新尝试加载。
    // 不清的话，翻到下一页若有个别头像加载失败，会永久停留在色块形态。
    Object.keys(brokenAvatars).forEach((key) => {
      delete brokenAvatars[key];
    });
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

/* 图片头像（第九批）：与色块同尺寸，object-fit: cover 防变形 */
.comment-avatar-img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  flex-shrink: 0;
}

.comment-author {
  font-size: 13px;
  color: var(--text-regular);
}

.comment-time {
  font-size: 12px;
  color: var(--text-muted);
  cursor: help; /* 方案 D：走 tooltip 看绝对时间 */
}

.comment-content {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-strong);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
