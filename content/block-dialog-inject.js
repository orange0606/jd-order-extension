/**
 * goods1.html 专用：通过外部扩展文件把 hook 注入页面主世界（绕过页面 CSP 的内联限制）。
 * 隔离世界负责读开关并写入 <html data-zcc-block-soldout>；
 * 主世界逻辑在 block-dialog-hook.js（web_accessible_resource），用 <script src> 加载。
 */
(function () {
  'use strict';

  function topIsGoods() {
    try { return window.top.location.hostname === 'mobile.yangkeduo.com' && window.top.location.pathname.indexOf('/goods') === 0; }
    catch (e) { return false; } // 跨域 iframe 由后台 chrome.scripting 注入
  }
  if (!topIsGoods()) return;

  // ---------- 1. 同步开关到 DOM（主世界 hook 实时读取） ----------
  function apply(enabled) {
    document.documentElement.setAttribute('data-zcc-block-soldout', enabled ? '1' : '0');
  }
  function readSetting() {
    try {
      chrome.storage.local.get('jd_settings', function (result) {
        var s = (result && result.jd_settings) || {};
        apply(s.blockSoldOutDialog !== false); // 默认开启
      });
    } catch (e) {
      apply(true);
    }
  }
  readSetting();
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.jd_settings) {
        var s = changes.jd_settings.newValue || {};
        apply(s.blockSoldOutDialog !== false);
      }
    });
  } catch (e) {}

  // ---------- 2. 以外部脚本方式注入主世界（现代/支持的内核下作为无黄条方案） ----------
  function inject() {
    try {
      var url = chrome.runtime.getURL('content/block-dialog-hook.js');
      var script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.onload = function () { script.remove(); };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn('[智查查] 注入主世界外部脚本失败:', e);
    }
  }

  inject();
})();
