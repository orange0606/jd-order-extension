/**
 * Background Service Worker
 * 负责：标签页监听、登录状态管理、数据同步到后端
 */

// 引入全局配置
try {
  importScripts('../config.js');
} catch (e) {
  console.error('加载config.js失败，使用默认配置', e);
}

// ==================== 配置 ====================
const CONFIG = {
  targetUrlPattern: '*://shop.jd.com/jdm/trade/orders/*',
  apiBaseUrl: (typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.apiBaseUrl) || 'http://localhost:3000/api',
  syncInterval: 5 * 60 * 1000, // 5分钟自动同步一次
  tokenStorageKey: 'zhichacha_token',
  userStorageKey: 'zhichacha_user',
  shopsStorageKey: 'zhichacha_shops' // 已绑定店铺列表
};

// ==================== 安装和初始化 ====================

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[京东订单抓取] 扩展已安装/更新:', details.reason);
  
  // 初始化设置
  chrome.storage.local.get('jd_settings', (result) => {
    if (!result.jd_settings) {
      chrome.storage.local.set({
        'jd_settings': {
          autoSync: true,
          showNotification: true
        }
      });
    }
  });
});

// ==================== 标签页监听 ====================

/**
 * 检测URL是否是目标订单页面
 */
function isOrderPage(url) {
  if (!url) return false;
  return url.includes('shop.jd.com/jdm/trade/orders/order-list') ||
         url.includes('shop.jd.com/jdm/trade/orders/');
}

/**
 * 更新扩展图标提示
 */
function updateIconStatus(tabId, isActive) {
  if (isActive) {
    chrome.action.setTitle({ tabId, title: '订单抓取助手 - 当前页面可抓取' });
  } else {
    chrome.action.setTitle({ tabId, title: '京东订单抓取助手' });
  }
}

// 监听标签页更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const isTarget = isOrderPage(tab.url);
    updateIconStatus(tabId, isTarget);
    
    if (isTarget) {
      console.log('[京东订单抓取] 检测到进入订单页面:', tab.url);
      
      // 检查登录状态
      checkLoginStatus().then(isLoggedIn => {
        if (!isLoggedIn) {
          console.log('[Background] 未登录智查查');
        }
      });

      // 显示通知（如果开启了）
      chrome.storage.local.get('jd_settings', (result) => {
        if (result.jd_settings?.showNotification) {
          // 可以在这里显示页面内提示
        }
      });
    }
  }
});

// 监听标签页切换
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const isTarget = isOrderPage(tab.url);
    updateIconStatus(tabId, isTarget);
  } catch (e) {
    console.error('获取标签页信息失败:', e);
  }
});

// ==================== 消息处理 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] 收到消息:', message.type);

  switch (message.type) {
    case 'ORDERS_SCraped':
      console.log('[Background] 收到订单数据:', message.payload);
      handleOrdersScraped(message.payload, sender);
      sendResponse({ received: true });
      break;

    case 'LOGIN':
      handleLogin(message.payload)
        .then(result => sendResponse(result))
        .catch(e => sendResponse({ success: false, message: e.message }));
      return true; // 异步响应

    case 'LOGOUT':
      handleLogout()
        .then(() => sendResponse({ success: true }));
      return true;

    case 'CHECK_LOGIN':
      checkLoginStatus()
        .then(isLoggedIn => sendResponse({ isLoggedIn }));
      return true;

    case 'SYNC_TO_SERVER':
      syncOrdersToServer(message.payload)
        .then(result => sendResponse(result))
        .catch(e => sendResponse({ success: false, message: e.message }));
      return true;

    case 'GET_SETTINGS':
      chrome.storage.local.get('jd_settings', (result) => {
        sendResponse({ settings: result.jd_settings || {} });
      });
      return true;

    case 'SAVE_SETTINGS':
      // 合并写入，避免覆盖 shopId 等其他字段
      chrome.storage.local.get('jd_settings', (result) => {
        const existing = result.jd_settings || {};
        const merged = Object.assign({}, existing, message.payload);
        chrome.storage.local.set({ 'jd_settings': merged }, () => {
          // 通知所有相关标签页设置已更新（京东订单页 + 京巴士页）
          chrome.tabs.query({ url: [
            'https://shop.jd.com/jdm/trade/orders/*',
            'https://pay.jingbashi.com/*'
          ] }, (tabs) => {
            tabs.forEach(tab => {
              chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: merged }).catch(() => {});
            });
          });
          sendResponse({ success: true });
        });
      });
      return true;

    case 'GET_SHOPS':
      chrome.storage.local.get(CONFIG.shopsStorageKey, (result) => {
        sendResponse({ shops: result[CONFIG.shopsStorageKey] || [] });
      });
      return true;

    case 'REFRESH_SHOPS':
      fetchUserShops()
        .then(shops => sendResponse({ success: true, shops }))
        .catch(e => sendResponse({ success: false, message: e.message }));
      return true;

    case 'RISK_BATCH_CHECK':
      batchRiskCheck(message.payload)
        .then(result => sendResponse({ success: true, data: result }))
        .catch(e => sendResponse({ success: false, message: e.message }));
      return true;

    case 'REPORT_ORDER_INFO':
      getReportOrderInfo(message.payload.orderNo)
        .then(data => sendResponse({ success: true, data }))
        .catch(e => sendResponse({ success: false, msg: e.message }));
      return true;

    case 'REPORT_SUBMIT':
      submitReport(message.payload)
        .then(data => sendResponse({ success: true, data }))
        .catch(e => sendResponse({ success: false, msg: e.message }));
      return true;

    case 'CHECK_LATEST_VERSION':
      console.log('[版本检查-SW] 请求地址:', CONFIG.apiBaseUrl + '/extension/latest');
      fetch(CONFIG.apiBaseUrl + '/extension/latest')
        .then(r => { console.log('[版本检查-SW] 响应状态:', r.status); return r.json(); })
        .then(data => { console.log('[版本检查-SW] 成功:', data); sendResponse({ success: true, data }); })
        .catch(e => { console.error('[版本检查-SW] 失败:', e); sendResponse({ success: false, msg: e.message }); });
      return true;
  }
});


// ==================== 业务逻辑 ====================

/**
 * 处理抓取到的订单数据
 */
async function handleOrdersScraped(payload, sender) {
  const { orders, importList, url, timestamp, syncId, statusSummary } = payload;
  
  console.log(`[Background] 收到 ${orders.length} 条订单数据，准备同步到服务器`);

  // 如果已登录，直接同步（使用接口格式的importList，不存本地）
  const isLoggedIn = await checkLoginStatus();
  let syncResult = null;
  if (isLoggedIn && importList && importList.length > 0) {
    try {
      syncResult = await syncOrdersToServer(importList);
      syncResult.syncId = syncId || '';
      syncResult.statusSummary = statusSummary || {};
      console.log('[Background] 同步结果:', syncResult);
      
      // 通知content同步结果
      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'SYNC_RESULT',
          payload: syncResult
        });
      }
    } catch (e) {
      console.error('同步失败:', e);
      syncResult = { success: false, message: e.message, syncId: syncId || '', statusSummary: statusSummary || {} };
      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'SYNC_RESULT',
          payload: syncResult
        });
      }
    }
  }

  // 显示通知（需登录、同步成功，且设置里开启了“抓取通知”）
  let notifyEnabled = true;
  try {
    const sr = await chrome.storage.local.get('jd_settings');
    notifyEnabled = (sr.jd_settings || {}).showNotification !== false;
  } catch (e) {}
  if (orders.length > 0 && syncResult?.success && notifyEnabled) {
    try {
      let notifyMsg = `成功同步 ${orders.length} 条订单`;
      if (syncResult.insert !== undefined || syncResult.update !== undefined) {
        notifyMsg += `\n新增 ${syncResult.insert || 0} 条，更新 ${syncResult.update || 0} 条`;
      }
      await chrome.notifications?.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '✅ 订单同步完成',
        message: notifyMsg,
        priority: 1
      });
    } catch (e) {
      // notifications权限可能未开启，忽略
    }
  }
}

/**
 * 获取并保存当前用户的已绑定店铺列表
 */
