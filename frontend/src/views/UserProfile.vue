<template>
  <div class="user-profile">
    <div class="user-profile-inner">
      <!-- 头部：作者信息 + 三个计数 + 返回广场。
           第 2 批起数据源是 GET /api/users/:id，不再从「命中的文章」反推 author ——
           旧实现该用户 0 篇文章时 authorInfo 为 null，头部退化成「用户 #id」，
           昵称 / 头像 / 简介全丢。现在接口有值就用，0 篇也正常显示。 -->
      <div class="profile-head">
        <!-- 头像渲染（第十一批补，第五处）：两种形态用 v-if 分支，有 avatar 渲染 <img>，
             否则回退色块 + 首字。avatarBroken 是图片加载失败的运行时状态，
             换人时必须复位，否则跳到下一个用户会沿用上一次的失败态。 -->
        <img
          v-if="avatarInfo.type === 'image' && !avatarBroken"
          class="profile-avatar-img"
          :src="avatarInfo.src"
          :alt="displayName"
          @error="avatarBroken = true"
        />
        <span v-else class="profile-avatar" :style="{ backgroundColor: fallbackColor }">{{ fallbackText }}</span>
        <div class="profile-meta">
          <!-- 昵称行：第 4 批把「关注 / 编辑资料」放在昵称右侧（margin-left:auto 推到行尾）。
               不放“返回广场”旁边 —— 那是「退出页面」的导航，这是「与这个人建立关系」的动作，
               两类不同性质的按钮并排会抢注意力。 -->
          <div class="profile-nameline">
            <h1 class="profile-name">
              {{ displayName }} 的主页
              <!-- 第 5 批：管理员徽章。role 来自 GET /api/users/:id（已透出）。 -->
              <UserBadge :role="detail?.role" />
            </h1>
          </div>

          <p class="profile-sub">
            <template v-if="detail">
              {{ detail.articleCount }} 篇文章 · {{ detail.receivedLikeCount }} 获赞 ·
              {{ detail.receivedCommentCount }} 收到评论

              <!-- 粉丝 / 关注列表的**唯一入口**。刻意做成不带数字的纯文字链接：
                   显示数字就得为每个主页多打两个请求（followers / following 各一次），
                   而这两个列表本身只是辅助视图，不值得在主页常驻成本。
                   唯一例外是自己的主页那条「N 关注」——数字来自 followingStore，零成本。 -->
              ·
              <router-link class="profile-stat" :to="{ name: 'user-follows', params: { id: targetId, type: 'following' } }">
                {{ followingLinkText }}
              </router-link>
              ·
              <router-link class="profile-stat" :to="{ name: 'user-follows', params: { id: targetId, type: 'followers' } }">
                {{ followersLinkText }}
              </router-link>
            </template>
            <template v-else-if="detailError">该用户不存在或已注销</template>
            <template v-else>加载中…</template>
          </p>
          <p v-if="detail && detail.bio" class="profile-bio">{{ detail.bio }}</p>
        </div>

        <!-- 第 5 批 fix：把动作按钮和「返回广场」放进同一个 flex 容器，
             用 align-items: center 保证两者严格垂直居中对齐。
             之前按钮嵌在 .profile-meta 内部，meta 因 bio 变高后中心线错位。 -->
        <div class="profile-actions">
          <!-- 三态互斥（v-if / v-else-if / v-else），不会有同时出现或都不出现的情况：
               isOwner → 编辑资料（自己不能关注自己，后端会 400，所以不放关注按钮）
               未关注（**含未登录**）→ 关注（未登录点击跳登录，带 redirect 回来）
               已关注 → 已关注（点击=取关，无二次确认：关系幂等，再关注回来只要一次点击） -->
          <el-button v-if="isOwner" class="profile-action" @click="goEditProfile">编辑资料</el-button>
          <el-button
            v-else-if="!following"
            class="profile-action"
            type="primary"
            :loading="followPending"
            @click="toggleFollow"
          >
            关注
          </el-button>
          <el-button v-else class="profile-action" :loading="followPending" @click="toggleFollow">
            已关注
          </el-button>
          <el-button class="profile-back" text @click="goHome">返回广场</el-button>
        </div>
      </div>

      <!-- 404：用户不存在 / 已软删。整页退化成一个提示。
           注意这与「用户存在但 0 篇文章」是两件事 —— 后者正常渲染头部 + 空列表。 -->
      <EmptyState v-if="detailError" :description="detailError" />

      <template v-else>
        <el-tabs v-model="activeTab" class="profile-tabs" @tab-change="handleTabChange">
          <el-tab-pane label="文章" name="articles" />
          <!-- 点赞 / 收藏 / 草稿 Tab 仅本人可见：查的是 /users/me/*，接口只允许查自己。
               isOwner 是 computed，userStore.user 到位后（AppHeader 的 fetchMe 返回）
               Tab 自动出现，不需要刷新页面。首屏 user 还没到位时会短暂只有文章 Tab。 -->
          <el-tab-pane v-if="isOwner" label="点赞" name="likes" />
          <!-- 第 9 批：收藏 Tab。与点赞 Tab 同规格（仅本人、复用 ArticleCard、
               默认排序 bookmarkedAt desc 不暴露排序控件）。 -->
          <el-tab-pane v-if="isOwner" label="收藏" name="bookmarks" />
          <!-- 第 6 批：草稿箱。草稿不进公开详情（DRAFT 详情一律 404），所以列表行
               不能复用 ArticleCard（它会跳详情页），用自定义行 + 「继续编辑」入口。 -->
          <el-tab-pane v-if="isOwner" label="草稿" name="drafts" />
        </el-tabs>

        <!-- 刷新条 + 半透明列表：只在「initialized 之后的再次加载」出现（翻页 / 改每页条数）。
             首屏走下面的骨架屏。与 Home.vue 的 .home-list.is-refreshing 同一套约定：
             保留旧列表不清空，避免翻页时闪白 + 滚动条跳动。 -->
        <div class="profile-refresh">
          <div class="profile-refresh-bar" :class="{ 'is-active': currentState.loading }"></div>
        </div>

        <!-- 骨架屏：复用全局 .sk-card（形状与 ArticleCard 完全一致，贴骨不位移）。
             **只给当前激活的 Tab 渲染**：首屏默认文章 Tab，切到点赞 Tab 才显示点赞的骨架。
             两个 Tab 共用同一套 SKELETON_COUNT / .sk-card 结构，不另造。 -->
        <el-skeleton v-if="currentState.loading && !currentState.initialized" animated>
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

        <div
          v-else
          class="profile-list"
          :class="{ 'is-refreshing': currentState.loading }"
        >
          <!-- 空态按 Tab 分开：0 篇 / 0 赞 / 0 草稿是三件事，共用一句会让用户以为数据丢了 -->
          <EmptyState v-if="!currentState.list.length" :description="currentState.emptyText" />

          <!-- 第 6 批：草稿列表。自定义行（不复用 ArticleCard）：
               草稿没有公开详情页，卡片点击会跳 404；行内直接给「继续编辑 / 删除」。 -->
          <template v-else-if="activeTab === 'drafts'">
            <div v-for="item in currentState.list" :key="item.id" class="draft-row">
              <div class="draft-main">
                <span class="draft-title">{{ item.title || '（无标题）' }}</span>
                <span class="draft-summary">{{ item.summary }}</span>
                <span class="draft-time">更新于 {{ formatRelativeTime(item.updatedAt) }}</span>
              </div>
              <div class="draft-actions">
                <el-button link type="primary" @click="goEditDraft(item.id)">继续编辑</el-button>
                <el-button link type="danger" @click="handleDeleteDraft(item)">删除</el-button>
              </div>
            </div>

            <Pagination
              :page="currentState.page"
              :page-size="currentState.pageSize"
              :total="currentState.total"
              @change="handlePageChange"
            />
          </template>

          <template v-else>
            <ArticleCard v-for="item in currentState.list" :key="item.id" :article="item" />

            <!-- 分页：total 是后端 COUNT 的真实总数（不再是前端过滤后的条数）。
                 翻页在 @change 里发请求，遵守 Pagination.vue 顶部约定：
                 不 watch(page) / watch(pageSize)，否则一次操作打两遍接口。 -->
            <Pagination
              :page="currentState.page"
              :page-size="currentState.pageSize"
              :total="currentState.total"
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
import { ElMessage, ElMessageBox } from 'element-plus';
import { getUser, listMyBookmarks, listMyLikes, listUserArticles, followUser, unfollowUser } from '../api/user.js';
import { deleteDraft, listMyDrafts } from '../api/article.js';
import {
  formatRelativeTime,
  getAvatarColor,
  getAvatarText,
  resolveAvatar,
} from '../utils/format.js';
import { useUserStore } from '../stores/user.js';
import { useFollowingStore } from '../stores/following.js';
import ArticleCard from '../components/ArticleCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Pagination from '../components/Pagination.vue';
import UserBadge from '../components/UserBadge.vue';

// 个人主页（第 2 批）：三个后端接口 + el-tabs + 真后端分页。
// 旧实现是「拉全站最近 100 篇再前端过滤+ 前端切片假分页」，本批全部换掉：
//   GET /api/users/:id           头部（昵称 / 头像 / 简介 / 三个计数）
//   GET /api/users/:id/articles  文章 Tab，真后端分页
//   GET /api/users/me/likes      点赞 Tab，仅本人
//
// 分页语义变了：Pagination 的 total 从「前端切片后的条数（受 100 窗约束）」
// 变成「后端 COUNT 的真实总数」。因此不再需要 capped（仅显示最近 100 篇）提示 ——
// 真后端分页没有 100 窗概念，留着是错的。

const SKELETON_COUNT = 5;

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const followingStore = useFollowingStore();

// 路由参数可能是非数字；非法时记 null，命中逻辑直接返回空（不至于 NaN 串进 UI）。
const targetId = computed(() => {
  const n = Number(route.params.id);
  return Number.isFinite(n) && n > 0 ? n : null;
});

const detail = ref(null);
const detailError = ref('');

const activeTab = ref('articles');

// 两个 Tab 各自一组状态，互不影响。切 Tab / 换人时只动其中一组。
function makeTabState(emptyText) {
  return reactive({
    list: [],
    total: 0,
    page: 1,
    pageSize: 10,
    loading: false,
    initialized: false,
    emptyText,
  });
}

const articlesState = makeTabState('还没有发布文章');
const likesState = makeTabState('还没有点赞过任何文章');
// 第 9 批：收藏 Tab。与点赞 Tab 完全对镜（同样的 makeTabState 模式）。
const bookmarksState = makeTabState('还没有收藏过任何文章');
const draftsState = makeTabState('还没有草稿，去写一篇吧');

const currentState = computed(() => {
  if (activeTab.value === 'likes') return likesState;
  if (activeTab.value === 'bookmarks') return bookmarksState;
  if (activeTab.value === 'drafts') return draftsState;
  return articlesState;
});

// 是否是「自己的主页」：点赞 Tab 只对本人可见（接口只允许查自己）。
// 必须是 computed —— userStore.user 是异步到位的（AppHeader 调 fetchMe），
// 一次性判断会在首屏 user 为 null 时算出 false 且再也不更新，Tab 永远不出现。
const isOwner = computed(() => {
  if (!userStore.isLogin) return false;
  const me = userStore.user;
  const id = targetId.value;
  if (!me || id === null) return false;
  return Number(me.id) === id;
});

// ---- 第 4 批：关注按钮 + 粉丝/关注列表入口 ----

// 是否已关注：**「我关注的人」集合是唯一真相来源**。
// 现有接口里没有任何一个返回这个布尔值（GET /users/:id 只有文章维度的三个计数），
// 所以只能靠 followingStore。集合未拉取或拉失败时为 false，
// 表现为「点了才知道已关注」——这是降级，不是错态。
const following = computed(() => followingStore.has(targetId.value));

// 请求中：按钮 :loading + 禁用，避免连点打出两个相反的请求。
const followPending = ref(false);

// 链接文案：别人的主页一律纯文字；自己的主页第一条**带免费数字** ——
// followingStore 登录后已经拉过自己的关注列表，这个数字不需要额外请求。
// 集合还没就绪时退化成「我的关注」，不闪 undefined、不占位跳动。
const followingLinkText = computed(() => {
  if (!isOwner.value) return '他关注';

  return followingStore.initialized ? `${followingStore.myFollowingCount} 关注` : '我的关注';
});

// 自己主页显示「我的粉丝」，别人主页显示「他的粉丝」。
// 都不带数字：我的粉丝数没有免费数据源，拿它要为个人主页常驻一个请求，不划算。
const followersLinkText = computed(() => (isOwner.value ? '我的粉丝' : '他的粉丝'));

/**
 * 关注 / 取关。
 *
 * 两个接口都**幂等**：重复关注、取消没关注过的都返回 200 / code 0，
 * 所以这里不需要 catch 任何「已关注 / 没关注」的错误码 —— 不存在。
 * （与 like 那两个接口的 409 / 404 刻意相反，别照着那里的写法改。）
 */
