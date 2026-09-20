/**
 * 京东商家后台订单数据抓取 Content Script
 * 匹配URL: https://shop.jd.com/jdm/trade/orders/order-list
 * 
 * 基于2026新版京东商家后台DOM结构精确适配
 */

(function() {
  'use strict';

  // ==================== 配置 ====================
  const CONFIG = {
    targetUrl: 'shop.jd.com/jdm/trade/orders/order-list',
    // 京巴士物流状态页（从 config.js 读取，去掉协议和query用于URL匹配）
    expressUrl: (() => {
      try {
        const u = new URL((typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.jbsExpressUrl) || 'https://pay.jingbashi.com/back.php/order/status');
        return u.host + u.pathname;
      } catch (e) {
        return 'pay.jingbashi.com/back.php/order/status';
      }
    })(),
    checkInterval: 2000,
    maxRetry: 10
  };

  // ==================== 精确选择器（基于真实DOM） ====================
  const SELECTORS = {
    // 订单列表容器（用户建议从这里开始）
    orderContainer: '.jd-scrollbar__view .table-body',
    // 单个订单卡片
    orderCard: '.card',
    // 订单号
    orderId: '.shop-order-id .order-info-btn span',
    // 下单/付款时间
    orderTime: '.order-time-info .shop-overflow-tooltip__content',
    // 商品列表容器
    skuList: '.sku-info-list__item',
    // 商品名称
    skuName: '.sku-name',
    // 规格/货号/SKU信息项
    skuConfigItem: '.card-left__desc .config-view-item',
    // SKU右侧价格数量
    skuRight: '.sku-info-card__right .config-view-item__value',
    // 应收金额列
    receivablesColumn: '[prop="receivables"]',
    // 收货人信息列
    consigneeColumn: '[prop="consigneeInfo"]',
    // 收货人姓名地址
    consigneeAddress: '.cons-address-text',
    // 收货人电话
    consigneePhone: '.cons-mobile-phone-text',
    // 买家京东账号(PIN)
    buyerPin: '.user-pin',
    // 订单状态列
    statusColumn: '[prop="orderStatus"]',
    // 订单状态文本
    orderStatus: '.order-status span',
    // 承诺发货时间
    shipTime: '.promise-out-ship-date .jd-only-child__content',
    // 订单备注
    remark: '.remark-cell__text',
    // 订单标签
    orderTags: '.order-tags-item .jd-tag__content'
  };

  // ==================== 状态管理 ====================
  let isScraping = false;
  let floatingPanel = null;

  // ==================== 工具函数 ====================
  
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        const el = document.querySelector(selector);
        if (el) {
          resolve(el);
        } else if (Date.now() - startTime > timeout) {
          reject(new Error(`等待元素超时: ${selector}`));
        } else {
          setTimeout(check, 300);
        }
      };
      check();
    });
  }

  function safeText(el, selector) {
    if (!el) return '';
    const node = el.querySelector(selector);
    return node ? node.textContent.trim() : '';
  }

  function parsePrice(text) {
    if (!text) return 0;
    const match = text.replace(/[^\d.]/g, '');
    return parseFloat(match) || 0;
  }

  function parseQuantity(text) {
    if (!text) return 1;
    const match = text.match(/x(\d+)/i);
    return match ? parseInt(match[1]) : 1;
  }

  // ==================== 核心抓取逻辑 ====================

  function isTargetPage() {
    return window.location.href.includes(CONFIG.targetUrl) ||
           window.location.href.includes('/jdm/trade/orders/');
  }

  function isExpressPage() {
    return window.location.href.includes(CONFIG.expressUrl);
  }

  /**
   * 解析单个商品SKU信息
   */
  function parseSkuItem(skuEl) {
    const sku = {
      name: safeText(skuEl, SELECTORS.skuName),
      spec: '',
      skuId: '',
      goodsNo: '',
      price: 0,
      quantity: 1
    };

    // 解析规格、货号、skuId
    const configItems = skuEl.querySelectorAll(SELECTORS.skuConfigItem);
    configItems.forEach(item => {
      const label = item.querySelector('.config-view-item__label');
      const value = item.querySelector('.config-view-item__value');
      if (!label && value) {
        // 没有label的是规格名称
        if (!sku.spec) sku.spec = value.textContent.trim();
      } else if (label && value) {
        const labelText = label.textContent.trim();
        const valueText = value.textContent.trim();
        if (labelText.includes('货号')) sku.goodsNo = valueText;
        if (labelText.includes('skuId') || labelText.includes('SKU')) sku.skuId = valueText;
      }
    });

    // 价格和数量
    const rightValues = skuEl.querySelectorAll(SELECTORS.skuRight);
    if (rightValues.length >= 1) {
      sku.price = parsePrice(rightValues[0].textContent);
    }
    if (rightValues.length >= 2) {
      sku.quantity = parseQuantity(rightValues[1].textContent);
    }

    return sku;
  }

  /**
   * 解析单条订单（基于新版京东卡片结构）
   */
  function parseOrderItem(orderEl) {
    try {
      const order = {
        orderId: '',
        orderTime: '',
        payTime: '',
        buyerPin: '',
        buyerName: '',
        receiverName: '',
        phone: '',
        address: '',
        products: [],
        productNames: '',
        skuIds: '',
        totalQuantity: 0,
        totalAmount: 0,
        freight: 0,
        paymentAmount: 0,
        orderStatus: '',
        promiseShipTime: '',
        remark: '',
        tags: [],
        // 智查查风险数据
        hasRiskData: false,
        riskFullAddress: '',      // 真实完整地址（未脱敏）
        riskFullMobile: '',       // 完整手机号
        riskFullPin: '',          // 完整咚咚号
        riskAdvise: '',           // 发货建议
        riskDistance: '',         // 风险距离
        riskLevel: '',            // 风险等级（低/中/高）
        rawHtml: ''
      };

      // ========== 1. 订单号 ==========
      order.orderId = safeText(orderEl, SELECTORS.orderId);

      // ========== 2. 下单/付款时间 ==========
      const timeText = safeText(orderEl, SELECTORS.orderTime);
      if (timeText) {
        // 格式: "2026-08-06 01:22:42 下单，2026-08-06 01:25:04 付款"
        const orderMatch = timeText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*下单/);
        const payMatch = timeText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*付款/);
        if (orderMatch) order.orderTime = orderMatch[1];
        if (payMatch) order.payTime = payMatch[1];
      }

      // ========== 3. 商品信息 ==========
      const skuElements = orderEl.querySelectorAll(SELECTORS.skuList);
      let totalQty = 0;
      const productNames = [];
      const skuIds = [];
      
      skuElements.forEach(skuEl => {
        const sku = parseSkuItem(skuEl);
        if (sku.name) {
          order.products.push(sku);
          productNames.push(sku.name);
          if (sku.skuId) skuIds.push(sku.skuId);
          totalQty += sku.quantity;
        }
      });

      order.productNames = productNames.join('; ');
      order.skuIds = skuIds.join(',');
      order.totalQuantity = totalQty;

      // ========== 4. 金额信息 ==========
      const receivablesCol = orderEl.querySelector(SELECTORS.receivablesColumn);
      if (receivablesCol) {
        const amountValues = receivablesCol.querySelectorAll('.config-view-item__value');
        if (amountValues.length >= 1) {
          order.totalAmount = parsePrice(amountValues[0].textContent);
          order.paymentAmount = order.totalAmount; // 应收即实付
        }
        // 运费
        const freightLabel = receivablesCol.querySelector('.config-view-item__label');
        if (freightLabel && freightLabel.textContent.includes('运费')) {
          const freightValue = freightLabel.nextElementSibling;
          if (freightValue) {
            order.freight = parsePrice(freightValue.textContent);
          }
        }
      }

      // ========== 5. 收货人信息 ==========
      const consigneeCol = orderEl.querySelector(SELECTORS.consigneeColumn);
      if (consigneeCol) {
        // 姓名和地址
        const addressText = safeText(consigneeCol, SELECTORS.consigneeAddress);
        if (addressText) {
          // 格式: "王**，陕西安康市紫阳县**********"
          const parts = addressText.split('，');
          if (parts.length >= 1) order.receiverName = parts[0];
          if (parts.length >= 2) order.address = parts.slice(1).join('，');
        }

        // 电话
        order.phone = safeText(consigneeCol, SELECTORS.consigneePhone);

        // 买家京东账号
        order.buyerPin = safeText(consigneeCol, SELECTORS.buyerPin);
        order.buyerName = order.buyerPin;
      }

      // ========== 6. 订单状态 ==========
      const statusCol = orderEl.querySelector(SELECTORS.statusColumn);
      if (statusCol) {
        order.orderStatus = safeText(statusCol, SELECTORS.orderStatus);
        order.promiseShipTime = safeText(statusCol, SELECTORS.shipTime);
      }

      // 已取消、待付款订单直接跳过，不抓取
      const skipStatus = ['已取消', '待付款'];
      if (order.orderStatus && skipStatus.some(s => order.orderStatus.includes(s))) {
        // console.log(`[订单跳过] ${order.orderId} 状态为"${order.orderStatus}"，跳过抓取`);
        return null;
      }

      // ========== 7. 备注 ==========
      order.remark = safeText(orderEl, SELECTORS.remark);

      // ========== 8. 订单标签 ==========
      const tagElements = orderEl.querySelectorAll(SELECTORS.orderTags);
      tagElements.forEach(tag => {
        const text = tag.textContent.trim();
        if (text) order.tags.push(text);
      });

      // 调试日志
      // console.log('[订单解析]', order.orderId, {
      //   状态: order.orderStatus,
      //   金额: order.totalAmount,
      //   商品数: order.products.length,
      //   买家: order.buyerPin
      // });
      // console.log('[订单解析] order', order);
      
      return order;
    } catch (e) {
      console.error('[订单解析失败]', e, orderEl);
      return null;
    }
  }

  /**
   * 匹配智查查插件的风险栏数据
   * 查找 .zgcc-result-bar-row[data-id=订单号]，补充真实地址、完整手机号等
   */
  function enrichOrdersWithRiskData(orders) {
    // 先查找页面上所有的风险栏
    const riskBars = document.querySelectorAll('.zgcc-result-bar-row');

    if (riskBars.length === 0) {
      return;
    }

    // 建立订单号 -> 风险栏的映射
    const riskMap = new Map();
    riskBars.forEach(bar => {
      const orderId = bar.getAttribute('data-id');
      if (orderId) {
        riskMap.set(orderId, bar);
      }
    });

    // 遍历订单，补充风险数据
    let matchedCount = 0;
    orders.forEach(order => {
      const bar = riskMap.get(order.orderId);
      if (!bar) return;

      try {
        order.hasRiskData = true;
        matchedCount++;

        // 1. 真实完整地址：a[data-type="a"] 的 data-content
        const addressLink = bar.querySelector('a[data-type="a"]');
        if (addressLink) {
          order.riskFullAddress = addressLink.getAttribute('data-content') || '';
          // 用真实地址替换原来脱敏的地址
          if (order.riskFullAddress) {
            order.address = order.riskFullAddress;
          }
          // 提取风险距离
          const addressText = addressLink.textContent || '';
          const distMatch = addressText.match(/([\d.]+m内有风险|风险)/);
          if (distMatch) {
            order.riskDistance = distMatch[1];
          }
        }

        // 2. 完整咚咚号：a[data-type="pi"] 的 data-content
        const pinLink = bar.querySelector('a[data-type="pi"]');
        if (pinLink) {
          order.riskFullPin = pinLink.getAttribute('data-content') || '';
          if (order.riskFullPin) {
            order.buyerPin = order.riskFullPin;
            order.buyerName = order.riskFullPin;
          }
        }

        // 3. 完整手机号和更多数据：.zgcc-report-link-inbar 的data属性
        const reportLink = bar.querySelector('.zgcc-report-link-inbar');
        if (reportLink) {
          order.riskFullMobile = reportLink.getAttribute('data-mobile') || '';
          if (order.riskFullMobile) {
            order.phone = order.riskFullMobile;
          }
          // 也可以从data-buyer再取一次
          const dataBuyer = reportLink.getAttribute('data-buyer');
          if (dataBuyer && !order.riskFullPin) {
            order.riskFullPin = dataBuyer;
            order.buyerPin = dataBuyer;
          }
        }

        // 4. 发货建议：.advise 的 data-advise 属性
        const adviseEl = bar.querySelector('.advise');
        if (adviseEl) {
          order.riskAdvise = adviseEl.getAttribute('data-advise') || adviseEl.textContent.trim();
          // 判断风险等级
          if (order.riskAdvise.includes('风险低') || order.riskAdvise.includes('可以发货')) {
            order.riskLevel = 'low';
          } else if (order.riskAdvise.includes('风险中') || order.riskAdvise.includes('谨慎')) {
            order.riskLevel = 'medium';
          } else if (order.riskAdvise.includes('风险高') || order.riskAdvise.includes('不要发货')) {
            order.riskLevel = 'high';
          }
        }
      } catch (e) {
        // 静默忽略单条解析失败
      }
    });
  }

  /**
   * 从DOM解析店铺信息（同步方法，精确匹配京东新版商家后台）
   * 参考用户提供的实际HTML结构
   */
  function parseShopInfoFromDom() {
    const shopInfo = {
      shopId: '',
      shopName: '',
      account: ''
    };

    try {
      // 1. 店铺名称：直接在页面上显示的，肯定能拿到
      const nameEl = document.querySelector('.shop-menu-accountV1__right-account-top-name');
      if (nameEl) {
        shopInfo.shopName = nameEl.getAttribute('title') || nameEl.textContent.trim();
      }

      // 2. 登录账号：在下拉里，但是DOM存在
      const pinEl = document.querySelector('.content-pin');
      if (pinEl) {
        shopInfo.account = pinEl.getAttribute('title') || pinEl.textContent.trim();
      }

      // 3. 店铺ID/商家ID：精确匹配class
      // 即使下拉是display:none，元素也在DOM里，可以直接查到
      const textItems = document.querySelectorAll('.shop-menu-shop-cardV1__textItem');
      textItems.forEach(item => {
        const keyEl = item.querySelector('.shop-menu-shop-cardV1__textItem-key');
        const valueEl = item.querySelector('.shop-menu-shop-cardV1__textItem-text');
        if (keyEl && valueEl) {
          const key = keyEl.textContent.trim();
          const value = valueEl.textContent.trim();
          // 优先取店铺ID，没有的话取商家ID（两者一般相同）
          if (key.includes('店铺ID') && value) {
            shopInfo.shopId = value.replace(/\D/g, '');
          }
          if (!shopInfo.shopId && key.includes('商家ID') && value) {
            shopInfo.shopId = value.replace(/\D/g, '');
          }
        }
      });

      // 4. 兜底：从title属性取（更可靠）
      if (!shopInfo.shopId) {
        const valueWithTitle = document.querySelector('.shop-menu-shop-cardV1__textItem-text[title]');
        if (valueWithTitle) {
          const titleVal = valueWithTitle.getAttribute('title');
          if (titleVal && /^\d+$/.test(titleVal)) {
            shopInfo.shopId = titleVal;
          }
        }
      }

    } catch (e) {
      console.error('[店铺信息] DOM解析异常:', e);
    }

    return shopInfo;
  }

  // 内存缓存最近一次店铺信息，避免频繁写 storage
  let _lastSavedShopId = '';

  /**
   * 自动获取店铺信息
   * 注：店铺ID的DOM虽然display:none，但存在于页面中，可以直接读取
   * 最多等3秒，防止页面刚加载完组件还没渲染
   */
  async function getShopInfo(maxWait = 3000) {
    let shopInfo = { shopId: '', shopName: '', account: '' };
    const startTime = Date.now();
    let tryCount = 0;

    while (Date.now() - startTime < maxWait) {
      tryCount++;
      shopInfo = parseShopInfoFromDom();

      if (shopInfo.shopId && shopInfo.shopName) {
        // console.log(`[店铺信息] 第${tryCount}次获取成功:`, shopInfo);
        // 仅在店铺ID变化时写入 storage，避免频繁写入覆盖设置
        if (shopInfo.shopId !== _lastSavedShopId) {
          _lastSavedShopId = shopInfo.shopId;
          chrome.storage.local.get('jd_settings', (result) => {
            const settings = result.jd_settings || {};
            settings.shopId = shopInfo.shopId;
            settings.shopName = shopInfo.shopName;
            settings.jdAccount = shopInfo.account;
            chrome.storage.local.set({ 'jd_settings': settings });
          });
        }
        return shopInfo;
      }

      // 第一次没拿到就触发一下鼠标悬停，让Vue渲染下拉
      if (tryCount === 1) {
        const accountArea = document.querySelector('.shop-menu-accountV1__right-account');
        if (accountArea) {
          accountArea.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
          accountArea.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        }
      }

      await new Promise(r => setTimeout(r, 300));
    }

    // console.log(`[店铺信息] 最终获取结果:`, shopInfo);
    return shopInfo;
  }

  /**
   * 转换为后端批量导入接口格式
   * 接口字段：shop_id, shop_name, order_no, goods_name, goods_count, pay_amount,
   *         buyer_account, buyer_name, buyer_phone, buyer_address, order_time
   */
  async function convertToApiFormat(orders) {
    // 优先自动从页面获取店铺信息，失败再用设置里的
    const autoShop = await getShopInfo();
    const settings = await chrome.storage.local.get('jd_settings');
    const shopId = autoShop.shopId || settings.jd_settings?.shopId || '';
    const shopName = autoShop.shopName || settings.jd_settings?.shopName || '京东店铺';

    const list = orders.map(order => {
      // 优先使用风险栏的完整数据，没有则用京东脱敏数据
      const buyerPhone = order.riskFullMobile || order.phone || '';
      const buyerAddress = order.riskFullAddress || order.address || '';
      const buyerAccount = order.riskFullPin || order.buyerPin || '';

      return {
        shop_id: shopId,
        shop_name: shopName,
        order_no: order.orderId,
        goods_name: order.productNames || '',
        goods_count: Number(order.totalQuantity) || 1,
        pay_amount: Number(order.paymentAmount || order.totalAmount) || 0,
        buyer_account: buyerAccount,
        buyer_name: order.receiverName || '',
        buyer_phone: buyerPhone,
        buyer_address: buyerAddress,
        order_time: order.orderTime || ''
      };
    });

    // console.log(`[格式转换] 已转换为接口格式，共 ${list.length} 条`);
    // console.table(list.map(item => ({
    //   order_no: item.order_no,
    //   金额: item.pay_amount,
    //   手机: item.buyer_phone,
    //   地址: item.buyer_address?.substring(0, 25)
    // })));

    return list;
  }

  /**
   * 抓取当前页所有订单
   */
  async function scrapeCurrentPage() {
    if (isScraping) {
      updateStatus('正在抓取，请稍候...', 'warning');
      return [];
    }

    // 先检查当前店铺是否已绑定
    const shopCheck = await checkCurrentShopBound();
    if (!shopCheck.bound) {
      const msg = shopCheck.shopId
        ? `❌ 当前店铺（ID:${shopCheck.shopId}）未绑定账号，无法同步`
        : '❌ 未获取到当前店铺信息，请确认已登录京东商家后台';
      updateStatus(msg, 'error');
      updateShopStatus();
      return [];
    }

    isScraping = true;
    // 同步前先清除页面上旧的风险标记
    clearRiskMarks();
    updateStatus('开始抓取订单数据...', 'info');

    try {
      // 1. 等待订单容器加载
      let container = null;
      try {
        container = await waitForElement(SELECTORS.orderContainer, 5000);
      } catch (e) {
        updateStatus('未找到jd-scrollbar容器，尝试查找.card...', 'warning');
      }

      // 2. 查找所有订单卡片
      let orderCards = [];
      if (container) {
        orderCards = container.querySelectorAll(SELECTORS.orderCard);
      }
      
      // 兜底：直接在页面找.card
      if (orderCards.length === 0) {
        orderCards = document.querySelectorAll(SELECTORS.orderCard);
      }

      if (orderCards.length === 0) {
        updateStatus('❌ 未找到订单卡片，请确认在订单列表页', 'error');
        return [];
      }

      updateStatus(`找到 ${orderCards.length} 个订单卡片，正在解析...`, 'info');

      // 3. 逐个解析
      const orders = [];
      orderCards.forEach((card, index) => {
        // 高亮正在解析的行
        card.classList.add('jd-order-highlight');
        
        const order = parseOrderItem(card);
        if (order && order.orderId) {
          // 给卡片打上我们自己的订单号标记
          card.setAttribute('data-orange-jbs-order-id', order.orderId);
          order.pageIndex = index;
          order.crawlTime = new Date().toISOString();
          order.source = 'jd_shop';
          order.pageUrl = window.location.href;
          orders.push(order);
        }

        // 延迟移除高亮
        setTimeout(() => card.classList.remove('jd-order-highlight'), 500);
      });

      if (orders.length === 0) {
        updateStatus('❌ 解析失败，未提取到有效订单号', 'error');
        return [];
      }

      // 4. 匹配智查查风险栏数据（真实地址、完整手机号、风险等级）
      updateStatus('正在匹配智查查风险数据...', 'info');
      enrichOrdersWithRiskData(orders);

      // 5. 转换为后端接口格式
      updateStatus('正在转换数据格式...', 'info');
      const importList = await convertToApiFormat(orders);

      updateStatus(`✅ 成功解析 ${orders.length} 条订单`, 'success');

      // 保存最近抓取的订单
      window.__lastScrapedOrders = orders;

      // 直接发起风险检测（不等待同步结果，独立接口）
      setTimeout(() => {
        batchRiskCheck(orders);
      }, 500);

      // 6. 打印转换后的接口数据，方便调试
      // console.log('%c========== 转换完成，准备提交到后端的数据 ==========', 'color: #e1251b; font-weight: bold; font-size: 14px;');
      // console.log('请求体 { list: [...] }:');
      // console.table(importList);
      // console.log('importList:', importList);
      // console.log('%c==================================================', 'color: #e1251b; font-weight: bold;');

      // 7. 通知后台同步（发送接口格式的数据）
      // console.log('[Content] 正在发送ORDERS_SCraped消息到后台...');
      chrome.runtime.sendMessage({
        type: 'ORDERS_SCraped',
        payload: {
          orders,          // 原始完整数据
          importList,      // 后端接口格式 { list: [...] }
          url: window.location.href,
          timestamp: Date.now()
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Content] 发送消息失败:', chrome.runtime.lastError.message);
          updateStatus('❌ 与后台通信失败，请刷新扩展', 'error');
        }
        // else {
        //   console.log('[Content] 后台已收到消息，响应:', response);
        // }
      });

      return { orders, importList };
    } catch (e) {
      console.error('[抓取失败]', e);
      updateStatus(`❌ 抓取失败: ${e.message}`, 'error');
      return [];
    } finally {
      isScraping = false;
    }
  }

  // ==================== 悬浮面板UI ====================

  function createFloatingPanel() {
    if (floatingPanel) return;

    floatingPanel = document.createElement('div');
    floatingPanel.id = 'jd-order-scraper-panel';
    floatingPanel.innerHTML = `
      <div class="scraper-header">
        <span class="scraper-title" id="panel-title">📦 智查查同步助手</span>
        <span class="risk-badge" id="risk-badge" style="display:none;">
          ⚠️ <span id="risk-count">0</span>
        </span>
        <div class="header-actions">
          <button class="header-icon-btn jd-only" id="btn-header-sync" title="同步当前页">🔄</button>
          <button class="header-icon-btn jd-only" id="btn-header-ship" title="立即查单发货">🚚</button>
          <button class="header-icon-btn jd-only" id="btn-header-goto-express" title="同步物流（发取件码）">📮</button>
          <button class="header-icon-btn jd-only" id="btn-header-clear" title="清除风险提示">🧹</button>
          <button class="header-icon-btn express-only" id="btn-header-express" title="立即同步物流" style="display:none;">📮</button>
          <button class="scraper-minimize" title="最小化/展开">−</button>
        </div>
      </div>
      <div class="scraper-body">
        <div class="login-warning jd-only" id="login-warning" style="display:none;">
          ⚠️ 未登录智查查，无法同步到服务器<br>
          <span style="font-size:11px;">请点击插件图标登录</span>
        </div>
        <div class="login-warning jd-only" id="shop-warning" style="display:none; background:#fff7e6; border-color:#ffd591; color:#fa8c16;">
          ⚠️ 当前店铺未绑定账号，无法同步<br>
          <span style="font-size:11px;" id="shop-warning-text">请先在后台添加该店铺</span>
        </div>
        <div class="scraper-status jd-only" id="scraper-status">
          <span class="status-dot status-info"></span>
          <span class="status-text">初始化中...</span>
        </div>
        <div class="scraper-status jd-only" id="ship-status" style="display:none;">
          <span class="status-dot status-info" id="ship-status-dot"></span>
          <span class="status-text" id="ship-status-text"></span>
        </div>
        <div class="shop-switch-plan jd-only" id="shop-switch-plan" style="display:none;">
          <div class="shop-switch-plan-title">
            <span>🔁 店铺自动切换计划</span>
            <button type="button" class="shop-switch-run-btn" id="btn-switch-run-now" title="立即按计划切换到下一个店铺并发货">立即执行</button>
          </div>
          <div class="shop-switch-plan-list" id="shop-switch-plan-list"></div>
        </div>
        <div class="scraper-status express-only" id="express-status" style="display:none;">
          <span class="status-dot status-info" id="express-status-dot"></span>
          <span class="status-text" id="express-status-text"></span>
        </div>
        <div class="scraper-actions jd-only">
          <button class="scraper-btn scraper-btn-primary" id="btn-scrape">
            🔄 同步当前页订单
          </button>
          <button class="scraper-btn scraper-btn-secondary" id="btn-clear-risk">
            🧹 清除风险提示
          </button>
        </div>
        <div class="scraper-actions express-only" id="express-actions" style="display:none;">
          <button class="scraper-btn scraper-btn-primary" id="btn-sync-express">
            📮 立即同步物流状态
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(floatingPanel);

    // 同步按钮（标题栏和内容区共用）
    const handleSyncClick = () => handleManualSync();
    document.getElementById('btn-scrape').addEventListener('click', handleSyncClick);
    document.getElementById('btn-header-sync').addEventListener('click', handleSyncClick);

    // 立即查单发货按钮（标题栏）
    document.getElementById('btn-header-ship').addEventListener('click', () => {
      runBatchShipOnce(true);
    });

    // 立即执行一次"切换店铺批量查单发货"轮转（手动，不受时段限制）
    const btnSwitchRunNow = document.getElementById('btn-switch-run-now');
    if (btnSwitchRunNow) {
      btnSwitchRunNow.addEventListener('click', () => {
        manualRunSwitchOnce();
      });
    }

    // 跳转京巴士同步物流页
    document.getElementById('btn-header-goto-express').addEventListener('click', () => {
      const url = (typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.jbsExpressUrl) || 'https://pay.jingbashi.com/back.php/order/status?ref=addtabs';
      window.open(url, '_blank');
    });

    // 立即同步物流按钮（标题栏和内容区）
    const handleExpressClick = () => runSyncExpressOnce(true);
    document.getElementById('btn-header-express').addEventListener('click', handleExpressClick);
    document.getElementById('btn-sync-express').addEventListener('click', handleExpressClick);

    // 清除按钮（标题栏和内容区共用）
    const handleClearClick = () => {
      clearRiskMarks();
      updateStatus('已清除页面风险提示', 'info');
    };
    document.getElementById('btn-clear-risk').addEventListener('click', handleClearClick);
    document.getElementById('btn-header-clear').addEventListener('click', handleClearClick);

    // 最小化/展开
    document.querySelector('.scraper-minimize').addEventListener('click', () => {
      floatingPanel.classList.toggle('minimized');
    });

    // 拖拽功能
    const header = floatingPanel.querySelector('.scraper-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.style.cursor = 'move';

    header.addEventListener('mousedown', (e) => {
      // 点到按钮不拖拽
      if (e.target.closest('button')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = floatingPanel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      floatingPanel.style.right = 'auto';
      floatingPanel.style.left = startLeft + 'px';
      floatingPanel.style.top = startTop + 'px';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = startLeft + dx;
      let newTop = startTop + dy;
      // 不超出视窗
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - floatingPanel.offsetWidth));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));
      floatingPanel.style.left = newLeft + 'px';
      floatingPanel.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  /**
   * 手动同步按钮
   */
  async function handleManualSync() {
    const isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) {
      updateStatus('❌ 请先登录智查查', 'error');
      showLoginWarning(true);
      return;
    }
    await scrapeCurrentPage();
  }

  /**
   * 检查登录状态（和background通信）
   */
  function checkLoginStatus() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'CHECK_LOGIN' }, response => {
          resolve(response?.isLoggedIn || false);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  /**
   * 获取当前账号已绑定的店铺列表
   */
  function getBoundShops() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_SHOPS' }, response => {
          resolve(response?.shops || []);
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  /**
   * 检查当前页面店铺是否已绑定
   * @returns {Promise<{bound: boolean, shopId: string, shopName: string, boundShops: Array}>}
   */
  async function checkCurrentShopBound() {
    const currentShop = await getShopInfo();
    const boundShops = await getBoundShops();

    if (!currentShop.shopId) {
      return { bound: false, shopId: '', shopName: currentShop.shopName, boundShops, reason: '未获取到当前店铺ID' };
    }

    const isBound = boundShops.some(s => String(s.shop_id) === String(currentShop.shopId));
    return {
      bound: isBound,
      shopId: currentShop.shopId,
      shopName: currentShop.shopName,
      boundShops
    };
  }

  /**
   * 更新面板上的店铺绑定状态
   */
  async function updateShopStatus() {
    const shopWarning = document.getElementById('shop-warning');
    const shopWarningText = document.getElementById('shop-warning-text');
    if (!shopWarning) return;

    // 先从后端刷新最新的已绑定店铺列表
    await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'REFRESH_SHOPS' }, () => resolve());
      } catch (e) {
        resolve();
      }
    });

    const result = await checkCurrentShopBound();
    if (result.bound) {
      shopWarning.style.display = 'none';
      return true;
    } else {
      if (result.shopId) {
        shopWarningText.textContent = `当前店铺ID: ${result.shopId}，请先在后台添加`;
      } else {
        shopWarningText.textContent = '未获取到店铺信息，请确认已登录京东商家后台';
      }
      shopWarning.style.display = 'block';
      return false;
    }
  }

  /**
   * 显示/隐藏未登录警告
   */
  function showLoginWarning(show) {
    const warning = document.getElementById('login-warning');
    if (warning) {
      warning.style.display = show ? 'block' : 'none';
    }
  }

  /**
   * 更新风险订单数量（预留）
   */
  function updateRiskCount(count) {
    const badge = document.getElementById('risk-badge');
    const countEl = document.getElementById('risk-count');
    if (badge && countEl) {
      if (count > 0) {
        badge.style.display = 'inline-block';
        countEl.textContent = count;
      } else {
        badge.style.display = 'none';
      }
    }
  }

  function updateStatus(text, type = 'info') {
    if (!floatingPanel) return;
    const statusEl = document.getElementById('scraper-status');
    if (!statusEl) return;

    statusEl.innerHTML = `
      <span class="status-dot status-${type}"></span>
      <span class="status-text">${text}</span>
    `;
  }

  // 定时查单发货独立状态
  function updateShipStatus(text, type = 'info') {
    if (!floatingPanel) return;
    const wrap = document.getElementById('ship-status');
    const dot = document.getElementById('ship-status-dot');
    const txt = document.getElementById('ship-status-text');
    if (!wrap || !dot || !txt) return;

    wrap.style.display = 'flex';
    dot.className = `status-dot status-${type}`;
    txt.textContent = text;
  }

  // 同步物流独立状态
  function updateExpressStatus(text, type = 'info') {
    if (!floatingPanel) return;
    const wrap = document.getElementById('express-status');
    const dot = document.getElementById('express-status-dot');
    const txt = document.getElementById('express-status-text');
    if (!wrap || !dot || !txt) return;

    wrap.style.display = 'flex';
    dot.className = `status-dot status-${type}`;
    txt.textContent = text;
  }

  // ==================== 批量风险检测 ====================

  async function batchRiskCheck(orders) {
    try {
      // 获取当前店铺ID
      let shopId = '';
      try {
        const shopInfo = await getShopInfo();
        shopId = shopInfo.shopId || '';
      } catch(e) {
        // 获取店铺ID失败，使用空值
      }

      // 构造请求体
      const checkList = orders.map(o => ({
        orderNo: o.orderId || o.orderNo || '',
        shopId: shopId,
        buyerAccount: o.riskFullPin || o.buyerPin || o.buyerAccount || '',
        buyerAddress: o.riskFullAddress || o.address || o.buyerAddress || ''
      })).filter(i => i.buyerAccount || i.buyerAddress);

      if (checkList.length === 0) {
        return;
      }

      updateStatus('🔍 正在进行全库风险检测...', 'info');

      // 发消息给background发请求（避免CORS问题）
      const response = await chrome.runtime.sendMessage({
        type: 'RISK_BATCH_CHECK',
        payload: checkList
      });

      if (!response || !response.success) {
        return;
      }

      const results = response.data || [];
      window.__riskResults = results;

      // 统计风险数量
      const high = results.filter(r => r.riskLevel === 'high').length;
      const medium = results.filter(r => r.riskLevel === 'medium').length;
      const low = results.filter(r => r.riskLevel === 'low').length;

      // 更新标题栏风险徽章
      const badgeEl = document.getElementById('risk-badge');
      const countEl = document.getElementById('risk-count');
      if (badgeEl && countEl) {
        if (high > 0) {
          countEl.textContent = high;
          badgeEl.style.display = 'inline-flex';
        } else {
          badgeEl.style.display = 'none';
        }
      }

      if (high > 0) {
        updateStatus(`🚨 检测到 ${high} 个高风险订单！中风险${medium}个，低风险${low}个`, 'error');
      } else if (medium > 0) {
        updateStatus(`⚠️ 检测到 ${medium} 个中风险订单，低风险${low}个`, 'warning');
      } else if (low > 0) {
        updateStatus(`✅ 同步完成，检测到 ${low} 个低风险订单`, 'success');
      } else {
        updateStatus(`✅ 同步完成，本页订单暂无风险`, 'success');
      }

      // 在页面订单上标记风险
      renderRiskToPage(results);

      // 5秒后自动折叠面板
      setTimeout(() => {
        if (floatingPanel) {
          floatingPanel.classList.add('minimized');
        }
      }, 5000);

    } catch (e) {
      console.error('[风险检测] 失败:', e);
    }
  }

  // ==================== 页面风险标记渲染 ====================

  // 清除页面上所有风险标记
  function clearRiskMarks() {
    // 移除所有插入的提示元素
    document.querySelectorAll('.orange-zcc-risk-bar, .orange-zcc-risk-tag').forEach(el => el.remove());
    // 移除卡片上的风险class
    document.querySelectorAll('.orange-zcc-risk-high, .orange-zcc-risk-medium, .orange-zcc-risk-low, .orange-zcc-risk-none').forEach(el => {
      el.classList.remove('orange-zcc-risk-high', 'orange-zcc-risk-medium', 'orange-zcc-risk-low', 'orange-zcc-risk-none');
    });
    // 隐藏标题栏徽章
    const badge = document.getElementById('risk-badge');
    if (badge) badge.style.display = 'none';
  }

  // 按订单号将风险结果渲染到页面卡片上
  function renderRiskToPage(results) {
    // 先清除旧标记
    clearRiskMarks();

    if (!results || results.length === 0) return;

    results.forEach(risk => {
      if (!risk.orderNo) return;

      // 按我们自己打的data-orange-jbs-order-id属性查找订单卡片
      const card = document.querySelector(`[data-orange-jbs-order-id="${risk.orderNo}"]`);
      if (!card) return;

      const level = risk.riskLevel || 'none';
      card.classList.add(`orange-zcc-risk-${level}`);

      // 创建风险提示条
      const bar = document.createElement('div');
      bar.className = `orange-zcc-risk-bar orange-zcc-risk-${level}`;

      let icon, levelText;
      switch(level) {
        case 'high':
          icon = '🚨'; levelText = '高风险'; break;
        case 'medium':
          icon = '⚠️'; levelText = '中风险'; break;
        case 'low':
          icon = 'ℹ️'; levelText = '低风险'; break;
        default:
          icon = '✅'; levelText = '安全';
      }

      // 账号、地址、相似度（点击跳转举报管理）
      const reportUrl = (keyword) =>
        `${ZHICHACHA_CONFIG.adminUrl}#/reportManage?keyword=${encodeURIComponent(keyword)}&tab=all`;
      const accountHtml = risk.buyerAccount
        ? `<a class="orange-zcc-risk-info-item orange-zcc-risk-link" href="${reportUrl(risk.buyerAccount)}" target="_blank" title="点击查看该账号举报记录">👤 ${risk.buyerAccount}</a>` : '';
      const addressHtml = risk.buyerAddress
        ? `<a class="orange-zcc-risk-info-item orange-zcc-risk-link" href="${reportUrl(risk.buyerAddress)}" target="_blank" title="点击查看该地址举报记录">📍 ${risk.buyerAddress}</a>` : '';

      const similarityHtml = risk.addressSimilarity > 0
        ? `<span class="orange-zcc-risk-info-item">相似度${risk.addressSimilarity}%</span>` : '';

      // 标签
      const tagsHtml = risk.tags && risk.tags.length > 0
        ? `<span class="orange-zcc-risk-tags">${risk.tags.map(t => `<span class="orange-zcc-risk-tag">${t}</span>`).join('')}</span>`
        : '';

      // 举报TA按钮
      const reportBtnHtml = risk.orderNo
        ? `<button class="orange-zcc-report-btn" data-order-no="${risk.orderNo}" title="举报这个买家">📨</button>`
        : '';

      // 跨店铺下单记录（时间+金额，最多前5个）
      const crossShopOrdersHtml = (risk.crossShopOrders && risk.crossShopOrders.length > 0)
        ? `<div class="orange-zcc-cross-orders" title="该买家在其他店铺的下单记录">
             <span class="orange-zcc-cross-orders-title">🔄 跨店下单:</span>
             <div class="orange-zcc-cross-orders-list">
               ${risk.crossShopOrders.slice(0, 5).map(o =>
                 `<span class="orange-zcc-cross-order">
                   <span class="orange-zcc-cross-time">${o.time}</span>
                   <span class="orange-zcc-cross-amount">￥${Number(o.amount).toFixed(1)}</span>
                 </span>`
               ).join('')}
             </div>
           </div>` : '';

      bar.innerHTML = `
        <span class="orange-zcc-risk-icon">${icon}</span>
        <span class="orange-zcc-risk-level">${levelText}</span>
        ${accountHtml}
        ${addressHtml}
        ${similarityHtml}
        ${tagsHtml}
        ${reportBtnHtml}
        ${crossShopOrdersHtml}
      `;

      // 绑定举报按钮点击事件
      const reportBtn = bar.querySelector('.orange-zcc-report-btn');
      if (reportBtn) {
        reportBtn.addEventListener('click', () => {
          openReportModal(risk.orderNo);
        });
      }

      // 插入到卡片最后面
      card.appendChild(bar);
    });
  }

  // ==================== 举报TA弹窗 ====================

  function openReportModal(orderNo) {
    // 先移除已存在的弹窗
    const existing = document.getElementById('zcc-report-modal-overlay');
    if (existing) existing.remove();

    // 创建遮罩
    const overlay = document.createElement('div');
    overlay.id = 'zcc-report-modal-overlay';
    overlay.className = 'zcc-modal-overlay';

    overlay.innerHTML = `
      <div class="zcc-modal-content">
        <div class="zcc-modal-header">
          <h3>🚩 举报买家</h3>
          <button class="zcc-modal-close">&times;</button>
        </div>
        <div class="zcc-modal-body">
          <div class="zcc-modal-loading">正在加载订单信息...</div>
          <form id="zcc-report-form" style="display:none">
            <div class="zcc-form-section">
              <h4>订单信息（自动填充）</h4>
              <div class="zcc-form-grid">
                <label>订单号</label>
                <input type="text" id="report-order-no">
                <label>买家账号</label>
                <input type="text" id="report-buyer-account">
                <label>收货人</label>
                <input type="text" id="report-receiver-name">
                <label>联系电话</label>
                <input type="text" id="report-receiver-phone">
                <label>收货地址</label>
                <input type="text" id="report-receiver-address">
                <label>商品</label>
                <input type="text" id="report-goods-name">
                <label>金额</label>
                <input type="text" id="report-pay-amount">
              </div>
            </div>
            <div class="zcc-form-section">
              <h4>举报信息</h4>
              <div class="zcc-form-grid">
                <label>纠纷类型 <span class="zcc-required">*</span></label>
                <select id="report-dispute-type" required>
                  <option value="">请选择</option>
                  <option value="1">异常索赔</option>
                  <option value="2">仅退款</option>
                  <option value="3">异常退货</option>
                  <option value="4">异常评价</option>
                  <option value="5">骗取财物</option>
                  <option value="6">其它</option>
                </select>
                <label>发生时间</label>
                <input type="datetime-local" id="report-happen-time">
              </div>
              <div class="zcc-form-field">
                <label>举报缘由 <span class="zcc-required">*</span></label>
                <textarea id="report-reason" rows="4" placeholder="请详细描述举报缘由..." required></textarea>
              </div>
            </div>
            <div class="zcc-form-actions">
              <button type="button" class="zcc-btn zcc-btn-cancel">取消</button>
              <button type="submit" class="zcc-btn zcc-btn-primary">提交举报</button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // 关闭弹窗
    const closeModal = () => overlay.remove();
    overlay.querySelector('.zcc-modal-close').addEventListener('click', closeModal);
    overlay.querySelector('.zcc-btn-cancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    // 加载订单信息
    loadOrderInfo(orderNo);

    // 提交表单
    overlay.querySelector('#zcc-report-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitReport(overlay, orderNo);
    });
  }

  async function loadOrderInfo(orderNo) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REPORT_ORDER_INFO',
        payload: { orderNo }
      });

      if (!response || !response.success) {
        throw new Error(response?.msg || '加载失败');
      }

      const order = response.data;
      const overlay = document.getElementById('zcc-report-modal-overlay');
      if (!overlay) return;

      overlay.querySelector('#report-order-no').value = order.order_no || '';
      overlay.querySelector('#report-buyer-account').value = order.buyer_account || '';
      overlay.querySelector('#report-receiver-name').value = order.buyer_name || '';
      overlay.querySelector('#report-receiver-phone').value = order.buyer_phone || '';
      overlay.querySelector('#report-receiver-address').value = order.buyer_address || '';
      overlay.querySelector('#report-goods-name').value = order.goods_name || '';
      overlay.querySelector('#report-pay-amount').value = order.pay_amount ? '￥' + Number(order.pay_amount).toFixed(2) : '';

      // 默认发生时间为当前时间
      const now = new Date();
      const localNow = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + 'T' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0');
      overlay.querySelector('#report-happen-time').value = localNow;

      // 隐藏加载，显示表单
      overlay.querySelector('.zcc-modal-loading').style.display = 'none';
      overlay.querySelector('#zcc-report-form').style.display = 'block';

    } catch (err) {
      const overlay = document.getElementById('zcc-report-modal-overlay');
      if (overlay) {
        overlay.querySelector('.zcc-modal-loading').innerHTML =
          `<div class="zcc-error">加载订单信息失败: ${err.message}</div>
           <button class="zcc-btn zcc-btn-cancel" onclick="document.getElementById('zcc-report-modal-overlay').remove()">关闭</button>`;
      }
      console.error('[举报弹窗] 加载订单信息失败:', err);
    }
  }

  async function submitReport(overlay, orderNo) {
    try {
      const disputeType = overlay.querySelector('#report-dispute-type').value;
      const happenTime = overlay.querySelector('#report-happen-time').value;
      const reason = overlay.querySelector('#report-reason').value.trim();
      const buyerAccount = overlay.querySelector('#report-buyer-account').value;
      const receiverName = overlay.querySelector('#report-receiver-name').value;
      const receiverPhone = overlay.querySelector('#report-receiver-phone').value;
      const receiverAddress = overlay.querySelector('#report-receiver-address').value;

      if (!disputeType) {
        alert('请选择纠纷类型');
        return;
      }
      if (!reason) {
        alert('请填写举报缘由');
        return;
      }

      const submitBtn = overlay.querySelector('.zcc-btn-primary');
      submitBtn.disabled = true;
      submitBtn.textContent = '提交中...';

      const response = await chrome.runtime.sendMessage({
        type: 'REPORT_SUBMIT',
        payload: {
          disputeType: parseInt(disputeType),
          orderNo,
          buyerAccount,
          receiverName,
          receiverPhone,
          receiverAddress,
          reason,
          happenTime: happenTime ? happenTime.replace('T', ' ') + ':00' : null
        }
      });

      if (!response || !response.success) {
        throw new Error(response?.msg || '提交失败');
      }

      alert('✅ 举报提交成功！');
      overlay.remove();

    } catch (err) {
      alert('❌ 提交失败: ' + err.message);
      const submitBtn = overlay.querySelector('.zcc-btn-primary');
      submitBtn.disabled = false;
      submitBtn.textContent = '提交举报';
      console.error('[举报提交] 失败:', err);
    }
  }

  async function autoScrapeAllPages() {
    updateStatus('自动翻页功能开发中...', 'warning');
    // TODO: 自动翻页逻辑
  }

  // ==================== 定时批量查单发货 ====================

  let autoShipTimer = null;       // setInterval 句柄
  let autoShipFirstTimer = null;  // 首次执行 setTimeout 句柄
  let isAutoShipping = false;     // 防止并发执行
  let expressTimer = null;
  let expressFirstTimer = null;
  let isSyncingExpress = false;
  let expressFrameReady = false; // 当前frame是否包含京巴士同步按钮（多frame环境下只在正确的frame运行）

  /**
   * 通过文字内容查找"批量查单发货"按钮
   * 兼容 a / button / span 等标签
   */
  function findBatchShipBtn() {
    const candidates = document.querySelectorAll('a, button, span, div, li');
    for (const el of candidates) {
      // 只匹配直接文字内容，避免匹配到父容器
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .join('');
      if (directText === '批量查单发货' && el.offsetParent !== null) {
        return el;
      }
    }
    // 兜底：包含文字的可点击元素
    for (const el of candidates) {
      if (el.textContent.trim() === '批量查单发货' && el.offsetParent !== null) {
        return el;
      }
    }
    return null;
  }

  /**
   * 等待弹窗出现（旧版 fo-layer-old）
   */
  function waitForShipDialog(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const dialog = document.getElementById('fo-layer-old');
        if (dialog && dialog.style.display !== 'none') {
          resolve(dialog);
        } else if (Date.now() - start > timeout) {
          reject(new Error('未找到查单发货弹窗，已放弃本次执行'));
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  /**
   * 等待发货完成：每5秒轮询内容是否出现"发货完成"
   * 超时120秒未完成则直接关闭弹窗，等下次执行
   */
  function waitForShipComplete(dialog, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastLine = '';
      const check = () => {
        // 容错：弹窗被关闭
        if (!document.getElementById('fo-layer-old') || dialog.style.display === 'none') {
          reject(new Error('查单发货弹窗被关闭，已取消本次执行'));
          return;
        }

        const content = dialog.querySelector('.fo-layer-old-content');
        const text = content ? content.textContent : '';

        // 完成判断：内容出现"发货完成"
        if (text.includes('发货完成')) {
          resolve('done');
          return;
        }

        // 更新面板进度（取最后一行非空文字）
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
        const curLine = lines[lines.length - 1] || '';
        if (curLine && curLine !== lastLine) {
          lastLine = curLine;
          const short = curLine.length > 30 ? curLine.slice(0, 30) + '...' : curLine;
          updateShipStatus(`🚚 ${short}`, 'info');
        }

        if (Date.now() - start > timeout) {
          reject(new Error('查单发货超时（120秒），已关闭弹窗，等待下次执行'));
        } else {
          setTimeout(check, 5000);
        }
      };
      setTimeout(check, 5000);
    });
  }

  /**
   * 判断当前时间是否在允许执行的时间段内
   * 支持跨天（如 22:00 ~ 07:00）
   */
  function isInShipTimeRange(settings) {
    if (!settings.autoShipTimeRange) return true;
    const toMin = (t) => {
      const [h, m] = (t || '0:0').split(':').map(Number);
      return h * 60 + (m || 0);
    };
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const start = toMin(settings.autoShipTimeStart);
    const end = toMin(settings.autoShipTimeEnd);
    if (start === end) return true;
    if (start < end) {
      return cur >= start && cur < end;
    }
    // 跨天：如 22:00 ~ 07:00
    return cur >= start || cur < end;
  }

  /**
   * 检查插件上下文是否有效（插件刷新/更新后旧content script会失效）
   */
  function checkExtensionContext() {
    if (!chrome.runtime?.id) {
      updateShipStatus('⚠️ 插件已更新，请刷新页面后再使用', 'error');
      return false;
    }
    return true;
  }

  /**
   * 执行一次批量查单发货
   */
  async function runBatchShipOnce(manual = false) {
    if (!checkExtensionContext()) return;
    if (isAutoShipping) {
      console.log('[定时发货] 上一次尚未结束，跳过本次');
      return;
    }

    // 时间范围判断（手动触发不受限制）
    const settings = await new Promise(r => chrome.storage.local.get('jd_settings', s => r(s.jd_settings || {})));
    if (!manual && !isInShipTimeRange(settings)) {
      console.log(`[定时发货] 当前时间不在 ${settings.autoShipTimeStart}~${settings.autoShipTimeEnd} 范围内，跳过`);
      return;
    }

    isAutoShipping = true;
    try {
      console.log('%c[定时发货] 开始执行批量查单发货', 'color:#67c23a;font-weight:bold;');

      // 0. 先检测并关闭上一次残留的弹窗
      const existDialog = document.getElementById('fo-layer-old');
      if (existDialog && existDialog.style.display !== 'none') {
        const closeBtn0 = existDialog.querySelector('.fo-layer-old-btnstop');
        if (closeBtn0) {
          console.log('[定时发货] 检测到上一次残留弹窗，先关闭');
          closeBtn0.click();
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      updateShipStatus('🚚 正在查找"批量查单发货"按钮...', 'info');

      // 1. 查找并点击"批量查单发货"按钮
      const btn = findBatchShipBtn();
      if (!btn) {
        throw new Error('未找到"批量查单发货"按钮，请确认在订单列表页');
      }
      btn.click();
      console.log('[定时发货] 已点击"批量查单发货"按钮');

      // 2. 等2秒后检测弹窗是否出现
      await new Promise(r => setTimeout(r, 2000));
      const dialog = await waitForShipDialog();
      console.log('[定时发货] 弹窗已出现');

      // 3. 勾选选项
      // 所有订单出库
      const radioAll = document.getElementById('shipmentstypeOld0');
      if (!radioAll) throw new Error('未找到"所有订单出库"选项，弹窗结构可能已变化');
      if (!radioAll.checked) radioAll.click();

      // 发货失败自动备注（默认已勾，确保勾上）
      const cbRemark = document.getElementById('sendErrorRemarksOld');
      if (cbRemark && !cbRemark.checked) cbRemark.click();

      // 使用后台上家快递单号发货出库
      const cbSync = document.getElementById('syncBackgroundExpressOld');
      if (cbSync && !cbSync.checked) cbSync.click();

      // 快速发货(有单号就发货)
      const radioFast = document.getElementById('shippingtypeOld0');
      if (!radioFast) throw new Error('未找到"快速发货"选项，弹窗结构可能已变化');
      if (!radioFast.checked) radioFast.click();

      console.log('[定时发货] 选项已勾选：所有订单出库/失败备注/后台单号/快速发货');

      // 等500ms让选项生效
      await new Promise(r => setTimeout(r, 500));

      // 4. 点击"开始"
      const startBtn = dialog.querySelector('.fo-layer-old-btnstart');
      if (!startBtn) throw new Error('未找到"开始"按钮');
      startBtn.click();
      console.log('[定时发货] 已点击"开始"，等待执行完成...');
      updateShipStatus('🚚 执行中，请稍候...', 'info');

      // 5. 等待执行完成（内部先等5秒再开始轮询，每5秒检测一次）
      await waitForShipComplete(dialog);
      console.log('%c[定时发货] 发货执行完成', 'color:#67c23a;font-weight:bold;');
      updateShipStatus('✅ 发货完成，5秒后关闭弹窗...', 'success');

      // 6. 等5秒让用户查看结果，再关闭弹窗
      await new Promise(r => setTimeout(r, 5000));
      const closeBtn = dialog.querySelector('.fo-layer-old-btnstop');
      if (closeBtn) {
        closeBtn.click();
        console.log('[定时发货] 已关闭弹窗');
      }

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      updateShipStatus(`✅ 查单发货完成（${timeStr}）`, 'success');

      // 记录本次执行时间到本地缓存（await确保scheduleNext读到新值）
      await new Promise(resolve => {
        chrome.storage.local.get('jd_settings', (result) => {
          const s = result.jd_settings || {};
          s.lastShipTime = Date.now();
          chrome.storage.local.set({ 'jd_settings': s }, resolve);
        });
      });
      return true;
    } catch (e) {
      console.error('[定时发货] 执行失败:', e);
      updateShipStatus(`❌ ${e.message}，等待下次执行`, 'error');
      // 超时或出错时尝试关闭弹窗
      const dlg = document.getElementById('fo-layer-old');
      if (dlg && dlg.style.display !== 'none') {
        const btn = dlg.querySelector('.fo-layer-old-btnstop');
        if (btn) btn.click();
      }
      // 失败也更新lastShipTime，避免立即重试
      await new Promise(resolve => {
        chrome.storage.local.get('jd_settings', (result) => {
          const s = result.jd_settings || {};
          s.lastShipTime = Date.now();
          chrome.storage.local.set({ 'jd_settings': s }, resolve);
        });
      });
      return false;
    } finally {
      isAutoShipping = false;
    }
  }

  /**
   * 计算距离下次执行的毫秒数
   * 综合考虑时间范围和执行间隔
   */
  function calcNextDelay(lastTime, settings, intervalMs) {
    const now = Date.now();
    const last = lastTime || 0;
    const elapsed = now - last;

    // 间隔剩余时间
    let intervalWait = (!last || elapsed >= intervalMs) ? 10000 : (intervalMs - elapsed);

    // 没有时间范围限制，直接按间隔
    if (!settings.autoShipTimeRange) return intervalWait;

    const toMin = (t) => {
      const [h, m] = (t || '0:0').split(':').map(Number);
      return h * 60 + (m || 0);
    };
    const nowDate = new Date();
    const cur = nowDate.getHours() * 60 + nowDate.getMinutes();
    const start = toMin(settings.autoShipTimeStart);
    const end = toMin(settings.autoShipTimeEnd);
    const DAY = 24 * 60;

    // 判断某分钟数是否在时段内
    const inRange = (mins) => {
      if (start < end) return mins >= start && mins < end;
      if (start > end) return mins >= start || mins < end;
      return true;
    };

    // 计算到下一个时段开始的毫秒数
    const msToNextStart = () => {
      if (start < end) {
        if (cur < start) return (start - cur) * 60000;
        return (DAY - cur + start) * 60000;
      } else if (start > end) {
        if (cur >= end && cur < start) return (start - cur) * 60000;
        return 0; // 已在时段内（跨天段）
      }
      return 0;
    };

    // 当前不在时段内，等到时段开始
    if (!inRange(cur)) return msToNextStart();

    // 当前在时段内，检查按间隔算出的时间是否还在时段内
    const nextMins = cur + Math.round(intervalWait / 60000);
    if (!inRange(nextMins % DAY)) {
      // 超出时段，排到下一个时段开始
      return msToNextStart();
    }

    return intervalWait;
  }

  /**
   * 递归调度下一次执行（统一走 setupAutoShipTimer，避免定时器冲突）
   */
  function scheduleNext() {
    setupAutoShipTimer();
  }

  /**
   * 启动/重启定时查单发货
   */
  function setupAutoShipTimer() {
    if (!isTargetPage()) return;
    if (autoShipTimer) {
      clearTimeout(autoShipTimer);
      autoShipTimer = null;
    }
    if (autoShipFirstTimer) {
      clearTimeout(autoShipFirstTimer);
      autoShipFirstTimer = null;
    }

    chrome.storage.local.get('jd_settings', async (result) => {
      const settings = result.jd_settings || {};
      if (!settings.autoShip) {
        console.log('[定时发货] 未开启');
        updateShipStatus('🚚 定时查单发货未开启', 'info');
        return;
      }
      // 开启了"自动切换店铺"：绑定店铺≥2个才走轮转调度，否则回退普通定时发货
      if (settings.autoSwitchShop) {
        const queue = await getSwitchShopQueue();
        if (queue.length >= 2) {
          console.log('%c[定时发货] 已启用自动切换店铺模式，进入店铺轮转调度', 'color:#409eff;font-weight:bold;');
          setupShopSwitchTimer();
          return;
        }
        console.log('[定时发货] 自动切换店铺已开启但绑定店铺不足2个，回退普通定时发货');
      }
      startNormalShipTimer(settings);
    });
  }

  /**
   * 普通（单店）定时查单发货调度
   */
  function startNormalShipTimer(settings) {
      const minutes = Math.max(1, Math.min(720, settings.autoShipInterval || 30));
      const intervalMs = minutes * 60 * 1000;
      const delay = calcNextDelay(settings.lastShipTime, settings, intervalMs);

      const nextTime = new Date(Date.now() + delay);
      const nextStr = `${String(nextTime.getHours()).padStart(2,'0')}:${String(nextTime.getMinutes()).padStart(2,'0')}`;
      const rangeText = settings.autoShipTimeRange
        ? `，时段 ${settings.autoShipTimeStart}~${settings.autoShipTimeEnd}`
        : '';
      console.log(`%c[定时发货] 已开启，每${minutes}分钟执行${rangeText}，下次执行：${nextStr}`, 'color:#67c23a;font-weight:bold;');
      updateShipStatus(`🚚 每${minutes}分钟，下次 ${nextStr}${rangeText}`, 'info');

      autoShipFirstTimer = setTimeout(async () => {
        await runBatchShipOnce();
        scheduleNext();
      }, delay);
  }

  // ==================== 自动切换店铺批量查单发货 ====================
  // 设计说明：切换店铺会导致页面刷新，内存状态全部丢失，
  // 因此调度进度统一持久化到 chrome.storage.local 的 shop_switch_state，
  // 页面刷新后由 setupShopSwitchTimer 检测 phase='switching' 并恢复执行。

  const SHOP_SWITCH_STATE_KEY = 'shop_switch_state';
  let shopSwitchTimer = null;       // 切换调度 setTimeout 句柄
  let isSwitchingShop = false;      // 防止切换流程并发
  let switchCountdownTimer = null;  // 30秒倒计时 interval 句柄

  // 读取 config.js 配置（带默认值兜底）
  function switchCfg(name, def) {
    const c = (typeof ZHICHACHA_CONFIG !== 'undefined') ? ZHICHACHA_CONFIG : {};
    return (c[name] !== undefined && c[name] !== null) ? c[name] : def;
  }

  // 时间戳格式化为 HH:MM:SS
  function fmtSwitchTime(ts) {
    if (!ts) return '--:--:--';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  // 读取切换调度状态
  function getShopSwitchState() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(SHOP_SWITCH_STATE_KEY, r => resolve(r[SHOP_SWITCH_STATE_KEY] || null));
      } catch (e) { resolve(null); }
    });
  }
  function saveShopSwitchState(state) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.set({ [SHOP_SWITCH_STATE_KEY]: state }, resolve);
      } catch (e) { resolve(); }
    });
  }
  function removeShopSwitchState() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.remove(SHOP_SWITCH_STATE_KEY, resolve);
      } catch (e) { resolve(); }
    });
  }

  // 获取用于轮转的店铺队列（来自已绑定店铺，按 shop_id 去重）
  async function getSwitchShopQueue() {
    const shops = await getBoundShops();
    const map = new Map();
    (shops || []).forEach(s => {
      const id = String(s.shop_id || '').trim();
      if (id && !map.has(id)) {
        map.set(id, { shopId: id, shopName: s.shop_name || id });
      }
    });
    return Array.from(map.values());
  }

  // 在折叠面板渲染每个店铺的下一次切换时间
  function renderSwitchPlan(queue, state) {
    const box = document.getElementById('shop-switch-plan');
    const list = document.getElementById('shop-switch-plan-list');
    if (!box || !list) return;
    if (!queue || queue.length === 0) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    const curIndex = state ? state.index : -1;
    list.innerHTML = '';
    queue.forEach((shop, i) => {
      const item = document.createElement('div');
      let cls = 'shop-switch-plan-item';
      let timeText = '排队中';
      const nextAt = state && state.shopNextAt ? state.shopNextAt[shop.shopId] : null;
      if (state && state.phase === 'switching' && i === curIndex) {
        cls += ' is-current';
        timeText = '切换/发货中';
      } else if (nextAt) {
        if (i === curIndex) cls += ' is-current';
        else if (curIndex >= 0 && i < curIndex) cls += ' is-done';
        // 只有"下一个待执行店铺"才给确切时间（基于上一店真实结束时间推算）
        timeText = fmtSwitchTime(nextAt);
      }
      item.className = cls;
      item.title = shop.shopName;
      item.innerHTML = `<span class="plan-name">${i + 1}. ${shop.shopName}</span><span class="plan-time">${timeText}</span>`;
      list.appendChild(item);
    });
  }

  /**
   * 计算各店铺的切换时刻（用于面板展示，含"最长2分钟"保底）
   * 每个店铺的保底窗口 = 切换倒计时 + 单店最长发货(2分钟) + 店间间隔；
   * 尚未执行的店铺按此保底窗口线性预估，避免排期过于乐观；
   * 当某店实际结束晚于保底（失败/卡住/超时），由 advanceAfterShop 用真实结束时间顺延。
   */
  function estimateShopNextAt(queue, index, baseCountdownAt) {
    const countdownMs = (switchCfg('shopSwitchCountdown', 30)) * 1000;
    const perShipMs = switchCfg('perShopShipTimeout', 120000); // 单店最长2分钟保底
    const gapMs = switchCfg('shopSwitchGap', 30000);
    const stepMs = countdownMs + perShipMs + gapMs;           // 单个店铺保底占用时长
    const result = {};
    queue.forEach((shop, i) => {
      let offset = i - index;
      if (offset < 0) offset += queue.length; // 已执行过的，排到下一轮
      result[shop.shopId] = baseCountdownAt + offset * stepMs + countdownMs;
    });
    return result;
  }

  // 移除倒计时浮层
  function removeSwitchCountdown() {
    if (switchCountdownTimer) { clearInterval(switchCountdownTimer); switchCountdownTimer = null; }
    const el = document.getElementById('orange-zcc-switch-toast');
    if (el) el.remove();
  }

  /**
   * 切换前30秒倒计时提示
   * @returns 取消函数
   */
  function showSwitchCountdown(shop, seconds, onDone, onCancel, onNow) {
    removeSwitchCountdown();
    const el = document.createElement('div');
    el.className = 'orange-zcc-switch-toast';
    el.id = 'orange-zcc-switch-toast';
    let remain = seconds;
    const draw = () => {
      el.innerHTML = `
        <div class="switch-toast-title">🔁 即将自动切换店铺</div>
        <div class="switch-toast-body">
          将在 <span class="switch-toast-count">${remain}</span> 秒后自动切换到【${shop.shopName}】并批量查单发货<br>
          <span style="color:#909399;font-size:11px;">预留切换时间 ${seconds} 秒，单店发货最长 2 分钟，可取消本次</span>
        </div>
        <div class="switch-toast-actions">
          <button class="switch-toast-cancel" type="button">取消本次（下次继续）</button>
          <button class="switch-toast-now" type="button">立即切换</button>
        </div>`;
      el.querySelector('.switch-toast-cancel').onclick = () => { removeSwitchCountdown(); onCancel && onCancel(); };
      el.querySelector('.switch-toast-now').onclick = () => { removeSwitchCountdown(); onNow && onNow(); };
    };
    draw();
    document.body.appendChild(el);
    switchCountdownTimer = setInterval(() => {
      remain--;
      if (remain <= 0) { removeSwitchCountdown(); onDone && onDone(); return; }
      const cnt = el.querySelector('.switch-toast-count');
      if (cnt) cnt.textContent = remain;
    }, 1000);
  }

  // 等待店铺列表面板出现且已渲染出店铺行
  function waitForShopListFrame(timeout) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const frame = document.querySelector('.j_showShopsFrame');
        const tbody = document.querySelector('#j_showShopsFrame-Tbody');
        const visible = frame && getComputedStyle(frame).display !== 'none'
          && tbody && tbody.querySelectorAll('tr').length > 0;
        if (visible) return resolve(frame);
        if (Date.now() - start > timeout) return reject(new Error('店铺列表面板未出现或为空'));
        setTimeout(check, 400);
      };
      check();
    });
  }

  /**
   * 执行 DOM 层面的店铺切换（点击后页面预期会刷新）
   */
  async function performSwitchToShop(shop) {
    // 1. 点击店铺列表展示按钮 .j_showShopsLogo
    const logo = document.querySelector('.j_showShopsLogo');
    if (!logo) throw new Error('未找到店铺列表展示按钮（.j_showShopsLogo），请确认在订单列表页');
    logo.click();
    console.log('%c[切换店铺] 步骤1：已点击店铺列表展示按钮', 'color:#e6a23c;');

    // 2. 约2秒后等待列表面板出现
    await new Promise(r => setTimeout(r, 2000));
    const frame = await waitForShopListFrame(switchCfg('shopListDialogTimeout', 8000));
    console.log('%c[切换店铺] 步骤2：店铺列表面板已出现', 'color:#e6a23c;');

    // 3. 按 data-id / data-name 匹配目标店铺的"已登录"按钮
    const btns = frame.querySelectorAll('#j_showShopsFrame-Tbody .j_showShopsFrame-Button');
    let target = null;
    btns.forEach(b => {
      const id = String(b.getAttribute('data-id') || '').trim();
      const name = (b.getAttribute('data-name') || '').trim();
      if (id === String(shop.shopId) || (shop.shopName && name === shop.shopName)) target = b;
    });
    if (!target) throw new Error(`店铺列表中未找到【${shop.shopName}】(ID:${shop.shopId})，请检查店铺绑定`);
    console.log(`%c[切换店铺] 步骤3：命中目标店铺【${shop.shopName}】，准备点击切换`, 'color:#e6a23c;');

    // 4. 先把"切换中"状态持久化（页面刷新后据此恢复）
    // 5. 点击目标店铺按钮，触发切换（页面会刷新）
    target.click();
    console.log('%c[切换店铺] 步骤4：已点击目标店铺，等待页面刷新切换...', 'color:#e6a23c;');
  }

  // 切换（页面刷新或局部切换）后，轮询等待当前店铺变为目标店铺
  // 匹配规则：店铺ID一致优先；ID取不到时用店铺名称兜底，避免ID口径不一致导致永远匹配不上
  function waitForCurrentShop(targetShopId, targetShopName, timeout) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastInfo = null;
      const check = async () => {
        try {
          const info = await getShopInfo();
          lastInfo = info;
          const idOk = info.shopId && String(info.shopId) === String(targetShopId);
          const nameOk = targetShopName && info.shopName &&
            String(info.shopName).trim() === String(targetShopName).trim();
          if (idOk || nameOk) {
            console.log(`%c[切换店铺] 店铺匹配成功（ID:${info.shopId || '-'} 名称:${info.shopName || '-'}）`, 'color:#67c23a;');
            return resolve(info);
          }
        } catch (e) { /* 忽略单次读取失败，继续轮询 */ }
        if (Date.now() - start > timeout) {
          console.error('[切换店铺] 等待目标店铺超时，最后解析到的店铺：', lastInfo);
          return reject(new Error(`切换后等待店铺【${targetShopName || targetShopId}】加载超时（当前:${lastInfo ? (lastInfo.shopName || lastInfo.shopId || '空') : '未解析到'}），请检查网络或手动刷新页面`));
        }
        setTimeout(check, 1000);
      };
      check();
    });
  }

  /**
   * 点击切换后，在"页面没有整页刷新"（局部切换）的情况下持续监控当前店铺，
   * 一旦变成目标店铺就接着走恢复发货；超时未变化则判失败并推进下一店。
   * 若页面整页刷新，本 JS 上下文随之销毁，改由新页面 init 的 resumeAfterSwitch 接管，互不冲突。
   */
  function watchSwitchOnSamePage(shop, queue, state) {
    const start = Date.now();
    const timeout = switchCfg('shopChangeTimeout', 30000);
    const tick = async () => {
      const s = await getShopSwitchState();
      // 状态已被其他流程改变（整页刷新后接管/已推进），停止监控
      if (!s || s.phase !== 'switching') return;
      const info = await getShopInfo().catch(() => ({ shopId: '', shopName: '' }));
      const idOk = info.shopId && String(info.shopId) === String(shop.shopId);
      const nameOk = shop.shopName && info.shopName &&
        String(info.shopName).trim() === String(shop.shopName).trim();
      if (idOk || nameOk) {
        console.log('%c[切换店铺] 当前页检测到已切换到目标店铺（未整页刷新），继续查单发货', 'color:#67c23a;font-weight:bold;');
        isSwitchingShop = false; // 解除 doSwitch 加的锁，让 resumeAfterSwitch 进入
        resumeAfterSwitch(s);
        return;
      }
      if (Date.now() - start > timeout) {
        console.error('[切换店铺] 等待店铺切换超时，判定失败并跳过该店');
        updateShipStatus(`❌ 切换到【${shop.shopName}】超时，请检查店铺登录状态或刷新页面`, 'error');
        isSwitchingShop = false;
        await advanceAfterShop(queue, s, '切换超时');
        return;
      }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 2000); // 2秒后开始检测，给切换动作留出时间
  }

  /**
   * 推进到下一个店铺：更新 index、计算下一次动作时间并重新调度
   * @param queue 当前队列
   * @param state 当前状态（会被修改并持久化）
   */
  async function advanceAfterShop(queue, state, reason) {
    console.log(`%c[切换店铺] 店铺【${queue[state.index] ? queue[state.index].shopName : state.index}】结束（${reason}），推进队列`, 'color:#909399;');
    const finishedIndex = state.index;
    state.index = (state.index + 1) % queue.length;
    const now = Date.now();

    const countdownMs = (switchCfg('shopSwitchCountdown', 30)) * 1000;
    const perShipMs = switchCfg('perShopShipTimeout', 120000); // 单店最长2分钟保底
    const gapMs = switchCfg('shopSwitchGap', 30000);
    const stepMs = countdownMs + perShipMs + gapMs;

    let gap;
    if (state.index === 0) {
      // 已跑完一整轮，按用户设置的间隔时间等待下一轮
      const minutes = Math.max(1, Math.min(720, state.intervalMin || 30));
      gap = minutes * 60 * 1000;
      console.log(`%c[切换店铺] 本轮全部店铺已完成，${minutes} 分钟后开启下一轮`, 'color:#67c23a;font-weight:bold;');
    } else {
      // 同一轮内，店铺间预留切换时间
      gap = gapMs;
    }

    // 下一店倒计时开始时刻 = max(上一店保底窗口结束, 上一店真实结束+间隔)
    // —— 正常情况保底2分钟优先，避免操作过快失误；失败/卡住导致实际更晚时按真实时间顺延
    const realNextStart = now + gap;
    const guardNextStart = (state.baseAt || now) + stepMs;
    const nextBase = Math.max(realNextStart, guardNextStart);
    if (realNextStart < guardNextStart) {
      console.log(`[切换店铺] 该店实际较早结束，按最长2分钟保底排期（${Math.round((guardNextStart - realNextStart) / 1000)}秒保底缓冲）`);
    } else {
      console.log('[切换店铺] 实际结束晚于保底窗口，下一店按真实结束时间顺延');
    }

    state.phase = 'idle';
    state.baseAt = nextBase;       // 下一店倒计时开始时刻
    state.nextAt = nextBase;
    state.targetShopId = '';
    state.targetShopName = '';
    state.shopNextAt = estimateShopNextAt(queue, state.index, nextBase);
    await saveShopSwitchState(state);
    renderSwitchPlan(queue, state);
    setupShopSwitchTimer();
  }

  /**
   * 到点后处理当前 index 对应的店铺：
   * 已在该店铺则直接发货；否则先倒计时再切换
   */
  async function beginCurrentShop(queue, state, settings, manual = false) {
    if (isSwitchingShop) return;
    const shop = queue[state.index];
    if (!shop) { // 队列异常，重置
      await removeShopSwitchState();
      setupShopSwitchTimer();
      return;
    }

    // 自动调度受时间范围限制（手动/恢复流程不走这里）
    if (!manual && !isInShipTimeRange(settings)) {
      console.log(`[切换店铺] 当前不在 ${settings.autoShipTimeStart}~${settings.autoShipTimeEnd} 时段，本次跳过`);
      updateShipStatus(`🔁 非执行时段，跳过【${shop.shopName}】`, 'info');
      await advanceAfterShop(queue, state, '非执行时段');
      return;
    }

    // 判断当前是否已处于目标店铺（无需切换）
    const cur = await getShopInfo();
    if (cur.shopId && String(cur.shopId) === String(shop.shopId)) {
      console.log(`%c[切换店铺] 当前已是目标店铺【${shop.shopName}】，无需切换，直接查单发货`, 'color:#409eff;');
      await shipForShopAndAdvance(queue, state, shop);
      return;
    }

    // 需要切换：先30秒倒计时提示（可取消 / 立即切换）
    const countdownSec = switchCfg('shopSwitchCountdown', 30);
    updateShipStatus(`🔁 ${countdownSec}秒后切换到【${shop.shopName}】`, 'info');
    console.log(`%c[切换店铺] 弹出 ${countdownSec} 秒切换倒计时：目标【${shop.shopName}】`, 'color:#e6a23c;font-weight:bold;');

    const doSwitch = async () => {
      isSwitchingShop = true;
      try {
        // 持久化 switching 状态，页面刷新后据此恢复
        state.phase = 'switching';
        state.targetShopId = shop.shopId;
        state.targetShopName = shop.shopName;
        state.switchAt = Date.now();
        await saveShopSwitchState(state);
        renderSwitchPlan(queue, state);
        await performSwitchToShop(shop);
        // 点击后分两种情况：
        // 1) 页面整页刷新 → 本上下文销毁，由新页面 init 检测 switching 走 resumeAfterSwitch；
        // 2) 页面不刷新（局部切换）→ 由 watchSwitchOnSamePage 持续轮询，店铺一切换到位就立即发货。
        watchSwitchOnSamePage(shop, queue, state);
      } catch (e) {
        console.error('[切换店铺] 切换操作失败:', e);
        updateShipStatus(`❌ 切换【${shop.shopName}】失败：${e.message}，已跳过等待下次`, 'error');
        isSwitchingShop = false;
        // 收起可能已展开的店铺列表面板
        const reduce = document.querySelector('.j_showShopsFrame-reduce');
        if (reduce) reduce.click();
        await advanceAfterShop(queue, state, '切换失败');
      }
    };

    showSwitchCountdown(
      shop,
      countdownSec,
      () => { doSwitch(); },                                  // 倒计时结束
      async () => {                                           // 取消本次
        console.log('[切换店铺] 用户取消本次切换，跳过该店，下一次继续');
        updateShipStatus(`⏭️ 已取消切换【${shop.shopName}】，本次跳过`, 'info');
        await advanceAfterShop(queue, state, '用户取消');
      },
      () => { doSwitch(); }                                   // 立即切换
    );
  }

  /**
   * 在目标店铺执行一次查单发货，完成后推进队列（切换流程专用）
   */
  async function shipForShopAndAdvance(queue, state, shop) {
    isSwitchingShop = true;
    try {
      updateShipStatus(`🚚 正在为【${shop.shopName}】批量查单发货...`, 'info');
      console.log(`%c[切换店铺] 开始为【${shop.shopName}】执行批量查单发货`, 'color:#409eff;font-weight:bold;');
      // 复用既有发货流程：manual=true 跳过时段判断；切换模式不依赖 lastShipTime
      const ok = await runBatchShipOnce(true);
      console.log(`%c[切换店铺]【${shop.shopName}】查单发货结束，结果：${ok ? '成功' : '存在失败'}`, ok ? 'color:#67c23a;' : 'color:#e6a23c;');
    } catch (e) {
      console.error(`[切换店铺]【${shop.shopName}】发货异常:`, e);
      updateShipStatus(`❌【${shop.shopName}】发货异常：${e.message}`, 'error');
    } finally {
      isSwitchingShop = false;
      await advanceAfterShop(queue, state, '发货结束');
    }
  }

  /**
   * 页面刷新后恢复：等待店铺切换完成 → 发货 → 推进
   */
  async function resumeAfterSwitch(state) {
    // 同步加锁（必须在第一个 await 之前），防止刷新恢复与局部切换监控重复进入
    if (isSwitchingShop) {
      console.log('[切换店铺] 恢复流程已在进行，忽略重复触发');
      return;
    }
    isSwitchingShop = true;
    const queue = await getSwitchShopQueue();
    const shop = { shopId: state.targetShopId, shopName: state.targetShopName || state.targetShopId };
    // 若队列里能找到更准确的名字，优先用队列
    const matched = queue.find(q => String(q.shopId) === String(shop.shopId));
    if (matched) shop.shopName = matched.shopName;

    try {
      console.log(`%c[切换店铺] 页面已刷新，等待切换到目标店铺【${shop.shopName}】...`, 'color:#e6a23c;font-weight:bold;');
      updateShipStatus(`🔁 正在切换到【${shop.shopName}】，等待页面加载...`, 'info');
      renderSwitchPlan(queue.length ? queue : [shop], state);

      // 等待当前店铺变为目标店铺
      await waitForCurrentShop(shop.shopId, shop.shopName, switchCfg('shopChangeTimeout', 30000));
      console.log(`%c[切换店铺] 已成功切换到【${shop.shopName}】，2秒后开始查单发货`, 'color:#67c23a;');
      updateShipStatus(`✅ 已切换到【${shop.shopName}】，准备发货`, 'success');
      // 多等2秒让订单页按钮渲染稳定
      await new Promise(r => setTimeout(r, 2000));

      // 用恢复后的完整队列推进；若队列取不到则用单店兜底
      const useQueue = queue.length ? queue : [shop];
      const useState = queue.length ? state : Object.assign({}, state, { index: 0 });
      await shipForShopAndAdvance(useQueue, useState, shop);
    } catch (e) {
      console.error('[切换店铺] 恢复切换流程失败:', e);
      updateShipStatus(`❌ ${e.message}`, 'error');
      isSwitchingShop = false;
      // 容错：切换恢复失败也推进到下一店，避免卡死整个轮转
      if (queue.length) {
        await advanceAfterShop(queue, state, '恢复失败');
      } else {
        state.phase = 'idle';
        state.targetShopId = '';
        await saveShopSwitchState(state);
        setupShopSwitchTimer();
      }
    }
  }

  /**
   * 手动立即执行一次"切换店铺批量查单发货"（面板按钮触发，不受时段限制）
   */
  async function manualRunSwitchOnce() {
    if (!checkExtensionContext()) return;
    if (isSwitchingShop) {
      updateShipStatus('🔁 店铺切换正在执行中，请勿重复触发', 'info');
      console.log('[切换店铺] 手动触发被拦截：上一次切换尚未结束');
      return;
    }
    const settings = await new Promise(r => chrome.storage.local.get('jd_settings', s => r(s.jd_settings || {})));
    if (!settings.autoShip || !settings.autoSwitchShop) {
      updateShipStatus('🔁 请先在插件设置中开启"定时查单发货"和"自动切换店铺"', 'error');
      console.warn('[切换店铺] 手动触发失败：未开启自动切换店铺');
      return;
    }
    const queue = await getSwitchShopQueue();
    if (queue.length < 2) {
      updateShipStatus('🔁 绑定店铺不足2个，无法切换，可直接用标题栏🚚发货', 'error');
      console.warn('[切换店铺] 手动触发失败：绑定店铺不足2个', queue);
      return;
    }

    // 取消正在等待的自动调度与倒计时，避免重复
    if (shopSwitchTimer) { clearTimeout(shopSwitchTimer); shopSwitchTimer = null; }
    removeSwitchCountdown();

    const minutes = Math.max(1, Math.min(720, settings.autoShipInterval || 30));
    let state = await getShopSwitchState();
    if (!state || !Array.isArray(state.queueIds) ||
      state.queueIds.join(',') !== queue.map(q => q.shopId).join(',')) {
      state = {
        phase: 'idle',
        queueIds: queue.map(q => q.shopId),
        index: 0,
        intervalMin: minutes,
        baseAt: Date.now(),
        nextAt: Date.now(),
        targetShopId: '',
        targetShopName: '',
        shopNextAt: {}
      };
    }
    // 手动触发时若残留 switching（如上次异常），复位为 idle 从当前 index 开始
    state.phase = 'idle';
    state.targetShopId = '';
    state.intervalMin = minutes;
    state.baseAt = Date.now(); // 手动立即开始，基准重置为当前
    state.nextAt = Date.now();
    state.shopNextAt = estimateShopNextAt(queue, state.index, Date.now(), settings);
    await saveShopSwitchState(state);
    renderSwitchPlan(queue, state);

    const shop = queue[state.index];
    console.log('%c[切换店铺] 手动触发：立即开始切换店铺发货，首个目标【' + (shop ? shop.shopName : '-') + '】', 'color:#f56c6c;font-weight:bold;');
    updateShipStatus(`🔁 手动触发，立即切换到【${shop ? shop.shopName : '-'}】`, 'info');
    await beginCurrentShop(queue, state, settings, true);
  }

  /**
   * 自动切换店铺调度器（切换模式下替代 setupAutoShipTimer 的普通调度）
   */
  async function setupShopSwitchTimer() {
    if (!isTargetPage()) return;
    if (shopSwitchTimer) { clearTimeout(shopSwitchTimer); shopSwitchTimer = null; }

    let settings;
    try {
      settings = await new Promise(r => chrome.storage.local.get('jd_settings', s => r(s.jd_settings || {})));
    } catch (e) { return; }

    // 未开启切换店铺：清理切换状态，交还给普通定时发货逻辑
    if (!settings.autoShip || !settings.autoSwitchShop) {
      const st = await getShopSwitchState();
      if (st && st.phase !== 'switching') await removeShopSwitchState();
      const planBox = document.getElementById('shop-switch-plan');
      if (planBox) planBox.style.display = 'none';
      return;
    }

    const state0 = await getShopSwitchState();
    // 恢复分支：页面刷新后处于 switching
    if (state0 && state0.phase === 'switching' && state0.targetShopId) {
      console.log('%c[切换店铺] 检测到切换中状态（页面刚刷新），恢复执行', 'color:#e6a23c;font-weight:bold;');
      resumeAfterSwitch(state0);
      return;
    }

    const queue = await getSwitchShopQueue();
    if (queue.length === 0) {
      updateShipStatus('🔁 未获取到绑定店铺，无法自动切换', 'error');
      return;
    }
    // 只有1个店铺时无需切换，直接走普通定时发货
    if (queue.length === 1) {
      console.log('[切换店铺] 仅1个绑定店铺，按普通定时发货处理');
      const planBoxOne = document.getElementById('shop-switch-plan');
      if (planBoxOne) planBoxOne.style.display = 'none';
      return;
    }

    const minutes = Math.max(1, Math.min(720, settings.autoShipInterval || 30));
    let state = state0;
    if (!state || !Array.isArray(state.queueIds) ||
      state.queueIds.join(',') !== queue.map(q => q.shopId).join(',')) {
      // 首次运行或店铺队列发生变化：重新初始化
      state = {
        phase: 'idle',
        queueIds: queue.map(q => q.shopId),
        index: 0,
        intervalMin: minutes,
        baseAt: Date.now() + 2000, // 首店倒计时开始时刻（与 nextAt 一致）
        nextAt: Date.now() + 2000, // 首次/重置后2秒即开始（尽快执行一遍）
        targetShopId: '',
        targetShopName: '',
        shopNextAt: {}
      };
      console.log('%c[切换店铺] 初始化轮转队列：', 'color:#409eff;font-weight:bold;', queue.map(q => q.shopName));
    }
    state.intervalMin = minutes;

    // 估算并渲染各店计划时间（以当前店倒计时开始时刻 baseAt 为基准，含2分钟保底）
    state.baseAt = state.baseAt || state.nextAt;
    state.shopNextAt = estimateShopNextAt(queue, state.index, state.baseAt, settings);
    await saveShopSwitchState(state);
    renderSwitchPlan(queue, state);

    const intervalMs = minutes * 60 * 1000;
    // 计算等待时长（叠加时间范围）
    let delay = Math.max(2000, (state.nextAt || 0) - Date.now());
    if (settings.autoShipTimeRange) {
      const rangeDelay = calcNextDelay(null, settings, intervalMs);
      // 非执行时段时，优先等到时段开始
      if (!isInShipTimeRange(settings)) delay = rangeDelay;
    }

    const nextShop = queue[state.index];
    console.log(`%c[切换店铺] 调度已规划：共${queue.length}个店，下一个【${nextShop ? nextShop.shopName : '-'}】，约${Math.round(delay / 1000)}秒后进入${switchCfg('shopSwitchCountdown', 30)}秒倒计时`, 'color:#409eff;');
    console.log('%c[切换店铺] 各店预计时间:', 'color:#409eff;',
      queue.map((q, i) => `${q.shopName}@${fmtSwitchTime(state.shopNextAt[q.shopId])}`).join('  |  '));
    updateShipStatus(`🔁 轮转${queue.length}店，下一个【${nextShop ? nextShop.shopName : '-'}】约${fmtSwitchTime(Date.now() + delay)}`, 'info');

    shopSwitchTimer = setTimeout(async () => {
      // 到点前再次读取最新设置，避免使用过期状态
      const latest = await new Promise(r => chrome.storage.local.get('jd_settings', s => r(s.jd_settings || {})));
      const curState = await getShopSwitchState();
      if (!latest.autoShip || !latest.autoSwitchShop || !curState) return;
      await beginCurrentShop(queue, curState, latest);
    }, delay);
  }

  // ==================== 同步物流状态（京巴士） ====================

  /**
   * 等待同步物流弹窗出现
   */
  function waitForExpressDialog(timeout = 8000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const dialog = document.querySelector('.jbs-send-express-modal');
        // zeromodal 弹窗打开时存在于 DOM，关闭时会被移除
        if (dialog && dialog.style.display !== 'none') {
          resolve(dialog);
          return;
        }
        if (Date.now() - start > timeout) {
          reject(new Error('未找到同步物流弹窗，已放弃本次执行'));
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  /**
   * 等待发送完成：每10秒检测 .jbs-sync-buy-log-status 的 data-state
   * data-state="success" 表示发送完成，"error"/"warning" 表示异常
   */
  function waitForExpressComplete(dialog, timeout = 300000, initialWait = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastState = '';
      const check = () => {
        // 容错：弹窗被关闭或移除
        if (!document.querySelector('.jbs-send-express-modal')) {
          reject(new Error('同步物流弹窗被关闭，已取消本次执行'));
          return;
        }

        const statusEl = dialog.querySelector('.jbs-sync-buy-log-status');
        const state = statusEl ? (statusEl.getAttribute('data-state') || '') : '';
        const text = statusEl ? statusEl.textContent.trim() : '';

        // 完成
        if (state === 'success' || text.includes('发送完成')) {
          resolve('done');
          return;
        }

        // 异常状态
        if (state === 'error' || (state === 'warning' && text.includes('失败'))) {
          reject(new Error(`执行异常：${text || '未知错误'}`));
          return;
        }

        // 更新面板进度
        if (text && text !== lastState) {
          lastState = text;
          updateExpressStatus(`📮 ${text}`, 'info');
        }

        if (Date.now() - start > timeout) {
          reject(new Error('同步物流超时（5分钟），已关闭弹窗，等待下次执行'));
        } else {
          setTimeout(check, 10000);
        }
      };
      setTimeout(check, initialWait);
    });
  }

  /**
   * 执行一次同步物流状态（并发送取件码）
   */
  async function runSyncExpressOnce(manual = false) {
    if (!checkExtensionContext()) return;
    if (isSyncingExpress) {
      console.log('[同步物流] 上一次尚未结束，跳过本次');
      return;
    }
    // 多frame环境下，只有包含同步按钮的frame才执行
    if (!expressFrameReady && !document.querySelector('a.sendExpressPrivacy')) {
      console.log('[同步物流] 当前frame无同步按钮，跳过');
      return;
    }

    // 时间范围判断（手动触发不受限制）
    const settings = await new Promise(r => chrome.storage.local.get('jd_settings', s => r(s.jd_settings || {})));
    if (!manual && !isInShipTimeRange(settings)) {
      console.log(`[同步物流] 当前时间不在 ${settings.autoShipTimeStart}~${settings.autoShipTimeEnd} 范围内，跳过`);
      return;
    }

    isSyncingExpress = true;
    try {
      console.log('%c[同步物流] 开始执行', 'color:#e6a23c;font-weight:bold;');

      // 检查弹窗是否已经打开（可能正在发送中）
      let dialog = document.querySelector('.jbs-send-express-modal');
      let dialogOpen = dialog && dialog.style.display !== 'none';

      // 如果弹窗停在错误/完成状态，先关闭再重新开始
      if (dialogOpen) {
        const oldStatus = dialog.querySelector('.jbs-sync-buy-log-status');
        const oldState = oldStatus ? oldStatus.getAttribute('data-state') : '';
        if (oldState === 'error' || oldState === 'success' || oldState === 'warning') {
          const closeBtn = dialog.querySelector('button.zeromodal-btn-default');
          if (closeBtn) closeBtn.click();
          await new Promise(r => setTimeout(r, 1500));
          dialog = null;
          dialogOpen = false;
        }
      }

      if (!dialogOpen) {
        updateExpressStatus('📮 正在查找"同步物流状态"按钮...', 'info');

        // 1. 点击"同步物流状态(并发送取件码)"按钮
        const btn = document.querySelector('a.sendExpressPrivacy');
        if (!btn) {
          throw new Error('未找到"同步物流状态(并发送取件码)"按钮');
        }
        btn.click();
        console.log('[同步物流] 已点击"同步物流状态"按钮，等待弹窗...');

        // 2. 等5秒后等弹窗出现
        await new Promise(r => setTimeout(r, 5000));
        dialog = await waitForExpressDialog();
        console.log('[同步物流] 弹窗已出现');

        // 3. 点击"开始发送"
        const startBtn = dialog.querySelector('button.zeromodal-btn-primary');
        if (!startBtn) throw new Error('未找到"开始发送"按钮');
        startBtn.click();
        console.log('[同步物流] 已点击"开始发送"，等待执行完成...');
      } else {
        // 弹窗已打开，检查是否在等待开始状态（idle），如果是则点"开始发送"
        const statusEl = dialog.querySelector('.jbs-sync-buy-log-status');
        const state = statusEl ? statusEl.getAttribute('data-state') : '';
        if (state === 'idle' || !state) {
          const startBtn = dialog.querySelector('button.zeromodal-btn-primary');
          if (startBtn) {
            startBtn.click();
            console.log('[同步物流] 弹窗已打开但未开始，已点击"开始发送"');
          }
        } else {
          console.log('[同步物流] 弹窗已打开且正在执行，直接等待完成...');
        }
      }

      updateExpressStatus('📮 发送中，请稍候...', 'info');

      // 4. 等待完成（弹窗已打开时不等待，直接轮询）
      await waitForExpressComplete(dialog, 300000, dialogOpen ? 0 : 5000);
      console.log('%c[同步物流] 发送完成', 'color:#67c23a;font-weight:bold;');
      updateExpressStatus('✅ 发送完成，5秒后关闭弹窗...', 'success');

      // 5. 等5秒再关闭
      await new Promise(r => setTimeout(r, 5000));
      const closeBtn = dialog.querySelector('button.zeromodal-btn-default');
      if (closeBtn) {
        closeBtn.click();
        console.log('[同步物流] 已关闭弹窗');
      }

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      updateExpressStatus(`✅ 同步物流完成（${timeStr}）`, 'success');

      // 记录本次执行时间（await确保scheduleExpressNext读到新值）
      await new Promise(resolve => {
        chrome.storage.local.get('jd_settings', (result) => {
          const s = result.jd_settings || {};
          s.lastExpressTime = Date.now();
          chrome.storage.local.set({ 'jd_settings': s }, resolve);
        });
      });
      return true;
    } catch (e) {
      console.error('[同步物流] 执行失败:', e);
      updateExpressStatus(`❌ ${e.message}，等待下次执行`, 'error');
      // 失败时关闭弹窗，避免残留影响下次执行
      const dlg = document.querySelector('.jbs-send-express-modal');
      if (dlg && dlg.style.display !== 'none') {
        const btn = dlg.querySelector('button.zeromodal-btn-default');
        if (btn) btn.click();
      }
      // 失败也更新lastExpressTime，避免立即重试
      await new Promise(resolve => {
        chrome.storage.local.get('jd_settings', (result) => {
          const s = result.jd_settings || {};
          s.lastExpressTime = Date.now();
          chrome.storage.local.set({ 'jd_settings': s }, resolve);
        });
      });
      return false;
    } finally {
      isSyncingExpress = false;
    }
  }

  /**
   * 递归调度下一次同步物流（统一走 setupExpressTimer，避免定时器冲突）
   */
  function scheduleExpressNext() {
    setupExpressTimer();
  }

  /**
   * 启动/重启定时同步物流
   */
  function setupExpressTimer() {
    if (!isExpressPage() || !expressFrameReady) return;
    if (expressTimer) {
      clearTimeout(expressTimer);
      expressTimer = null;
    }
    if (expressFirstTimer) {
      clearTimeout(expressFirstTimer);
      expressFirstTimer = null;
    }

    chrome.storage.local.get('jd_settings', (result) => {
      const settings = result.jd_settings || {};
      if (!settings.autoSyncExpress) {
        console.log('[同步物流] 未开启');
        updateExpressStatus('📮 定时同步物流未开启', 'info');
        return;
      }
      const minutes = Math.max(1, Math.min(1440, settings.autoSyncExpressInterval || 120));
      const intervalMs = minutes * 60 * 1000;
      const delay = calcNextDelay(settings.lastExpressTime, settings, intervalMs);

      const nextTime = new Date(Date.now() + delay);
      const nextStr = `${String(nextTime.getHours()).padStart(2,'0')}:${String(nextTime.getMinutes()).padStart(2,'0')}`;
      const rangeText = settings.autoShipTimeRange
        ? `，时段 ${settings.autoShipTimeStart}~${settings.autoShipTimeEnd}`
        : '';
      console.log(`%c[同步物流] 已开启，每${minutes}分钟执行${rangeText}，下次：${nextStr}`, 'color:#e6a23c;font-weight:bold;');
      updateExpressStatus(`📮 每${minutes}分钟，下次 ${nextStr}${rangeText}`, 'info');

      expressFirstTimer = setTimeout(async () => {
        await runSyncExpressOnce();
        scheduleExpressNext();
      }, delay);
    });
  }

  // ==================== 消息监听 ====================
  
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'CHECK_PAGE':
        sendResponse({
          isTargetPage: isTargetPage(),
          url: window.location.href,
          orderCount: document.querySelectorAll(SELECTORS.orderCard).length
        });
        break;
      case 'TRIGGER_SCRAPE':
        scrapeCurrentPage().then(orders => {
          sendResponse({ success: true, count: orders.length, orders });
        });
        return true;
      case 'GET_PAGE_INFO':
        sendResponse({
          url: window.location.href,
          title: document.title,
          isOrderPage: isTargetPage()
        });
        break;

      case 'GET_CURRENT_SHOP':
        // 返回当前页面店铺信息（异步）
        getShopInfo().then(shopInfo => {
          sendResponse(shopInfo);
        });
        return true;

      case 'SYNC_RESULT':
        if (message.payload.success) {
          const result = message.payload;
          let msg = `✅ 同步成功：`;
          if (result.msg) {
            msg += result.msg;
          } else if (result.insert !== undefined || result.update !== undefined) {
            msg += `新增${result.insert || 0}条，更新${result.update || 0}条`;
          } else if (result.synced) {
            msg += `${result.synced}条`;
          }
          updateStatus(msg, 'success');
        } else {
          updateStatus(`❌ 同步失败：${message.payload.message || message.payload.msg || '未知错误'}`, 'error');
        }
        break;

      case 'RUN_BATCH_SHIP':
        // 手动触发一次查单发货
        runBatchShipOnce(true).then(() => {
          sendResponse({ success: true });
        }).catch(e => {
          sendResponse({ success: false, message: e.message });
        });
        return true;

      case 'RUN_SYNC_EXPRESS':
        // 手动触发一次同步物流
        runSyncExpressOnce(true).then(() => {
          sendResponse({ success: true });
        }).catch(e => {
          sendResponse({ success: false, message: e.message });
        });
        return true;

      case 'SETTINGS_UPDATED': {
        // 用户在设置面板点了保存：切换店铺模式下重置轮转，立即刷新计划并马上执行一遍
        const ns = message.settings || {};
        if (isTargetPage() && ns.autoShip && ns.autoSwitchShop && !isSwitchingShop) {
          console.log('%c[切换店铺] 检测到设置已保存，重置轮转并立即执行一遍', 'color:#f56c6c;font-weight:bold;');
          if (shopSwitchTimer) { clearTimeout(shopSwitchTimer); shopSwitchTimer = null; }
          removeSwitchCountdown();
          chrome.storage.local.remove(SHOP_SWITCH_STATE_KEY, () => {
            setupAutoShipTimer();
          });
        } else {
          // 设置已更新，重新设置定时器
          setupAutoShipTimer();
        }
        if (isExpressPage()) setupExpressTimer();
        break;
      }
    }
  });

  // 监听登录状态变化，退出登录时清除风险标记
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.zhichacha_token) {
      const newToken = changes.zhichacha_token.newValue;
      if (!newToken) {
        // token被清除，说明退出登录了
        clearRiskMarks();
        console.log('[风险检测] 已退出登录，清除页面风险标记');
      }
    }
    // 设置变化时重新设置定时器
    if (area === 'local' && changes.jd_settings) {
      setupAutoShipTimer();
      if (isExpressPage()) setupExpressTimer();
    }
  });

  // ==================== 初始化 ====================
  
  async function init() {
    // 京巴士物流状态页
    if (isExpressPage()) {
      if (document.readyState === 'loading') {
        await new Promise(resolve => {
          document.addEventListener('DOMContentLoaded', resolve);
        });
      }

      // 等待工具栏按钮出现，确认当前frame是正确的页面（避免多frame重复启动）
      let btn = null;
      try {
        btn = await waitForElement('a.sendExpressPrivacy', 10000);
      } catch (e) {
        console.log('[京巴士物流同步] 当前frame未找到同步按钮，不启动');
        return;
      }
      if (!btn) return;

      expressFrameReady = true;
      console.log('%c[京巴士物流同步助手] 已加载', 'color: #e6a23c; font-weight: bold;');

      setTimeout(() => {
        createFloatingPanel();
        floatingPanel.classList.add('express-mode');
        document.getElementById('panel-title').textContent = '📮 京巴士物流同步';
        floatingPanel.querySelectorAll('.jd-only').forEach(el => el.style.display = 'none');
        floatingPanel.querySelectorAll('.express-only').forEach(el => el.style.display = '');
        setupExpressTimer();
      }, 1500);
      return;
    }

    if (!isTargetPage()) {
      console.log('[京东订单抓取] 当前不是订单页面');
      return;
    }

    console.log('%c[京东订单抓取助手] 已加载', 'color: #e1251b; font-weight: bold;');
    // console.log('选择器配置:', SELECTORS);

    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve);
      });
    }

    setTimeout(async () => {
      createFloatingPanel();

      // 启动定时查单发货（独立于同步，不依赖登录）
      setupAutoShipTimer();

      // 1. 获取店铺信息（最多等8秒重试）
      updateStatus('正在识别店铺信息...', 'info');
      const shopInfo = await getShopInfo();
      let shopName = shopInfo.shopName || '京东店铺';

      // 2. 检查智查查登录状态
      const isLoggedIn = await checkLoginStatus();
      if (!isLoggedIn) {
        showLoginWarning(true);
        updateStatus('⚠️ 未登录智查查，请先登录', 'warning');
        return;
      }

      // 3. 检查当前店铺是否已绑定
      const shopBound = await updateShopStatus();
      if (!shopBound) {
        updateStatus(`❌ 当前店铺未绑定，无法同步`, 'error');
        console.warn(`[初始化] 店铺 ${shopInfo.shopName} (ID:${shopInfo.shopId}) 未绑定账号`);
        return;
      }

      updateStatus(`✅ ${shopName} 已就绪，10秒后自动同步...`, 'success');
      console.log(`[初始化] 已识别店铺：${shopName} (ID: ${shopInfo.shopId})，已绑定，10秒后自动抓取`);

      // 3. 10秒倒计时自动抓取
      let countdown = 10;
      const timer = setInterval(() => {
        countdown--;
        if (countdown > 0) {
          updateStatus(`⏱️ ${countdown} 秒后自动同步当前页...`, 'info');
        } else {
          clearInterval(timer);
        }
      }, 1000);

      setTimeout(async () => {
        clearInterval(timer);
        updateStatus('🔄 正在自动抓取并同步...', 'info');

        try {
          const result = await scrapeCurrentPage();
          if (result && result.importList && result.importList.length > 0) {
            updateStatus(`✅ 已同步 ${result.importList.length} 条订单到服务器`, 'success');
          } else {
            updateStatus('❌ 抓取失败，请手动点击同步', 'error');
          }
        } catch (e) {
          updateStatus(`❌ 同步失败: ${e.message}`, 'error');
          console.error('自动同步失败:', e);
        }
      }, 10000);

    }, 1500);
  }

  init().catch(e => {
    console.error('[初始化失败]', e);
  });

})();