async function fetchUserShops() {
  try {
    const { token } = await getCurrentUser();
    if (!token) return [];

    const response = await fetch(`${CONFIG.apiBaseUrl}/shop/list`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    if (data.code === 0 && data.data) {
      const shops = data.data;
      await chrome.storage.local.set({ [CONFIG.shopsStorageKey]: shops });
      console.log(`[Background] 已加载 ${shops.length} 个绑定店铺:`, shops.map(s => s.shop_id));
      return shops;
    }
    return [];
  } catch (e) {
    console.error('[Background] 获取店铺列表失败:', e);
    return [];
  }
}

/**
 * 处理登录
 */
async function handleLogin({ username, password }) {
  const baseUrl = CONFIG.apiBaseUrl;

  try {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();
    console.log('[Background] 登录响应-response:', response);
    console.log('[Background] 登录响应-data:', data);
    if (response.status !== 200 || data.code !== 0) {
      throw new Error(data.msg || '登录失败，请检查账号密码');
    }
    const user = data.data || {};
    // 保存token和用户信息
    await chrome.storage.local.set({
      [CONFIG.tokenStorageKey]: user.token,
      [CONFIG.userStorageKey]: user
    });

    // 登录成功后立即拉取已绑定店铺列表
    await fetchUserShops();

    console.log('[Background] 登录成功');
    return { success: true, user: user };
  } catch (e) {
    console.error('[Background] 登录失败:', e);
    throw e;
  }
}

/**
 * 退出登录
 */
async function handleLogout() {
  await chrome.storage.local.remove([CONFIG.tokenStorageKey, CONFIG.userStorageKey, CONFIG.shopsStorageKey]);
  console.log('[Background] 已退出登录，清除用户信息和店铺列表');
}

/**
 * 检查登录状态
 */
let __profileCache = { ts: 0, ok: false };
async function checkLoginStatus() {
  try {
    const result = await chrome.storage.local.get(CONFIG.tokenStorageKey);
    const token = result[CONFIG.tokenStorageKey];
    if (!token) { __profileCache = { ts: 0, ok: false }; return false; }
    const now = Date.now();
    if (__profileCache.ts && now - __profileCache.ts < 60000 && __profileCache.ok) return true;
    try {
      const resp = await fetch(`${CONFIG.apiBaseUrl}/auth/profile`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await resp.json();
      if (data && data.code === 0) {
        __profileCache = { ts: now, ok: true };
        return true;
      }
      // 401/403：未登录或账号停用 → 清除本地登录态，使各功能闸门关闭
      await chrome.storage.local.remove([CONFIG.tokenStorageKey, CONFIG.userStorageKey]);
      __profileCache = { ts: 0, ok: false };
      console.warn('[Background] 账号校验未通过，已清除登录态:', data && data.msg);
      return false;
    } catch (netErr) {
      // 网络异常时降级信任本地 token，避免断网导致功能全部停用
      return true;
    }
  } catch (e) {
    return false;
  }
}

/**
 * 获取当前用户信息
 */
async function getCurrentUser() {
  const result = await chrome.storage.local.get([CONFIG.tokenStorageKey, CONFIG.userStorageKey]);
  return {
    token: result[CONFIG.tokenStorageKey],
    user: result[CONFIG.userStorageKey]
  };
}

/**
 * 同步订单到服务器
 * 接口：POST /order/batchAdd
 * 请求体：{ list: [订单数组] }
 */
async function syncOrdersToServer(ordersToSync = null) {
  const { token, user } = await getCurrentUser();
  if (!token) {
    throw new Error('未登录，请先登录智查查系统');
  }

  const baseUrl = CONFIG.apiBaseUrl;

  if (!ordersToSync || ordersToSync.length === 0) {
    return { success: true, message: '没有需要同步的数据', synced: 0 };
  }

  console.log(`[Background] 正在同步 ${ordersToSync.length} 条订单到 /order/batchAdd...`);
  console.log('[Background] 请求数据示例:', ordersToSync[0]);

  try {
    const response = await fetch(`${baseUrl}/order/batchAdd`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        list: ordersToSync
      })
    });

    const data = await response.json();
    console.log('[Background] 服务器响应:', data);

    if (data.code !== 0) {
      throw new Error(data.msg || '同步失败');
    }

    // 更新最后同步时间
    await chrome.storage.local.set({ 'jd_last_sync_time': Date.now() });

    const resultMsg = data.data
      ? `新增${data.data.insert}条，更新${data.data.update}条` +
        (data.data.skipCanceled ? `，${data.data.skipCanceled}条首次出现的已取消订单未入库` : '')
      : `${ordersToSync.length}条`;
    console.log(`[Background] 同步成功: ${resultMsg}`);

    return {
      success: true,
      synced: ordersToSync.length,
      insert: data.data?.insert || 0,
      update: data.data?.update || 0,
      skipCanceled: data.data?.skipCanceled || 0,
      skipExisting: data.data?.skipExisting || 0,
      skipPending: data.data?.skipPending || 0,
      processOrderNos: data.data?.processOrderNos || [],
      skippedCanceledOrderNos: data.data?.skippedCanceledOrderNos || [],
      msg: data.msg
    };
  } catch (e) {
    console.error('[Background] 同步失败:', e);
    throw e;
  }
}

/**
 * 批量风险检测
 * 接口：POST /risk/batchMatch
 * 入参：{ list: [{ shopId, buyerAccount, buyerAddress }] }
 */