async function toggleFollow() {
  const id = targetId.value;

  if (id === null) return;

  // 未登录：先去登录，带 redirect 回来继续对话。不等后端返回 401 再处理 ——
  // 那已经是一次注定失败的请求了。
  if (!userStore.isLogin) {
    goLogin();
    return;
  }

  if (followPending.value) return;

  followPending.value = true;

  try {
    const data = following.value ? await unfollowUser(id) : await followUser(id);

    // 集合只在请求成功后改（不做乐观更新）——失败路径都要回滚，收益却不划算。
    if (data && data.following) {
      followingStore.add(id);
    } else {
      followingStore.remove(id);
    }

    // ⚠️ 响应里的 followerCount 属于「这个人」，followingCount 属于「我」。
    // 本页不显示对方的关注 / 粉丝数（需要额外请求），所以这两个值**都不落到 UI**，不是漏写；
    // 自己主页那个「N 关注」由 followingStore 的 ±1 维护。
  } catch (error) {
    ElMessage.error(error.message || '操作失败，请稍后重试');
  } finally {
    followPending.value = false;
  }
}

function goLogin() {
  router.push({ name: 'login', query: { redirect: route.fullPath } });
}

// 编辑资料：跳 /settings/profile（route name 是 settings-profile，见 router/index.js）。
// 这是**第三个**入口 —— 另外两个是右上角 UserDropdown 的「设置」与 Settings 侧栏的
// 「编辑资料」，两者都不改，这里只是补一条「从自己的主页直接改资料」的直觉路径。
function goEditProfile() {
  router.push({ name: 'settings-profile' });
}

