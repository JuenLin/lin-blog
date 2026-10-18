import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { listMyBookmarks } from '../api/user.js';

/**
 * 「我收藏过的文章 id」的前端缓存。
 *
 * ## 与 liked.js 的关系
 *
 * 本 store 是 `stores/liked.js` 的**逐行对镜**（第 9 批）：同样是「公开列表接口不返回
 * 收藏态，登录后拉一次自己的清单补缺口」的模式。两边刻意保持同构 —— 改动一处时
 * 同步另一处，行为漂移会让两个按钮一个认刷新一个不认。
 *
 * 差异只有两点，都不改变架构：
 *   1. 数据源换成 `GET /api/users/me/bookmarks`（liked 用 /me/likes）；
 *   2. 顶部注释里不再重复「为什么用拉清单而不是批量查询接口」的论证，直接引用 liked.js。
 *
 * ## ⚠️ 两条职责边界（与 liked 完全相同，混了就会出 bug）
 *
 * **1. Set 是「真相来源」，只在请求成功之后才改，不做乐观更新。**
 *    点击手感由卡片 / 详情页的本地计数 override 提供，分工细节见 stores/liked.js 顶部。
 *
 * **2. 缓存会过期，但「过期」的表现必须是退化，不是错态。**
 *    - `truncated`（收藏数超过一次拉取上限）：集合不完整，未命中的卡片维持空心；
 *    - 跨设备 / 跨标签页不同步。
 *    两种情况都表现为「空心的星标点了才点亮」——即改之前的旧行为。**MVP 接受这个精度。**
 */

// 单页拉取条数。`GET /api/users/me/bookmarks` 的 pageSize 上限是 100（契约），取满。
const PAGE_SIZE = 100;

// 补拉页数上限：100 × 10 = 1000 篇。超过就置 truncated 走降级。
const MAX_PAGES = 10;

export const useBookmarksStore = defineStore('bookmarks', () => {
  // Set 的元素统一存 number（后端 id 是自增 int，URL 参数和某些调用点是 string），
  // 读写两侧都过 Number()，避免 `1` 和 1 判不中的经典坑。
  //
  // 用 reactive 而非 ref：Vue 3 的响应式系统原生代理 Set / Map，
  // 增删元素能触发依赖它的 computed 重算（这正是 ArticleCard 需要的）。
  const idSet = reactive(new Set());

  // SPA 生命周期内是否已拉过。true 时 ensureLoaded 直接返回，不再打接口。
  const initialized = ref(false);

  // 是否因超过 MAX_PAGES 而缓存不完整。true 不代表出错，只代表「可能有漏」。
  const truncated = ref(false);

  // 正在拉取。防止 AppHeader 与别处并发调用时重复打接口。
  const loading = ref(false);

  const count = computed(() => idSet.size);

  function toId(value) {
    return value == null || value === '' ? null : Number(value);
  }

  /**
   * 幂等初始化：整个 SPA 生命周期只真正拉一次。
   *
   * ⚠️ **未登录不要调** —— 接口强制 401，而 request.js 的 401 分支会清 token 并跳登录页，
   * 会把匿名访问首页的读者踢走（与 likedStore.ensureLoaded / getArticleLiked 同纪律）。
   */
  async function ensureLoaded() {
    if (initialized.value || loading.value) return;

    loading.value = true;

    try {
      let page = 1;
      let totalPages = 1;

      do {
        const data = await listMyBookmarks({ page, pageSize: PAGE_SIZE });
        const rows = data && data.list ? data.list : [];

        for (const row of rows) {
          const id = toId(row && row.id);

          if (id != null) idSet.add(id);
        }

        // 后端保证返回 totalPages（见 docs/API.md 第 9 批第 4 个接口）。
        // 拿不到就当只有一页，不至于把循环跑飞。
        totalPages = Number(data && data.totalPages) || 1;
        page += 1;
      } while (page <= totalPages && page <= MAX_PAGES);

      // 循环结束后：page 停在第一页没拉的位置。
      //   - 正常拉完：page === totalPages + 1 → 条件为 false
      //   - 被 MAX_PAGES 截断：page === MAX_PAGES + 1 且仍 <= totalPages → true
      truncated.value = page <= totalPages;
      initialized.value = true;
    } catch (error) {
      // 401 已由 request.js 处理（清 token + 跳登录）；其余错误（网络抖动 /
      // 服务端 500）一律**不改任何状态**，维持「全是空心」这个安全默认值。
      // 注意这里故意不置 initialized：留着 false 让下一次调用可以重试。
    } finally {
      loading.value = false;
    }
  }

  /** 收藏成功后写回。只由 ArticleCard / ArticleDetail 的成功分支调用，不做事前乐观写入。 */
  function add(id) {
    const numeric = toId(id);

    if (numeric != null) idSet.add(numeric);
  }

  /** 取消收藏成功后写回。重复删同一个 id 无害。 */
  function remove(id) {
    const numeric = toId(id);

    if (numeric != null) idSet.delete(numeric);
  }

  /**
   * 清空。必须在**登出**和**切换账号**时调用，否则会串号 ——
   * 前一个账号收藏过的文章，在后一个账号的卡片上也会点亮金色星标。
   * 挂在 userStore.setToken 里（login / register / logout / 401 全都经过那里），不会漏口径。
   */
  function reset() {
    idSet.clear();
    initialized.value = false;
    truncated.value = false;
    loading.value = false;
  }

  function has(id) {
    const numeric = toId(id);

    return numeric != null && idSet.has(numeric);
  }

  return {
    idSet,
    initialized,
    truncated,
    loading,
    count,
    ensureLoaded,
    add,
    remove,
    reset,
    has,
  };
});
