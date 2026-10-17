<template>
  <div class="user-follows">
    <div class="user-follows-inner">
      <!-- 头部：返回 + 标题。标题里的昵称要额外拉一次 GET /users/:id ——
           列表接口只返回成员资料，拿不到"这个列表属于谁"。一次请求换一个清楚的标题，
           比让用户看「关注」两个字猜是谁的关注划算。 -->
      <div class="follows-head">
        <h1 class="follows-title">{{ title }}</h1>
        <el-button class="follows-back" text @click="goBack">返回主页</el-button>
      </div>

      <!-- 用户不存在 / 已软删：整页退化成提示，不再渲染列表骨架 -->
      <EmptyState v-if="targetError" :description="targetError" />

      <template v-else>
        <!-- 刷新条：只在「initialized 之后的再次加载」出现（翻页 / 改每页条数）。
             首屏走下面的骨架屏，避免闪白 + 滚动条跳动。与 UserProfile 同一套约定。 -->
        <div class="follows-refresh">
          <div class="follows-refresh-bar" :class="{ 'is-active': state.loading }"></div>
        </div>

        <el-skeleton v-if="state.loading && !state.initialized" animated>
          <template #template>
            <div v-for="i in SKELETON_COUNT" :key="i" class="sk-row">
              <div class="el-skeleton__item sk-avatar"></div>
              <div class="el-skeleton__item sk-line" style="width: 120px"></div>
              <div class="el-skeleton__item sk-line" style="width: 80px"></div>
            </div>
          </template>
        </el-skeleton>

        <div v-else class="follows-list" :class="{ 'is-refreshing': state.loading }">
          <!-- 空态按 type 分开：没粉丝和没关注过是两件事，共用一句会让人以为数据丢了 -->
          <EmptyState v-if="!state.list.length" :description="emptyText" />

          <template v-else>
            <!-- 列表项：整行就是一个 router-link（这里没有外层 <a>，不需要 ArticleCard 那套
                 span + .prevent.stop 的绕法），点任意位置进该用户主页。
                 ⚠️ 刻意**不放**行内的「关注 / 已关注」按钮：router-link 里嵌可交互元素
                 又是 ArticleCard 踩过的坑，且翻页后还要逐个重算按钮态。本批不做。 -->
            <router-link
              v-for="item in state.list"
              :key="item.id"
              class="follow-row"
              :to="{ name: 'user-profile', params: { id: item.id } }"
            >
              <img
                v-if="avatarInfo(item).type === 'image' && !brokenMap[item.id]"
                class="follow-avatar-img"
                :src="avatarInfo(item).src"
                :alt="displayNameOf(item)"
                @error="brokenMap[item.id] = true"
              />
              <span v-else class="follow-avatar" :style="{ backgroundColor: fallbackColor(item) }">
                {{ fallbackText(item) }}
              </span>

              <span class="follow-meta">
                <span class="follow-name">{{ displayNameOf(item) }}</span>
                <span class="follow-username">@{{ item.username }}</span>
              </span>

              <!-- 相对时间 + hover 出绝对时间（与 ArticleCard 同一写法）。
                   ⚠️ 取 followedAt（关注发生时间），**不是** createdAt ——
                   createdAt 来自 PUBLIC_FIELDS，是**该用户的注册时间**，语义完全不同。 -->
              <span class="follow-time" :title="absoluteTimeOf(item.followedAt)">
                {{ relativeTimeOf(item.followedAt) }}
              </span>
            </router-link>

            <!-- 真后端分页：total 是 COUNT 出来的真实总数。
                 只在 @change 里发请求，不 watch(page)（Pagination.vue 顶部约定）。 -->
            <Pagination
              :page="state.page"
              :page-size="state.pageSize"
              :total="state.total"
              @change="handlePageChange"
            />
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { getUser, listFollowers, listFollowing } from '../api/user.js';
import {
  formatAbsoluteTime,
  formatRelativeTime,
  getAvatarColor,
  getAvatarText,
  resolveAvatar,
} from '../utils/format.js';
import EmptyState from '../components/EmptyState.vue';
import Pagination from '../components/Pagination.vue';

// 第 4 批：粉丝 / 关注列表页（GET /api/users/:id/followers|following）。
//
// 状态机完全沿用 UserProfile.vue 的写法（tabState + initialized + 骨架屏 + 刷新条），
// 两个页面同一套视觉与时序约定，将来改动一处另一处也认得出来。
const SKELETON_COUNT = 6;

const route = useRoute();
const router = useRouter();

// 路由参数可能是非数字；非法时记 null，直接进错误态（不至于 NaN 串进 URL）。
const targetId = computed(() => {
  const n = Number(route.params.id);

  return Number.isFinite(n) && n > 0 ? n : null;
});

// 非法 type 已被 router 的 beforeEnter 挡在外面，这里只需要二选一。
// 兜底是 followers（上面的 if 不命中就是非法值），同时打一句 warn：
// 万一将来有人改掉 beforeEnter，至少有日志可查，不至于静默显示错列表。
const type = computed(() => {
  if (route.params.type !== 'followers' && route.params.type !== 'following') {
    console.warn('[UserFollows] 非法的 type 参数：', route.params.type);
  }

  return route.params.type === 'following' ? 'following' : 'followers';
});

const isFollowers = computed(() => type.value === 'followers');

const targetName = ref('');
const targetError = ref('');

