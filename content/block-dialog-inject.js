/**
 * mobile.yangkeduo.com 专用（隔离世界，document_start）。
 * 1) 把「售罄弹窗转通知」「自动确认绑定采购单」开关同步到 <html data-*>，供主世界 hook 读取；
 * 2) 注入主世界 hook（block-dialog-hook.js，绕过 CSP）；
 * 3) 自动确认绑定采购单：点击 #goodsUrlQRCodeBindingOrder 后轮询 layui 弹窗并点「绑定」。
 */
(function () {
  'use strict';

  function topIsGoods() {
    try { return window.top.location.hostname === 'mobile.yangkeduo.com' && window.top.location.pathname.indexOf('/goods') === 0; }
    catch (e) { return false; } // 跨域 iframe 由后台 chrome.scripting 注入
  }
  if (!topIsGoods()) return;

  // ---------- 1. 同步开关到 DOM（主世界 hook 实时读取） ----------
  function applySoldout(on) { document.documentElement.setAttribute('data-zcc-block-soldout', on ? '1' : '0'); }
  function applyBind(on) {
    document.documentElement.setAttribute('data-zcc-auto-bind-order', on ? '1' : '0');
    // 仅开启自动确认绑定时才显示极速版按钮
    if (on) { injectFastBindBtn(); }
    else { var f = document.getElementById('zcc-fast-bind-btn'); if (f) f.remove(); }
  }

  function readSetting() {
    try {
      chrome.storage.local.get(['jd_settings', 'zhichacha_token'], function (result) {
        var s = (result && result.jd_settings) || {};
        var loggedIn = !!(result && result.zhichacha_token); // 未登录/账号停用不启用
        applySoldout(loggedIn && s.blockSoldOutDialog !== false);
        applyBind(loggedIn && s.autoConfirmBindOrder === true);
      });
    } catch (e) { applySoldout(true); applyBind(false); }
  }
  readSetting();
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && (changes.jd_settings || changes.zhichacha_token)) readSetting();
    });
  } catch (e) {}

  // ---------- 2. 以外部脚本方式注入主世界 ----------
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

  // ---------- 3. 自动确认绑定采购单 ----------
  function smallToast(msg) {
    try {
      var wrap = document.getElementById('zcc-bind-toast-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'zcc-bind-toast-wrap';
        wrap.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;flex-direction:column;gap:8px;';
        (document.body || document.documentElement).appendChild(wrap);
      }
      var item = document.createElement('div');
      item.textContent = msg;
      item.style.cssText = 'padding:9px 14px;background:#fff;border:1px solid #d9e7ff;border-left:4px solid #3768fa;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.15);color:#303133;font-size:13px;';
      wrap.appendChild(item);
      setTimeout(function () { item.remove(); }, 3000);
    } catch (e) {}
  }

  function bindSettingOn() {
    return document.documentElement.getAttribute('data-zcc-auto-bind-order') === '1';
  }

  function findBindLayer() {
    var layers = document.querySelectorAll('.layui-layer');
    for (var i = 0; i < layers.length; i++) {
      var t = layers[i].querySelector('.layui-layer-title');
      if (t && t.textContent.indexOf('绑定采购单') !== -1) return layers[i];
    }
    return null;
  }

  var __bindBusy = false;
  function startBindWatch(fast) {
    if (__bindBusy) return;
    __bindBusy = true;
    var waited = 0;
    var timer = setInterval(function () {
      waited += 500;
      var layer = findBindLayer();
      if (layer) {
        clearInterval(timer);
        // 弹窗已出现，等 1 秒让用户看一眼内容，再点「绑定」
        setTimeout(function () {
          try {
            var btn = layer.querySelector('.layui-layer-btn0');
            if (btn) {
              btn.click();
              smallToast(fast ? '已自动点击「绑定」（极速版，1秒后关页）' : '已自动点击「绑定」');
              // 通知 SW 临时 attach debugger，拦截随后的原生 alert（绑定成功提示）
              try { chrome.runtime.sendMessage({ type: 'ZCC_BIND_DIALOG_WATCH', fast: !!fast }); } catch (e) {}
            }
          } catch (e) {}
          setTimeout(function () { __bindBusy = false; }, 3000);
        }, 1000);
        return;
      }
      if (waited >= 12000) {
        clearInterval(timer);
        __bindBusy = false;
      }
    }, 500);
  }

  // 往二维码弹窗注入「绑定采购单-极速版」按钮（1秒后关页）
  function injectFastBindBtn() {
    if (!bindSettingOn()) return; // 未开启自动确认绑定时不显示
    if (document.getElementById('zcc-fast-bind-btn')) return;
    var qr = document.getElementById('goodsUrlQRCode');
    var origBtn = document.getElementById('goodsUrlQRCodeBindingOrder');
    if (!qr || !origBtn) return;
    var fast = document.createElement('button');
    fast.type = 'button';
    fast.id = 'zcc-fast-bind-btn';
    fast.className = 'layui-btn layui-btn-danger';
    fast.textContent = '绑定采购单-极速版（1秒关页）';
    fast.style.cssText = 'height:30px;line-height:30px;width:100%;margin:6px 0 0 0;padding:0;font-size:14px;text-align:center;box-sizing:border-box;';
    fast.addEventListener('click', function () {
      if (__bindBusy) { smallToast('请稍候，正在处理...'); return; }
      // 标记本次为极速模式，原版按钮监听器会读取此标记
      window.__zccFastBind = true;
      // 触发原版按钮的点击，让拼多多弹出 layui 确认框
      try { origBtn.click(); } catch (e) {}
    });
    qr.appendChild(fast);
  }
  // 轮询注入（二维码弹窗可能延迟出现）
  var __injectTimer = setInterval(injectFastBindBtn, 1500);

  // 捕获阶段监听：用户点「绑定采购单(匹配当前下单)」按钮
  document.addEventListener('click', function (e) {
    try {
      var btn = e.target && e.target.closest && e.target.closest('#goodsUrlQRCodeBindingOrder');
      if (!btn) return;
      if (!bindSettingOn()) return; // 开关未开：不干预
      // 双保险：同步写标记，确保 MAIN world hook 立即读到
      document.documentElement.setAttribute('data-zcc-auto-bind-order', '1');
      // 检查是否来自极速版按钮
      var fast = !!window.__zccFastBind;
      window.__zccFastBind = false;
      smallToast(fast ? '已开启极速绑定（1秒后关页）' : '已开启自动确认绑定采购单');
      startBindWatch(fast);
    } catch (err) {}
  }, true);

  // ---------- 4. 绑定成功后：倒计时自动关闭本页 ----------
  function showBindSuccessCloseCountdown(fast) {
    var sec = fast ? 1 : 5;
    var secText = String(sec);
    var wrap = document.createElement('div');
    wrap.id = 'zcc-bind-close-countdown';
    wrap.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:24px 28px;width:320px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;';
    wrap.innerHTML =
      '<div style="font-size:16px;font-weight:600;color:#303133;margin-bottom:8px;">✅ 绑定采购单成功</div>' +
      '<div style="font-size:13px;color:#606266;line-height:1.6;margin-bottom:16px;">本页面将在 <b id="zcc-bind-countdown" style="color:#f56c6c;font-size:18px;">' + secText + '</b> 秒后自动关闭</div>' +
      '<div style="display:flex;gap:10px;justify-content:center;">' +
      '  <button id="zcc-bind-close-cancel" style="padding:7px 18px;border:1px solid #dcdfe6;background:#fff;color:#606266;border-radius:6px;cursor:pointer;font-size:13px;">取消</button>' +
      '  <button id="zcc-bind-close-now" style="padding:7px 18px;border:none;background:#f56c6c;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;">立即关闭</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(wrap);

    var numEl = wrap.querySelector('#zcc-bind-countdown');
    var timer = setInterval(function () {
      sec--;
      if (numEl) numEl.textContent = sec;
      if (sec <= 0) {
        clearInterval(timer);
        doCloseTab();
      }
    }, 1000);

    function cleanup() { clearInterval(timer); if (wrap.parentNode) wrap.remove(); }
    wrap.querySelector('#zcc-bind-close-cancel').addEventListener('click', function () { cleanup(); });
    wrap.querySelector('#zcc-bind-close-now').addEventListener('click', function () { cleanup(); doCloseTab(); });

    function doCloseTab() {
      cleanup();
      try {
        chrome.runtime.sendMessage({ type: 'ZCC_CLOSE_TAB' }, function () {
          if (chrome.runtime.lastError) { try { window.close(); } catch (e) {} }
        });
      } catch (e) { try { window.close(); } catch (e2) {} }
      // 兜底：1秒后若页面还在，尝试 window.close
      setTimeout(function () { try { window.close(); } catch (e) {} }, 1000);
    }
  }

  // 监听 SW 发来的「绑定成功，开始倒计时关闭」
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'ZCC_BIND_SUCCESS_CLOSE') showBindSuccessCloseCountdown(msg.fast);
    });
  } catch (e) {}

  // 主世界 hook 通知：移动端无 debugger，绑定成功 alert 被吞掉后直接弹倒计时
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    if (e.data && e.data.type === 'ZCC_BIND_ALERT_CLOSED') {
      showBindSuccessCloseCountdown(e.data.fast);
    }
  });

  // ---------- 5. 移动端触摸拖动：让 .dragBox 订单信息框支持手指拖动 ----------
  function enableTouchDrag() {
    var box = document.querySelector('.dragBox');
    if (!box || box.getAttribute('data-zcc-touch-drag') === '1') return;
    var title = box.querySelector('.title');
    if (!title) return;
    box.setAttribute('data-zcc-touch-drag', '1');

    var startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false;

    title.addEventListener('touchstart', function (e) {
      // 点到按钮（中断/收起）时不拖动
      if (e.target.closest('button') || e.target.closest('.jbs_toggleBtn')) return;
      var t = e.touches[0];
      dragging = true;
      startX = t.clientX;
      startY = t.clientY;
      var rect = box.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      // 切换为绝对定位，方便直接设 left/top
      box.style.right = 'auto';
      box.style.left = origLeft + 'px';
      box.style.top = origTop + 'px';
    }, { passive: true });

    title.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var t = e.touches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      var newLeft = Math.max(0, Math.min(window.innerWidth - 40, origLeft + dx));
      var newTop = Math.max(0, Math.min(window.innerHeight - 40, origTop + dy));
      box.style.left = newLeft + 'px';
      box.style.top = newTop + 'px';
      e.preventDefault();
    }, { passive: false });

    title.addEventListener('touchend', function () { dragging = false; }, { passive: true });
  }
  setInterval(enableTouchDrag, 1000);
})();