const displayName = computed(() => {
  const d = detail.value;
  if (d) return d.nickname || d.username || '匿名';
  return targetId.value === null ? '用户' : `用户 #${targetId.value}`;
});

// 头像形态由 resolveAvatar 统一决定：有 avatar 渲染 <img>，否则色块 + 首字。
// detail 为 null（加载中 / 出错）时 resolveAvatar 内部有truthy 判断，自然回退文字头像。
const avatarInfo = computed(() => resolveAvatar(detail.value, displayName.value));
const fallbackText = computed(() => getAvatarText(displayName.value));
const fallbackColor = computed(() => getAvatarColor(displayName.value));

// 图片加载失败（文件被手工删了 /悬空引用）时回退到色块 + 首字。
// 换人时必须在下面的 watch 里复位，否则跳到下一个用户会沿用上一次的失败状态。
const avatarBroken = ref(false);

/**
 * 重置某个 Tab 的状态。切 Tab / 换人时调用。
 * 注意要把 initialized 一起归 false —— 否则切回来时 initialized 仍是 true，
 * 骨架屏不出现，页面会先闪一下空列表再出数据。
 */
function resetTabState(state) {
  state.list = [];
  state.total = 0;
  state.page = 1;
  state.loading = false;
  state.initialized = false;
}

