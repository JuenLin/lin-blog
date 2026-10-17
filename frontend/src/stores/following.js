import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { listFollowing } from '../api/user.js';

/**
 * 「我关注的人」的前端缓存（第 4 批）。
 *
 * 与 stores/liked.js **结构对称**（那里是「我赞过的文章」），这里只多了一个入参。
 *
 * ## 为什么需要它
 *
 * 现有接口里没有任何一个能告诉前端「我是否已关注他」：
 * `GET /api/users/:id` 只返回文章维度的三个计数（articleCount / receivedLikeCount /
 * receivedCommentCount），列表与详情类接口又按 docs/API.md 的约定「不随登录态变化」。
 * 少了这个缓存，个人主页的关注按钮就只能永远是「关注」，点一下靠 200 幂等成功才发现
 * 其实早就关注过 —— 用户永远看不到「已关注」这个状态，也就没法取关。
 *
 * ## 它的两个用途（缺一个就不值得单独建 store）
 *
 *   1. **关注按钮的初始态**：`has(id)` 决定渲染「关注」还是「已关注」
 *   2. **我自己关注了多少人**：`myFollowingCount`，给个人主页那个免费计数用
 *      （所以别人的主页不显示关注数 —— 那没有免费数据源）
 *
 * ## ⚠️ 两条纪律（与 likedStore 同一套，改这里前先看它）
 *
 * **1. Set 是「真相来源」，只在请求成功之后才改，不做乐观更新。**
 *    众多失败路径（网络超时 / 401 / 404）都要回滚乐观写入，收益却只是省掉
 *    ~100ms 的按钮变色延迟 —— 不划算。
 *
 * **2. 缓存会过期，但「过期」的表现必须是退化，不是错态。**
 *    - `truncated`：集合不完整（见下方精确语义），未命中的用户维持「未关注」；
 *    - 跨设备 / 跨标签页不同步：另一处点的关注，这个标签页不知道。
 *    两种情况都表现为「点了才知道已关注」，最坏情况是**一次多余的点击**，不是显示错误。
 *    **MVP 接受这个精度，不做 storage 事件监听**（跨标签同步的复杂度不值）。
 *
 * ## 为什么传 meId 而不是自己 import userStore
 *
 * 本文件**故意不 import userStore**：stores/user.js 里已经 import 了 liked.js，
 * 若这里再反向 import user.js 就会形成环。拉 `GET /api/users/{id}/following`
 * 需要自己的 id，所以由调用方把它传进来（AppHeader 传 `userStore.user.id`）。
 */

// 单页拉取条数。这里拉的是「我关注的人」，取列表接口的上限。
const PAGE_SIZE = 100;

export const useFollowingStore = defineStore('following', () => {
  // Set 的元素统一存 number。后端 id 是自增 int，但路由参数普遍是 string，
  // 所以读写两侧都过 Number()，避免 `1` 和 1 判不中的经典坑。
  //
  // 用 reactive 而非 ref：Vue 3 原生代理 Set，增删元素能触发依赖它的 computed 重算。
  const idSet = reactive(new Set());

  /**
   * 我关注了多少人。
   *
   * 取请求的 `total` 而不是 `idSet.size`：关注数超过一页时 Set 是不完整的，
   * 但 `total` 永远是真值。add / remove 时再各自 ±1 维护，**前提是幂等**（见下）。
   */
  const myFollowingCount = ref(0);

  // SPA 生命周期内是否已拉过。true 时 ensureLoaded 直接返回，不再打接口。
  const initialized = ref(false);

  /**
   * **精确语义（别写成"严重截断"）**：
   * `truncated === true` 只表示 **idSet 可能不完整**（关注人数 > PAGE_SIZE）。
   *
   * 之所以说"可能"：判据是 `totalPages > 1`，而 total=100 时 totalPages 仍是 1（不误报），
   * total=101 时 totalPages=2 就会置起 —— 可实际只漏了 1 个人。
   * 它只是一个**保守标记**：宁可标记着，也不要让人误以为集合一定完整。
   */
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
   * ⚠️ **未登录不要调** —— 虽然 `GET /users/:id/following` 是公开接口不需要登录，
   * 但这里拉的是"我"的关注列表，没有 id 就没有意义；调用方用 `userStore.user?.id` 把关即可。
   *
   * @param {number|null} meId 当前登录用户的 id；为空直接返回（等它到位由调用方再触发）
   */
  async function ensureLoaded(meId) {
    const id = toId(meId);

    if (initialized.value || loading.value || id == null) return;

    loading.value = true;

    try {
      const data = await listFollowing(id, { page: 1, pageSize: PAGE_SIZE });
      const rows = data && data.list ? data.list : [];

      for (const row of rows) {
        add(row && row.id);
      }

      myFollowingCount.value = Number(data && data.total) || idSet.size;

      const totalPages = Number(data && data.totalPages) || 1;
      truncated.value = totalPages > 1;

      initialized.value = true;
    } catch (error) {
      // 网络抖动 / 服务端 500：一律**不改任何状态**，维持「全是未关注」这个安全默认值。
      // 这里故意不置 initialized：留着 false 让下一次调用可以重试。
    } finally {
      loading.value = false;
    }
  }

  /**
   * 请求成功后写回。**幂等**：已在集合里则什么都不做，
   * 否则重复 add 同一个 id 会把 myFollowingCount 多加一次。
   *
   * ⚠️ truncated 场景下 add 可能把已关注的 id 当作新增而 +1。
   * 这是已知降级，不是 bug。刷新页面会修正。
   *
   * （场景：关注 150 人但 idSet 只装了前 100，遗漏 50 人。第 120 人 has() 为 false，
   * 用户点了关注 → 后端 P2002 幂等返回 200 → 这里 +1，计数 150 变 151。
   * 每点一次这类项就偏大 1，累计上限 = truncated 遗漏的人数；
   * 同一人只会贡献 1（点完按钮切已关注）。本批不修，刷新页面从 total 重新校准。）
   */
  function add(id) {
    const numeric = toId(id);

    if (numeric == null || idSet.has(numeric)) return;

    idSet.add(numeric);
    myFollowingCount.value += 1;
  }

  /** 取消关注成功后写回。删除不存在的 id 无害，也不减计数。 */
  function remove(id) {
    const numeric = toId(id);

    if (numeric == null || !idSet.has(numeric)) return;

    idSet.delete(numeric);
    myFollowingCount.value = Math.max(0, myFollowingCount.value - 1);
  }

  /**
   * 清空。必须在**登出**和**切换账号**时调用，否则会串号 ——
   * 前一个账号关注的人，在后一个账号的主页上也会显示成「已关注」。
   * 挂点在 stores/user.js 的 setToken()（login / register / logout / 401 全经过那里）。
   */
  function reset() {
    idSet.clear();
    myFollowingCount.value = 0;
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
    myFollowingCount,
    initialized,
    truncated,
    loading,
    count,
    ensureLoaded,
    has,
    add,
    remove,
    reset,
  };
});
