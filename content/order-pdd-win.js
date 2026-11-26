/**
 * 订单列表（waitOut/allOrders/hadOut/canceled）：京巴士关联单采购订单号旁加「拼多多小窗」。
 * 小窗函数在全交易后台注册，供拒收台账调用；自动扫描按钮仍仅限订单列表，避免其他页面重复注入。
 * 页面打开/切换tab后自动扫描（首次延迟5秒，之后每3秒补扫，覆盖懒加载/翻页）。
 * 单号取关联单 <a class="j_buyMsg_orderId"> 的 order_sn，弹窗复用拼多多内嵌登录态机制（ZCC_PDD_EMBED_ON/OFF）。
 */
(function () {
  'use strict';
  if (window.__zccOrderPddWinLoaded) return;
  window.__zccOrderPddWinLoaded = true;

  // ---------- 智查查插件登录闸门：关联单小窗功能仅登录后可用 ----------
  var pluginLoggedIn = false;
  function refreshPluginLogin() {
    try {
      chrome.storage.local.get(['zhichacha_token'], function (r) {
        pluginLoggedIn = !!(r && r.zhichacha_token); // 未登录/账号停用（token被清）时功能关闭
      });
    } catch (e) { pluginLoggedIn = false; }
  }
  refreshPluginLogin();
  // 性能：改用 storage 变化事件驱动登录态，去掉每10秒轮询
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.zhichacha_token) refreshPluginLogin();
    });
  } catch (e) {}

  var MODAL_ID = 'zcc-order-pdd-modal';
  var BTN_CLASS = 'zcc-pdd-win-btn';

  // ---------- 可拖动/可调整宽高弹窗（与售后小窗同款交互） ----------
  function pddUrl(sn) { return 'https://mobile.yangkeduo.com/order.html?order_sn=' + encodeURIComponent(sn); }

  // 轻提示（顶部居中，2.5秒消失）
  function zccToast(msg) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'padding:8px 16px;border-radius:4px;font-size:13px;color:#fff;background:#e6a23c;box-shadow:0 2px 8px rgba(0,0,0,.2);';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2500);
  }

  function openPddModal(sn) {
    if (!sn) return;
    if (!pluginLoggedIn) { zccToast('请先登录智查查后再使用该功能'); return; } // 插件登录闸门
    var url = pddUrl(sn);
    var modal = document.getElementById(MODAL_ID);
    if (modal) {
      // 已有弹窗：换单直接更新 iframe 和标题，位置保留
      modal.querySelector('.zcc-pdd-modal-title-text').textContent = '采购单 ' + sn;
      modal.querySelector('.zcc-pdd-modal-open-tab').setAttribute('data-url', url);
      document.body.appendChild(modal); // 移到同级最上层，避免台账列表遮挡已创建的采购单小窗
      modal.style.display = 'flex';
      loadFrame(modal, url);
      return;
    }
    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.style.cssText = 'position:fixed;left:50px;top:50px;width:500px;height:600px;z-index:2147483647;' +
      'background:#fff;border:1px solid #dcdfe6;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.25);' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'resize:both;min-width:360px;min-height:320px;'; // 右下角拖柄可调整宽高
    modal.innerHTML =
      '<div class="zcc-pdd-modal-header" style="flex:0 0 34px;display:flex;align-items:center;gap:8px;padding:0 10px;' +
      'background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;cursor:move;user-select:none;font-size:13px;">' +
      '  <span class="zcc-pdd-modal-title-text" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">采购单 ' + sn + '</span>' +
      '  <button type="button" class="zcc-pdd-modal-refresh" title="刷新当前小窗页面"' +
      '    style="border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:3px;cursor:pointer;font-size:12px;height:22px;padding:0 8px;">↻ 刷新</button>' +
      '  <button type="button" class="zcc-pdd-modal-open-tab" data-url="' + url + '" title="在新标签页打开"' +
      '    style="border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:3px;cursor:pointer;font-size:12px;height:22px;padding:0 8px;">↗ 新标签</button>' +
      '  <button type="button" class="zcc-pdd-modal-close" title="关闭"' +
      '    style="border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:3px;cursor:pointer;font-size:14px;height:22px;width:22px;line-height:20px;padding:0;">×</button>' +
      '</div>' +
      '<iframe src="about:blank" style="flex:1;width:100%;border:none;background:#fff;" allow="clipboard-read; clipboard-write"></iframe>';
    document.body.appendChild(modal);
    loadFrame(modal, url);

    // 拖动时给 iframe 盖一层透明遮罩，防止鼠标移入 iframe 后丢失 move 事件
    var shield = document.createElement('div');
    shield.style.cssText = 'position:absolute;inset:34px 0 0 0;display:none;z-index:2;';
    modal.appendChild(shield);

    var header = modal.querySelector('.zcc-pdd-modal-header');
    var dragging = false, startX = 0, startY = 0, origL = 0, origT = 0;
    header.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origL = modal.offsetLeft; origT = modal.offsetTop;
      shield.style.display = 'block';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      modal.style.left = (origL + e.clientX - startX) + 'px';
      modal.style.top = (origT + e.clientY - startY) + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      shield.style.display = 'none';
    });

    modal.querySelector('.zcc-pdd-modal-close').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      modal.style.display = 'none';
      // 关闭只移除注入规则，不做任何 Cookie 清除/恢复（防止把拼多多整站弄掉登录）
      try { chrome.runtime.sendMessage({ type: 'ZCC_PDD_EMBED_OFF' }, function () { void chrome.runtime.lastError; }); } catch (err) {}
    }, true);
    modal.querySelector('.zcc-pdd-modal-refresh').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      // 刷新时重新走内嵌登录态加载，避免跨域直接操作iframe.location
      var currentUrl = modal.querySelector('.zcc-pdd-modal-open-tab').getAttribute('data-url') || url;
      loadFrame(modal, currentUrl);
    }, true);
    modal.querySelector('.zcc-pdd-modal-open-tab').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      window.open(this.getAttribute('data-url') || url, '_blank', 'noopener');
    }, true);
  }

  // 提供给插件台账列表的采购单号直接打开小窗，复用本文件登录闸门与拖动/缩放能力
  window.__zccOpenPddModal = openPddModal;

  function loadFrame(modal, url) {
    var frame = modal.querySelector('iframe');
    try {
      // 先让 SW 注入拼多多登录Cookie规则/种子，再加载 iframe
      chrome.runtime.sendMessage({ type: 'ZCC_PDD_EMBED_ON' }, function () {
        void chrome.runtime.lastError;
        frame.src = url;
      });
    } catch (e) { frame.src = url; }
  }

  // ---------- 关联单扫描：采购订单号后插入小窗按钮 ----------
  function isOrderListPage() {
    return location.pathname.indexOf('/jdm/trade/orders/order-list') === 0;
  }
  function scan() {
    if (!isOrderListPage()) return; // 全交易后台仅注册小窗函数，自动按钮仍只注入订单列表
    if (!pluginLoggedIn) return; // 插件未登录不注入小窗按钮
    if (document.hidden) return; // 性能：后台标签页不扫描，回到前台由补扫覆盖
    try {
      var links = document.querySelectorAll('a.j_buyMsg_orderId');
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var holder = a.closest('.j_buyMsg') || a.parentElement;
        if (!holder || holder.querySelector('.' + BTN_CLASS)) continue;
        var sn = '';
        try { sn = new URLSearchParams((a.href || '').split('?')[1] || '').get('order_sn') || ''; } catch (e) {}
        if (!sn) sn = holder.getAttribute('data-buy-orderid') || '';
        if (!sn) continue;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BTN_CLASS;
        btn.textContent = '🗗 小窗';
        btn.title = '小窗口打开拼多多采购单';
        btn.setAttribute('data-sn', sn);
        btn.style.cssText = 'height:20px;padding:0 6px;margin-left:4px;border:1px solid #b3d8ff;background:#ecf5ff;' +
          'color:#409eff;border-radius:3px;cursor:pointer;font-size:12px;line-height:18px;vertical-align:middle;';
        btn.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          openPddModal(this.getAttribute('data-sn') || '');
        }, true);
        a.insertAdjacentElement('afterend', btn);
      }
    } catch (e) {}
  }

  setTimeout(scan, 5000);   // 首次5秒：等京巴士关联单渲染
  setInterval(scan, 5000);  // 补扫：tab切换/翻页/懒加载（性能：3秒→5秒，后台跳过）
  // 回到前台立即补扫一次，保证后台期间新增的关联单也能注入按钮
  try { document.addEventListener('visibilitychange', function () { if (!document.hidden) scan(); }); } catch (e) {}
})();