function resetAll() {
  resetTabState(articlesState);
  resetTabState(likesState);
  resetTabState(bookmarksState);
  resetTabState(draftsState);
  activeTab.value = 'articles';
}

async function loadDetail() {
  const id = targetId.value;
  if (id === null) {
    detailError.value = '用户不存在或已注销';
    return;
  }
  try {
    detail.value = await getUser(id);
    detailError.value = '';
  } catch (error) {
    // 错误提示由 request.js 拦截器统一抛出；头部信息拿不到时退化成整页错误态。
    detail.value = null;
    detailError.value = error.businessCode === 40400 ? '用户不存在或已注销' : '加载失败，请稍后重试';
  }
}

async function loadArticles() {
  const id = targetId.value;
  if (id === null) return;
  articlesState.loading = true;
  try {
    const data = await listUserArticles(id, {
      page: articlesState.page,
      pageSize: articlesState.pageSize,
    });
    articlesState.list = (data && data.list) || [];
    articlesState.total = (data && data.total) || 0;
  } catch (error) {
    ElMessage.error(error.message || '加载失败');
  } finally {
    articlesState.loading = false;
    articlesState.initialized = true;
  }
}

async function loadLikes() {
  likesState.loading = true;
  try {
    // sortBy 用默认值 likedAt desc（最近点赞的在前）。Tab 不暴露排序控件。
    const data = await listMyLikes({
      page: likesState.page,
      pageSize: likesState.pageSize,
    });
    likesState.list = (data && data.list) || [];
    likesState.total = (data && data.total) || 0;
  } catch (error) {
    ElMessage.error(error.message || '加载失败');
  } finally {
    likesState.loading = false;
    likesState.initialized = true;
  }
}

