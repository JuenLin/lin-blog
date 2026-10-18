<template>
  <div class="home">
    <div class="home-inner">
      <div class="home-head">
        <h1 class="home-title">博客广场</h1>

        <div class="home-head-right">
          <!-- 分类筛选：唯一数据源是 URL 上的 ?category=，与 keyword 正交可叠加。
               选项「全部分类」对应空值（删掉 query.category）；选中具体分类写入 query。
               切分类回第 1 页（与 search tip 同一理由：筛选变窄后原页码可能越界）。 -->
          <el-select
            :model-value="category"
            class="home-category-select"
            placeholder="全部分类"
            @change="handleCategoryChange"
          >
            <el-option label="全部分类" value="" />
            <el-option v-for="c in CATEGORIES" :key="c" :label="c" :value="c" />
          </el-select>

          <el-tabs v-model="activeTab" class="home-tabs" @tab-change="handleTabChange">
            <el-tab-pane label="最新" name="createdAt" />
            <el-tab-pane label="热门" name="likeCount" />
          </el-tabs>
        </div>
      </div>

      <!-- ⑦ 搜索状态提示条：有搜索词时明确告诉用户「正在看筛选结果」并给一个清空入口。
           不放这里的话，用户搜到 0 结果会以为博客空了。 -->
      <div v-if="keyword" class="home-search-tip">
        <span class="home-search-tip-text">
          正在搜索「<strong class="home-search-tip-kw">{{ keyword }}</strong>」，共 {{ total }} 篇
        </span>
        <el-button size="small" text type="primary" @click="clearKeyword">清空搜索</el-button>
      </div>

      <!-- 第 7 批：标签筛选提示条（与搜索提示条同款式）。 -->
      <div v-if="tag" class="home-search-tip">
        <span class="home-search-tip-text">
          「<strong class="home-search-tip-kw">{{ tag }}</strong>」标签下的文章，共 {{ total }} 篇
        </span>
        <el-button size="small" text type="primary" @click="clearTag">清除标签筛选</el-button>
      </div>

      <!-- 第 7 批：热门标签行。数据来自 GET /api/tags（articleCount 只数已发布文章）。
           点击 chip = 设置 ?tag= 筛选（与 category / keyword 正交叠加）；
           再次点击当前选中的 chip = 取消筛选。加载失败整行隐藏（增值信息，不报错打扰）。 -->
      <div v-if="hotTags.length" class="home-tags-row" data-testid="hot-tags-row">
        <span class="home-tags-label">热门标签</span>
        <button
          v-for="t in hotTags"
          :key="t.id"
          type="button"
          class="home-tag-chip"
          :class="{ 'is-active': tag === t.name }"
          @click="handleTagChipClick(t.name)"
        >
          {{ t.name }}
          <span class="home-tag-count">{{ t.articleCount }}</span>
        </button>
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
        <!-- ⑦ 两种空态要分开：有搜索词 0 结果 ≠ 博客没文章。
             混成一句话的话，用户会以为文章被清空了。 -->
        <EmptyState
          v-if="keyword && !list.length"
          :description="`没有找到与「${keyword}」相关的文章`"
        >
          <el-button type="primary" @click="clearKeyword">清空搜索</el-button>
        </EmptyState>

        <EmptyState v-else-if="!list.length" description="还没有文章，去写第一篇吧">
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
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { listArticles, listHotTags } from '../api/article.js';
import { useUserStore } from '../stores/user.js';
import ArticleCard from '../components/ArticleCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Pagination from '../components/Pagination.vue';

// Tab：「最新」= createdAt desc，「热门」= likeCount desc，两个值都在后端 sortBy 白名单里
// （docs/API.md 的白名单为 createdAt / updatedAt / id / likeCount，越界后端返回 40000）。
// 「热门」的排序在**后端 SQL 层**完成（关联计数排序，不是拉全量再排），口径是
// **all-time 累计点赞数**——不做时间窗衰减、不引入阅读量。并列时后端用 id desc 兜底
// 保证翻页稳定（见 utils/query.js 的 DEFAULT_SECONDARY_SORT）。
// 原先这里是「最近更新」Tab，2026-10-04 换成「热门」；updatedAt 仍在白名单里（接口不缩水），
// 只是前端不再暴露入口。
// 骨架屏画几张：跟真实卡片同形，取 5 张撑满一屏即可，不跟 pageSize 联动
// （pageSize 可能是 10 / 20，照它画会把首屏撑得很长）。
const SKELETON_COUNT = 5;

// 分类写死 4 个字符串（与后端 ARTICLE_CATEGORIES 一致，按用户拍板前端不抽常量文件）。
const CATEGORIES = ['技术', '生活', '随笔', '未分类'];

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

const activeTab = ref('createdAt');

// ⑦ 搜索词：唯一数据源是 URL 上的 ?keyword=，不另存一份本地 state。
// 这样刷新页面 / 浏览器前进后退 / 直接分享链接，行为都一致（不会出现「输入框有词但列表没筛」）。
const keyword = computed(() => {
  const value = route.query.keyword;
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : '';
});

// 分类筛选：与 keyword 同源（都从 URL 读），但独立存储、互不清除。
// 非法 / 空值归一为 ''（不过滤）。「全部分类」选项的 value 是 ''，选中即删 query。
const category = computed(() => {
  const value = route.query.category;
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && CATEGORIES.includes(raw) ? raw : '';
});

// 第 7 批：标签筛选。与 keyword / category 同套路 —— URL ?tag= 是唯一数据源，
// 刷新 / 前进后退 / 分享链接行为一致。大小写敏感（后端不折叠，前端原样传）。
const tag = computed(() => {
  const value = route.query.tag;
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '';
});

