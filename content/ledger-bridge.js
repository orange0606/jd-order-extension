/**
 * 台账网页桥接（内容脚本）：注入到智查查网页源（本地 + 线上）。
 * 网页 window.postMessage → 这里 chrome.runtime.sendMessage(内部) → SW → 原路 postMessage 回网页。
 * 无需 externally_connectable、无需手动填插件ID：只要启用本插件即自动生效。
 */
(function () {
  'use strict';
  if (window.__zccLedgerBridgeLoaded) return;
  window.__zccLedgerBridgeLoaded = true;

  var PAGE_SRC = 'zcc-ledger-page';
  var EXT_SRC = 'zcc-ledger-ext';
  var ALLOW = { ZCC_LEDGER_LOOKUP: 1, ZCC_LEDGER_PDD_ON: 1, ZCC_LEDGER_PDD_OFF: 1 };

  window.addEventListener('message', function (e) {
    // 只接受本页发起的桥接请求
    if (e.source !== window || !e.data || e.data.source !== PAGE_SRC) return;
    var type = e.data.type;
    if (!ALLOW[type]) return;
    var reqId = e.data.reqId;
    try {
      chrome.runtime.sendMessage({ type: type, orderNo: e.data.orderNo }, function (resp) {
        var err = chrome.runtime.lastError; // 读取以消除 unchecked 警告
        var payload = resp || { ok: false, error: (err && err.message) || '插件无响应' };
        window.postMessage({ source: EXT_SRC, reqId: reqId, payload: payload }, '*');
      });
    } catch (err) {
      window.postMessage({ source: EXT_SRC, reqId: reqId, payload: { ok: false, error: String((err && err.message) || err) } }, '*');
    }
  });

  // 告知网页桥接已就绪（网页可据此判断插件是否启用）
  window.postMessage({ source: EXT_SRC, ready: true }, '*');
})();