// 第 9 批：收藏列表。与 loadLikes 完全对镜（照抄改接口名与 state 名）：
// 默认 bookmarkedAt desc（最近收藏的在前），Tab 不暴露排序控件。
// list[] 与点赞 Tab 同形（toArticleListItem + 平铺 bookmarkedAt），ArticleCard 原样复用。
async function loadBookmarks() {
  bookmarksState.loading = true;
  try {
    const data = await listMyBookmarks({
      page: bookmarksState.page,
      pageSize: bookmarksState.pageSize,
    });
    bookmarksState.list = (data && data.list) || [];
    bookmarksState.total = (data && data.total) || 0;
  } catch (error) {
    ElMessage.error(error.message || '加载失败');
  } finally {
    bookmarksState.loading = false;
    bookmarksState.initialized = true;
  }
}

// 第 6 批：草稿箱列表。默认 updatedAt 倒序（最近编辑的在前），Tab 不暴露排序控件。
// list[] 每条带 content 全文（回填编辑器用），本页只渲染 summary，不浪费渲染。
async function loadDrafts() {
  draftsState.loading = true;
  try {
    const data = await listMyDrafts({
      page: draftsState.page,
      pageSize: draftsState.pageSize,
    });
    draftsState.list = (data && data.list) || [];
    draftsState.total = (data && data.total) || 0;
  } catch (error) {
    ElMessage.error(error.message || '加载失败');
  } finally {
    draftsState.loading = false;
    draftsState.initialized = true;
  }
}

/** 继续编辑草稿：进编辑器（同组件会识别出这是草稿并回填全文）。 */
function goEditDraft(id) {
  router.push({ name: 'editor-edit', params: { id } });
}

