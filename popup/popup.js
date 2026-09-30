/**
 * Popup 弹窗逻辑
 */

document.addEventListener('DOMContentLoaded', () => {
  // 从配置文件读取版本号
  const verEl = document.getElementById('app-version');
  if (verEl && typeof ZHICHACHA_CONFIG !== 'undefined') {
    verEl.textContent = 'v' + ZHICHACHA_CONFIG.version + ' | 智查查风控系统';
  }
  bindEvents();
  initApp();
});


async function initApp() {
  await checkLoginStatus();
  await loadShopList();
}

// ==================== 事件绑定 ====================

function bindEvents() {
  // 登录表单
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  
  // 主界面按钮
  document.getElementById('btn-logout').addEventListener('click', handleLogout);
  document.getElementById('btn-admin').addEventListener('click', openAdminPage);
  document.getElementById('btn-search-bad').addEventListener('click', openSearchBadPage);
  
  // 设置
  document.getElementById('btn-settings').addEventListener('click', showSettingsView);
  document.getElementById('btn-back').addEventListener('click', showMainView);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  // 定时查单发货开关联动
  // 定时查单发货开关联动
  document.getElementById('setting-auto-ship').addEventListener('change', (e) => {
    const on = e.target.checked;
    document.getElementById('auto-ship-interval-row').style.display = on ? 'flex' : 'none';
    document.getElementById('auto-switch-shop-row').style.display = on ? 'flex' : 'none';
    document.getElementById('auto-ship-timerange-row').style.display = on ? 'flex' : 'none';
    if (!on) document.getElementById('auto-ship-timepick-row').style.display = 'none';
  });

  // 时间段开关联动
  document.getElementById('setting-auto-ship-timerange').addEventListener('change', (e) => {
    document.getElementById('auto-ship-timepick-row').style.display = e.target.checked ? 'flex' : 'none';
  });

  // 同步物流开关联动
  document.getElementById('setting-auto-sync-express').addEventListener('change', (e) => {
    document.getElementById('sync-express-interval-row').style.display = e.target.checked ? 'flex' : 'none';
  });
}

// ==================== 视图切换 ====================

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
}

function showSettingsView() {
  showView('settings-view');
  loadSettings();
}

function showMainView() {
  showView('main-view');
}

function showLoginView() {
  showView('login-view');
}

// ==================== 登录相关 ====================

async function checkLoginStatus() {
  try {
    const response = await sendMessage({ type: 'CHECK_LOGIN' });
    if (response.isLoggedIn) {
      const user = await getStoredUser();
      document.getElementById('user-name').textContent = user?.username || '用户';
      showMainView();
    } else {
      showLoginView();
    }
  } catch (e) {
    console.error('检查登录状态失败:', e);
    showLoginView();
  }
}

async function getStoredUser() {
  const result = await chrome.storage.local.get('zhichacha_user');
  return result.zhichacha_user;
}

async function handleLogin(e) {
  e.preventDefault();
  
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  
  if (!username || !password) {
    errorEl.textContent = '请输入账号和密码';
    return;
  }
  
  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = '登录中...';
  
  try {
    const response = await sendMessage({
      type: 'LOGIN',
      payload: { username, password }
    });
    
    if (response.success) {
      showToast('登录成功', 'success');
      document.getElementById('user-name').textContent = response.user?.username || username;
      showMainView();
      await loadShopList();
    } else {
      errorEl.textContent = response.message || '登录失败';
    }
  } catch (e) {
    errorEl.textContent = e.message || '登录失败，请检查网络和服务器地址';
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

async function handleLogout() {
  if (!confirm('确定要退出登录吗？')) return;
  
  await sendMessage({ type: 'LOGOUT' });
  showToast('已退出登录');
  showLoginView();
}

// ==================== 页面检测 ====================

async function checkCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.url) {
      updatePageStatus('无法获取页面信息', 'warning');
      return null;
    }
    
    if (tab.url.includes('shop.jd.com')) {
      updatePageStatus('✅ 京东商家后台', 'success');
      return tab;
    } else {
      updatePageStatus('⚠️ 未在京东商家后台', 'warning');
      return tab;
    }
  } catch (e) {
    updatePageStatus('检测页面失败', 'error');
    return null;
  }
}

function updatePageStatus(text, type = 'info') {
  document.getElementById('page-status-text').textContent = text;
  document.getElementById('page-status-dot').className = `status-dot ${type}`;
}

// ==================== 店铺列表 ====================

let currentTabShopId = '';

async function loadShopList() {
  const shopListEl = document.getElementById('shop-list');
  const shopCountEl = document.getElementById('shop-count');

  try {
    // 1. 获取已绑定店铺
    const response = await sendMessage({ type: 'GET_SHOPS' });
    const shops = response.shops || [];
    shopCountEl.textContent = shops.length;

    if (shops.length === 0) {
      shopListEl.innerHTML = '<div class="shop-empty">暂无绑定店铺，请先在后台添加</div>';
      return;
    }

    // 2. 获取当前标签页的店铺ID
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('shop.jd.com')) {
        const shopInfo = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_SHOP' });
        if (shopInfo && shopInfo.shopId) {
          currentTabShopId = String(shopInfo.shopId);
        }
      }
    } catch (e) {
      console.log('获取当前页面店铺失败（可能不是订单页）:', e);
    }

    // 3. 排序：当前店铺置顶
    const sortedShops = [...shops].sort((a, b) => {
      const aIsCurrent = currentTabShopId && String(a.shop_id) === currentTabShopId;
      const bIsCurrent = currentTabShopId && String(b.shop_id) === currentTabShopId;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return 0;
    });

    // 4. 渲染列表
    renderShopList(sortedShops);

  } catch (e) {
    console.error('加载店铺列表失败:', e);
    shopListEl.innerHTML = '<div class="shop-empty">加载失败</div>';
  }
}

