import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getMe, login as loginApi, register as registerApi } from '../api/auth.js';
import { useLikedStore } from './liked.js';
import { useFollowingStore } from './following.js';

const TOKEN_KEY = 'token';

export const useUserStore = defineStore('user', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) || '');
  const user = ref(null);

  const isLogin = computed(() => Boolean(token.value));

  function setToken(value) {
    token.value = value || '';

    // token 一变，登录态就变了，likedStore 里那份「我赞过的文章」必然失效。
    // 挂在 setToken 而不是 logout 单个函数里：login / register / logout 全都经过这里，
    // 不会漏口径 —— 漏了就会出现「A 赞过的文章，在 B 的首页上也是红的」这种串号。
    //
    // 这里只清空，不重新拉取：拉取由 AppHeader 的 watch(token) 触发，
    // 那个 watch 在注销时不满足 isLogin 条件，自然不会给已登出的人打接口。
    useLikedStore().reset();

    // 第 4 批：同一个道理 ——「我关注的人」集合也必须跟着换人。
    // 漏了就会串号：A 关注过的人，在 B 的主页上显示成「已关注」，且 B 的关注数跟着错。
    useFollowingStore().reset();

    if (token.value) {
      localStorage.setItem(TOKEN_KEY, token.value);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }

  function setUser(value) {
    user.value = value || null;
  }

  async function login(payload) {
    const data = await loginApi(payload);

    setToken(data.token);
    setUser(data.user);

    return data;
  }

  async function register(payload) {
    return registerApi(payload);
  }

  async function fetchMe() {
    const data = await getMe();

    setUser(data);

    return data;
  }

  /**
   * 第 5 批：确保 user 已加载（没有才拉一次）。给 /admin 路由守卫用。
   *
   * 为什么需要它：刷新 /admin 时 AppHeader 的 fetchMe 是异步的，
   * 守卫直接读 userStore.user.role 可能拿到 null 把管理员误弹。
   * 守卫里 await 这个函数，user 到位后再判 role。
   *
   * 未登录返回 null（调用方自己决定跳登录还是回首页）。
   * @returns {Promise<object|null>} 当前 user 或 null
   */
  async function ensureLoaded() {
    if (user.value) {
      return user.value;
    }

    if (!isLogin.value) {
      return null;
    }

    return fetchMe();
  }

  function logout() {
    setToken('');
    setUser(null);
  }

  return {
    token,
    user,
    isLogin,
    setToken,
    setUser,
    login,
    register,
    fetchMe,
    ensureLoaded,
    logout,
  };
});
