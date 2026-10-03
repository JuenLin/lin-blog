<template>
  <div class="user-profile">
    <div class="user-profile-inner">
      <!-- 头部：作者信息 + 返回广场。作者名从命中文章里取昵称 / 用户名；
           若 100 窗内没有该作者的文章（0 篇），退化为「用户 #id」。 -->
      <div class="profile-head">
        <!-- 第五处头像渲染（第十一批补）：前四处是 UserDropdown / ArticleCard /
             AuthorCard / CommentList，都走 resolveAvatar；这里原本只渲染文字头像，
             第九批漏了，导致「上传了头像却在个人主页看不到」。
             两种形态同样用 v-if 分支：有 avatar 渲染 <img>，否则回退色块 + 首字。 -->
        <img
          v-if="avatarInfo.type === 'image' && !avatarBroken"
          class="profile-avatar-img"
          :src="avatarInfo.src"
          :alt="displayName"
          @error="avatarBroken = true"
        />
        <span v-else class="profile-avatar" :style="{ backgroundColor: fallbackColor }">{{ fallbackText }}</span>
        <div class="profile-meta">
          <h1 class="profile-name">{{ displayName }} 的主页</h1>
          <p class="profile-sub">
            {{ total }} 篇文章<template v-if="capped"><span class="profile-cap">（仅显示最近 100 篇）</span></template>
          </p>
        </div>
        <el-button class="profile-back" text @click="goHome">返回广场</el-button>
      </div>

      <!-- 骨架屏：复用全局 .sk-card（形状与 ArticleCard 完全一致，B1 同形贴骨）。
           只在「首次加载」出现；翻页是纯前端切片，不重新请求，故不重复骨架。 -->
      <el-skeleton v-if="loading && !initialized" animated>
        <template #template>
          <div v-for="i in SKELETON_COUNT" :key="i" class="sk-card">
            <div class="sk-row">
              <div class="el-skeleton__item sk-avatar"></div>
              <div class="el-skeleton__item sk-line" style="width: 84px"></div>
              <div class="el-skeleton__item sk-line" style="width: 60px"></div>
            </div>
            <div class="el-skeleton__item sk-line-lg" style="width: 44%; height: 18px; margin-top: 12px"></div>
            <div class="el-skeleton__item sk-line" style="width: 92%; margin-top: 10px"></div>
            <div class="el-skeleton__item sk-line" style="width: 72%; margin-top: 8px"></div>
          </div>
        </template>
      </el-skeleton>

      <template v-else>
        <!-- 空态复用 EmptyState：该作者 0 篇时给出明确文案 -->
        <EmptyState v-if="!filtered.length" :description="emptyText" />

        <template v-else>
          <div class="profile-list">
            <ArticleCard v-for="item in pagedList" :key="item.id" :article="item" />
          </div>

          <!-- 分页复用现有 Pagination；total 取前端过滤后的真实条数（受 100 窗上限约束） -->
          <Pagination
            v-model:page="page"
            v-model:page-size="pageSize"
            :total="total"
            @change="handlePageChange"
          />
        </template>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { listArticles } from '../api/article.js';
import { getAvatarColor, getAvatarText, resolveAvatar } from '../utils/format.js';
import ArticleCard from '../components/ArticleCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Pagination from '../components/Pagination.vue';

// 个人主页（第一步 ①）：纯前端，不改接口 / 不改 schema / 不动契约。
// 用现有 GET /api/articles 拉「最近 100 篇」窗口，前端按 author.id 过滤出该作者的文章。
// 已知限制：单用户超过 100 篇时只能看到最近 100 篇（pageSize 上限 = 后端 MAX_PAGE_SIZE，契约 §7 / §11）。
// 分页是纯前端切片：数据已在 100 窗内，翻页 / 改每页条数不再打接口。

const SKELETON_COUNT = 5;
const WINDOW_SIZE = 100; // 与后端 MAX_PAGE_SIZE 对齐，一次拉满一窗

const route = useRoute();
const router = useRouter();

// 路由参数可能是非数字；非法时记 null，命中逻辑直接返回空（不至于 NaN 串进 UI）。
const targetId = computed(() => {
  const n = Number(route.params.id);
  return Number.isFinite(n) ? n : null;
});