/** 删除草稿（物理删除，草稿无评论/点赞/版本，可安全硬删）。 */
async function handleDeleteDraft(item) {
  try {
    await ElMessageBox.confirm('草稿删除后不可恢复，确认删除？', '提示', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 用户取消
  }

  try {
    await deleteDraft(item.id);
    ElMessage.success('草稿已删除');

    // 当前页删空且不是第一页时回退一页，避免停在空页上。
    if (draftsState.list.length === 1 && draftsState.page > 1) {
      draftsState.page -= 1;
    }
    loadDrafts();
  } catch (error) {
    ElMessage.error(error.message || '删除失败，请稍后重试');
  }
}

/**
 * 切 Tab。三个要点：
 * 1. **必须把目标 Tab 的 page 重置为 1**。文章停在第 3 页时切到点赞（可能只有 1 页），
 *    沿用旧页码会拿到空列表，看起来像「他没赞过」。与首页切分类同一理由。
 * 2. **先清空目标 Tab 的列表**。切 Tab 属于换了数据集，不清会短暂显示上一个 Tab 的内容。
 * 3. **每次切 Tab 都重新请求**（不做「首次才发」的短路）。
 *
 *    ⚠️ 这里踩过一次真bug：早期写成
 *        state.list = []; if (state.initialized) return;
 *    结果「清空」之后被短路挡住，loadArticles() 根本没被调用 ——
 *    切回文章 Tab 时列表永远停在空态（探针实测 cards=0、空态文案「还没有发布文章」、
 *    Network 域抓到**零个** /articles 请求）。清空与发请求必须成对出现，
 *    不能用一个「已加载过」的标志把发请求挡掉。
 *
 *    语义上也**就该**每次重拉：Tab 的数据是可能变的（别人新发了文章、
 *    自己刚取消点赞），缓存旧列表给用户看不准确的数据反而是错的。
 *    initialized 只用于「首次加载才显示骨架屏」，不承担跳过请求的职责。
 */
function handleTabChange(name) {
  const state =
    name === 'likes'
      ? likesState
      : name === 'bookmarks'
        ? bookmarksState
        : name === 'drafts'
          ? draftsState
          : articlesState;
  state.page = 1;
  state.list = [];
  state.total = 0;
  // 让骨架屏重新出现：这次是「换数据集」，不是「翻页保旧列表」
  state.initialized = false;

  if (name === 'likes') loadLikes();
  else if (name === 'bookmarks') loadBookmarks();
  else if (name === 'drafts') loadDrafts();
  else loadArticles();
}

/**
 * 翻页 / 改每页条数。只在 Pagination 的 @change 里发请求，
 * 不 watch(page) / watch(pageSize)（Pagination.vue 顶部约定，否则一次操作打两遍）。
 */
function handlePageChange({ page, pageSize }) {
  const state = currentState.value;
  state.page = page;
  state.pageSize = pageSize;
  if (activeTab.value === 'likes') loadLikes();
  else if (activeTab.value === 'bookmarks') loadBookmarks();
  else if (activeTab.value === 'drafts') loadDrafts();
  else loadArticles();
}

function goHome() {
  router.push({ name: 'home' });
}

// 换人（:id 变）：头部与两个 Tab 全部重置，initialized 归 false 重走骨架屏。
// 新用户不能沿用上一个人的列表 / 页码 / 计数。
//
// ⚠️ 这里曾经是**两个** watch(() => route.params.id)：一个只复位 avatarBroken，
// 一个做 resetAll + 加载。两个都合法、都会触发，但同一 source 拆成两处，
// 将来有人加第三个就会搞不清顺序（比如谁先清谁后加载）。
// 现在合并成一个，一个 watch 做一件事的完整集合：
//   ① 复位头像失败态 ② 清空头部 ③ 重置两个 Tab ④ 重新加载
watch(
  () => route.params.id,
  () => {
    // ① 头像失败态必须复位，否则跳到下一个人会沿用上一次的破图状态
    avatarBroken.value = false;
    // ② 头部先清空，避免短暂显示上一个人的昵称 / 计数
    detail.value = null;
    detailError.value = '';
    // ③ 两个 Tab 全清（页码、列表、initialized）
    resetAll();
    // ④ 重新加载：头部详情 + 默认文章 Tab
    loadDetail();
    loadArticles();
  }
);

// 【已删】原来这里有个 watch(isOwner)：userStore.user 到位、isOwner 翻 true 时
// 若当前在点赞 Tab 就补 loadLikes()。它现在**有害**—— 是重复请求的第二个来源：
// AppHeader 异步 fetchMe() 落地的那一刻，watch 与 handleTabChange 各发一次
// /users/me/likes（探针实测同一 URL 发两条）。
// 根因是 handleTabChange 曾经被「首次才发」的短路挡住，两处都要兜同一个空缺。
// 现在 handleTabChange 每次切 Tab 都发，这个 watch 的存在前提已消失，删掉。
//
// 为什么不需要兜底：点赞 Tab 由 v-if="isOwner" 控制，isOwner 为 false 时
// **这个 Tab 根本不存在**，用户点不到它；等 isOwner 变 true、Tab 出现时，
// 用户第一次点它必然触发 handleTabChange → loadLikes()。没有「Tab 在但没数据」的窗口。

onMounted(() => {
  loadDetail();
  loadArticles();
});
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

/* 简介：单行省略，避免长 bio 把头部撑得很高 */
.profile-bio {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 第 4 批：昵称行 —— 名字在左，动作按钮贴行尾。
   min-width:0 让长昵称不把按钮顶出容器。 */
.profile-nameline {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

/* 第 5 批 fix：动作按钮与「返回广场」共用同一个 flex 容器，严格垂直居中对齐。 */
.profile-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}

.profile-action {
  flex: 0 0 auto;
}

/* 第 4 批：粉丝 / 关注列表入口。视觉上就是普通弱化文字，hover 才给出可点提示 ——
   它是入口而不是主要信息，不该在副标题里抢「文章 / 获赞 / 评论」的注意力。 */
.profile-stat {
  color: var(--text-muted);
  text-decoration: none;
}

.profile-stat:hover,
.profile-stat:focus-visible {
  color: var(--accent);
  text-decoration: underline;
}

.profile-back {
  flex: 0 0 auto;
}

/* Tab 样式与 Home.vue 完全一致（同一份视觉语言）：
   header 外边距归零而不是用负 margin 抵消，底部 2px 灰线换成 1px 浅色线。 */
.profile-tabs :deep(.el-tabs__header) {
  margin: 0;
}

.profile-tabs :deep(.el-tabs__nav-wrap)::after {
  height: 1px;
  background: var(--border);
}

/* 顶部 2px 刷新条：只在翻页 / 改每页条数时动，指示「在加载但旧内容还在」 */
.profile-refresh {
  height: 2px;
  margin-bottom: 12px;
  overflow: hidden;
  border-radius: 1px;
  background: var(--border);
}

.profile-refresh-bar {
  width: 30%;
  height: 100%;
  border-radius: 1px;
  background: var(--accent);
  opacity: 0;
  transition: opacity var(--transition-base);
}

.profile-refresh-bar.is-active {
  opacity: 1;
  animation: profile-refresh-slide 1.1s ease-in-out infinite;
}

@keyframes profile-refresh-slide {
  0% {
    transform: translateX(-120%);
  }

  100% {
    transform: translateX(360%);
  }
}

/* 列表容器：与首页同形，复用 ArticleCard 的外边距 / 间距体系 */
.profile-list {
  transition: opacity var(--transition-base);
}

.profile-list.is-refreshing {
  opacity: 0.5;
  pointer-events: none;
}

/* 第 6 批：草稿列表行。视觉密度比 ArticleCard 高（草稿是待办不是内容），
   标题 + 摘要一行省略 + 更新时间，右侧操作按钮。 */
.draft-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}

.draft-row:last-of-type {
  border-bottom: none;
}

.draft-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.draft-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.draft-summary {
  font-size: 13px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.draft-time {
  font-size: 12px;
  color: var(--text-faint);
}

.draft-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
}
</style>