function renderShopList(shops) {
  const shopListEl = document.getElementById('shop-list');
  shopListEl.innerHTML = '';

  shops.forEach(shop => {
    const isCurrent = currentTabShopId && String(shop.shop_id) === currentTabShopId;
    const item = document.createElement('div');
    item.className = `shop-item ${isCurrent ? 'current' : ''}`;
    item.innerHTML = `
      <div class="shop-item-icon">${isCurrent ? '📍' : '🏪'}</div>
      <div class="shop-item-info">
        <div class="shop-item-name">${shop.shop_name || '未命名店铺'}</div>
        <div class="shop-item-id">ID: ${shop.shop_id}</div>
      </div>
      ${isCurrent ? '<div class="shop-item-badge">当前</div>' : ''}
    `;
    shopListEl.appendChild(item);
  });
}

function openAdminPage() {
  const url = (typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.adminUrl) || 'http://localhost:3000';
  chrome.tabs.create({ url });
  window.close();
}

function openSearchBadPage() {
  const url = (typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.searchBadGuyUrl) || 'http://localhost:3000/#/search';
  chrome.tabs.create({ url });
  window.close();
}

// ==================== 设置 ====================

async function loadSettings() {
  try {
    const response = await sendMessage({ type: 'GET_SETTINGS' });
    const settings = response.settings || {};
    
    document.getElementById('setting-auto-sync').checked = settings.autoSync !== false;
    document.getElementById('setting-notification').checked = settings.showNotification !== false;
    document.getElementById('setting-auto-ship').checked = settings.autoShip === true;
    document.getElementById('setting-auto-ship-interval').value = settings.autoShipInterval || 30;
    document.getElementById('setting-auto-ship-timerange').checked = settings.autoShipTimeRange === true;
    // 自动切换店铺开关
    document.getElementById('setting-auto-switch-shop').checked = settings.autoSwitchShop === true;
    const cfg = (typeof ZHICHACHA_CONFIG !== 'undefined') ? ZHICHACHA_CONFIG : {};
    const timeStart = settings.autoShipTimeStart || cfg.autoShipTimeStart || '07:00';
    const timeEnd = settings.autoShipTimeEnd || cfg.autoShipTimeEnd || '22:00';
    document.getElementById('setting-ship-time-start').value = timeStart;
    document.getElementById('setting-ship-time-end').value = timeEnd;
    document.getElementById('auto-ship-timerange-desc').textContent = `勾选后仅在 '${timeStart} ~ ${timeEnd}' 内自动执行`;
    document.getElementById('auto-ship-interval-row').style.display = settings.autoShip ? 'flex' : 'none';
    document.getElementById('auto-switch-shop-row').style.display = settings.autoShip ? 'flex' : 'none';
    document.getElementById('auto-ship-timerange-row').style.display = settings.autoShip ? 'flex' : 'none';
    document.getElementById('auto-ship-timepick-row').style.display = (settings.autoShip && settings.autoShipTimeRange) ? 'flex' : 'none';
    document.getElementById('setting-auto-sync-express').checked = settings.autoSyncExpress === true;
    document.getElementById('setting-assist-associate').checked = settings.assistAssociate === true;
    document.getElementById('sync-express-interval-row').style.display = settings.autoSyncExpress ? 'flex' : 'none';
  } catch (e) {
    console.error('加载设置失败:', e);
  }
}

async function saveSettings() {
  const interval = parseInt(document.getElementById('setting-auto-ship-interval').value, 10) || 30;
  const expressInterval = parseInt(document.getElementById('setting-sync-express-interval').value, 10) || 120;
  const autoShipOn = document.getElementById('setting-auto-ship').checked;
  const userStart = document.getElementById('setting-ship-time-start').value || '07:00';
  const userEnd = document.getElementById('setting-ship-time-end').value || '22:00';
  const newSettings = {
    autoSync: document.getElementById('setting-auto-sync').checked,
    showNotification: document.getElementById('setting-notification').checked,
    autoShip: autoShipOn,
    autoShipInterval: Math.max(1, Math.min(720, interval)),
    autoSwitchShop: autoShipOn && document.getElementById('setting-auto-switch-shop').checked,
    autoShipTimeRange: document.getElementById('setting-auto-ship-timerange').checked,
    autoShipTimeStart: userStart,
    autoShipTimeEnd: userEnd,
    autoSyncExpress: document.getElementById('setting-auto-sync-express').checked,
    autoSyncExpressInterval: Math.max(1, Math.min(1440, expressInterval)),
    assistAssociate: document.getElementById('setting-assist-associate').checked
  };
  // 先读取现有设置合并（保留 shopId/lastShipTime 等字段），直接写入 storage
  // 直接写入 storage 比发消息给 service-worker 更可靠（避免 SW 休眠导致延迟）
  const result = await chrome.storage.local.get('jd_settings');
  const merged = Object.assign({}, result.jd_settings || {}, newSettings);
  await chrome.storage.local.set({ 'jd_settings': merged });

  // 再通知 service-worker（用于通知京巴士等其他标签页）
  try {
    await sendMessage({ type: 'SAVE_SETTINGS', payload: newSettings });
  } catch (e) {
    // storage 已写入成功，SW 通知失败不影响
  }

  showToast('设置已保存', 'success');
  showMainView();
}

// ==================== 工具函数 ====================

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}
