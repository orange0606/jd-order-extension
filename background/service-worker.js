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
  const { orders, importList, url, timestamp } = payload;
  
  console.log(`[Background] 收到 ${orders.length} 条订单数据，准备同步到服务器`);

  // 如果已登录，直接同步（使用接口格式的importList，不存本地）
  const isLoggedIn = await checkLoginStatus();
  let syncResult = null;
  if (isLoggedIn && importList && importList.length > 0) {
    try {
      syncResult = await syncOrdersToServer(importList);
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
      syncResult = { success: false, message: e.message };
      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'SYNC_RESULT',
          payload: syncResult
        });
      }
    }
  }

  // 显示通知
  if (orders.length > 0 && syncResult?.success) {
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
async function checkLoginStatus() {
  try {
    const result = await chrome.storage.local.get(CONFIG.tokenStorageKey);
    return !!result[CONFIG.tokenStorageKey];
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
      ? `新增${data.data.insert}条，更新${data.data.update}条` 
      : `${ordersToSync.length}条`;
    console.log(`[Background] 同步成功: ${resultMsg}`);

    return {
      success: true,
      synced: ordersToSync.length,
      insert: data.data?.insert || 0,
      update: data.data?.update || 0,
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