async function batchRiskCheck(checkList) {
  const { token } = await getCurrentUser();
  if (!token) {
    throw new Error('未登录');
  }

  const baseUrl = CONFIG.apiBaseUrl;

  if (!checkList || checkList.length === 0) {
    return [];
  }

  console.log(`[Background] 正在批量风险检测 ${checkList.length} 条...`);

  const response = await fetch(`${baseUrl}/risk/batchMatch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ list: checkList })
  });

  const data = await response.json();
  console.log('[Background] 风险检测结果:', data);

  if (data.code !== 0) {
    throw new Error(data.msg || '风险检测失败');
  }

  return data.data || [];
}

// ==================== 右键菜单 ====================

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: 'scrape-this-page',
      title: '抓取当前页订单数据',
      contexts: ['page'],
      documentUrlPatterns: ['*://shop.jd.com/jdm/trade/orders/*']
    });

    chrome.contextMenus.create({
      id: 'sync-orders',
      title: '同步订单到智查查',
      contexts: ['page'],
      documentUrlPatterns: ['*://shop.jd.com/*']
    });
  } catch (e) {
    console.log('右键菜单创建失败（可能已存在）');
  }
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  switch (info.menuItemId) {
    case 'scrape-this-page':
      chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_SCRAPE' });
      break;
    case 'sync-orders':
      try {
        await syncOrdersToServer();
      } catch (e) {
        console.error('同步失败:', e);
      }
      break;
  }
});

console.log('[京东订单抓取] Background Service Worker 已启动');


/**
 * 根据订单号查询订单信息（举报用）
 */
async function getReportOrderInfo(orderNo) {
  const { token } = await getCurrentUser();
  if (!token) {
    throw new Error('未登录');
  }
  const baseUrl = CONFIG.apiBaseUrl;
  const response = await fetch(`${baseUrl}/report/orderInfo?orderNo=${encodeURIComponent(orderNo)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(data.msg || '查询失败');
  }
  return data.data;
}

/**
 * 提交举报
 */
async function submitReport(payload) {
  const { token } = await getCurrentUser();
  if (!token) {
    throw new Error('未登录');
  }
  const baseUrl = CONFIG.apiBaseUrl;
  const response = await fetch(`${baseUrl}/report/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(data.msg || '提交失败');
  }
  return data.data;
}
/* ===== 拼多多 goods1.html：售罄原生弹窗处理 =====
   方案A(无黄条)：MAIN world hook 重写 alert，覆盖现代内核；
   方案B(兜底)：chrome.debugger 监听 Page.javascriptDialogOpening，自动确定售罄框并转通知。 */
(function () {
  var KEYWORD = "获取售罄商品信息失败";
  var attached = {}; // tabId -> true
  var __bindDialogOn = false; // 绑定成功提示转通知开关（由 readSettings 更新）
  function isGoods(url) {
    try { var u = new URL(url); return u.hostname === "mobile.yangkeduo.com" && u.pathname.indexOf("/goods") === 0; }
    catch (e) { return false; }
  }
  function readSettings(cb) {
    try {
      chrome.storage.local.get(["jd_settings", CONFIG.tokenStorageKey], function (r) {
        var st = (r && r.jd_settings) || {};
        var loggedIn = !!(r && r[CONFIG.tokenStorageKey]); // 未登录/账号停用（token被清）时不启用
        var hookOn = loggedIn && st.blockSoldOutDialog !== false;
        var debugOn = hookOn && st.soldoutDebugCompat === true; // 调试器兼容模式默认关（避免黄条）
        __bindDialogOn = loggedIn && st.autoConfirmBindOrder === true; // 绑定成功提示转通知开关
        cb({ hookOn: hookOn, debugOn: debugOn });
      });
    } catch (e) { cb({ hookOn: false, debugOn: false }); }
  }

  /* ---- 方案A：hook 注入（保留，现代内核无黄条） ---- */
  function runInject(tabId, target) {
    if (!chrome.scripting || !chrome.scripting.executeScript) return;
    try {
      var p = chrome.scripting.executeScript({ target: target, files: ["content/block-dialog-hook.js"], world: "MAIN", injectImmediately: true });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
  if (chrome.webNavigation) {
    chrome.webNavigation.onCommitted.addListener(function (d) {
      if (d.frameId === 0 && isGoods(d.url)) {
        readSettings(function (st) {
          if (st.hookOn) {
            runInject(d.tabId, { tabId: d.tabId, allFrames: true });
            [300, 1000, 2500].forEach(function (ms) { setTimeout(function () { runInject(d.tabId, { tabId: d.tabId, allFrames: true }); }, ms); });
          }
          if (st.debugOn) attachDebugger(d.tabId); else detachDebugger(d.tabId);
        });
      } else if (d.frameId === 0) {
        detachDebugger(d.tabId);
      }
    });
  }
  if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(function (tabId) { detachDebugger(tabId); });

  /* ---- 方案B：chrome.debugger 自动处理原生对话框 ---- */
  function attachDebugger(tabId) {
    if (!chrome.debugger || attached[tabId]) return;
    try {
      chrome.debugger.attach({ tabId: tabId }, "1.3", function () {
        if (chrome.runtime.lastError) { return; }
        attached[tabId] = true;
        chrome.debugger.sendCommand({ tabId: tabId }, "Page.enable", function () { void chrome.runtime.lastError; });
        // 告诉主世界 hook：debugger 已激活，绑定 alert 放行给原生由 debugger 接管
        try {
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            args: [true],
            func: function (v) { try { window.__zccDebuggerActive = v; } catch (e) {} }
          }).catch(function () {});
        } catch (e) {}
      });
    } catch (e) {}
  }
  function detachDebugger(tabId) {
    if (!chrome.debugger || !attached[tabId]) return;
    try { chrome.debugger.detach({ tabId: tabId }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    delete attached[tabId];
    // 清除页面标记
    try {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        args: [false],
        func: function (v) { try { window.__zccDebuggerActive = v; } catch (e) {} }
      }).catch(function () {});
    } catch (e) {}
  }

  // 页面内显示非阻塞 toast（自包含，注入到顶层 frame）
  function showToastInPage(text) {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, function () {});
    Object.keys(attached).forEach(function (id) {
      var tabId = Number(id);
      try {
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          args: [text],
          func: function (msg) {
            try {
              var STYLE_ID = "zcc-dialog-toast-style", CONTAINER_ID = "zcc-dialog-toast-wrap";
              if (!document.getElementById(STYLE_ID)) {
                var st = document.createElement("style"); st.id = STYLE_ID;
                st.textContent = "#"+CONTAINER_ID+"{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;}" +
                  ".zcc-dialog-toast{pointer-events:auto;min-width:240px;max-width:420px;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;background:#fff;border:1px solid #f0d9b0;border-left:4px solid #e6a23c;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.15);color:#303133;font-size:13px;line-height:1.5;word-break:break-word;}" +
                  ".zcc-dialog-toast .zcc-ico{flex:0 0 auto;font-size:15px;line-height:1.4;}.zcc-dialog-toast .zcc-msg{flex:1;}" +
                  ".zcc-dialog-toast .zcc-x{flex:0 0 auto;cursor:pointer;color:#b0b3b8;font-size:15px;line-height:1.2;padding:0 2px;background:none;border:none;}" +
                  "@keyframes zccToastIn{from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:translateY(0);}}";
                (document.head || document.documentElement).appendChild(st);
              }
              function build() {
                var wrap = document.getElementById(CONTAINER_ID);
                if (!wrap) { wrap = document.createElement("div"); wrap.id = CONTAINER_ID; document.body.appendChild(wrap); }
                var item = document.createElement("div"); item.className = "zcc-dialog-toast";
                var ico = document.createElement("span"); ico.className = "zcc-ico"; ico.textContent = "\u26A0\uFE0F";
                var txt = document.createElement("span"); txt.className = "zcc-msg"; txt.textContent = String(msg);
                var close = document.createElement("button"); close.className = "zcc-x"; close.textContent = "\u00D7";
                item.appendChild(ico); item.appendChild(txt); item.appendChild(close); wrap.appendChild(item);
                var timer = setTimeout(function () { item.remove(); }, 4000);
                close.onclick = function () { clearTimeout(timer); item.remove(); };
              }
              if (document.body) build(); else window.addEventListener("DOMContentLoaded", build, { once: true });
            } catch (e) {}
          }
        }).catch(function () {});
      } catch (e) {}
    });
  }

  // 记录每个 tab 的绑定是否为极速版（1秒关页）
  var __bindFastMap = {};

  var BIND_KEYWORD = "绑定采购单成功";
  if (chrome.debugger && chrome.debugger.onEvent) {
    chrome.debugger.onEvent.addListener(function (source, method, params) {
      if (method !== "Page.javascriptDialogOpening") return;
      var tabId = source.tabId;
      var msg = (params && params.message) || "";
      var type = params && params.type;
      if (type === "beforeunload") return;
      var isSold = msg.indexOf(KEYWORD) !== -1;
      var isBind = msg.indexOf(BIND_KEYWORD) !== -1;
      if (isBind && !__bindDialogOn) return; // 绑定成功提示：开关关闭时保持原生弹窗
      if (!isSold && !isBind) return; // 非目标弹窗：不干预
      if (isSold) {
        chrome.debugger.sendCommand({ tabId: tabId }, "Page.handleJavaScriptDialog", { accept: true }, function () { void chrome.runtime.lastError; });
        console.log("[智查查] 已自动关闭售罄弹窗:", msg);
        showToastInPage(msg);
      } else if (isBind) {
        console.log("[智查查] 绑定成功弹窗将在 1 秒后自动确定:", msg);
        setTimeout(function () {
          chrome.debugger.sendCommand({ tabId: tabId }, "Page.handleJavaScriptDialog", { accept: true }, function () {
            void chrome.runtime.lastError;
            // alert 关闭后立即通知页面显示倒计时自动关闭窗口
            var fast = !!__bindFastMap[tabId];
            setTimeout(function () {
              try { chrome.tabs.sendMessage(tabId, { type: 'ZCC_BIND_SUCCESS_CLOSE', fast: fast }); } catch (e) {}
              delete __bindFastMap[tabId];
            }, 300);
          });
        }, 1000);
        scheduleBindDetach(tabId);
      }
    });
  }

  // 点完“绑定”后临时 attach debugger，拦截绑定成功 alert；10 秒后自动 detach（售罄兼容模式常开除外）
  var __bindDetachTimer = {};
  function scheduleBindDetach(tabId) {
    clearTimeout(__bindDetachTimer[tabId]);
    __bindDetachTimer[tabId] = setTimeout(function () {
      try {
        chrome.storage.local.get("jd_settings", function (r) {
          var st = (r && r.jd_settings) || {};
          var soldDebugOn = st.blockSoldOutDialog !== false && st.soldoutDebugCompat === true;
          if (!soldDebugOn) detachDebugger(tabId);
        });
      } catch (e) {}
    }, 10000);
  }
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.type === "ZCC_BIND_DIALOG_WATCH" && sender.tab && sender.tab.id != null) {
        if (msg.fast) __bindFastMap[sender.tab.id] = true;
        attachDebugger(sender.tab.id);
      }
      if (msg && msg.type === "ZCC_CLOSE_TAB" && sender.tab && sender.tab.id != null) {
        // 先 detach debugger 再关 tab
        try { detachDebugger(sender.tab.id); } catch (e) {}
        chrome.tabs.remove(sender.tab.id, function () { void chrome.runtime.lastError; });
      }
      // 自主售后页：查询京东订单对应的关联采购单（SW 发起跨域请求，携带京大师登录 Cookie）
      if (msg && msg.type === "ZCC_AFS_BIND_QUERY" && Array.isArray(msg.orderIds) && msg.orderIds.length) {
        var filter = JSON.stringify({ order_id: msg.orderIds.join(",") });
        var op = JSON.stringify({ order_id: "in" });
        var url = "https://pay.jingbashi.com/back.php/order/status/index" +
          "?addtabs=1&sort=buy_time&order=desc&offset=0&limit=200" +
          "&filter=" + encodeURIComponent(filter) +
          "&op=" + encodeURIComponent(op) +
          "&_=" + Date.now();
        fetch(url, {
          method: "GET",
          credentials: "include", // 携带登录 Cookie
          headers: {
            // 关键：告诉后端这是 AJAX 请求，才会返回 JSON
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/plain, */*"
          }
        }).then(function (resp) { return resp.text(); })
          .then(function (text) {
            // 兜底判断：如果返回的是 HTML（说明又被当成页面了），给出提示
            if (text.trim().startsWith("<")) {
              sendResponse({ ok: false, notLogin: true, error: "京巴士未登录，请先登录后再查询" });
              return;
            }
            var parsed = JSON.parse(text);
            // 未登录 JSON：{code:0, msg:"请登录后操作", url:"/index/login?..."} → 显式标记，避免被当成“无关联单”
            if (parsed && parsed.code === 0 &&
                (String(parsed.msg || '').indexOf('登录') !== -1 || String(parsed.url || '').indexOf('login') !== -1)) {
              sendResponse({ ok: false, notLogin: true, error: "京巴士未登录，请先登录后再查询" });
              return;
            }
            sendResponse({ ok: true, data: parsed });
          })
          .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
        return true; // 异步 sendResponse
      }
      // 自主售后页：查询退货/中转仓出库单（zzc.jingbashi.com，与跟单接口不同域名）
      if (msg && msg.type === "ZCC_AFS_RETURN_QUERY" && Array.isArray(msg.orderIds) && msg.orderIds.length) {
        var ids = msg.orderIds;
        // 单条沿用原接口 LIKE 模糊匹配；多条用 in 精确匹配（逗号分隔）
        var isMulti = ids.length > 1;
        var rFilter = JSON.stringify({ order_id: isMulti ? ids.join(",") : ids[0] });
        var rOp = JSON.stringify({ order_id: isMulti ? "in" : "LIKE" });
        var rUrl = "https://zzc.jingbashi.com/returns/index" +
          "?addtabs=1&sort=id&order=desc&offset=0&limit=200" +
          "&filter=" + encodeURIComponent(rFilter) +
          "&op=" + encodeURIComponent(rOp) +
          "&_=" + Date.now();
        // 360 下 SW 直 fetch 带不上 zzc Cookie：优先走第一方 zzc 标签页代请求，失败再回退直 fetch
        function handleReturnText(text) {
          // 兜底：返回 HTML 说明被当成页面访问（缺登录态）
          if (text.trim().startsWith("<")) {
            sendResponse({ ok: true, notLogin: true });
            return;
          }
          var parsed = JSON.parse(text);
          // 未登录时接口返回 JSON：{code:0, msg:"请登录后操作", url:"/index/login?..."}
          if (parsed && parsed.code === 0 &&
              (String(parsed.msg || '').indexOf('登录') !== -1 || String(parsed.url || '').indexOf('login') !== -1)) {
            sendResponse({ ok: true, notLogin: true });
            return;
          }
          sendResponse({ ok: true, data: parsed });
        }
        function directReturnFetch() {
          fetch(rUrl, {
            method: "GET",
            credentials: "include", // 携带站点登录 Cookie
            headers: {
              // 关键：告知后端为 AJAX 请求，才返回 JSON 而非 HTML 页面
              "X-Requested-With": "XMLHttpRequest",
              "Accept": "application/json, text/plain, */*"
            }
          }).then(function (resp) { return resp.text(); })
            .then(handleReturnText)
            .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
        }
        zzcProxyFetch(rUrl, {
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/plain, */*"
          }
        }, function (resp) {
          if (!resp) { directReturnFetch(); return; }
          try {
            handleReturnText(b64ToText(resp.body));
          }
          catch (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
        });
        return true; // 异步 sendResponse
      }
      // 已取消订单采集：统一开独立标签页读取真实订单页，读完自动关闭；
      // 由 SW 主动轮询读取，不使用 iframe，避免框架内渲染限制和后台定时器节流影响
      if (msg && msg.type === "ZCC_COLLECT_CANCELED_IDS") {
        var cFinished = false;
        var cTabId = null;
        var cListener = null;
        var cTimer = null;
        var cPollTimer = null;
        var cTries = 0;
        var cLastSignature = '';
        var cStable = 0;
        function cFinish(resp) {
          if (cFinished) return;
          cFinished = true;
          try { if (cListener) chrome.tabs.onUpdated.removeListener(cListener); } catch (e) {}
          cListener = null;
          if (cPollTimer) { clearTimeout(cPollTimer); cPollTimer = null; }
          if (cTimer) { clearTimeout(cTimer); cTimer = null; }
          var idToClose = cTabId;
          cTabId = null;
          if (idToClose != null) {
            try { chrome.tabs.remove(idToClose, function () { void chrome.runtime.lastError; }); } catch (e) {}
          }
          sendResponse(resp);
        }
        function cPoll() {
          if (cFinished || cTabId == null) return;
          chrome.tabs.sendMessage(cTabId, { type: "ZCC_COLLECT_CANCELED_PAGE" }, function (resp) {
            if (cFinished) return;
            if (chrome.runtime.lastError) resp = null;
            cTries++;
            if (resp && resp.ok) {
              if (resp.orders && resp.orders.length) {
                // 连续两次读取到同一组订单号才完成，避免切到已取消标签前读取旧列表
                var signature = resp.orders.map(function (o) { return o.oid; }).sort().join(',');
                if (signature === cLastSignature) cStable++; else { cLastSignature = signature; cStable = 0; }
                if (cStable >= 1) { cFinish({ ok: true, orders: resp.orders, ids: resp.ids, url: resp.url }); return; }
              } else { cLastSignature = ''; cStable = 0; }
              if (cTries >= 18) {
                if (resp.emptyList) cFinish({ ok: true, orders: [], ids: [], url: resp.url });
                else cFinish({ ok: false, error: "已取消订单页已打开，但列表没有稳定渲染出来（可能被登录或风控拦截）" });
                return;
              }
            } else if (cTries >= 18) {
              cFinish({ ok: false, error: "后台采集页加载超时，未读取到订单列表" });
              return;
            }
            cPollTimer = setTimeout(cPoll, 2000);
          });
        }
        function cBegin() {
          if (cFinished) return;
          setTimeout(function () { cPoll(); }, 4000); // 页面 complete 后再等4秒让列表渲染
        }
        try {
          var collectUrl = "https://shop.jd.com/jdm/trade/orders/order-list?tabType=canceled&zcc_collect=1";
          function cOnTab(tab) {
            if (chrome.runtime.lastError || !tab || tab.id == null) {
              cFinish({ ok: false, error: "无法打开已取消订单采集页" });
              return;
            }
            cTabId = tab.id;
            cListener = function (tabId, info) {
              if (tabId !== cTabId || cFinished) return;
              if (info.status === "complete") {
                try { chrome.tabs.onUpdated.removeListener(cListener); } catch (e) {}
                cListener = null;
                cBegin();
              }
            };
            chrome.tabs.onUpdated.addListener(cListener);
            cTimer = setTimeout(function () {
              cFinish({ ok: false, error: "已取消订单采集超时（50秒）" });
            }, 50000);
            // 页面可能在监听器挂上之前就已加载完成，主动补查一次状态
            chrome.tabs.get(cTabId, function (t) {
              if (cFinished || !t) return;
              if (t.status === "complete" && cListener) {
                try { chrome.tabs.onUpdated.removeListener(cListener); } catch (e) {}
                cListener = null;
                cBegin();
              }
            });
          }
          if (msg.visible && chrome.windows && chrome.windows.create) {
            // 勾选“视图”：使用真正的顶层浏览器小窗，不用iframe；读取结束关闭唯一标签时小窗一并关闭
            chrome.windows.create({ url: collectUrl, type: "popup", width: 600, height: 700, left: 80, top: 60, focused: true }, function (win) {
              if (chrome.runtime.lastError || !win || !win.tabs || !win.tabs.length) {
                // 360等浏览器不支持popup时退回落到前台标签页，不让任务中断
                chrome.tabs.create({ url: collectUrl, active: true }, cOnTab);
                return;
              }
              cOnTab(win.tabs[0]);
            });
          } else {
            chrome.tabs.create({ url: collectUrl, active: false }, cOnTab); // 默认后台小标签，不抢占当前页面
          }
        } catch (e) {
          cFinish({ ok: false, error: String((e && e.message) || e) });
        }
        return true; // 异步 sendResponse
      }
    });
  }

  // 开关变化：实时 attach/detach
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      // 登出/账号停用导致 token 被清除：关闭拼多多页调试器
      if (changes[CONFIG.tokenStorageKey] && !changes[CONFIG.tokenStorageKey].newValue) {
        chrome.tabs.query({}, function (tabs) {
          (tabs || []).forEach(function (t) { if (isGoods(t.url)) detachDebugger(t.id); });
        });
      }
      if (!changes.jd_settings) return;
      var s = changes.jd_settings.newValue || {};
      var debugOn = s.blockSoldOutDialog !== false && s.soldoutDebugCompat === true;
      chrome.tabs.query({}, function (tabs) {
        (tabs || []).forEach(function (t) {
          if (!isGoods(t.url)) return;
          if (debugOn) attachDebugger(t.id); else detachDebugger(t.id);
        });
      });
    });
  }

  // 售后关联单「小窗」：允许拼多多订单页 / 京巴士中转仓被 iframe 内嵌（仅 sub_frame 请求，去掉 X-Frame-Options / CSP 响应头）
  if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules) {
    chrome.declarativeNetRequest.updateSessionRules({
      // 91003/91004 为历史 Cookie 注入规则：残留会用旧快照覆盖实时会话导致整站掉登录/令牌错误，启动即清理
      removeRuleIds: [91001, 91003, 91004],
      addRules: [{
        id: 91001,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "x-frame-options", operation: "remove" },
            { header: "content-security-policy", operation: "remove" },
            { header: "content-security-policy-report-only", operation: "remove" }
          ]
        },
        condition: {
          requestDomains: ["yangkeduo.com", "jingbashi.com"],
          resourceTypes: ["sub_frame"]
        }
      }]
    }, function () { void chrome.runtime.lastError; });
  }

  // 弹窗内嵌拼多多订单页登录态：跨站 iframe 默认不带 SameSite=Lax 的登录 Cookie，
  // 且 iframe 的第三方 Cookie 存储为空，页面 JS 读 document.cookie 校验会判未登录。
  // 方案：弹窗打开时 1) DNR 给 iframe 文档/接口请求注入 Cookie 头（兜底老内核）；
  //       2) chrome.cookies.set 把登录 Cookie 升级为 SameSite=None; Secure，
  //          并写一份 CHIPS 分区副本（partitionKey=jd.com），让 iframe 原生带 Cookie；
  //       弹窗关闭时只移除 DNR 规则，不动 Cookie（恢复/删除 Cookie 会导致拼多多整站掉登录）。
  function pddCookieUrl(c) {
    return "https://" + String(c.domain || "").replace(/^\./, "") + (c.path || "/");
  }
  // 确保有拼多多登录态快照（localStorage+可见Cookie，由 content/pdd-embed.js 采集）。
  // 快照缺失/过期时：优先从已打开的拼多多标签页直接采集；没有则后台开一个拼多多页采集后关闭。
  function ensurePddSeed(cb) {
    chrome.storage.local.get("zcc_pdd_embed_seed", function (res) {
      var seed = res && res.zcc_pdd_embed_seed;
      if (seed && seed.ts && (Date.now() - seed.ts < 24 * 3600 * 1000)) { cb(); return; }
      try {
        chrome.tabs.query({ url: "https://mobile.yangkeduo.com/*" }, function (tabs) {
          if (tabs && tabs.length) {
            try {
              chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                func: function () {
                  try {
                    var ls = {};
                    for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
                    return { ls: ls, cookie: document.cookie || "", ts: Date.now(), href: location.href };
                  } catch (e) { return null; }
                }
              }, function (rs) {
                void chrome.runtime.lastError;
                var r = rs && rs[0] && rs[0].result;
                if (r) {
                  chrome.storage.local.set({ zcc_pdd_embed_seed: r }, function () { void chrome.runtime.lastError; cb(); });
                } else { cb(); }
              });
            } catch (e) { cb(); }
            return;
          }
          // 没有已打开的拼多多标签页：后台静默开一个采集，6秒后关闭
          chrome.tabs.create({ url: "https://mobile.yangkeduo.com/", active: false }, function (tab) {
            void chrome.runtime.lastError;
            setTimeout(function () {
              try { chrome.tabs.remove(tab.id, function () { void chrome.runtime.lastError; }); } catch (e) {}
              cb();
            }, 6000);
          });
        });
      } catch (e) { cb(); }
    });
  }

  // ---------- 中转仓小窗登录态：debugger Fetch 拦截 + 第一方代请求 ----------
  // 360 内核下 DNR 请求头注入、SW fetch、debugger 改头均带不上 zzc Cookie，
  // 现由 zzc 第一方标签页代 fetch，Fetch.fulfillRequest 喂给 iframe；XHR/fetch 走注入的网络桥。
  // 仅弹窗打开期间 attach 对应京东标签页，关闭即 detach。
  var zzcDebugTabs = {}; // tabId -> { attached: true }
  if (chrome.debugger && chrome.debugger.onEvent) {
    chrome.debugger.onEvent.addListener(function (source, method, params) {
      if (method !== 'Fetch.requestPaused' || !params) return;
      var st = zzcDebugTabs[source.tabId];
      if (!st) return;
      var req = params.request || {};
      function plainContinue() {
        // 兜底：普通放行，避免请求卡死导致iframe空白
        try {
          chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.continueRequest', {
            requestId: params.requestId
          }, function () { void chrome.runtime.lastError; });
        } catch (e) {}
      }
      // 360 下 SW fetch / debugger 改头都带不上 zzc Cookie：改由 zzc 第一方标签页代 fetch，
      // 回传 status/headers/body 后用 Fetch.fulfillRequest 喂给 iframe
      var HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
      var fwd = {};
      var raw = req.headers || {};
      for (var k in raw) {
        var name = String(k).trim();
        if (!name || name.charAt(0) === ':' || !HEADER_NAME_RE.test(name)) continue;
        var low = name.toLowerCase();
        if (low === 'cookie' || low === 'host' || low === 'content-length' || low === 'accept-encoding') continue;
        // 第一方代请求自动带Cookie；去掉跨站痕迹头，避免服务端/WAF按cross-site拒绝
        if (low.indexOf('sec-fetch-') === 0 || low === 'origin' || low === 'referer') continue;
        fwd[name] = String(raw[k]);
      }
      // ref=addtabs 是后台外壳地址（非导航请求会被重定向到主页）；小窗内嵌应取内层列表页 addtabs=1
      var fetchUrl = String(req.url || '').replace('ref=addtabs', 'addtabs=1');
      zzcProxyFetch(fetchUrl, { method: req.method || 'GET', headers: fwd, body: req.postData || null }, function (resp) {
        if (!resp) {
          plainContinue();
          return;
        }
        // 文档响应注入网络桥：iframe 内 XHR/fetch 改走第一方代请求（360 不拦 XHR，裸奔会未登录）
        var outBody = resp.body;
        var ct = '';
        (resp.headers || []).forEach(function (p) { if (String(p[0]).toLowerCase() === 'content-type') ct = p[1]; });
        if (params.resourceType === 'Document' && ct.indexOf('html') !== -1) {
          try {
            var html = b64ToText(resp.body);
            var tag = '<script>(' + zzcFrameBridge.toString() + ')();</script>';
            if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, function (m) { return m + tag; });
            else html = tag + html;
            outBody = textToB64(html);
          } catch (e) {}
        }
        var rh = [];
        (resp.headers || []).forEach(function (pair) {
          var n = pair[0], v = pair[1];
          // 去掉set-cookie/压缩/长度/嵌套限制头：body已解码，iframe嵌套限制由代理响应解除
          if (/^(set-cookie|content-encoding|content-length|x-frame-options|content-security-policy|content-security-policy-report-only)$/i.test(n)) return;
          rh.push({ name: n, value: v });
        });
        try {
          chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: resp.status,
            responseHeaders: rh,
            body: outBody
          }, function () {
            if (chrome.runtime.lastError) plainContinue();
          });
        } catch (e) { plainContinue(); }
      });
    });
    chrome.debugger.onDetach.addListener(function (source) {
      if (source && source.tabId != null) delete zzcDebugTabs[source.tabId];
    });
  }
  function zzcDebuggerOn(tabId, done) {
    if (!chrome.debugger || tabId == null) { if (done) done(); return; }
    zzcDebugTabs[tabId] = zzcDebugTabs[tabId] || {};
    function enable() {
      try {
        chrome.debugger.sendCommand({ tabId: tabId }, 'Fetch.enable', {
          patterns: [{ urlPattern: 'https://*.jingbashi.com/*', requestStage: 'Request' }]
        }, function () {
          void chrome.runtime.lastError;
          if (done) done();
        });
      } catch (e) { if (done) done(); }
    }
    if (zzcDebugTabs[tabId].attached) { enable(); return; }
    try {
      chrome.debugger.attach({ tabId: tabId }, '1.3', function () {
        void chrome.runtime.lastError; // 已attach过（弹窗复用）视为成功；其它错误放弃拦截，走第一方代理兜底
        zzcDebugTabs[tabId].attached = true;
        enable();
      });
    } catch (e) { if (done) done(); }
  }
  function zzcDebuggerOff(tabId) {
    if (!chrome.debugger || tabId == null || !zzcDebugTabs[tabId]) return;
    delete zzcDebugTabs[tabId];
    try {
      chrome.debugger.sendCommand({ tabId: tabId }, 'Fetch.disable', {}, function () {
        void chrome.runtime.lastError;
        try { chrome.debugger.detach({ tabId: tabId }, function () { void chrome.runtime.lastError; }); } catch (e) {}
      });
    } catch (e) {}
  }

  // ---------- 第一方代请求通道 ----------
  // 360 下 SW fetch / 跨站 iframe / debugger 改头都带不上 zzc Cookie，
  // 改由 zzc 标签页（第一方）的 content/zzc-proxy.js 代 fetch 回传。
  var zzcProxyTabId = null;
  var zzcProxyCreated = false;
  var zzcModalOpen = false;
  function ensureZzcProxyTab(cb, forceCreate) {
    if (!forceCreate && zzcProxyTabId != null) {
      chrome.tabs.get(zzcProxyTabId, function (t) {
        if (chrome.runtime.lastError || !t) { zzcProxyTabId = null; ensureZzcProxyTab(cb); }
        else cb(zzcProxyTabId);
      });
      return;
    }
    try {
      chrome.tabs.query({ url: 'https://zzc.jingbashi.com/*' }, function (tabs) {
        if (!forceCreate && tabs && tabs.length) {
          zzcProxyTabId = tabs[0].id; zzcProxyCreated = false; cb(zzcProxyTabId); return;
        }
        // 没有已登录zzc标签页：后台开一个（顶层导航带Cookie），加载完即可代请求
        chrome.tabs.create({ url: 'https://zzc.jingbashi.com/returns?addtabs=1', active: false }, function (t) {
          void chrome.runtime.lastError;
          if (!t || t.id == null) { cb(null); return; }
          zzcProxyTabId = t.id; zzcProxyCreated = true;
          var done = false;
          function finish() { if (!done) { done = true; cb(t.id); } }
          var timer = setTimeout(finish, 8000);
          chrome.tabs.onUpdated.addListener(function listener(tid, info) {
            if (tid === t.id && info.status === 'complete') {
              clearTimeout(timer);
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(finish, 300); // 等 content script 注入就绪
            }
          });
        });
      });
    } catch (e) { cb(null); }
  }
  function closeZzcProxyTab() {
    if (zzcProxyCreated && zzcProxyTabId != null) {
      var id = zzcProxyTabId;
      try { chrome.tabs.remove(id, function () { void chrome.runtime.lastError; }); } catch (e) {}
    }
    zzcProxyTabId = null; zzcProxyCreated = false;
  }
  function zzcProxyFetch(url, opt, cb, retried) {
    ensureZzcProxyTab(function (tabId) {
      if (tabId == null) { cb(null); return; }
      var payload = {
        type: 'ZCC_PROXY_FETCH', url: url,
        method: (opt && opt.method) || 'GET',
        headers: (opt && opt.headers) || {},
        body: (opt && opt.body) || null
      };
      function send() {
        try {
          chrome.tabs.sendMessage(tabId, payload, function (resp) {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              // 插件重载后旧标签页没有 content script：就地补注入后重试一次
              if (!send.injected && chrome.scripting && chrome.scripting.executeScript) {
                send.injected = true;
                try {
                  chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content/zzc-proxy.js'] }, function () {
                    void chrome.runtime.lastError;
                    send();
                  });
                  return;
                } catch (e) {}
              }
              // 仍失败：换新建后台标签页兜底一次（旧标签页可能状态异常）
              if (!retried) {
                zzcProxyTabId = null;
                zzcProxyFetch(url, opt, cb, true);
                return;
              }
              cb(null);
              return;
            }
            cb(resp);
          });
        } catch (e) { cb(null); }
      }
      send();
    }, retried === true);
  }
  function b64ToText(b64) {
    var bin = atob(b64 || '');
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function textToB64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(bin);
  }
  // 快速填单脚本源码（注入小窗 srcdoc 弹层用；该脚本纯 DOM/postMessage，不依赖 chrome API）
  var qfSource = null;
  function withQfSource(cb) {
    if (qfSource !== null) { cb(qfSource); return; }
    fetch(chrome.runtime.getURL('content/returns-quick-fill.js'))
      .then(function (r) { return r.text(); })
      .then(function (t) { qfSource = t; cb(t); })
      .catch(function () { cb(''); });
  }
  // 注入小窗 iframe 的网络桥（函数源码序列化进 HTML 的 <script>，运行于 zzc 页面上下文）：
  // 360 的 Fetch 只拦文档不拦 iframe 内 XHR，导致接口裸奔未登录。
  // 这里改写 XHR/fetch：postMessage 给京东页中继 → SW → 第一方 zzc 标签页代请求，结果回传。
  function zzcFrameBridge() {
    if (window.__zccBridge) return;
    window.__zccBridge = true;
    // 小窗搜索栏精简：仅中转仓列表页（/returns，iframe 地址为 /returns?ref=addtabs）生效。
    // 搜索表单由页面 JS 后渲染，DOMContentLoaded 时可能不存在，用 MutationObserver 持续处理。
    if (location.pathname === '/returns') {
      // 搜索区紧凑样式：输入框高度/字号收窄、行距收紧
      try {
        var compactSt = document.createElement('style');
        compactSt.textContent = '.commonsearch-table .form-control{height:28px;padding:3px 8px;font-size:12px;}' +
          '.commonsearch-table .form-group{margin-bottom:6px;}' +
          '.commonsearch-table .btn{padding:4px 12px;font-size:12px;}';
        (document.head || document.documentElement).appendChild(compactSt);
      } catch (e) {}
      var trimSearch = function () {
        try {
          var groups = document.querySelectorAll('.commonsearch-table .form-group');
          if (!groups.length) return;
          for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            if (g.querySelector('#order_id,#package_waybill')) continue;
            if (g.querySelector('button[type="submit"],button[type="reset"]')) continue;
            g.style.display = 'none';
          }
        } catch (e) {}
      };
      trimSearch();
      new MutationObserver(trimSearch).observe(document.documentElement, { childList: true, subtree: true });
    }
    // srcdoc 弹层的 location.href 是 about:srcdoc，不能作为相对请求地址的基准；优先取文档baseURI，仍无效时回到京巴士站点
    var bridgeBase = String(location.href || '');
    if (!/^https:\/\/zzc\.jingbashi\.com\//.test(bridgeBase)) {
      try { bridgeBase = String(document.baseURI || ''); } catch (e) { bridgeBase = ''; }
      if (!/^https:\/\/zzc\.jingbashi\.com\//.test(bridgeBase)) bridgeBase = 'https://zzc.jingbashi.com/returns';
    }
    var bridgeOrigin = new URL(bridgeBase).origin;
    var bridgeOrderPrefill = { orderId: '', waybill: '' };
    try {
      var prefillParams = new URL(bridgeBase).searchParams;
      bridgeOrderPrefill.orderId = String(prefillParams.get('zcc_order_id') || '').replace(/\D/g, '');
      bridgeOrderPrefill.waybill = String(prefillParams.get('zcc_package_waybill') || '').replace(/[^A-Za-z0-9-]/g, '');
    } catch (e) {}
    // 弹层（layer）嵌套 iframe：跨站直载会丢登录 Cookie（360 不拦嵌套文档请求）。
    // 监听新出现的同源 iframe，第一方代取 HTML 后 srcdoc 回填，并注入同样的桥（表单内 XHR 也走代理）。
    var __bridgeSrc = '';
    try { __bridgeSrc = arguments.callee.toString(); } catch (e) {}
    function patchLayerIframes() {
      try {
        var frames = document.querySelectorAll('iframe[src]');
        for (var i = 0; i < frames.length; i++) {
          var f = frames[i];
          if (f.getAttribute('data-zcc-proxied')) continue;
          var src = f.getAttribute('src') || '';
          if (!src || src === 'about:blank') continue;
          var absSrc;
          try { absSrc = new URL(src, bridgeBase).href; } catch (e) { continue; }
          try { if (new URL(absSrc).origin !== bridgeOrigin) continue; } catch (e) { continue; }
          f.setAttribute('data-zcc-proxied', '1');
          f.setAttribute('allow', 'clipboard-read; clipboard-write'); // 弹层内读剪贴板快速填单
          (function (frame, url) {
            frame.src = 'about:blank'; // 先阻断直载，避免未登录页面闪现
            proxy('GET', url, {}, null, function (d) {
              if (!d.ok) { frame.src = url; return; } // 代理失败回退直载
              var html = '';
              try { html = new TextDecoder('utf-8').decode(b64Bytes(d.body)); } catch (e) {}
              if (html) {
                var prefillTag = '';
                if ((bridgeOrderPrefill.orderId || bridgeOrderPrefill.waybill) && /\/returns\/add/.test(url)) {
                  prefillTag = '<script>window.__ZCC_ORDER_PREFILL=' + JSON.stringify(bridgeOrderPrefill) + ';<\/script>';
                }
                var tag = prefillTag + '<script>(' + __bridgeSrc + ')();<\/script>';
                if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, function (m) { return m + tag; });
                else html = tag + html;
                frame.srcdoc = html;
              } else frame.src = url;
            });
          })(f, absSrc);
        }
      } catch (e) {}
    }
    patchLayerIframes();
    new MutationObserver(patchLayerIframes).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src']
    });
    var seq = 0, cbs = {};
    // 每层iframe独立编号会从1开始，嵌套弹层与列表页容易撞号；带随机层标识可确保保存回包传到真正的发起层
    var bridgeId = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    function b64Bytes(b64) {
      var bin = atob(b64 || '');
      var u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d) return;
      // 嵌套 srcdoc 弹层（如 /returns/add 确定保存）：代理请求逐层向上中继，最终到达京东页 after-sale-bind → SW → 第一方zzc标签页
      // 原逻辑只处理本层结果回传，导致表单层的保存请求停在列表层，永远不会真正发出
      if (d.type === 'ZCC_XHR_PROXY') {
        try { parent.postMessage(d, '*'); } catch (err) {}
        return;
      }
      if (d.type !== 'ZCC_XHR_PROXY_RESULT') return;
      var cb = cbs[d.id];
      if (cb) {
        delete cbs[d.id];
        cb(d);
        return;
      }
      // 本层没有该请求回调：说明请求来自嵌套弹层，把结果继续向下广播，由真正的发起层接收
      try {
        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
          try { if (frames[i].contentWindow) frames[i].contentWindow.postMessage(d, '*'); } catch (err) {}
        }
      } catch (err) {}
    });
    function normalizeProxyHeaders(headers) {
      var out = {};
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach(function (v, k) { out[k] = v; });
      } else {
        Object.keys(headers || {}).forEach(function (k) { out[k] = headers[k]; });
      }
      return out;
    }
    function encodeFormField(k, v) { return encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : String(v)); }
    function normalizeProxyBody(body, headers) {
      // FormData 经过 runtime 消息会退化成普通对象；保存前先序列化为后端可识别的 application/x-www-form-urlencoded
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        var pairs = [];
        body.forEach(function (v, k) { pairs.push(encodeFormField(k, v)); });
        var hasType = Object.keys(headers).some(function (k) { return k.toLowerCase() === 'content-type'; });
        if (!hasType) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        return pairs.join('&');
      }
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        var hasSearchType = Object.keys(headers).some(function (k) { return k.toLowerCase() === 'content-type'; });
        if (!hasSearchType) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        return body.toString();
      }
      return body || null;
    }
    function proxy(method, url, headers, body, cb) {
      var id = bridgeId + ':' + (++seq);
      var normalizedHeaders = normalizeProxyHeaders(headers);
      var normalizedBody = normalizeProxyBody(body, normalizedHeaders);
      cbs[id] = cb;
      parent.postMessage({ type: 'ZCC_XHR_PROXY', id: id, method: method, url: url, headers: normalizedHeaders, body: normalizedBody }, '*');
    }
    function abs(u) {
      var raw = String(u || '');
      // 原add表单未写action时，FastAdmin使用location.href；直载是/returns/add，srcdoc则会变成about:srcdoc，需还原真实保存地址
      if (/^about:(?:srcdoc|blank)$/i.test(raw)) {
        var isFillForm = window.__ZCC_QF_ROLE === 'fill';
        try { isFillForm = isFillForm || !!document.querySelector('#add-form'); } catch (e) {}
        if (isFillForm) return bridgeOrigin + '/returns/add?dialog=1';
      }
      try { return new URL(raw, bridgeBase).href; } catch (e) { return u; }
    }
    function isLocal(u) { try { return new URL(abs(u), bridgeBase).origin === bridgeOrigin; } catch (e) { return false; } }
    function ProxyXHR() {
      var self = this;
      this.readyState = 0; this.status = 0; this.statusText = ''; this.responseText = ''; this.response = ''; this.responseType = '';
      this._h = {}; this._rh = [];
      this.onreadystatechange = null; this.onload = null; this.onerror = null; this.onloadend = null;
      this.open = function (m, u) { self._m = m; self._u = abs(u); self.readyState = 1; };
      this.setRequestHeader = function (n, v) { self._h[n] = v; };
      this.getAllResponseHeaders = function () { return self._rh.map(function (p) { return p[0] + ': ' + p[1]; }).join('\r\n'); };
      this.getResponseHeader = function (n) {
        n = String(n).toLowerCase();
        for (var i = 0; i < self._rh.length; i++) if (self._rh[i][0].toLowerCase() === n) return self._rh[i][1];
        return null;
      };
      this.abort = function () {};
      this.send = function (body) {
        proxy(self._m || 'GET', self._u, self._h, body, function (d) {
          if (!d.ok) {
            self.status = 0; self.statusText = d.error || 'error'; self.readyState = 4;
            self.responseText = d.error || ''; self.response = self.responseText;
            try { console.error('[智查查-京巴士代理] 请求失败:', self._m, self._u, self.statusText); } catch (e) {}
            if (self.onerror) self.onerror(); if (self.onloadend) self.onloadend(); return;
          }
          self.status = d.status; self.statusText = d.status >= 200 && d.status < 300 ? 'OK' : ''; self._rh = d.headers || [];
          var txt = '';
          try { txt = new TextDecoder('utf-8').decode(b64Bytes(d.body)); } catch (e) {}
          self.responseText = txt;
          if (self.responseType === 'json') { try { self.response = JSON.parse(txt); } catch (e) { self.response = null; } }
          else self.response = txt;
          self.readyState = 4;
          if (self.onreadystatechange) self.onreadystatechange();
          if (self.onload) self.onload();
          if (self.onloadend) self.onloadend();
        });
      };
    }
    window.XMLHttpRequest = ProxyXHR;
    var nativeFetch = window.fetch;
    window.fetch = function (u, opt) {
      opt = opt || {};
      var rawUrl = typeof u === 'string' ? u : u.url;
      if (!isLocal(rawUrl)) return nativeFetch.apply(this, arguments);
      return new Promise(function (resolve, reject) {
        proxy(opt.method || 'GET', abs(rawUrl), opt.headers || {}, opt.body || null, function (d) {
          if (!d.ok) { reject(new TypeError(d.error || 'zcc proxy failed')); return; }
          var h = new Headers();
          (d.headers || []).forEach(function (p) { h.append(p[0], p[1]); });
          resolve(new Response(b64Bytes(d.body), { status: d.status, headers: h }));
        });
      });
    };

    // FastAdmin弹层底部“确定”在外层，实际通过 Form.api.submit → Fast.api.ajax → jQuery.ajax 提交。
    // 对该保存接口直接接管 $.ajax，避免跨iframe的jQuery传输器与ProxyXHR差异导致静默error；其它接口仍走原生/ProxyXHR。
    function patchJQueryReturnsSave() {
      var jq = window.jQuery;
      if (!jq || !jq.ajax) return false;
      if (jq.__zccReturnsSaveBridge) return true;
      jq.__zccReturnsSaveBridge = true;
      var nativeAjax = jq.ajax;
      jq.ajax = function (options) {
        options = options || {};
        var method = String(options.type || options.method || 'GET').toUpperCase();
        var requestUrl = abs(options.url || bridgeBase);
        if (method !== 'POST' || !isLocal(requestUrl) || !/\/returns\/add(?:\?|$)/.test(requestUrl)) {
          return nativeAjax.apply(this, arguments);
        }
        var callbackContext = options.context || options;
        var requestHeaders = normalizeProxyHeaders(options.headers || {});
        var hasContentType = Object.keys(requestHeaders).some(function (k) { return k.toLowerCase() === 'content-type'; });
        if (!hasContentType) requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        if (!requestHeaders['X-Requested-With']) requestHeaders['X-Requested-With'] = 'XMLHttpRequest';
        if (!requestHeaders['Accept']) requestHeaders['Accept'] = 'application/json, text/javascript, */*; q=0.01';
        var finished = false;
        var fakeXhr = {
          readyState: 0, status: 0, statusText: '', responseText: '', response: null, responseJSON: undefined, _rh: [],
          abort: function () { finished = true; this.readyState = 4; this.statusText = 'abort'; },
          setRequestHeader: function (n, v) { requestHeaders[n] = v; },
          getAllResponseHeaders: function () {
            return this._rh.map(function (p) { return p[0] + ': ' + p[1]; }).join('\r\n');
          },
          getResponseHeader: function (n) {
            n = String(n).toLowerCase();
            for (var i = 0; i < this._rh.length; i++) {
              if (String(this._rh[i][0]).toLowerCase() === n) return this._rh[i][1];
            }
            return null;
          }
        };
        if (typeof options.beforeSend === 'function' && options.beforeSend.call(callbackContext, fakeXhr, options) === false) return fakeXhr;
        try { console.log('[智查查-售后保存] 开始代理POST:', requestUrl); } catch (e) {}
        proxy('POST', requestUrl, requestHeaders, options.data || null, function (d) {
          if (finished) return;
          finished = true;
          fakeXhr.readyState = 4;
          fakeXhr.status = d.status || 0;
          fakeXhr._rh = d.headers || [];
          var text = '';
          try { text = new TextDecoder('utf-8').decode(b64Bytes(d.body)); } catch (e) {}
          fakeXhr.responseText = text;
          var httpOk = !!(d.ok && ((fakeXhr.status >= 200 && fakeXhr.status < 300) || fakeXhr.status === 304));
          var parsed = text;
          var parseError = null;
          if (httpOk && String(options.dataType || '').toLowerCase() === 'json') {
            try { parsed = JSON.parse(text); } catch (e) { parseError = e; }
          }
          try { console.log('[智查查-售后保存] 代理回包:', fakeXhr.status, d.error || '', text.slice(0, 500)); } catch (e) {}
          var textStatus = 'success';
          if (httpOk && !parseError) {
            fakeXhr.statusText = 'OK';
            fakeXhr.response = parsed;
            if (String(options.dataType || '').toLowerCase() === 'json') fakeXhr.responseJSON = parsed;
            if (typeof options.success === 'function') options.success.call(callbackContext, parsed, 'success', fakeXhr);
          } else {
            textStatus = parseError ? 'parsererror' : 'error';
            fakeXhr.statusText = parseError ? 'parsererror' : (d.error || 'error');
            fakeXhr.response = text;
            if (typeof options.error === 'function') options.error.call(callbackContext, fakeXhr, textStatus, parseError || d.error || 'error');
          }
          if (typeof options.complete === 'function') options.complete.call(callbackContext, fakeXhr, textStatus);
        });
        return fakeXhr;
      };
      return true;
    }
    var jqPatchTries = 0;
    var jqPatchTimer = setInterval(function () {
      jqPatchTries++;
      if (patchJQueryReturnsSave() || jqPatchTries > 100) clearInterval(jqPatchTimer);
    }, 100);
    if (patchJQueryReturnsSave()) clearInterval(jqPatchTimer);
  }

  // 内嵌站点配置：拼多多采购单 / 京巴士中转仓（zzc+pay 同属 jingbashi.com）
  var PDD_EMBED_SITE = { cookieDomain: "yangkeduo.com", urlFilter: "||mobile.yangkeduo.com/", ruleIds: [91002, 91003], seed: true };
  var ZZC_EMBED_SITE = { cookieDomain: "jingbashi.com", urlFilter: "||jingbashi.com/", ruleIds: [91004], seed: false, injectCookie: false };

  function embedCookieRule(on, done, site) {
    site = site || PDD_EMBED_SITE;
    var dnrOk = chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules;
    // 京巴士：登录态走第一方代请求通道，禁用 DNR Cookie 注入——
    // 旧快照会覆盖其它窗口的实时会话（sub_frame/XHR），导致整站掉登录、登录报令牌错误，
    // 且会话规则残留到浏览器重启才清除。这里只负责清掉历史注入规则。
    if (site.injectCookie === false) {
      if (dnrOk) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: site.ruleIds }, function () { void chrome.runtime.lastError; });
      if (done) done();
      return;
    }
    if (!on) {
      // 关闭弹窗：只移除 DNR 注入规则。不做任何 Cookie 恢复/删除动作——
      // 之前恢复原始属性+删分区副本会把拼多多登录 Cookie 弄丢，导致整站掉登录。
      if (dnrOk) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: site.ruleIds }, function () { void chrome.runtime.lastError; });
      if (done) done();
      return;
    }
    if (!chrome.cookies || !chrome.cookies.getAll) { if (done) done(); return; }
    function run() {
    chrome.cookies.getAll({ domain: site.cookieDomain }, function (cookies) {
      // 只取非分区的第一方 Cookie 作为源
      var list = (cookies || []).filter(function (c) { return !c.partitionKey; });
      var pairs = list.map(function (c) { return c.name + "=" + c.value; });
      if (!pairs.length) { if (done) done(); return; } // 没有该站Cookie（未登录），不注入
      var pending = list.length;
      function afterOne() {
        pending--;
        if (pending > 0) return;
        if (!dnrOk) { if (done) done(); return; }
        chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: site.ruleIds,
          addRules: [{
            id: site.ruleIds[0],
            priority: 2,
            action: {
              type: "modifyHeaders",
              requestHeaders: [{ header: "cookie", operation: "set", value: pairs.join("; ") }]
            },
            condition: {
              urlFilter: site.urlFilter,
              resourceTypes: ["sub_frame", "xmlhttprequest"]
            }
          }]
        }, function () {
          void chrome.runtime.lastError;
          if (done) done();
        });
      }
      list.forEach(function (c) {
        var details = {
          url: pddCookieUrl(c), name: c.name, value: c.value, path: c.path || "/",
          secure: true, httpOnly: !!c.httpOnly, sameSite: "no_restriction"
        };
        if (!c.hostOnly && c.domain) details.domain = c.domain;
        if (c.expirationDate) details.expirationDate = c.expirationDate;
        var fired = false;
        function once() { if (!fired) { fired = true; afterOne(); } }
        try {
          chrome.cookies.set(details, function () {
            void chrome.runtime.lastError;
            // CHIPS 分区副本：第三方 Cookie 被拦截时 iframe 读分区存储（老内核不支持则忽略报错）
            try {
              var p = {}; for (var k in details) p[k] = details[k];
              p.partitionKey = { topLevelSite: "https://jd.com" };
              chrome.cookies.set(p, function () { void chrome.runtime.lastError; once(); });
            } catch (e) { once(); }
          });
        } catch (e) { once(); }
      });
    });
    }
    // 拼多多需要 localStorage 登录态快照（iframe 内页面 JS 校验依赖它）；中转仓为服务端渲染，只需 Cookie
    if (site.seed) ensurePddSeed(run); else run();
  }
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.type === "ZCC_PDD_EMBED_ON") { embedCookieRule(true, function () { sendResponse({ ok: true }); }, PDD_EMBED_SITE); return true; }
      if (msg && msg.type === "ZCC_PDD_EMBED_OFF") embedCookieRule(false, null, PDD_EMBED_SITE);
      // ===== 台账网页桥接（内容脚本 ledger-bridge.js 转发，无需 externally_connectable/插件ID）=====
      // 拼多多小窗登录态开/关（复用插件小窗同款机制；此处 embedCookieRule 在作用域内）
      if (msg && msg.type === 'ZCC_LEDGER_PDD_ON') { embedCookieRule(true, function () { sendResponse({ ok: true }); }, PDD_EMBED_SITE); return true; }
      if (msg && msg.type === 'ZCC_LEDGER_PDD_OFF') { embedCookieRule(false, null, PDD_EMBED_SITE); sendResponse({ ok: true }); return; }
      // 京巴士关联单查询 → 供台账自动回填采购单/快递单/快递公司
      if (msg && msg.type === 'ZCC_LEDGER_LOOKUP') {
        var orderNo = String(msg.orderNo || '').trim();
        if (!orderNo) { sendResponse({ ok: false, error: '缺少订单号' }); return; }
        var filter = JSON.stringify({ order_id: orderNo });
        var op = JSON.stringify({ order_id: 'in' });
        var url = 'https://pay.jingbashi.com/back.php/order/status/index' +
          '?addtabs=1&sort=buy_time&order=desc&offset=0&limit=200' +
          '&filter=' + encodeURIComponent(filter) + '&op=' + encodeURIComponent(op) + '&_=' + Date.now();
        fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' }
        }).then(function (r) { return r.text(); })
          .then(function (text) {
            if (text.trim().charAt(0) === '<') { sendResponse({ ok: false, notLogin: true, error: '京巴士未登录' }); return; }
            var parsed = JSON.parse(text);
            if (parsed && parsed.code === 0 &&
                (String(parsed.msg || '').indexOf('登录') !== -1 || String(parsed.url || '').indexOf('login') !== -1)) {
              sendResponse({ ok: false, notLogin: true, error: '京巴士未登录' }); return;
            }
            var rows = (parsed && parsed.rows) || [];
            var out = [];
            var seen = {};
            rows.forEach(function (row) {
              var extra = row.extra && Array.isArray(row.extra.buy) ? row.extra.buy : [];
              [row].concat(extra).forEach(function (r) {
                var sn = String(r.buy_order_id || '');
                if (!sn || seen[sn]) return;
                seen[sn] = 1;
                out.push({
                  buy_order_id: sn,
                  buy_express_id: String(r.buy_express_id || ''),
                  buy_express_company: String(r.buy_express_company || ''),
                  buy_platform_text: String(r.buy_platform_text || '')
                });
              });
            });
            sendResponse({ ok: true, rows: out });
          })
          .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
        return true; // 异步 sendResponse
      }
      if (msg && msg.type === "ZCC_ZZC_EMBED_ON") {
        // 先确保DNR规则生效，再attach/放行iframe请求
        var ztab = sender && sender.tab ? sender.tab.id : null;
        zzcModalOpen = true;
        embedCookieRule(true, function () {
          zzcDebuggerOn(ztab, function () { sendResponse({ ok: true }); });
        }, ZZC_EMBED_SITE);
        return true;
      }
      if (msg && msg.type === "ZCC_ZZC_EMBED_OFF") {
        zzcModalOpen = false;
        embedCookieRule(false, null, ZZC_EMBED_SITE);
        zzcDebuggerOff(sender && sender.tab ? sender.tab.id : null);
        closeZzcProxyTab();
      }
      // 小窗网络桥中继：iframe 内 XHR/fetch → 京东页 → 这里 → 第一方 zzc 标签页代请求
      if (msg && msg.type === "ZCC_FRAME_FETCH") {
        zzcProxyFetch(msg.url, { method: msg.method, headers: msg.headers, body: msg.body }, function (resp) {
          // 仅GET表单文档注入快速填单；POST /returns/add 是保存请求，其JSON成功响应必须原样立即回传，不能再走HTML注入
          if (String(msg.method || 'GET').toUpperCase() === 'GET' && resp && resp.ok && /\/returns\/add/.test(String(msg.url || ''))) {
            withQfSource(function (src) {
              try {
                var html = b64ToText(resp.body);
                if (html.trim().charAt(0) === '<') {
                  // 紧凑样式（单列）：标签与输入框共占一行，输入框/按钮尺寸收窄
                  var compact = '<style id="zcc-qf-compact">' +
                    '#add-form .form-group{display:flex;align-items:center;margin-bottom:8px;}' +
                    '#add-form label.control-label{flex:0 0 76px;width:auto;font-size:12px;text-align:right;padding:0 8px 0 0;margin:0;}' +
                    '#add-form .form-group > div{flex:1;width:auto;}' +
                    '#add-form .form-control{height:28px;padding:3px 8px;font-size:12px;width:100%;max-width:300px;box-sizing:border-box;}' +
                    '#add-form textarea.form-control{height:auto;min-height:56px;}' +
                    '#add-form .btn{padding:4px 12px;font-size:12px;}' +
                    '</style>';
                  var tag = compact + '<script>window.__ZCC_QF_ROLE="fill";</script>' + (src ? '<script>' + src + '<\/script>' : '');
                  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, function (m) { return m + tag; });
                  else html = tag + html;
                  resp.body = textToB64(html);
                }
              } catch (e) {}
              sendResponse(resp);
            });
            return;
          }
          sendResponse(resp || { ok: false });
        });
        return true; // 异步 sendResponse
      }
    });
  // 台账小窗跳转完整管理页：域名统一读取 config.js 的 adminUrl，路由仅允许台账页面
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'ZCC_LEDGER_OPEN_ADMIN') return;
    if (msg.path !== '/expressLedger') { sendResponse({ success: false, msg: '页面不在允许范围' }); return; }
    const base = (typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.adminUrl) || 'http://localhost:8080/';
    const url = base.replace(/\/?$/, '/') + '#/expressLedger';
    chrome.tabs.create({ url: url }, function () {
      const err = chrome.runtime.lastError;
      sendResponse(err ? { success: false, msg: err.message } : { success: true, url: url });
    });
    return true;
  });
  // 京东交易后台台账小窗统一API代理：复用插件登录token，只允许白名单内的台账、店铺及桌宠今日统计接口
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'ZCC_LEDGER_API') return;
    const allowed = /^\/(ledger\/(list|counts|lookup|add|edit|del)|shop\/list|dashboard\/shop-stats)$/;
    if (!allowed.test(String(msg.path || ''))) { sendResponse({ success: false, msg: '接口不在允许范围' }); return; }
    (async function () {
      const authInfo = await getCurrentUser();
      if (!authInfo.token) throw new Error('请先登录智查查');
      const method = String(msg.method || 'GET').toUpperCase();
      let url = CONFIG.apiBaseUrl + msg.path;
      if (msg.query) {
        const qs = new URLSearchParams();
        Object.keys(msg.query).forEach(function (k) {
          if (msg.query[k] !== '' && msg.query[k] !== null && msg.query[k] !== undefined) qs.set(k, msg.query[k]);
        });
        const text = qs.toString(); if (text) url += (url.indexOf('?') >= 0 ? '&' : '?') + text;
      }
      const resp = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authInfo.token },
        body: method === 'GET' ? undefined : JSON.stringify(msg.body || {})
      });
      const data = await resp.json().catch(function () { return { code: -1, msg: '服务返回格式错误' }; });
      if (!resp.ok) throw new Error(data.msg || ('HTTP ' + resp.status));
      sendResponse({ success: data.code === 0, data: data.data, msg: data.msg || '', code: data.code });
    })().catch(function (e) { sendResponse({ success: false, msg: String((e && e.message) || e) }); });
    return true;
  });
  }
})();

/* ===== 小泷京准通广告费用静默采集 =====
   使用屏幕内正常尺寸的小窗/小标签让京准通SPA完整渲染，读取总花费后立即关闭；查不到则静默结束，不影响其他巡检 */
(function () {
  var adCostJob = null;
  var AD_COST_URL = 'https://jzt.jd.com/home/#/index';

  function finishAdCostJob(result) {
    var job = adCostJob;
    if (!job || job.finished) return;
    job.finished = true;
    adCostJob = null;
    if (job.timer) clearTimeout(job.timer);
    if (job.tabId != null) {
      try { chrome.tabs.remove(job.tabId, function () { void chrome.runtime.lastError; }); } catch (e) {}
    }
    try { job.sendResponse({ success: true, data: result || { found: false } }); } catch (e) {}
  }

  function openAdCostPage() {
    var url = AD_COST_URL + (AD_COST_URL.indexOf('?') >= 0 ? '&' : '?') + 'zcc_ad_collect=' + Date.now();
    function onTab(tab) {
      if (!adCostJob || adCostJob.finished) return;
      if (chrome.runtime.lastError || !tab || tab.id == null) { finishAdCostJob({ found: false }); return; }
      adCostJob.tabId = tab.id;
      adCostJob.timer = setTimeout(function () { finishAdCostJob({ found: false, reason: '京准通页面读取超时' }); }, 45000);
    }
    try {
      if (chrome.windows && chrome.windows.create) {
        // 120x80且移到屏幕外会导致部分京准通页面不渲染；改成屏幕内正常小窗，非聚焦显示、读完自动关闭
        chrome.windows.create({ url: url, type: 'popup', width: 560, height: 680, left: 80, top: 60, focused: false }, function (win) {
          if (chrome.runtime.lastError || !win || !win.tabs || !win.tabs.length) {
            // 360等不支持popup时退到小标签；前台加载可确保SPA渲染，采集结束会立即关闭
            chrome.tabs.create({ url: url, active: true }, onTab);
            return;
          }
          onTab(win.tabs[0]);
        });
      } else {
        chrome.tabs.create({ url: url, active: true }, onTab);
      }
    } catch (e) {
      try { chrome.tabs.create({ url: url, active: true }, onTab); }
      catch (err) { finishAdCostJob({ found: false, reason: '无法打开京准通采集小窗' }); }
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'ZCC_AD_COST_QUERY') {
      if (adCostJob) { sendResponse({ success: true, data: { found: false, busy: true } }); return; }
      adCostJob = { sendResponse: sendResponse, tabId: null, timer: null, finished: false };
      openAdCostPage();
      return true; // 等待采集结果或45秒超时
    }
    if (msg.type === 'ZCC_AD_COST_COLLECTED') {
      if (!adCostJob || !sender.tab || sender.tab.id !== adCostJob.tabId) return;
      var cost = Number(msg.cost);
      if (msg.found && isFinite(cost) && cost >= 0) finishAdCostJob({ found: true, cost: cost, url: String(msg.url || '') });
      else if (msg.found === false) finishAdCostJob({ found: false, reason: String(msg.reason || '未读取到京准通总花费') });
      // 不回复采集脚本：结果统一返回给发起巡检的小泷页面
    }
  });
})();