const all = ref([]); // 100 窗内全部文章
const filtered = ref([]); // 命中所选作者的那部分
const initialized = ref(false);
const loading = ref(false);

const page = ref(1);
const pageSize = ref(10);

const authorInfo = computed(() => {
  const hit = filtered.value.find((a) => a.author);
  return hit ? hit.author : null;
});

const displayName = computed(() => {
  const a = authorInfo.value;
  if (a) return a.nickname || a.username || '匿名';
  return targetId.value === null ? '用户' : `用户 #${targetId.value}`;
});

// 头像形态由 resolveAvatar 统一决定：有 avatar 渲染 <img>，否则色块 + 首字。
// authorInfo 在「该作者 0 篇」时为 null，resolveAvatar 内部有 truthy 判断，自然回退文字头像。
const avatarInfo = computed(() => resolveAvatar(authorInfo.value, displayName.value));
const fallbackText = computed(() => getAvatarText(displayName.value));
const fallbackColor = computed(() => getAvatarColor(displayName.value));

// 图片加载失败（文件被手工删了 / 悬空引用）时回退到色块 + 首字。
// 头像 URL 服务端只校验形态、不保证可达（docs/API.md），所以这是常态路径之一，不是兜底。
// 关键：作者切换时必须复位，否则跳到下一个作者会沿用上一次的失败状态。
const avatarBroken = ref(false);

watch(
  () => route.params.id,
  () => {
    avatarBroken.value = false;
  }
);

// 过滤后的真实条数（受 100 窗上限约束，可能小于作者实际总数）
const total = computed(() => filtered.value.length);
// 命中数恰好达到窗口上限，说明可能还有更老的没拉到 —— 给个提示
const capped = computed(() => total.value >= WINDOW_SIZE);

const pagedList = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return filtered.value.slice(start, start + pageSize.value);
});

const emptyText = computed(() => {
  const a = authorInfo.value;
  const name = a ? a.nickname || a.username || '该作者' : targetId.value === null ? '用户' : `用户 #${targetId.value}`;
  return `${name} 还没有发布文章`;
});

async function load() {
  loading.value = true;
  try {
    const data = await listArticles({
      page: 1,
      pageSize: WINDOW_SIZE,
      sortBy: 'createdAt',
      order: 'desc',
    });
    const list = (data && data.list) || [];
    all.value = list;
    filtered.value = list.filter(
      (a) => a.author && targetId.value !== null && Number(a.author.id) === targetId.value
    );
  } catch (error) {
    // 错误提示由 request.js 拦截器统一抛出；列表加载失败落到空态，不卡在 loading。
    ElMessage.error(error.message || '加载失败');
  } finally {
    loading.value = false;
    initialized.value = true;
  }
}

// 分页是纯前端切片：只在 @change 里更新页码 / 每页条数，不重新发请求。
function handlePageChange({ page: nextPage, pageSize: nextPageSize }) {
  page.value = nextPage;
  pageSize.value = nextPageSize;
}

function goHome() {
  router.push({ name: 'home' });
}

// 在个人主页之间跳转（换了 :id）时重新拉取窗口
watch(
  () => route.params.id,
  () => {
    page.value = 1;
    load();
  }
);

onMounted(load);
</script>

<style scoped>
.user-profile {
  padding: 24px 16px 48px;
}

.user-profile-inner {
  max-width: 800px;
  margin: 0 auto;
  text-align: left;
}

.profile-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 20px;
}

.profile-avatar,
.profile-avatar-img {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-brand);
  font-size: 20px;
  font-weight: 600;
  flex: 0 0 auto;
}

/* object-fit: cover —— 上传的原图长宽比不确定，不裁会撑变形 */
.profile-avatar-img {
  object-fit: cover;
  display: block;
}

.profile-meta {
  flex: 1 1 auto;
  min-width: 0;
}

.profile-name {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-strong);
}

.profile-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}

.profile-cap {
  color: var(--text-faint);
}

.profile-back {
  flex: 0 0 auto;
}

/* 列表容器：与首页同形，复用 ArticleCard 的外边距 / 间距体系 */
.profile-list {
  margin-top: 4px;
}
</style>
