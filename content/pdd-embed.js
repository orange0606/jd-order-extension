/**
 * 拼多多内嵌登录态种子脚本（售后关联单「小窗」iframe 专用）
 * 背景：拼多多移动端除 Cookie 外，还把登录 token 存在 localStorage；
 *       跨站 iframe 的 localStorage 是独立空存储，页面 JS 校验失败会整页跳登录页。
 * 方案：
 *   1) 顶层拼多多页面（用户正常登录的标签页）：采集 localStorage + JS可见Cookie 快照存入 storage.local；
 *   2) iframe 内（京东售后页弹窗）：document_start 抢先把快照种回 localStorage / document.cookie。
 */
(function () {
  'use strict';
  var SEED_KEY = 'zcc_pdd_embed_seed';
  var isTop = false;
  try { isTop = (window.top === window); } catch (e) { isTop = false; }

  // ---------- 顶层页面：采集登录态快照 ----------
  function harvest() {
    try {
      var ls = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        ls[k] = localStorage.getItem(k);
      }
      var seed = { ls: ls, cookie: document.cookie || '', ts: Date.now(), href: location.href };
      chrome.storage.local.set({ zcc_pdd_embed_seed: seed }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      console.warn('[zcc-pdd-embed] 采集快照失败:', e);
    }
  }

  if (isTop) {
    harvest();
    // 页面加载完再采一次，覆盖刚登录/刷新token的情况
    window.addEventListener('load', function () { setTimeout(harvest, 1500); });
    return;
  }

  // ---------- iframe 内：种回登录态 ----------
  try {
    chrome.storage.local.get(SEED_KEY, function (res) {
      var seed = res && res[SEED_KEY];
      if (!seed) {
        console.warn('[zcc-pdd-embed] 无登录态快照，请先在普通标签页打开一次拼多多页面');
        return;
      }
      try {
        for (var k in seed.ls) {
          if (localStorage.getItem(k) !== seed.ls[k]) {
            localStorage.setItem(k, seed.ls[k]);
          }
        }
      } catch (e) {
        console.warn('[zcc-pdd-embed] localStorage 种入失败（可能被第三方存储拦截）:', e);
      }
      try {
        (seed.cookie || '').split(';').forEach(function (p) {
          p = p.trim();
          if (!p) return;
          document.cookie = p + '; path=/; domain=.yangkeduo.com; SameSite=None; Secure';
        });
      } catch (e) {
        console.warn('[zcc-pdd-embed] Cookie 种入失败:', e);
      }
    });
  } catch (e) {
    console.warn('[zcc-pdd-embed] iframe 种子流程异常:', e);
  }
})();