// 热门标签数据。加载失败静默隐藏整行（增值信息，不值得弹错误提示）。
const hotTags = ref([]);

async function loadHotTags() {
  try {
    const data = await listHotTags({ limit: 20 });
    hotTags.value = (data && data.list) || [];
  } catch {
    hotTags.value = [];
  }
}

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
      // ⑦ 无搜索词时传 undefined，axios 会直接不带这个参数（而不是 keyword= 空串），
      // 对应后端「空串视为不传」的语义。
      keyword: keyword.value || undefined,
      // 分类筛选：与 keyword 正交，可叠加。空串（「全部分类」）等同不过滤。
      category: category.value || undefined,
      // 第 7 批：标签筛选，与 keyword / category 三者正交可叠加。空值不带参数。
      tag: tag.value || undefined,
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

// ⑦ 清空搜索：只删 keyword，保留 pageSize 等其他 query，并回到第 1 页。
// 必须回到第 1 页 —— 搜索词变宽后原来的第 5 页可能已越界，会显示成空列表。
function clearKeyword() {
  const query = { ...route.query };
  delete query.keyword;
  router.push({ name: 'home', query });
}

// 分类下拉变化：只动 category，保留 keyword（与 keyword 正交），并回到第 1 页。
// 用 :model-value + @change 双向绑定到 URL，而不是本地 ref —— 与 keyword 同一套路，
// 刷新 / 前进后退行为一致。选中「全部分类」（value 为 ''）则删掉 query.category。
function handleCategoryChange(val) {
  const query = { ...route.query };
  if (val) {
    query.category = val;
  } else {
    delete query.category;
  }
  router.push({ name: 'home', query });
}

// 第 7 批：热门标签 chip 点击。当前已选中 → 取消筛选（toggle）；未选中 → 设为筛选。
// 与 keyword / category 互不清除（正交）。chip 点击回第 1 页由 watch(tag) 统一处理。
function handleTagChipClick(name) {
  const query = { ...route.query };
  if (tag.value === name) {
    delete query.tag;
  } else {
    query.tag = name;
  }
  router.push({ name: 'home', query });
}

// 清除标签筛选：只删 tag，保留 keyword / category。
function clearTag() {
  const query = { ...route.query };
  delete query.tag;
  router.push({ name: 'home', query });
}

onMounted(() => {
  load();
  loadHotTags();
});

// ⑦ 搜索词变化（含浏览器前进后退）→ 回到第 1 页重新拉。
// 刻意不复用 handleTabChange：那会把 activeTab 一起重置，而搜索时 Tab 排序是要保留的。
watch(keyword, () => {
  page.value = 1;
  load();
});

// 分类变化（含浏览器前进后退）→ 回到第 1 页重新拉。刻意不与 keyword watch 合并，
// 两者独立保留对方的筛选条件（正交）。
watch(category, () => {
  page.value = 1;
  load();
});

// 第 7 批：标签变化 → 回到第 1 页重新拉（标签筛选变窄后原页码可能越界，同 keyword 理由）。
watch(tag, () => {
  page.value = 1;
  load();
});
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

/* 标题左、分类下拉 + Tab 右的一组容器 */
.home-head-right {
  display: flex;
  align-items: center;
  gap: 18px;
  flex: 0 0 auto;
}

.home-category-select {
  width: 132px;
  height: 40px;
  /* 相对 Tab 整体下移 2px，视觉上不与 Tab 顶部齐平 */
  margin-top: 2px;
}

/* 让下拉内壳与 Tab 标题栏同高（实测 el-tabs__nav 为 40px）。
 * scoped 样式需 :deep() 穿透命中 el-select 内部元素；先 unset 默认 min-height(32px) 才能覆写 height。 */
.home-category-select :deep(.el-select__wrapper) {
  min-height: unset;
  height: 40px;
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

/* ⑦ 搜索提示条：贴在标题下方，用主色的浅底把「当前处于筛选状态」明确说出来。 */
.home-search-tip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -4px 0 16px;
  padding: 8px 12px;
  border: 1px solid rgba(var(--brand-rgb), 0.24);
  border-radius: 8px;
  background: rgba(var(--brand-rgb), 0.06);
  font-size: 13px;
  color: var(--text-regular);
}

.home-search-tip-kw {
  color: var(--brand-start);
  font-weight: 600;
}

/* 第 7 批：热门标签行。chip 用原生 button（可聚焦、可键盘操作），
   样式对齐 ArticleCard 的元数据 chip 视觉；选中态用品牌色浅底。 */
.home-tags-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: -6px 0 16px;
}

.home-tags-label {
  font-size: 13px;
  color: var(--text-muted);
  flex: 0 0 auto;
}

.home-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border: 1px solid var(--border-light);
  border-radius: var(--chip-radius);
  background: transparent;
  font-size: 12px;
  color: var(--text-regular);
  cursor: pointer;
  transition: background var(--transition-base), border-color var(--transition-base), color var(--transition-base);
}

.home-tag-chip:hover,
.home-tag-chip:focus-visible {
  border-color: rgba(var(--brand-rgb), 0.4);
  color: var(--brand-start);
  outline: none;
}

.home-tag-chip.is-active {
  background: rgba(var(--brand-rgb), 0.1);
  border-color: rgba(var(--brand-rgb), 0.4);
  color: var(--brand-start);
  font-weight: 600;
}

.home-tag-count {
  font-size: 11px;
  color: var(--text-faint);
}

.home-tag-chip.is-active .home-tag-count {
  color: var(--brand-start);
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
