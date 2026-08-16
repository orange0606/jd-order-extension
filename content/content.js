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

      bar.innerHTML = `
        <span class="orange-zcc-risk-icon">${icon}</span>
        <span class="orange-zcc-risk-level">${levelText}</span>
        ${accountHtml}
        ${addressHtml}
        ${similarityHtml}
        ${tagsHtml}
      `;

      // 插入到卡片最后面
      card.appendChild(bar);
    });
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
   * 等待弹窗出现
   */
  function waitForShipDialog(timeout = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const dialog = document.getElementById('fo-layer');
        // fixed 元素的 offsetParent 为 null，用 display 判断可见性
        if (dialog && dialog.style.display !== 'none') {
          resolve(dialog);
        } else if (Date.now() - start > timeout) {
          reject(new Error('等待查单发货弹窗超时'));
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  /**
   * 等待发货完成：每5秒轮询一次
   * 检测 .jbs-batch-express-log-status 的 data-state 和文字
   * data-state 为 warning/success/error 且文字含"完成"时判定结束
   */
  function waitForShipComplete(dialog, timeout = 300000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastProgress = '';
      let hasStarted = false;
      let pollCount = 0;
      const check = () => {
        pollCount++;

        // 容错1：弹窗已被关闭或移除
        if (!document.getElementById('fo-layer') || dialog.style.display === 'none') {
          reject(new Error('查单发货弹窗被关闭，已取消本次执行'));
          return;
        }

        const statusEl = dialog.querySelector('.jbs-batch-express-log-status');
        const state = statusEl ? (statusEl.getAttribute('data-state') || '') : '';
        const statusText = statusEl ? statusEl.textContent.trim() : '';

        // 容错2：状态元素一直找不到（弹窗结构异常）
        if (pollCount > 2 && !statusEl) {
          reject(new Error('未找到执行状态元素，弹窗结构可能已变化'));
          return;
        }

        // 容错3：状态为 error
        if (state === 'error' || statusText.includes('失败') && statusText.includes('异常')) {
          reject(new Error(`执行异常：${statusText || '未知错误'}`));
          return;
        }

        // 进度信息
        const progressEl = dialog.querySelector('.jbs-batch-express-log-progress');
        const progressText = progressEl ? progressEl.textContent.replace(/\s+/g, ' ').trim() : '';

        if (state && state !== 'idle') hasStarted = true;

        // 完成判断：状态文字含"完成"
        if (hasStarted && (statusText.includes('完成') || statusText.includes('完毕'))) {
          resolve(statusText);
          return;
        }

        // 更新面板进度
        const display = statusText ? `${statusText} ${progressText}`.trim() : progressText;
        if (display && display !== lastProgress) {
          lastProgress = display;
          updateShipStatus(`🚚 ${display}`, 'info');
        }

        if (Date.now() - start > timeout) {
          reject(new Error('查单发货执行超时（5分钟），已取消本次执行'));
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
      const existDialog = document.getElementById('fo-layer');
      if (existDialog && existDialog.style.display !== 'none') {
        const closeBtn = existDialog.querySelector('.fo-layer-btnstop');
        if (closeBtn) {
          console.log('[定时发货] 检测到上一次残留弹窗，先关闭');
          closeBtn.click();
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

      // 2. 等待弹窗
      const dialog = await waitForShipDialog();
      console.log('[定时发货] 弹窗已出现');

      // 3. 勾选选项
      // 所有订单出库
      const radioAll = document.getElementById('shipmentstype0');
      if (!radioAll) throw new Error('未找到"所有订单出库"选项，弹窗结构可能已变化');
      if (!radioAll.checked) radioAll.click();

      // 发货失败自动备注（默认已勾，确保勾上）
      const cbRemark = document.getElementById('sendErrorRemarks');
      if (cbRemark && !cbRemark.checked) cbRemark.click();

      // 使用后台上家快递单号发货出库
      const cbSync = document.getElementById('syncBackgroundExpress');
      if (cbSync && !cbSync.checked) cbSync.click();

      // 快速发货(有单号就发货)
      const radioFast = document.getElementById('shippingtype0');
      if (!radioFast) throw new Error('未找到"快速发货"选项，弹窗结构可能已变化');
      if (!radioFast.checked) radioFast.click();

      console.log('[定时发货] 选项已勾选：所有订单出库/失败备注/后台单号/快速发货');

      // 等500ms让选项生效
      await new Promise(r => setTimeout(r, 500));

      // 4. 点击"开始"
      const startBtn = dialog.querySelector('.fo-layer-btnstart');
      if (!startBtn) throw new Error('未找到"开始"按钮');
      startBtn.click();
      console.log('[定时发货] 已点击"开始"，等待执行完成...');
      updateShipStatus('🚚 执行中，请稍候...', 'info');

      // 5. 等待执行完成（内部先等5秒再开始轮询）
      await waitForShipComplete(dialog);
      console.log('%c[定时发货] 发货执行完成', 'color:#67c23a;font-weight:bold;');
      updateShipStatus('✅ 发货完成，5秒后关闭弹窗...', 'success');

      // 6. 等5秒让用户查看结果，再关闭弹窗
      await new Promise(r => setTimeout(r, 5000));
      const closeBtn = dialog.querySelector('.fo-layer-btnstop');
      if (closeBtn) {
        closeBtn.click();
        console.log('[定时发货] 已关闭弹窗');
      }

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      updateShipStatus(`✅ 查单发货完成（${timeStr}）`, 'success');

      // 记录本次执行时间到本地缓存
      chrome.storage.local.get('jd_settings', (result) => {
        const settings = result.jd_settings || {};
        settings.lastShipTime = Date.now();
        chrome.storage.local.set({ 'jd_settings': settings });
      });
    } catch (e) {
      console.error('[定时发货] 执行失败:', e);
      updateShipStatus(`❌ ${e.message}，等待下次执行`, 'error');
      // 失败时不强制关闭弹窗，保留现场让用户查看；仅当弹窗不存在时无需处理
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
   * 递归调度下一次执行
   */
  function scheduleNext() {
    chrome.storage.local.get('jd_settings', (result) => {
      const settings = result.jd_settings || {};
      if (!settings.autoShip) return;

      const minutes = Math.max(1, Math.min(720, settings.autoShipInterval || 30));
      const intervalMs = minutes * 60 * 1000;
      const delay = calcNextDelay(settings.lastShipTime, settings, intervalMs);

      const nextTime = new Date(Date.now() + delay);
      const nextStr = `${String(nextTime.getHours()).padStart(2,'0')}:${String(nextTime.getMinutes()).padStart(2,'0')}`;
      const rangeText = settings.autoShipTimeRange
        ? `，时段 ${settings.autoShipTimeStart}~${settings.autoShipTimeEnd}`
        : '';
      updateShipStatus(`🚚 每${minutes}分钟，下次 ${nextStr}${rangeText}`, 'info');

      autoShipTimer = setTimeout(async () => {
        await runBatchShipOnce();
        scheduleNext();
      }, delay);
    });
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

    chrome.storage.local.get('jd_settings', (result) => {
      const settings = result.jd_settings || {};
      if (!settings.autoShip) {
        console.log('[定时发货] 未开启');
        updateShipStatus('🚚 定时查单发货未开启', 'info');
        return;
      }
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
    });
  }

  // ==================== 同步物流状态（京巴士） ====================

  /**
   * 等待同步物流弹窗出现
   */
  function waitForExpressDialog(timeout = 15000) {
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
          reject(new Error('等待同步物流弹窗超时'));
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  /**
   * 等待发送完成：每10秒检测 .jbs-sync-buy-log-status 的 data-state
   * data-state="success" 表示发送完成
   */
  function waitForExpressComplete(dialog, timeout = 300000, initialWait = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastState = '';
      const check = () => {
        const statusEl = dialog.querySelector('.jbs-sync-buy-log-status');
        const state = statusEl ? (statusEl.getAttribute('data-state') || '') : '';
        const text = statusEl ? statusEl.textContent.trim() : '';

        if (state === 'success' || text.includes('发送完成')) {
          resolve('done');
          return;
        }

        // 更新面板进度
        if (text && text !== lastState) {
          lastState = text;
          updateExpressStatus(`📮 ${text}`, 'info');
        }

        if (Date.now() - start > timeout) {
          reject(new Error('同步物流执行超时（5分钟）'));
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
      const dialogOpen = dialog && dialog.style.display !== 'none';

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
        console.log('[同步物流] 弹窗已打开，直接等待完成...');
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

      // 记录本次执行时间
      chrome.storage.local.get('jd_settings', (result) => {
        const s = result.jd_settings || {};
        s.lastExpressTime = Date.now();
        chrome.storage.local.set({ 'jd_settings': s });
      });
    } catch (e) {
      console.error('[同步物流] 执行失败:', e);
      updateExpressStatus(`❌ 同步物流失败: ${e.message}`, 'error');
      // 失败时不强制关闭弹窗（可能正在发送中），等待下次调度
    } finally {
      isSyncingExpress = false;
    }
  }

  /**
   * 递归调度下一次同步物流
   */
  function scheduleExpressNext() {
    chrome.storage.local.get('jd_settings', (result) => {
      const settings = result.jd_settings || {};
      if (!settings.autoSyncExpress) return;

      const minutes = Math.max(1, Math.min(1440, settings.autoSyncExpressInterval || 120));
      const intervalMs = minutes * 60 * 1000;
      const delay = calcNextDelay(settings.lastExpressTime, settings, intervalMs);

      const nextTime = new Date(Date.now() + delay);
      const nextStr = `${String(nextTime.getHours()).padStart(2,'0')}:${String(nextTime.getMinutes()).padStart(2,'0')}`;
      const rangeText = settings.autoShipTimeRange
        ? `，时段 ${settings.autoShipTimeStart}~${settings.autoShipTimeEnd}`
        : '';
      updateExpressStatus(`📮 每${minutes}分钟，下次 ${nextStr}${rangeText}`, 'info');

      expressTimer = setTimeout(async () => {
        await runSyncExpressOnce();
        scheduleExpressNext();
      }, delay);
    });
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

      case 'SETTINGS_UPDATED':
        // 设置已更新，重新设置定时器
        setupAutoShipTimer();
        if (isExpressPage()) setupExpressTimer();
        break;
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