const state = reactive({
  list: [],
  total: 0,
  page: 1,
  pageSize: 10,
  loading: false,
  initialized: false,
});

const emptyText = computed(() => (isFollowers.value ? '还没有粉丝' : '还没有关注任何人'));

const title = computed(() => {
  const who = targetName.value || (targetId.value === null ? '用户' : `用户 #${targetId.value}`);

  return `${who} 的${isFollowers.value ? '粉丝' : '关注'}`;
});

// 逐个 id 记「头像加载失败」（文件被手工删了 / 悬空引用），失败就回退色块头像。
// 用对象当 Map：key 是用户 id，方便模板里直接查 brokenMap[item.id]。
const brokenMap = reactive({});

function displayNameOf(item) {
  return item.nickname || item.username || '匿名';
}

// 头像形态由 resolveAvatar 统一决定（有 avatar 渲染 img，否则色块 + 首字），
// 与 UserProfile / AuthorCard / ArticleCard 同一套。
function avatarInfo(item) {
  return resolveAvatar(item, displayNameOf(item));
}

function fallbackText(item) {
  return getAvatarText(displayNameOf(item));
}

function fallbackColor(item) {
  return getAvatarColor(displayNameOf(item));
}

function relativeTimeOf(value) {
  return formatRelativeTime(value);
}

function absoluteTimeOf(value) {
  return formatAbsoluteTime(value);
}

async function loadTarget() {
  const id = targetId.value;

  if (id === null) {
    targetError.value = '用户不存在或已注销';
    return;
  }

  try {
    const detail = await getUser(id);

    targetName.value = detail.nickname || detail.username || '';
    targetError.value = '';
  } catch (error) {
    targetName.value = '';
    targetError.value = error.businessCode === 40400 ? '用户不存在或已注销' : '加载失败，请稍后重试';
  }
}

async function loadList() {
  const id = targetId.value;

  if (id === null) return;

  state.loading = true;

  try {
    // sortBy 不传，用后端默认 followedAt desc（最近发生的关系在前）。页面不暴露排序控件。
    const data =
      type.value === 'followers'
        ? await listFollowers(id, { page: state.page, pageSize: state.pageSize })
        : await listFollowing(id, { page: state.page, pageSize: state.pageSize });

    state.list = (data && data.list) || [];
    state.total = (data && data.total) || 0;
  } catch (error) {
    ElMessage.error(error.message || '加载失败');
  } finally {
    state.loading = false;
    state.initialized = true;
  }
}

function handlePageChange({ page, pageSize }) {
  state.page = page;
  state.pageSize = pageSize;
  loadList();
}

function goBack() {
  router.push({ name: 'user-profile', params: { id: targetId.value } });
}

/** 归零。换人 / 换 type 时用，让骨架屏重新出现（这是"换数据集"，不是翻页保旧列表）。 */
function resetState() {
  state.list = [];
  state.total = 0;
  state.page = 1;
  state.loading = false;
  state.initialized = false;
}

// 换人或切换粉丝 / 关注：整个数据集都变了，全部重拉。
// 一个 watch 做完整一件事（清空 + 复位 + 重拉），不拆成多个同 source 的 watch。
watch([() => route.params.id, () => route.params.type], () => {
  targetName.value = '';
  targetError.value = '';
  resetState();
  loadTarget();
  loadList();
});

onMounted(() => {
  loadTarget();
  loadList();
});
</script>

<style scoped>
.user-follows {
  padding: 24px 16px 48px;
}

.user-follows-inner {
  max-width: 800px;
  margin: 0 auto;
  text-align: left;
}

.follows-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.follows-title {
  margin: 0;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-strong);
}

.follows-back {
  flex: 0 0 auto;
}

/* 顶部 2px 刷新条：只在翻页 / 改每页条数时动，指示「在加载但旧内容还在」 */
.follows-refresh {
  height: 2px;
  margin-bottom: 12px;
  overflow: hidden;
  border-radius: 1px;
  background: var(--border);
}

.follows-refresh-bar {
  width: 30%;
  height: 100%;
  border-radius: 1px;
  background: var(--accent);
  opacity: 0;
  transition: opacity var(--transition-base);
}

.follows-refresh-bar.is-active {
  opacity: 1;
  animation: follows-refresh-slide 1.1s ease-in-out infinite;
}

@keyframes follows-refresh-slide {
  0% {
    transform: translateX(-120%);
  }

  100% {
    transform: translateX(360%);
  }
}

.follows-list {
  transition: opacity var(--transition-base);
}

.follows-list.is-refreshing {
  opacity: 0.5;
  pointer-events: none;
}

/* 列表项：一行一个用户摘要（40px 头像 + 昵称 + @username + 右侧关注时间）。
   刻意**不显示 bio** —— 列表的重点是"谁、什么时候发生的"，简介会抢注意力且挤掉时间。 */
.follow-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 2px;
  border-bottom: 1px solid var(--border-light);
  text-decoration: none;
}

.follow-row:last-of-type {
  border-bottom: none;
}

.follow-avatar,
.follow-avatar-img {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-brand);
  font-size: 17px;
  font-weight: 600;
}

/* object-fit: cover —— 上传的原图长宽比不确定，不裁会撑变形 */
.follow-avatar-img {
  object-fit: cover;
  display: block;
}

.follow-meta {
  flex: 1 1 auto;
  min-width: 0;
}

.follow-name {
  display: block;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.follow-username {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.follow-time {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
