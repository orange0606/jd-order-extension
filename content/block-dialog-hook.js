/**
 * 主世界执行（通过 <script src=chrome-extension://...> 注入）。
 * 仅在 goods1.html 由 block-dialog-inject.js 引入。
 * 把"获取售罄商品信息失败"alert/confirm 转为非阻塞 toast。
 * 开关读取 <html data-zcc-block-soldout>，由隔离世界脚本同步。
 */
(function () {
  'use strict';

  if (window.__zccDialogHooked) return;
  window.__zccDialogHooked = true;
  document.documentElement.setAttribute('data-zcc-dialog-hooked', '1');

  var KEYWORD = '获取售罄商品信息失败';
  var DIAG = false; // 诊断模式关闭：仅拦截售罄弹窗
  function topIsGoods() {
    try {
      var t = window.top.location;
      return t.hostname === 'mobile.yangkeduo.com' && t.pathname === '/goods1.html';
    } catch (e) {
      return false; // 跨源 frame 无法判断顶层，交由 host_permissions 注入策略控制
    }
  }
  function enabled() {
    if (DIAG) return true; // 诊断期：所有 frame 都拦截
    return topIsGoods() && document.documentElement.getAttribute('data-zcc-block-soldout') !== '0';
  }
  function isTarget(msg) {
    if (DIAG) return true; // 诊断期：匹配所有弹窗内容
    return msg && String(msg).indexOf(KEYWORD) !== -1;
  }

  var STYLE_ID = 'zcc-dialog-toast-style';
  var CONTAINER_ID = 'zcc-dialog-toast-wrap';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#' + CONTAINER_ID + '{position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
      'z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}' +
      '.zcc-dialog-toast{pointer-events:auto;min-width:240px;max-width:420px;display:flex;align-items:flex-start;' +
      'gap:8px;padding:10px 12px;background:#fff;border:1px solid #f0d9b0;border-left:4px solid #e6a23c;' +
      'border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.15);color:#303133;font-size:13px;line-height:1.5;' +
      'animation:zccToastIn .25s ease;word-break:break-word;}' +
      '.zcc-dialog-toast .zcc-ico{flex:0 0 auto;font-size:15px;line-height:1.4;}' +
      '.zcc-dialog-toast .zcc-msg{flex:1;}' +
      '.zcc-dialog-toast .zcc-x{flex:0 0 auto;cursor:pointer;color:#b0b3b8;font-size:15px;line-height:1.2;' +
      'padding:0 2px;background:none;border:none;}' +
      '.zcc-dialog-toast .zcc-x:hover{color:#606266;}' +
      '@keyframes zccToastIn{from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:translateY(0);}}';
    (document.head || document.documentElement).appendChild(style);
  }
  function showToast(msg) {
    function build() {
      injectStyle();
      var wrap = document.getElementById(CONTAINER_ID);
      if (!wrap) { wrap = document.createElement('div'); wrap.id = CONTAINER_ID; document.body.appendChild(wrap); }
      var item = document.createElement('div');
      item.className = 'zcc-dialog-toast';
      var ico = document.createElement('span'); ico.className = 'zcc-ico'; ico.textContent = '⚠️';
      var txt = document.createElement('span'); txt.className = 'zcc-msg'; txt.textContent = String(msg);
      var close = document.createElement('button'); close.className = 'zcc-x'; close.textContent = '×';
      item.appendChild(ico); item.appendChild(txt); item.appendChild(close);
      wrap.appendChild(item);
      var timer = setTimeout(function () { item.remove(); }, 4000);
      close.addEventListener('click', function () { clearTimeout(timer); item.remove(); });
    }
    if (document.body) build();
    else window.addEventListener('DOMContentLoaded', build, { once: true });
  }

  // 用访问器属性锁死 alert/confirm：页面读取、缓存、bind、尝试覆盖/删除，拿到的都是拦截版
  function installOn(obj) {
    if (!obj) return;
    try {
      var nativeAlert = obj.alert;
      var nativeConfirm = obj.confirm;
      var ourAlert = function (msg) {
        if (enabled() && isTarget(msg)) {
          if (DIAG) { console.warn('[zcc拦截alert]', msg, '| frame:', location.href); console.trace('[zcc alert调用栈]'); }
          showToast(msg); return undefined;
        }
        return nativeAlert.apply(obj, arguments);
      };
      var ourConfirm = function (msg) {
        if (enabled() && isTarget(msg)) {
          if (DIAG) { console.warn('[zcc拦截confirm]', msg, '| frame:', location.href); console.trace('[zcc confirm调用栈]'); }
          showToast(msg); return true;
        }
        return nativeConfirm.apply(obj, arguments);
      };
      try {
        Object.defineProperty(obj, 'alert', {
          configurable: false, enumerable: true,
          get: function () { return ourAlert; },
          set: function () { /* 阻止页面还原原生 */ }
        });
        Object.defineProperty(obj, 'confirm', {
          configurable: false, enumerable: true,
          get: function () { return ourConfirm; },
          set: function () { }
        });
      } catch (defineErr) {
        // 极端情况下 defineProperty 失败，退回直接赋值
        try { obj.alert = ourAlert; obj.confirm = ourConfirm; } catch (e2) {}
      }
    } catch (e) {
      console.warn('[智查查] hook 安装失败:', e);
    }
  }

  try {
    installOn(window);
    console.log('[智查查] 售罄弹窗转通知 hook 已生效');
  } catch (e) {
    console.warn('[智查查] hook 执行失败:', e);
  }
})();
