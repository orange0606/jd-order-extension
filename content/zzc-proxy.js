/**
 * 京巴士第一方代请求中继（zzc.jingbashi.com 顶层页面）
 * 360 内核下 SW/跨站 iframe 的请求都带不上 zzc 登录 Cookie（SameSite/第三方策略/禁止头），
 * 唯一可靠通道是第一方页面自身发请求。本脚本驻留在 zzc 标签页（用户已登录的或插件后台开的），
 * 接收 SW 的 ZCC_PROXY_FETCH 消息，以第一方身份 fetch 并把 status/headers/body(base64) 回传，
 * 由 SW 喂给京东页弹窗 iframe（Fetch.fulfillRequest）或用于退货中转仓查询。
 */
(function () {
  'use strict';
  if (window.__zccZzcProxyLoaded) return;
  window.__zccZzcProxyLoaded = true;

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'ZCC_PROXY_FETCH') return;
    var opt = {
      method: msg.method || 'GET',
      credentials: 'include', // 第一方请求自动携带登录Cookie
      redirect: 'follow',
      headers: msg.headers || {}
    };
    if (msg.body && opt.method !== 'GET' && opt.method !== 'HEAD') opt.body = msg.body;
    fetch(msg.url, opt).then(function (r) {
      return r.arrayBuffer().then(function (buf) { return { r: r, buf: buf }; });
    }).then(function (o) {
      var hs = [];
      o.r.headers.forEach(function (v, n) { hs.push([n, v]); });
      var bytes = new Uint8Array(o.buf);
      var bin = '';
      for (var i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      sendResponse({ ok: true, status: o.r.status, url: o.r.url, headers: hs, body: btoa(bin) });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true; // 异步 sendResponse
  });
})();