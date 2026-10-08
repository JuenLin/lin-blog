import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getMe, login as loginApi, register as registerApi } from '../api/auth.js';
import { useLikedStore } from './liked.js';

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
    logout,
  };
});
