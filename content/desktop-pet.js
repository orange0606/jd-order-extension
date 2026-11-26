/**
 * 小泷桌宠：右上角二次元数量巡检助手
 * 10分钟周期由content.js统一调度；本模块负责10秒首巡、回前台重巡和点击人物30秒节流
 * 未登录智查查时不渲染人物、不启动循环调度、不执行任何巡检数据请求
 * 今日订单和金额严格按当前店铺统计；广告费用由京准通小窗读取后自动关闭
 */
(function () {
  'use strict';
  if (window.top !== window.self) return;

  let root = null;
  let messages = [];
  let messageIndex = 0;
  let running = false;
  let petEnabled = false;
  let loginActive = false;
  let petTaskEnabled = true;
  let settingsRevision = 0;
  let interacting = false;
  let interactionIndex = 0;
  let interactionRestoreTimer = null;
  let lastInteractionAt = Date.now();
  let outfitIndex = -1;
  let outfitDateKey = '';
  let currentExpression = 'normal';
  let manualOutfitSelection = null;
  let hintsHideTimer = null;
  let pinnedMessageIndex = -1;
  let pinnedCategory = '';
  let pinRemaining = 0;
  let pinExpiresAt = 0;
  let lastManualPetClickAt = 0;
  let lastInspectionStartedAt = 0;
  let initialInspectionTimer = null;
  let initialInspectionHandled = false;
  let tabWasHidden = document.hidden;

  // 性能约定：全模块仅保留一个循环调度器；首巡、互动恢复和菜单隐藏均为可清理的一次性计时
  let petTickTimer = null;
  let lastRotateAt = Date.now();
  let lastOutfitCheckAt = Date.now();
  const INITIAL_INSPECTION_DELAY = 10000;
  const MANUAL_CLICK_COOLDOWN = 30000;
  const VISIBILITY_INSPECTION_COOLDOWN = 120000; // 回前台巡检距离上一轮至少2分钟，避免频繁切换标签产生重复请求
  const PET_POSITION_LAYOUT = 'right-top-v1';
  const PAGE_ENTERED_AT = Date.now();

  // 五套装扮各含日常、巡检、着急、庆祝、鼓励五张图；每天按星期自动换装，手动切换仅在当天生效
  const OUTFITS = [
    { file: 'classic', name: '经典女仆' },
    { file: 'butterfly', name: '粉蝶女仆' },
    { file: 'silver', name: '银辉女仆' },
    { file: 'red', name: '红装女仆' },
    { file: 'fantasy', name: '花冠礼裙' }
  ];
  const PET_EXPRESSIONS = ['normal', 'working', 'urgent', 'celebrate', 'encourage'];
  // Date.getDay() 以周日起始：周日到周六分别使用第2、1、2、3、4、5、1套
  const DAILY_OUTFIT_SEQUENCE = [2, 1, 2, 3, 4, 5, 1];
  const HINT_CATEGORIES = [
    { key: 'purchase', icon: '📦', label: '采购提示' },
    { key: 'ledger', icon: '📒', label: '台账提示' },
    { key: 'canceled', icon: '🚨', label: '取消单提示' },
    { key: 'today', icon: '📈', label: '今日单量提示' },
    { key: 'ad', icon: '💰', label: '广告提示' }
  ];

  function localDateKey(date) {
    const value = date || new Date();
    return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
  }

  function dailyOutfitIndex(date) {
    const value = date || new Date();
    return DAILY_OUTFIT_SEQUENCE[value.getDay()] - 1;
  }

  function resolvedOutfitIndex() {
    const today = localDateKey();
    if (manualOutfitSelection && manualOutfitSelection.dateKey === today) {
      const selected = Number(manualOutfitSelection.index);
      if (Number.isInteger(selected) && selected >= 0 && selected < OUTFITS.length) return selected;
    }
    return dailyOutfitIndex();
  }

  function renderOutfitImage() {
    if (!root || !petEnabled) return;
    if (outfitIndex < 0) outfitIndex = resolvedOutfitIndex();
    const outfit = OUTFITS[outfitIndex];
    const image = root.querySelector('#zcc-pet-image');
    const character = root.querySelector('#zcc-pet-character');
    const switchButton = root.querySelector('#zcc-pet-outfit-switch');
    if (!image || !character) return;
    image.src = chrome.runtime.getURL('icons/pet-xiaolong-' + outfit.file + '-' + currentExpression + '.png');
    image.alt = '小泷桌宠 · ' + outfit.name;
    character.dataset.outfit = outfit.file;
    character.title = '小泷 · ' + outfit.name + ' · 每日自动换装 · 点击立即巡检，按住可拖动';
    if (switchButton) {
      switchButton.title = '切换小泷：当前' + outfit.name + '，点击更换下一套（仅当天有效）';
      switchButton.setAttribute('aria-label', switchButton.title);
    }
  }

  function applyDailyOutfit(force) {
    const today = localDateKey();
    const nextIndex = resolvedOutfitIndex();
    if (!force && nextIndex === outfitIndex && today === outfitDateKey) return;
    outfitIndex = nextIndex;
    outfitDateKey = today;
    renderOutfitImage();
  }

  function switchOutfit() {
    if (!root || !petEnabled) return;
    const current = outfitIndex >= 0 ? outfitIndex : resolvedOutfitIndex();
    manualOutfitSelection = { index: (current + 1) % OUTFITS.length, dateKey: localDateKey() };
    try { chrome.storage.local.set({ zcc_desktop_pet_outfit: manualOutfitSelection }); } catch (e) {}
    applyDailyOutfit(true);
  }

  function storageGet(key) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(key, function (st) { resolve(st || {}); }); }
      catch (e) { resolve({}); }
    });
  }

  // 登录闸门统一复用 Background 的账号校验：未登录、token失效或账号停用时均返回false
  function checkLoginStatus() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'CHECK_LOGIN' }, function (response) {
          if (chrome.runtime.lastError) { resolve(false); return; }
          resolve(!!(response && response.isLoggedIn));
        });
      } catch (e) { resolve(false); }
    });
  }

  // 每次巡检重新识别当前店铺；实时DOM读取失败时不回退到可能属于上一店的缓存，防止跨店误统计
  async function getCurrentShopInfo() {
    if (typeof window.__zccGetCurrentShopInfo === 'function') {
      try {
        const info = await window.__zccGetCurrentShopInfo();
        return {
          shopId: String((info && info.shopId) || '').trim(),
          shopName: String((info && info.shopName) || '').trim()
        };
      } catch (e) {
        return { shopId: '', shopName: '' };
      }
    }
    // 仅兼容尚未暴露实时读取入口的旧版 content.js；新版始终以上方当前页DOM为准
    const st = await storageGet('jd_settings');
    const settings = (st && st.jd_settings) || {};
    return { shopId: String(settings.shopId || '').trim(), shopName: String(settings.shopName || '').trim() };
  }

  // 接口无论是否已支持 shopId 过滤，都在本端再次按店铺明细取值，绝不把全店 totalCount/totalAmount 当作本店数据
  function pickCurrentShopStats(value, shop) {
    const list = value && Array.isArray(value.list) ? value.list : [];
    const current = list.find(function (item) { return String(item.shopId || '') === shop.shopId; });
    if (current) {
      return {
        range: value.range,
        shopId: shop.shopId,
        shopName: current.shopName || shop.shopName,
        totalCount: Number(current.orderCount) || 0,
        totalAmount: Number(current.orderAmount) || 0,
        list: [current]
      };
    }
    // 新版后端按 shopId 过滤后会回传相同标识；当前店铺没有订单时允许列表为空并安全返回0
    if (value && String(value.shopId || '') === shop.shopId) {
      return {
        range: value.range,
        shopId: shop.shopId,
        shopName: shop.shopName,
        totalCount: Number(value.totalCount) || 0,
        totalAmount: Number(value.totalAmount) || 0,
        list: list
      };
    }
    throw new Error('未找到当前店铺（ID:' + shop.shopId + '）的统计明细，已跳过，避免误用全店合计');
  }

  function api(path, query) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage({ type: 'ZCC_LEDGER_API', path: path, method: 'GET', query: query || {} }, function (r) {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (!r || !r.success) { reject(new Error((r && r.msg) || '数据接口请求失败')); return; }
          resolve(r.data || {});
        });
      } catch (e) { reject(e); }
    });
  }

  function queryAdCost(shop) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'ZCC_AD_COST_QUERY', shopId: shop.shopId || '', shopName: shop.shopName || '' }, function (r) {
          if (chrome.runtime.lastError) { resolve({ found: false }); return; }
          resolve((r && r.success && r.data) || { found: false });
        });
      } catch (e) { resolve({ found: false }); }
    });
  }

  function movePetTo(left, top) {
    if (!root) return;
    const width = root.offsetWidth || 300;
    const height = root.offsetHeight || 360;
    const x = Math.max(0, Math.min(left, window.innerWidth - width));
    const y = Math.max(0, Math.min(top, window.innerHeight - height));
    root.style.left = Math.round(x) + 'px';
    root.style.top = Math.round(y) + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  // 按住人物或气泡拖动整个桌宠；位移超过4px时不触发点击巡检，并记住位置
  function makePetDraggable() {
    let startX = 0, startY = 0, originX = 0, originY = 0;
    let dragging = false, moved = false, suppressClick = false;
    function onMove(e) {
      if (!dragging || !root) return;
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 4) moved = true;
      if (moved) movePetTo(originX + e.clientX - startX, originY + e.clientY - startY);
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      if (root) root.classList.remove('is-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved && root) {
        suppressClick = true;
        try { chrome.storage.local.set({ zcc_desktop_pet_position: { left: parseInt(root.style.left, 10) || 0, top: parseInt(root.style.top, 10) || 0, layout: PET_POSITION_LAYOUT } }); } catch (e) {}
        setTimeout(function () { suppressClick = false; }, 0);
      }
    }
    root.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !root || e.target.closest('.zcc-pet-interact, .zcc-pet-hint')) return; // 互动按钮和弧形提示按钮不参与拖动
      const rect = root.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      originX = rect.left; originY = rect.top;
      dragging = true; moved = false;
      root.style.left = rect.left + 'px'; root.style.top = rect.top + 'px'; root.style.bottom = 'auto';
      root.classList.add('is-dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    root.querySelector('#zcc-pet-character').addEventListener('click', function () {
      if (suppressClick) return;
      const now = Date.now();
      const remaining = MANUAL_CLICK_COOLDOWN - (now - lastManualPetClickAt);
      // 仅限制点击人物触发的手动巡检；自动首巡、回前台和统一定时任务不受此30秒节流影响
      if (remaining > 0) { showManualClickCooldown(remaining); return; }
      lastManualPetClickAt = now;
      triggerPetInspection('manual');
    });
    // 旧版左下角坐标不恢复，避免覆盖新的右上角默认布局；本版拖动后的坐标才按版本恢复
    storageGet('zcc_desktop_pet_position').then(function (st) {
      const pos = st && st.zcc_desktop_pet_position;
      if (root && pos && pos.layout === PET_POSITION_LAYOUT && isFinite(pos.left) && isFinite(pos.top)) movePetTo(Number(pos.left), Number(pos.top));
    });
  }

  // 点击节流只给出轻量提示，不新增倒计时定时器，也不打断正在固定查看的巡检消息
  function showManualClickCooldown(remainingMs) {
    if (!root) return;
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const character = root.querySelector('#zcc-pet-character');
    if (character) character.title = '小泷30秒内只能点击巡检一次 · 还需约' + seconds + '秒';
    const meta = root.querySelector('#zcc-pet-meta');
    if (meta && pinnedMessageIndex < 0 && !interacting) meta.textContent = '手动巡检30秒一次 · 约' + seconds + '秒后可再次点击';
  }

  // 所有入口统一走任务面板巡检函数，复用其防重入、状态展示和最后执行时间；模块缺失时才直接调用本地巡检
  function triggerPetInspection(reason) {
    if (!loginActive) { applySettings(false); return Promise.resolve('未登录智查查，已跳过小泷巡检'); }
    if (running) return Promise.resolve('小泷正在巡检，请稍候');
    if (typeof window.__zccRunPetTask === 'function') return Promise.resolve(window.__zccRunPetTask());
    return runInspection(reason);
  }

  // 页面进入10秒后首巡；若同一时刻已有巡检刚启动则跳过重复请求，10分钟周期仍由content.js统一调度
  function scheduleInitialInspection() {
    if (initialInspectionHandled || initialInspectionTimer || !loginActive || !petTaskEnabled) return;
    const delay = Math.max(0, INITIAL_INSPECTION_DELAY - (Date.now() - PAGE_ENTERED_AT));
    initialInspectionTimer = setTimeout(function () {
      initialInspectionTimer = null;
      if (initialInspectionHandled || !loginActive || !petTaskEnabled) return;
      initialInspectionHandled = true;
      if (Date.now() - lastInspectionStartedAt < 3000) return;
      triggerPetInspection('initial');
    }, delay);
  }

  // 空闲互动：不覆盖任务告警，也不影响点击人物立即巡检；手动点击“逗逗小泷”可随时互动
  const IDLE_INTERACTIONS = [
    { title: '主人，给你比心 ♡', text: '今天也辛苦啦！订单和广告投产，小泷都会帮你盯着～', expression: 'celebrate' },
    { title: '小泷整理好围裙啦', text: '我没有偷懒哦，只是在乖乖等下一次巡检～', expression: 'normal' },
    { title: '一起伸个懒腰吧', text: '看屏幕这么久，记得喝口水、活动一下肩膀～', expression: 'encourage' },
    { title: '主人今天也很棒！', text: '不管单量多不多，我们都一步一步来，小泷给你加油～', expression: 'encourage' }
  ];

  function playInteraction(manual) {
    if (!petEnabled || running || !root || pinnedMessageIndex >= 0) return;
    const current = messages[messageIndex];
    // 自动互动只在非告警状态出现；手动互动也不打断重要提醒
    if (current && current.level >= 2) return;
    if (interactionRestoreTimer) clearTimeout(interactionRestoreTimer);
    interacting = true;
    lastInteractionAt = Date.now();
    const item = IDLE_INTERACTIONS[interactionIndex % IDLE_INTERACTIONS.length];
    interactionIndex++;
    const character = root.querySelector('#zcc-pet-character');
    character.classList.add('is-interacting');
    root.querySelector('#zcc-pet-title').textContent = item.title;
    root.querySelector('#zcc-pet-text').textContent = item.text;
    root.querySelector('#zcc-pet-meta').textContent = manual ? '和小泷互动了一下 · 稍后回到任务' : '空闲小动作 · 稍后回到任务';
    setExpression(item.expression);
    interactionRestoreTimer = setTimeout(function () {
      interacting = false;
      if (root) root.querySelector('#zcc-pet-character').classList.remove('is-interacting');
      renderMessage();
    }, 6000);
  }

  function setExpression(name) {
    if (!root || !petEnabled) return;
    const expression = PET_EXPRESSIONS.indexOf(name) >= 0 ? name : 'normal';
    currentExpression = expression;
    const character = root.querySelector('#zcc-pet-character');
    if (!character) return;
    character.dataset.expression = expression;
    applyDailyOutfit(false);
    renderOutfitImage();
  }

  function findMessageIndexByCategory(category) {
    for (let i = 0; i < messages.length; i++) {
      const title = String(messages[i].title || '');
      const content = title + ' ' + String(messages[i].text || '');
      if (category === 'ad' && title.indexOf('广告') >= 0) return i;
      if (category === 'purchase' && title.indexOf('采购') >= 0) return i;
      if (category === 'ledger' && content.indexOf('台账') >= 0) return i;
      if (category === 'canceled' && content.indexOf('取消') >= 0) return i;
      if (category === 'today' && content.indexOf('今日') >= 0 && title.indexOf('广告') < 0) return i;
    }
    return -1;
  }

  function updateHintButtons() {
    if (!root) return;
    root.querySelectorAll('.zcc-pet-hint[data-category]').forEach(function (button) {
      const category = button.getAttribute('data-category');
      const index = findMessageIndexByCategory(category);
      const msg = index >= 0 ? messages[index] : null;
      // 用户主动点击时可查看任意已有提示；新的重要巡检告警到达时仍会取消固定查看
      button.disabled = index < 0;
      button.classList.toggle('is-active', pinnedCategory === category && pinnedMessageIndex >= 0);
      button.classList.toggle('has-message', index >= 0);
      const categoryInfo = HINT_CATEGORIES.filter(function (item) { return item.key === category; })[0];
      button.title = index < 0 ? categoryInfo.label + '暂无数据' : categoryInfo.label + '：' + msg.title + '（点击固定查看60秒）';
    });
  }

  function updatePinnedMeta() {
    if (!root || pinnedMessageIndex < 0) return;
    root.querySelector('#zcc-pet-meta').textContent = '📌 固定查看 · 剩余 ' + pinRemaining + ' 秒';
  }

  function clearPinnedMessage(render) {
    pinnedMessageIndex = -1;
    pinnedCategory = '';
    pinRemaining = 0;
    pinExpiresAt = 0;
    lastRotateAt = Date.now();
    updateHintButtons();
    if (render) renderMessage();
  }

  // 点击弧形提示按钮后固定查看60秒；鼠标移开、自动轮播和空闲互动都不会打断本次固定查看
  function pinMessageByCategory(category) {
    if (!petEnabled || running || !root) return;
    const index = findMessageIndexByCategory(category);
    if (index < 0) return;
    clearPinnedMessage(false);
    if (interactionRestoreTimer) { clearTimeout(interactionRestoreTimer); interactionRestoreTimer = null; }
    interacting = false;
    root.querySelector('#zcc-pet-character').classList.remove('is-interacting');
    pinnedMessageIndex = index;
    pinnedCategory = category;
    messageIndex = index;
    pinRemaining = 60;
    pinExpiresAt = Date.now() + 60000;
    renderMessage();
    updatePinnedMeta();
    updateHintButtons();
    // 固定提示的秒数与60秒恢复都由唯一的petTick调度器处理，不再单独创建interval和timeout
    schedulePetTick(1000);
  }

  // 圆弧按钮由 JS 控制显示：离开人物或按钮后保留3秒，滑入任一按钮立即取消隐藏并持续显示
  function showHintButtons() {
    if (!root) return;
    if (hintsHideTimer) { clearTimeout(hintsHideTimer); hintsHideTimer = null; }
    root.classList.add('is-hints-visible');
  }

  function scheduleHideHintButtons() {
    if (hintsHideTimer) clearTimeout(hintsHideTimer);
    hintsHideTimer = setTimeout(function () {
      hintsHideTimer = null;
      if (!root) return;
      const hoveredButton = root.querySelector('.zcc-pet-hint:hover');
      if (hoveredButton) { showHintButtons(); return; }
      root.classList.remove('is-hints-visible');
    }, 3000);
  }

  function bindHintVisibility() {
    const character = root.querySelector('#zcc-pet-character');
    character.addEventListener('mouseenter', showHintButtons);
    character.addEventListener('mouseleave', scheduleHideHintButtons);
    root.querySelectorAll('.zcc-pet-hint').forEach(function (button) {
      button.addEventListener('mouseenter', showHintButtons);
      button.addEventListener('mouseleave', scheduleHideHintButtons);
      button.addEventListener('focus', showHintButtons);
      button.addEventListener('blur', scheduleHideHintButtons);
    });
  }

  function stopPetTick() {
    if (petTickTimer) { clearTimeout(petTickTimer); petTickTimer = null; }
  }

  function getPetTickDelay() {
    if (pinnedMessageIndex >= 0) return 1000;
    if (messages.length > 1) return Math.max(250, Math.min(5000, 8000 - (Date.now() - lastRotateAt)));
    return 5000;
  }

  // 唯一循环调度器：按下一次事件动态睡眠，统一处理消息轮播、空闲互动、跨日换装与固定提示倒计时
  function schedulePetTick(delay) {
    stopPetTick();
    if (!petEnabled || document.hidden) return;
    petTickTimer = setTimeout(function () {
      petTickTimer = null;
      runPetTick();
    }, typeof delay === 'number' ? delay : getPetTickDelay());
  }

  function runPetTick() {
    if (!petEnabled || document.hidden) return;
    const now = Date.now();
    if (pinnedMessageIndex >= 0) {
      pinRemaining = Math.max(0, Math.ceil((pinExpiresAt - now) / 1000));
      if (pinRemaining <= 0) clearPinnedMessage(true);
      else updatePinnedMeta();
    } else if (!running && messages.length > 1 && now - lastRotateAt >= 8000) {
      messageIndex = (messageIndex + 1) % messages.length;
      lastRotateAt = now;
      renderMessage();
    }
    if (now - lastOutfitCheckAt >= 60000) {
      lastOutfitCheckAt = now;
      applyDailyOutfit(false); // 每分钟核对本地日期，跨天后按星期自动切换对应装扮
    }
    if (!running && !interacting && pinnedMessageIndex < 0 && now - lastInteractionAt >= 45000) playInteraction(false);
    schedulePetTick();
  }

  function ensurePet() {
    if (root && document.getElementById('zcc-desktop-pet')) return root;
    root = document.createElement('div');
    root.id = 'zcc-desktop-pet';
    root.innerHTML =
      '<div class="zcc-pet-bubble" id="zcc-pet-bubble" role="status" aria-live="polite">' +
      '  <div class="zcc-pet-bubble-title" id="zcc-pet-title">小泷来啦～</div>' +
      '  <div class="zcc-pet-bubble-text" id="zcc-pet-text">我去看看采购、台账和今日单量，马上回来！</div>' +
      '  <div class="zcc-pet-bubble-footer"><span class="zcc-pet-bubble-meta" id="zcc-pet-meta">每10分钟巡检 · 点小泷可立即刷新</span>' +
      '  <button type="button" class="zcc-pet-interact" id="zcc-pet-interact" title="空闲时和小泷互动">♡ 逗逗小泷</button></div>' +
      '</div>' +
      '<button type="button" class="zcc-pet-character" id="zcc-pet-character" data-expression="normal" title="小泷桌宠：点击立即巡检，按住可拖动">' +
      '  <img id="zcc-pet-image" src="' + chrome.runtime.getURL('icons/pet-xiaolong-classic-normal.png') + '" alt="二次元妹子小泷桌宠">' +
      '  <span>小泷</span>' +
      '</button>' +
      '<div class="zcc-pet-hints" id="zcc-pet-hints" aria-label="小泷提示快捷按钮">' +
      HINT_CATEGORIES.map(function (item) {
        return '<button type="button" class="zcc-pet-hint" data-category="' + item.key + '" aria-label="' + item.label + '" title="' + item.label + '">' + item.icon + '</button>';
      }).join('') +
      '<button type="button" class="zcc-pet-hint zcc-pet-outfit-switch" id="zcc-pet-outfit-switch" aria-label="切换小泷" title="切换小泷：点击更换下一套装扮">👗</button>' +
      '</div>';
    document.body.appendChild(root);
    root.querySelector('#zcc-pet-interact').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      playInteraction(true);
    });
    root.querySelectorAll('.zcc-pet-hint[data-category]').forEach(function (button) {
      button.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        pinMessageByCategory(button.getAttribute('data-category'));
      });
    });
    root.querySelector('#zcc-pet-outfit-switch').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      switchOutfit();
      showHintButtons();
    });
    bindHintVisibility();
    applyDailyOutfit(true);
    storageGet('zcc_desktop_pet_outfit').then(function (st) {
      const saved = st && st.zcc_desktop_pet_outfit;
      manualOutfitSelection = saved && saved.dateKey === localDateKey() ? saved : null;
      if (root) applyDailyOutfit(true);
    });
    updateHintButtons();
    makePetDraggable();
    return root;
  }

  function renderMessage() {
    if (!petEnabled || interacting) return;
    const pet = ensurePet();
    const msg = messages[messageIndex] || {
      title: '小泷来啦～',
      text: '我会乖乖守着数量任务，到时间就自动巡检！',
      level: 0
    };
    const bubble = pet.querySelector('#zcc-pet-bubble');
    bubble.classList.toggle('is-alert', msg.level >= 3);
    bubble.classList.toggle('is-warn', msg.level === 2);
    bubble.classList.toggle('is-celebrate', !!msg.celebrate);
    pet.querySelector('#zcc-pet-title').textContent = msg.title;
    pet.querySelector('#zcc-pet-text').textContent = msg.text;
    pet.querySelector('#zcc-pet-meta').textContent = msg.meta || '每10分钟巡检 · 点小泷可立即刷新';
    // 表情与话术同步：紧急/超时着急，达标开心，未达标加油，其余温柔待机
    setExpression(msg.expression || (msg.level >= 3 ? 'urgent' : (msg.celebrate ? 'celebrate' : (msg.encourage ? 'encourage' : 'normal'))));
    updatePinnedMeta();
    updateHintButtons();
  }

  function setMessages(list) {
    clearPinnedMessage(false); // 新巡检结果到达时取消固定查看，重要告警可立即显示
    messages = list.slice().sort(function (a, b) { return (b.level || 0) - (a.level || 0); });
    messageIndex = 0;
    lastRotateAt = Date.now();
    renderMessage();
    updateHintButtons();
  }

  function money(n) {
    return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function collectData() {
    const currentShop = await getCurrentShopInfo();
    const tasks = {
      ledger: function () { return api('/ledger/counts').then(function (value) { return { value: value }; }); },
      today: function () {
        // 单量和金额必须限定当前店铺；识别不到店铺时明确失败，不允许静默退成全店总量
        if (!currentShop.shopId) return Promise.reject(new Error('未识别到当前店铺ID，已跳过今日统计，避免混入其他店铺'));
        return api('/dashboard/shop-stats', { range: 'today', shopId: currentShop.shopId })
          .then(function (value) { return { value: pickCurrentShopStats(value, currentShop) }; });
      },
      adCost: function () { return queryAdCost(currentShop).then(function (value) { return { value: value }; }); },
      canceled: function () {
        return storageGet('zcc_task_canceled_assoc_binds').then(function (st) {
          return { value: Number(st.zcc_task_canceled_assoc_binds || 0) };
        });
      }
    };
    // 采购巡检严格限定待出库Tab；其他位置不创建请求、不弹原巡检卡片
    if (location.href.indexOf('tabType=waitOut') !== -1 && typeof window.__zccCollectPetPurchaseStats === 'function') {
      tasks.purchase = function () {
        return window.__zccCollectPetPurchaseStats().then(function (value) { return { value: value }; });
      };
    }
    const keys = Object.keys(tasks);
    const values = await Promise.all(keys.map(function (key) {
      return Promise.resolve().then(tasks[key]).catch(function (e) {
        return { error: String((e && e.message) || e) };
      });
    }));
    const result = {};
    keys.forEach(function (key, i) { result[key] = values[i]; });
    return result;
  }

  async function runInspection(reason) {
    if (running) return '小泷正在巡检，请稍候';
    running = true; // 登录校验期间也占用防重入锁，避免首巡、回前台和点击并发请求
    const loggedIn = await checkLoginStatus();
    loginActive = loggedIn;
    if (!loggedIn) {
      running = false;
      await applySettings(false);
      return '未登录智查查，已跳过小泷巡检';
    }
    lastInspectionStartedAt = Date.now();
    interacting = false;
    clearPinnedMessage(false);
    lastInteractionAt = Date.now();
    if (interactionRestoreTimer) { clearTimeout(interactionRestoreTimer); interactionRestoreTimer = null; }
    if (petEnabled) {
      const pet = ensurePet();
      const character = pet.querySelector('#zcc-pet-character');
      character.classList.remove('is-interacting');
      const bubble = pet.querySelector('#zcc-pet-bubble');
      character.classList.add('is-working');
      setExpression('working');
      bubble.classList.remove('is-alert', 'is-warn', 'is-celebrate');
      pet.querySelector('#zcc-pet-title').textContent = '小泷巡检中…';
      pet.querySelector('#zcc-pet-text').textContent = '正在核对最新数量，稍等我一下下～';
      pet.querySelector('#zcc-pet-meta').textContent = '每10分钟巡检 · 点小泷可立即刷新';
    }
    try {
      const data = await collectData();
      const list = [];
      let canceledCount = 0;
      let pendingCount = 0;
      let todayCount = 0;
      let todayAmount = 0;
      let purchaseSummary = '';
      let adSummary = '';

      if (data.canceled && !data.canceled.error) {
        canceledCount = Number(data.canceled.value || 0);
        if (canceledCount > 0) {
          list.push({
            level: 4,
            title: '🚨 有取消单还没处理！',
            text: '还有 ' + canceledCount + ' 个已取消订单存在采购关联或中转仓待处理，快点处理吧，拖久了可能造成货损！'
          });
        } else {
          list.push({ level: 0, title: '✅ 取消关联单已清零', text: '已取消订单关联数量为 0，目前没有这类紧急事项，表现棒棒哒～' });
        }
      }

      if (data.purchase && !data.purchase.error) {
        const p = data.purchase.value || {};
        if (!p.skipped) {
          const total = Number(p.total || 0), bought = Number(p.bought || 0), unbought = Number(p.unbought || 0);
          const warn = Number(p.warn || 0), overdue = Number(p.overdue || 0);
          purchaseSummary = '采购未' + unbought + '/预警' + warn + '/超时' + overdue;
          list.push({
            level: overdue > 0 ? 3 : (unbought > 0 ? 2 : 0),
            title: overdue > 0 ? '⏰ 有采购超时单，要抓紧啦！' : '📦 采购巡检结果',
            text: '总计 ' + total + '，已采购 ' + bought + '，未采购 ' + unbought + '，发货预警(>24h) ' + warn + '，超时(>48h) ' + overdue + '。' + (unbought > 0 ? '记得尽快采购噢～' : '采购都安排好啦～')
          });
        }
      } else if (data.purchase && data.purchase.error) {
        list.push({ level: 1, title: '采购数据暂未刷新', text: data.purchase.error + '，其他数量我已先帮你更新啦。' });
      }

      if (data.ledger && !data.ledger.error) {
        pendingCount = Number((data.ledger.value && data.ledger.value.pending) || 0);
        list.push({
          level: pendingCount > 0 ? 2 : 0,
          title: pendingCount > 0 ? '📒 台账还有待处理哦' : '📒 台账待处理已清零',
          text: pendingCount > 0 ? '当前有 ' + pendingCount + ' 条台账待处理，记得及时跟进，别让小事情堆成大问题～' : '台账待处理数量为 0，清清爽爽，继续保持～'
        });
      } else if (data.ledger && data.ledger.error) {
        list.push({ level: 1, title: '台账数量暂未刷新', text: data.ledger.error });
      }

      if (data.today && !data.today.error) {
        todayCount = Number((data.today.value && data.today.value.totalCount) || 0);
        todayAmount = Number((data.today.value && data.today.value.totalAmount) || 0);
        const reached = todayAmount >= 1000;
        list.push({
          // 紧急订单/采购超时优先；达标庆祝先于普通台账提醒展示，鼓励话术仍参与轮换
          level: reached ? 2.5 : 1.5,
          celebrate: reached,
          encourage: !reached,
          title: reached ? '🎉 达成千元小目标啦！' : '💪 今日继续加油呀',
          text: reached
            ? '本店今日 ' + todayCount + ' 单，金额 ¥' + money(todayAmount) + '，太棒啦，小目标达成！继续冲呀～'
            : '本店今日 ' + todayCount + ' 单，金额 ¥' + money(todayAmount) + '，还差 ¥' + money(Math.max(0, 1000 - todayAmount)) + ' 到1000小目标，继续努力，就差一点点啦～'
        });
      } else if (data.today && data.today.error) {
        list.push({ level: 1, title: '今日数据暂未刷新', text: data.today.error });
      }

      // 广告投产比 = 当前店铺今日成交额 ÷ 京准通总花费；达到20%费用占比或低于5:1就提醒，查不到广告费用则完全跳过
      if (data.adCost && !data.adCost.error && data.adCost.value && data.adCost.value.found && data.today && !data.today.error) {
        const adCost = Number(data.adCost.value.cost);
        if (isFinite(adCost) && adCost >= 0) {
          const roi = adCost > 0 ? todayAmount / adCost : null;
          const burnWarning = adCost > 0 && (todayAmount <= 0 || adCost >= todayAmount * 0.2 || roi < 5);
          adSummary = '广告 ¥' + money(adCost) + (roi === null ? '' : ' / 投产 ' + roi.toFixed(2) + ':1');
          if (burnWarning) {
            const ratioText = roi === null ? '' : '，投产比约 ' + roi.toFixed(2) + ':1，已到5:1预警线';
            list.push({
              level: 3,
              title: '🔥 广告要烧穿咯！',
              text: '本店今日成交额 ¥' + money(todayAmount) + '，广告已花 ¥' + money(adCost) + ratioText + '。先别急着加预算，看看高消耗低成交的计划、素材和人群，必要时分批缩量观察。小泷按京准通首页当前总花费与当前店铺今日成交额粗算提醒哦～'
            });
          } else if (adCost > 0) {
            list.push({
              level: 1,
              title: '✅ 广告投产目前正常',
              text: '本店今日成交额 ¥' + money(todayAmount) + '，广告花费 ¥' + money(adCost) + '，投产比约 ' + roi.toFixed(2) + ':1，未触及5:1预警线。继续观察消耗和成交变化就好～'
            });
          } else {
            list.push({ level: 0, title: '📊 今日广告尚未产生花费', text: '京准通总花费为 ¥0.00，本店今日成交额 ¥' + money(todayAmount) + '，小泷会继续帮你看着～' });
          }
        }
      }

      if (!list.length) list.push({ level: 0, title: '本轮巡检结束', text: '采购巡检只在待出库Tab执行，其他数量暂时没有读取到哦。' });
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      list.forEach(function (m) { m.meta = '每10分钟巡检 · 更新于 ' + time; });
      setMessages(list);
      return (purchaseSummary ? purchaseSummary + ' · ' : '') + '台账待处理 ' + pendingCount + ' · 取消关联 ' + canceledCount + ' · 今日 ' + todayCount + ' 单 / ¥' + money(todayAmount) + (adSummary ? ' · ' + adSummary : '');
    } finally {
      running = false;
      if (root) {
        root.querySelector('#zcc-pet-character').classList.remove('is-working');
        renderMessage();
      }
    }
  }

  // 设置与登录态共同决定是否显示人物；巡检任务开关独立控制首巡和回前台自动巡检，不影响用户手动点击
  async function applySettings(triggerRun) {
    const revision = ++settingsRevision;
    const result = await Promise.all([storageGet(['jd_settings', 'zcc_desktop_pet_task_enabled']), checkLoginStatus()]);
    if (revision !== settingsRevision) return; // 登录态快速变化时，旧异步结果不得覆盖最新状态
    const st = result[0] || {};
    const settings = st.jd_settings || {};
    loginActive = result[1] === true;
    petTaskEnabled = st.zcc_desktop_pet_task_enabled !== false;
    const nextEnabled = settings.desktopPetEnabled !== false && loginActive;
    const wasEnabled = petEnabled;
    petEnabled = nextEnabled;
    if (petEnabled) {
      ensurePet();
      renderMessage();
      schedulePetTick();
      if (triggerRun && !wasEnabled) triggerPetInspection('settings');
    } else {
      stopPetTick();
      if (root) {
        clearPinnedMessage(false);
        if (hintsHideTimer) { clearTimeout(hintsHideTimer); hintsHideTimer = null; }
        root.remove();
        root = null;
        interacting = false;
        if (interactionRestoreTimer) { clearTimeout(interactionRestoreTimer); interactionRestoreTimer = null; }
        messages = [];
        messageIndex = 0;
      }
    }
    if (loginActive && petTaskEnabled) scheduleInitialInspection();
    else if (initialInspectionTimer) { clearTimeout(initialInspectionTimer); initialInspectionTimer = null; }
  }

  window.__zccRunDesktopPetInspection = runInspection;
  applySettings(false);
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      // 退出登录会立即隐藏人物并停止调度；重新登录后按设置恢复，10秒首巡只执行一次
      if (changes.zhichacha_token || changes.zcc_desktop_pet_task_enabled) applySettings(false);
      else if (changes.jd_settings) applySettings(true);
    });
  }

  // 回前台巡检距上一轮至少2分钟；冷却期内只恢复界面调度，不重复调用登录校验和巡检接口
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      tabWasHidden = true;
      stopPetTick();
      return;
    }
    const shouldInspect = tabWasHidden;
    tabWasHidden = false;
    const cooldownPassed = Date.now() - lastInspectionStartedAt >= VISIBILITY_INSPECTION_COOLDOWN;
    if (!shouldInspect || !petTaskEnabled || !cooldownPassed) {
      if (petEnabled) schedulePetTick(0);
      return;
    }
    // 设置和登录变化已由storage监听维护；到点时直接进入统一巡检，避免回前台重复做一次前置登录校验
    if (!petEnabled) return;
    schedulePetTick(0);
    triggerPetInspection('visibility');
  });
})();
