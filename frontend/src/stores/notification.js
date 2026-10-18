import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getUnreadCount, markRead, markReadOne } from '../api/notification.js';

/**
 * 通知未读数缓存 + 轮询（第 8 批）。
 *
 * ## 与 liked / following store 的关系
 *
 * 那两个管的是「我赞过的文章 / 我关注的人」这种**集合型**状态（用 Set 当真相来源，
 * 成功后才写回，不做乐观更新 —— 见 stores/liked.js 顶部纪律）。
 *
 * 通知这里不一样：**没有「已读集合」需要前端缓存**。已读是后端 `readAt` 字段说了算，
 * 前端只关心一个标量——**未读数**（驱动铃铛红点），以及「全部已读 / 单条已读」两个动作。
 * 所以本 store 不存集合，只存一个数字 `unreadCount` + 轮询定时器。
 *
 * ## 轮询纪律（用户决策点 3）
 *
 *   - **只在已登录态开启**：`startPolling()` 由 AppHeader 在 `isLogin` 时调用，
 *     登出 / 组件卸载 / token 变更 → `stopPolling()` + `reset()`，防内存泄漏。
 *   - 30s 一次 `GET /api/notifications/unread-count`，只拉一个数字，开销极低。
 *   - 定时器 id 存模块级闭包变量（非响应式，避免 Vue 追踪它）。
 *
 * ## 为什么 reset() 挂在 userStore.setToken()
 *
 * 与 liked / following 同一条纪律（见 stores/user.js）：换账号 / 登出时，前一个人的
 * 未读数必须清空，否则铃铛会串号（A 的通知红点显示在 B 头上）。setToken 在
 * login / register / logout / 401 全经过，挂那里不会漏口径。
 */

// 轮询间隔：30s。用户决策点 3 明确规定。
const POLL_INTERVAL = 30 * 1000;

// 定时器句柄。模块级（store 工厂只跑一次），故意不 reactive。
let pollTimer = null;

export const useNotificationStore = defineStore('notification', () => {
  // 未读数（铃铛红点）。初始 0。
  const unreadCount = ref(0);

  // SPA 生命周期内是否已拉过一次（onMounted / watch 幂等防重）。
  const initialized = ref(false);

  // 正在拉未读数。防止并发重复打接口。
  const loading = ref(false);

  /**
   * 拉一次未读数（轮询 / 初始化共用）。
   * 失败一律**不改 unreadCount**（维持旧值，最坏只是红点晚一拍更新，不是错态）。
   */
  async function refreshUnread() {
    if (loading.value) return;

    loading.value = true;

    try {
      const data = await getUnreadCount();
      const n = Number(data && data.unreadCount);

      unreadCount.value = Number.isFinite(n) ? n : unreadCount.value;
      initialized.value = true;
    } catch (error) {
      // 401 由 request.js 处理（清 token + 跳登录）；其余错误退化为「不动红点数」。
    } finally {
      loading.value = false;
    }
  }

  /**
   * 开启轮询。重复调用安全（先清再建，不会叠加多个定时器）。
   * ⚠️ 必须已登录才调 —— 匿名访问会吃 401 被踢去登录页。
   */
  function startPolling() {
    stopPolling();

    // 进页面先立刻拉一次，避免铃铛在第一次轮询前一直显示旧值。
    refreshUnread();

    pollTimer = setInterval(() => {
      refreshUnread();
    }, POLL_INTERVAL);
  }

  /** 停止轮询。登出 / 卸载 / 换号前必须调，否则定时器泄漏。 */
  function stopPolling() {
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * 全部已读。调用 `PUT /notifications/read` 传空数组（API.md：空数组 = 全部已读）。
   * 成功把未读数清 0；失败不动（红点晚清，非错态）。
   */
  async function markAll() {
    try {
      await markRead([]);
      unreadCount.value = 0;
    } catch (error) {
      // 网络 / 服务端错误：维持原红点数，用户可重试。
    }
  }

  /**
   * 单条已读。调用 `PUT /notifications/:id/read`（已读 / 不存在 / 非本人 → 200 幂等）。
   * 成功未读数 -1（最小 0）；失败不 -1（避免红点变负）。
   *
   * @param {number|string} id 通知 id
   */
  async function markOne(id) {
    try {
      await markReadOne(id);
      unreadCount.value = Math.max(0, unreadCount.value - 1);
    } catch (error) {
      // 同上：失败不动。
    }
  }

  /**
   * 清空并停轮询。登录态变化时（登出 / 换号）由 userStore.setToken() 调用。
   * 这里只清红点数 + 定时器 + 标志位，**不重新拉取**（拉取由 AppHeader 的
   * watch(token) 在登录态满足时重新 startPolling 触发）。
   */
  function reset() {
    stopPolling();
    unreadCount.value = 0;
    initialized.value = false;
    loading.value = false;
  }

  return {
    unreadCount,
    initialized,
    loading,
    refreshUnread,
    startPolling,
    stopPolling,
    markAll,
    markOne,
    reset,
  };
});
