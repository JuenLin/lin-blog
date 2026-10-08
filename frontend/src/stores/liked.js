import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { listMyLikes } from '../api/user.js';

/**
 * 「我赞过的文章 id」的前端缓存。
 *
 * ## 为什么需要它
 *
 * 列表类接口（广场 / 用户文章 Tab / 详情页其他文章）都是**公开接口**，
 * 按 docs/API.md 的通用约定**不返回 liked**（原因：响应不能随登录态变化，否则公共缓存失效）。
 * 所以 ArticleCard 上那颗爱心，以前只能表示「本次会话里你在这张卡上点过」——
 * 刷新一下就回到空心，用户再点一次才会拿到 409「已点赞过这篇文章」。
 *
 * 本 store 补上这个缺口：登录后拉一次自己的点赞清单，卡片渲染时查集合，命中即红。
 *
 * ## 为什么用「拉点赞清单」而不是批量查询接口
 *
 * 契约里没有 `GET /api/articles/liked?ids=...`。加一个要走完整的契约流程
 * （API 草案 → 确认 → DB.md → 后端 → 前端 → 探针 → 文档），
 * 而 `GET /api/users/me/likes` 是第 2 批刚做完的现成接口，重复利用即零契约改动。
 *
 * ## ⚠️ 两条职责边界（务必分清，混了就会出 bug）
 *
 * **1. Set 是「真相来源」，只在请求成功之后才改，不做乐观更新。**
 *
 *    与之对照，ArticleCard 里的 `likeCountOverride` 是「即时反馈」，点击后立刻 +1。
 *    两者分工是故意的：
 *      - Set 只为解决「刷新 / 换页之后还认得 red 态」，不负责点击手感；
 *      - 点击手感由 likeCountOverride 提供（本地态，本来就有）；
 *      - 所以 Set 等响应回来再改是安全的，代价只有 ~100ms 的延迟，且这段延迟期间
 *        卡片本来也已经在 `is-busy`（半透明 + 禁用），用户看不出差别。
 *    反过来若做乐观更新，回滚路径容易漏（网络超时 / 409 / 404 三种都要回滚），
 *    收益却已经被 likeCountOverride 拿走了 —— 不划算。
 *
 * **2. 缓存会过期，但「过期」的表现必须是退化，不是错态。**
 *
 *    - `truncated`（赞过的文章超过一次拉取上限）：集合不完整，未命中的卡片维持空心；
 *    - 跨设备 / 跨标签页不同步：另一个地方点的赞，这个标签页不知道。
 *
 *    两种情况都表现为「空心的卡片点了才变红」——也就是改之前的旧行为。
 *    ArticleCard 里既有的 409 catch 会把 Set 纠正过来，所以最坏情况是**一次多余的点击**，
 *    不是显示错误。**MVP 接受这个精度，不做 storage 事件监听**（跨标签同步的复杂度不值）。
 */

// 单页拉取条数。`GET /api/users/me/likes` 的 pageSize 上限是 100（契约），取满。
const PAGE_SIZE = 100;

// 补拉页数上限：100 × 10 = 1000 篇。超过就置 truncated 走降级。
// 一个真实用户赞过 1000 篇文章是小概率事件，为此多打几十个请求不值得。
const MAX_PAGES = 10;

export const useLikedStore = defineStore('liked', () => {
  // Set 的元素统一存 number。后端 id 是自增 int，但 URL 参数和某些调用点是 string，
  // 所以读写两侧都过 Number()，避免 `1` 和 1 判不中的经典坑。
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
   * 会把匿名访问首页的读者踢走（这条纪律与详情页的 `getArticleLiked` 一致，见 api/like.js 注释）。
   */
  async function ensureLoaded() {
    if (initialized.value || loading.value) return;

    loading.value = true;

    try {
      let page = 1;
      let totalPages = 1;

      do {
        const data = await listMyLikes({ page, pageSize: PAGE_SIZE });
        const rows = data && data.list ? data.list : [];

        for (const row of rows) {
          const id = toId(row && row.id);

          if (id != null) idSet.add(id);
        }

        // 后端保证返回 totalPages（见 docs/API.md 第 2 批第 3 个接口）。
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

  /** 请求成功后写回。只由 ArticleCard / ArticleDetail 的成功分支调用，不做事前乐观写入。 */
  function add(id) {
    const numeric = toId(id);

    if (numeric != null) idSet.add(numeric);
  }

  /** 取消点赞成功后写回。重复删同一个 id 无害。 */
  function remove(id) {
    const numeric = toId(id);

    if (numeric != null) idSet.delete(numeric);
  }

  /**
   * 清空。必须在**登出**和**切换账号**时调用，否则会串号 ——
   * 前一个账号赞过的文章，在后一个账号的首页上也会显示成红色。
   * 这是本方案最容易出的真 bug，探针有专门断言覆盖（见 probe-card-liked.mjs case 8）。
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
