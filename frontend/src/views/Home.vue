<template>
  <div class="home">
    <div class="home-inner">
      <div class="home-head">
        <h1 class="home-title">博客广场</h1>

        <el-tabs v-model="activeTab" class="home-tabs" @tab-change="handleTabChange">
          <el-tab-pane label="最新" name="createdAt" />
          <el-tab-pane label="最近更新" name="updatedAt" />
        </el-tabs>
      </div>

      <!-- B1：骨架屏贴形 —— 骨架的外框（内边距 / 圆角 / 边框 / 阴影）跟 ArticleCard 一模一样，
           所以数据到位后只有内容在变，外框不动，不会有位移。
           B2：骨架只在「首次加载」出现；翻页 / 切 Tab 时保留旧列表（见 .home-list.is-refreshing）。 -->
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
        <EmptyState v-if="!list.length" description="还没有文章，去写第一篇吧">
          <!-- D1：空态加「写第一篇」入口；未登录时不显示（点进去也会跳登录页，不如不展示）。 -->
          <el-button v-if="userStore.isLogin" type="primary" @click="goCreate">写第一篇</el-button>
        </EmptyState>

        <template v-else>
          <!-- B2：刷新期间旧列表留在原地，只做「变淡 + 不可点」的反馈，
               不再整块换成骨架屏 —— 翻页时列表不会闪一下白。
               B2-补充：列表顶部 2px 刷新进度条（纯 CSS），让「正在刷新」可被感知。
               进度条放在 .home-list-region 上、与变淡的列表平级，所以不会跟着一起变灰。 -->
          <div class="home-list-region">
            <div class="home-refresh-bar" :class="{ 'is-active': loading }"></div>

            <div class="home-list" :class="{ 'is-refreshing': loading }">
              <ArticleCard v-for="item in list" :key="item.id" :article="item" />
            </div>
          </div>

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
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { listArticles } from '../api/article.js';
import { useUserStore } from '../stores/user.js';
import ArticleCard from '../components/ArticleCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Pagination from '../components/Pagination.vue';

// Tab 只保留「最新 / 最近更新」两个，对应 sortBy 白名单里的 createdAt / updatedAt
// （docs/API.md 的 sortBy 白名单为 createdAt / updatedAt / id，越界后端返回 40000）。
// 本期不做「热门」Tab：没有阅读量 / 点赞字段，做出来也是假的。
// 骨架屏画几张：跟真实卡片同形，取 5 张撑满一屏即可，不跟 pageSize 联动
// （pageSize 可能是 10 / 20，照它画会把首屏撑得很长）。
const SKELETON_COUNT = 5;

const router = useRouter();
const userStore = useUserStore();

const activeTab = ref('createdAt');

// B2：区分「首次加载」和「刷新」。首次才用骨架屏，之后一律保留旧列表。
const initialized = ref(false);

const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const loading = ref(false);

async function load() {
  loading.value = true;

  try {
    const data = await listArticles({
      page: page.value,
      pageSize: pageSize.value,
      sortBy: activeTab.value,
      order: 'desc',
    });

    list.value = data.list;
    total.value = data.total;
  } catch (error) {
    // 错误提示由 request.js 拦截器统一抛出。
    // B2：刷新失败时**保留旧列表**，不清空 —— 一次网络抖动不该把用户正在看的内容抹掉。
    // 首次加载就失败的话 list 本来就是空的，自然落到空态，不会卡在 loading。
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
    // 无论成功失败都算「已经初始化过」：骨架屏只在首屏出现一次，之后翻页都保留旧列表。
    initialized.value = true;
  }
}

// 严格遵守 Pagination.vue 的约定：只在 @change 里发请求，不 watch 分页状态。
function handlePageChange({ page: nextPage, pageSize: nextPageSize }) {
  page.value = nextPage;
  pageSize.value = nextPageSize;
  load();
}

// 切 Tab 等于换排序，回到第一页：不重置的话第 3 页切 Tab 可能直接越界成空列表。
function handleTabChange() {
  page.value = 1;
  load();
}

// D1：空态「写第一篇」按钮 → 跳新建文章页（未登录会被路由守卫拦到登录页）。
function goCreate() {
  router.push({ name: 'editor-create' });
}

onMounted(load);
</script>

<style scoped>
.home {
  padding: 24px 16px 48px;
}

.home-inner {
  max-width: 1120px;
  margin: 0 auto;
  text-align: left;
}

/* 优化第一批 A5：原来这里用 `.home-tabs{margin-bottom:-8px}` 去抵消 el-tabs 自带的
 * header 外边距，属于负 margin hack —— 组件内部结构一变就会错位。
 * 现在改成把 el-tabs 自己的 header 外边距归零，容器用正常的间距。
 */
.home-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.home-tabs {
  flex: 0 0 auto;
}

.home-tabs :deep(.el-tabs__header) {
  margin: 0;
}

/* el-tabs 底部那条 2px 灰线换成 1px 浅色线，配合浅色科技感的轻量视觉 */
.home-tabs :deep(.el-tabs__nav-wrap)::after {
  height: 1px;
  background: var(--border);
}

.home-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: var(--text-strong);
}

/* B2：刷新中的旧列表 —— 变淡 + 不可点。
   不可点很关键：旧卡片马上就要被替换，点进去会跳到「上一页的那篇」。 */
.home-list-region {
  position: relative;
}

/* B2-补充：列表顶部 2px 进度条。放在 .home-list-region 上、与变淡的列表平级，
   所以刷新时这条亮条不会被一起降到 0.5 透明度，用户能明确感知「在刷新」。 */
.home-refresh-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-base);
  z-index: 2;
}

.home-refresh-bar.is-active {
  opacity: 1;
}

/* 一条沿轨道滑动的品牌渐变高亮，纯 CSS @keyframes，不加依赖。 */
.home-refresh-bar::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 40%;
  background: var(--brand-gradient);
  animation: refresh-slide 1.1s ease-in-out infinite;
}

@keyframes refresh-slide {
  0% {
    transform: translateX(-120%);
  }

  100% {
    transform: translateX(360%);
  }
}

.home-list {
  transition: opacity var(--transition-base);
}

.home-list.is-refreshing {
  opacity: 0.5;
  pointer-events: none;
}
</style>
