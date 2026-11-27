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
    maxRetry: 10,
    // 以下字段统一从 config.js 读取
    version: (typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.version) || '1.0.0',
    apiBaseUrl: (typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.apiBaseUrl) || '',
    riskSearchUrl: (typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.riskSearchUrl) || '',
    extensionDownloadUrl: (typeof ZHICHACHA_CONFIG !== 'undefined' && ZHICHACHA_CONFIG.extensionDownloadUrl) || ''
  };
    // 单个订单卡片

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


  // 店铺名称脱敏：1字原样，2字第二字为*，3字及以上第二三字为*
  function maskShopName(name) {
    if (!name) return "";
    if (name.length === 1) return name;
    if (name.length === 2) return name[0] + "*";
    return name[0] + "**" + name.substring(3);
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
      // 状态直接取当前订单卡片内的 .order-status span（如 <div class="order-status"><span>待出库</span></div>）
      // 优先状态列，列选择器失效时从整张订单卡片兜底，避免 order_status 为空导致已取消订单规则失效
      order.orderStatus = (statusCol && safeText(statusCol, SELECTORS.orderStatus)) ||
        safeText(orderEl, SELECTORS.orderStatus) ||
        safeText(orderEl, '.order-status');
      if (statusCol) {
        order.promiseShipTime = safeText(statusCol, SELECTORS.shipTime);
      }

      // 待付款订单直接跳过，不抓取；已取消订单要采集并传状态（后端仅在已有该订单记录时才覆盖为已取消，首次出现不保存）
      const skipStatus = ['待付款'];
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

    // 建立订单号 -> 风险栏的映射（统一转字符串+trim，防止数字/字符串/空格错配）
    const riskMap = new Map();
    riskBars.forEach(bar => {
      const orderId = String(bar.getAttribute('data-id') || '').trim();
      if (orderId) {
        riskMap.set(orderId, bar);
      }
    });

    // 遍历订单，补充风险数据
    let matchedCount = 0;
    orders.forEach(order => {
      const orderIdKey = String(order.orderId || '').trim();
      const bar = riskMap.get(orderIdKey);
      if (!bar) return; // 订单号不一致，保留订单卡片里的原地址，不用风险栏数据

      try {
        order.hasRiskData = true;
        matchedCount++;

        // 1. 真实完整地址：a[data-type="a"] 的 data-content
        const addressLink = bar.querySelector('a[data-type="a"]');
        if (addressLink) {
          const fullAddr = addressLink.getAttribute('data-content') || '';
          // 只有真实完整地址（非空、不含掩码星号）才替换
          if (fullAddr && fullAddr.indexOf('*') === -1) {
            order.riskFullAddress = fullAddr;
            order.address = fullAddr;
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

  // 小泷巡检通过此入口实时读取当前页店铺，避免自动切换店铺后误用 jd_settings 中的上一店缓存
  window.__zccGetCurrentShopInfo = getShopInfo;

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
        order_time: order.orderTime || '',
        order_status: order.orderStatus || '' // 订单状态原文（如 已取消/待出库/已完成），后端据此决定是否覆盖已取消
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
  async function scrapeCurrentPage(expectedTabId) {
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
    const scrapeTabVersion = __orderTabVersion;
    const scrapePageUrl = window.location.href;
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
      // 直接读取卡片并逐行解析，不再做容器可见性或tab状态过滤
      let orderCards = getCurrentOrderCards();

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
      // 风险栏可能异步渲染，最多等3秒让它出现再匹配
      updateStatus('正在匹配智查查风险数据...', 'info');
      for (let waitRound = 0; waitRound < 6; waitRound++) {
        const bars = document.querySelectorAll('.zgcc-result-bar-row');
        if (bars.length > 0) break;
        await new Promise(r => setTimeout(r, 500));
      }
      enrichOrdersWithRiskData(orders);

      // 5. 转换为后端接口格式
      updateStatus('正在转换数据格式...', 'info');
      const importList = await convertToApiFormat(orders);

      updateStatus(`✅ 成功解析 ${orders.length} 条订单`, 'success');

      // 保存最近抓取的订单
      window.__lastScrapedOrders = orders;

      // 页面风险与关联单展示不再绑定后台新增/覆盖白名单；SYNC_RESULT后按订单状态筛选展示
      // 普通已存在订单不覆盖数据库但仍正常显示；待付款、首次出现的已取消订单不做后续检测

      // 6. 打印转换后的接口数据，方便调试
      // console.log('%c========== 转换完成，准备提交到后端的数据 ==========', 'color: #e1251b; font-weight: bold; font-size: 14px;');
      // console.log('请求体 { list: [...] }:');
      // console.table(importList);
      // console.log('importList:', importList);
      // console.log('%c==================================================', 'color: #e1251b; font-weight: bold;');

      // 不再校验订单状态必须匹配当前tab；每行独立读取订单号和 .order-status span，以卡片真实状态上传
      // 7. 通知后台同步（发送接口格式的数据）
      // 抓取期间用户切换了订单tab：当前结果属于旧列表，直接丢弃，绝不上传覆盖新标签对应的订单状态
      if (scrapeTabVersion !== __orderTabVersion || scrapePageUrl !== window.location.href) {
        updateStatus('已切换订单标签，本次旧列表数据已丢弃，等待同步新列表...', 'warning');
        return { orders: [], importList: [] };
      }
      // console.log('[Content] 正在发送ORDERS_SCraped消息到后台...');
      chrome.runtime.sendMessage({
        type: 'ORDERS_SCraped',
        payload: {
          orders,          // 原始完整数据
          importList,      // 后端接口格式 { list: [...] }
          url: window.location.href,
          timestamp: Date.now(),
          syncId: __taskPageSyncActiveId,
          statusSummary: orders.reduce(function (acc, o) { const s = o.orderStatus || '空状态'; acc[s] = (acc[s] || 0) + 1; return acc; }, {})
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

  // 原“智查查同步助手”浮动面板已彻底移除：
  // 同步当前页/采购巡检/清除风险提示已迁移到定时任务面板顶部图标区，查单发货/同步物流/切换店铺已迁移为定时任务，其余旧按钮废弃
  function createFloatingPanel() { /* 不再创建旧浮动面板，相关状态函数均有空元素保护 */ }

  /**
   * 手动同步按钮
   */
  async function handleManualSync(expectedTabId) {
    const isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) {
      updateStatus('❌ 请先登录智查查', 'error');
      showLoginWarning(true);
      return [];
    }
    const result = await scrapeCurrentPage(expectedTabId);
    return result || [];
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
    // 旧浮动面板已移除：无警告元素时仍须执行店铺绑定校验，仅跳过提示展示

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
      if (shopWarning) shopWarning.style.display = 'none';
      return true;
    } else {
      if (shopWarningText) {
        if (result.shopId) {
          shopWarningText.textContent = `当前店铺ID: ${result.shopId}，请先在后台添加`;
        } else {
          shopWarningText.textContent = '未获取到店铺信息，请确认已登录京东商家后台';
        }
      }
      if (shopWarning) shopWarning.style.display = 'block';
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


  // 状态栏添加「跳转下一个风险订单」按钮（只跳高、中风险）
  let __riskJumpIndex = -1;
  function addJumpRiskButton(total) {
    const statusEl = document.getElementById('scraper-status');
    if (!statusEl) return;
    const oldBtn = document.getElementById('jump-risk-btn');
    if (oldBtn) oldBtn.remove();

    // 固定风险卡片列表和总数，避免懒加载/虚拟滚动导致数量变化
    const cards = Array.from(document.querySelectorAll('[data-orange-jbs-order-id].orange-zcc-risk-high, [data-orange-jbs-order-id].orange-zcc-risk-medium'));
    const cardTotal = cards.length;
    let jumpIndex = -1;
    if (cardTotal === 0) return;

    const btn = document.createElement('button');
    btn.id = 'jump-risk-btn';
    btn.className = 'orange-zcc-jump-risk-btn';
    btn.textContent = `⬇ 下一个风险 (0/${cardTotal})`;
    btn.title = '点击滚动到下一个高/中风险订单';

    btn.addEventListener('click', () => {
      jumpIndex++;
      if (jumpIndex >= cardTotal) jumpIndex = 0;
      const target = cards[jumpIndex];
      const cur = jumpIndex + 1;
      const label = cur >= cardTotal ? '回到第一个' : '下一个风险';
      btn.textContent = `⬇ ${label} (${cur}/${cardTotal})`;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 1000);
      setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 1500);
      target.classList.add('orange-zcc-jump-flash');
      setTimeout(() => target.classList.remove('orange-zcc-jump-flash'), 1800);
    });

    statusEl.appendChild(btn);
  }

  // ==================== 已取消订单 · 采购关联单检测与定位 ====================
  let __assocRunTimer = null;
  let __assocStepTimers = [];

  function isCanceledTab() {
    return window.location.href.indexOf("tabType=canceled") !== -1;
  }

  // 登录态闸门：未登录或账号被停用（SW 校验后会清除 token）时，所有自动化功能一律不执行
  async function zccHasToken() {
    try {
      const r = await chrome.storage.local.get('zhichacha_token');
      return !!(r && r.zhichacha_token);
    } catch (e) { return false; }
  }

  // 开关默认开启
  function getCanceledAssocEnabled() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(["jd_settings", "zhichacha_token"], function (st) {
          const cfg = (st && st.jd_settings) || {};
          resolve(cfg.canceledAssocCheck !== false && !!(st && st.zhichacha_token));
        });
      } catch (e) { resolve(false); }
    });
  }

  // 离开已取消页：清定时器并移除全部关联单UI
  function removeAssocUI() {
    clearTimeout(__assocRunTimer);
    __assocRunTimer = null;
    __assocStepTimers.forEach(clearTimeout);
    __assocStepTimers = [];
    const b = document.getElementById("jump-assoc-btn"); if (b) b.remove();
    const a = document.getElementById("zcc-assoc-panel"); if (a) a.remove();
    window.__zccGotoNextAssoc = null;
  }

  function scrollToAssoc(el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("orange-zcc-assoc-flash");
    setTimeout(function () { el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 1000);
    setTimeout(function () { el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 1500);
    setTimeout(function () { el.classList.remove("orange-zcc-assoc-flash"); }, 2200);
  }

  const zccSleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // 找页面主滚动容器（订单内容可能在容器内滚动而非整页）
  function findAssocScrollContainer() {
    let best = null, bestH = 0;
    document.querySelectorAll("div").forEach(function (d) {
      const cs = getComputedStyle(d);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && d.clientHeight > 300 && (d.scrollHeight - d.clientHeight) > 300) {
        if (d.scrollHeight > bestH) { bestH = d.scrollHeight; best = d; }
      }
    });
    return best;
  }

  // 状态栏“定位关联单”按钮（计数 + 多次滚动校正），定位当前页
  function renderAssocJumpButton(orders) {
    const oldBtn = document.getElementById("jump-assoc-btn");
    if (oldBtn) oldBtn.remove();
    if (!orders.length) { window.__zccGotoNextAssoc = null; return; }
    let idx = -1;
    // 逐个定位逻辑独立于状态栏：弹窗“立即定位”直接调用此函数，旧状态栏移除后依然可用
    function gotoNext() {
      idx++;
      if (idx >= orders.length) idx = 0;
      locateCanceledOrder(orders[idx].oid);
      return idx;
    }
    window.__zccGotoNextAssoc = gotoNext;
    const statusEl = document.getElementById("scraper-status");
    if (!statusEl) return; // 旧状态栏已移除时不再渲染按钮，但定位功能仍可用
    const btn = document.createElement("button");
    btn.id = "jump-assoc-btn";
    btn.className = "orange-zcc-jump-risk-btn orange-zcc-jump-assoc-btn";
    btn.title = "已取消订单仍有采购关联单，点击逐个定位，请及时取消采购单避免货损";
    btn.textContent = "⚠️ 定位关联单 (0/" + orders.length + ")";
    btn.addEventListener("click", function () {
      const i = gotoNext();
      btn.textContent = "⚠️ 下一个关联单 (" + (i + 1) + "/" + orders.length + ")";
    });
    statusEl.appendChild(btn);
  }

  // 收集本页全部已取消订单（卡片 + 订单号 + 备注），不再依赖滚动识别
  function collectCanceledOrders() {
    const list = [];
    document.querySelectorAll(SELECTORS.orderCard).forEach(function (card) {
      const el = card.querySelector(SELECTORS.orderId);
      const oid = el ? el.textContent.trim() : '';
      if (!/^\d{6,}$/.test(oid)) return;
      const remarkEl = card.querySelector(SELECTORS.remark);
      const remark = remarkEl ? remarkEl.textContent.trim() : '';
      // 备注含“备”= 雀手中转仓订单（无采购关联单，也需提醒处理）
      list.push({ oid: oid, card: card, remark: remark, que: remark.indexOf('备') !== -1 });
    });
    return list;
  }

  // 定位到对应订单卡片并高亮闪烁
  function locateCanceledOrder(oid) {
    let card = document.querySelector('[data-orange-jbs-order-id="' + oid + '"]');
    if (!card) {
      document.querySelectorAll(SELECTORS.orderCard).forEach(function (c) {
        const el = c.querySelector(SELECTORS.orderId);
        if (el && el.textContent.trim() === oid) card = c;
      });
    }
    if (!card) card = document.querySelector('.j_buyMsg[data-orderid="' + oid + '"]');
    if (card) scrollToAssoc(card);
  }

  // 右上角折叠面板：结果区 + 最近检测记录；点标题折叠/展开
  let __assocPanelCollapsed = false;
  function ensureAssocPanel() {
    let p = document.getElementById('zcc-assoc-panel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'zcc-assoc-panel';
    p.innerHTML =
      '<div class="zcc-ap-header" id="zcc-ap-header">⚠️ 已取消关联单检测<span class="zcc-ap-toggle" id="zcc-ap-toggle">折叠 ▲</span></div>' +
      '<div class="zcc-ap-body" id="zcc-ap-body"><div id="zcc-ap-result"></div>' +
      '<div class="zcc-ap-log" id="zcc-ap-log" style="display:none;"></div></div>';
    document.body.appendChild(p);
    p.querySelector('#zcc-ap-header').addEventListener('click', function () {
      __assocPanelCollapsed = !__assocPanelCollapsed;
      p.querySelector('#zcc-ap-body').style.display = __assocPanelCollapsed ? 'none' : 'block';
      p.querySelector('#zcc-ap-toggle').textContent = __assocPanelCollapsed ? '展开 ▼' : '折叠 ▲';
    });
    return p;
  }

  // 最近检测记录：最新在最上，只留最近8条
  function assocLog(text) {
    const p = ensureAssocPanel();
    const log = p.querySelector('#zcc-ap-log');
    log.style.display = 'block';
    const line = document.createElement('div');
    line.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] ' + text;
    log.insertBefore(line, log.firstChild);
    while (log.children.length > 8) log.removeChild(log.lastChild);
  }

  function setAssocCard(inner, cls) {
    const p = ensureAssocPanel();
    const box = p.querySelector('#zcc-ap-result');
    box.innerHTML = '<div class="zcc-assoc-card ' + (cls || "") + '">' + inner + '</div>';
    return box;
  }

  function showAssocChecking(done, total, found) {
    setAssocCard(
      '<div class="zcc-assoc-title is-checking">🔍 正在检测已取消京巴士关联单...</div>' +
      '<div class="zcc-assoc-msg">本页共 <b>' + total + '</b> 个已取消订单，接口直查进度 <b>' + done + '</b>/<b>' + total + '</b>，已发现 <b>' + found + '</b> 个仍关联订单。</div>',
      "is-checking");
  }

  function showAssocResult(orders, queOrders) {
    queOrders = queOrders || [];
    const total = orders.reduce(function (s, o) { return s + o.count; }, 0);
    const rowsHtml = orders.map(function (o) {
      return '<div class="zcc-assoc-order-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px dashed #f0f0f0;">' +
        '<span style="font-family:monospace;">' + o.oid + ' <b style="color:#f56c6c;">(' + o.count + '个关联单)</b></span>' +
        '<button type="button" class="zcc-assoc-btn zcc-assoc-locate-one" data-oid="' + o.oid + '">定位</button></div>';
    }).join('');
    // 雀手中转仓订单（备注含“备”）：无关联单也单独列出提醒
    const queHtml = queOrders.length
      ? '<div class="zcc-assoc-msg" style="margin:6px 0 4px;">另有 <b>' + queOrders.length + '</b> 个雀手中转仓订单（备注含“备”），无关联单也需及时处理：</div>' +
        queOrders.map(function (o) {
          return '<div class="zcc-assoc-order-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px dashed #f0f0f0;">' +
            '<span style="font-family:monospace;">' + o.oid + ' <b style="color:#e6a23c;">(雀手中转仓)</b></span>' +
            '<button type="button" class="zcc-assoc-btn zcc-assoc-locate-one" data-oid="' + o.oid + '">定位</button></div>';
        }).join('')
      : '';
    const el = setAssocCard(
      '<div class="zcc-assoc-title">' + (orders.length ? '⚠️ 检查完成：发现未处理采购关联单' : '⚠️ 检查完成：发现雀手中转仓订单') + '</div>' +
      '<div class="zcc-assoc-msg">' + (orders.length
        ? '本页检测到 <b>' + total + '</b> 个采购关联单（涉及 <b>' + orders.length + '</b> 个已取消订单）。<br>请及时到采购平台取消对应采购单，避免继续发货造成货物损失。'
        : '本页未发现采购关联单，但有雀手中转仓订单需要处理。') + '</div>' +
      '<div style="max-height:180px;overflow:auto;margin:6px 0;">' + rowsHtml + queHtml + '</div>' +
      '<div class="zcc-assoc-btns">' +
      '  <button type="button" class="zcc-assoc-btn" id="zcc-assoc-redetect">🔄 重新检测</button>' +
      '  <button type="button" class="zcc-assoc-btn primary" id="zcc-assoc-locate">立即定位</button>' +
      '  <button type="button" class="zcc-assoc-btn" id="zcc-assoc-close">我知道了</button>' +
      '</div>', "");
    el.querySelector("#zcc-assoc-redetect").addEventListener("click", rerunCanceledAssocCheck);
    el.querySelector("#zcc-assoc-locate").addEventListener("click", function () {
      if (typeof window.__zccGotoNextAssoc === "function") window.__zccGotoNextAssoc();
    });
    el.querySelector("#zcc-assoc-close").addEventListener("click", function () { el.innerHTML = ''; }); // 清空结果区，保留折叠面板与记录
    // 逐个定位：点击跳转对应订单卡片
    el.querySelectorAll(".zcc-assoc-locate-one").forEach(function (btn) {
      btn.addEventListener("click", function () { locateCanceledOrder(btn.getAttribute("data-oid")); });
    });
  }

  function showAssocEmpty() {
    const el = setAssocCard(
      '<div class="zcc-assoc-title is-ok">✅ 检查完成</div>' +
      '<div class="zcc-assoc-msg">已通过接口核查本页全部已取消订单，未发现仍关联的采购关联单及雀手中转仓订单（备注含“备”）。</div>' +
      '<div class="zcc-assoc-btns">' +
      '  <button type="button" class="zcc-assoc-btn primary" id="zcc-assoc-redetect">🔄 重新检测</button>' +
      '  <button type="button" class="zcc-assoc-btn" id="zcc-assoc-close">我知道了</button>' +
      '</div>',
      "is-ok");
    el.querySelector("#zcc-assoc-redetect").addEventListener("click", rerunCanceledAssocCheck);
    el.querySelector("#zcc-assoc-close").addEventListener("click", function () { el.innerHTML = ''; }); // 清空结果区，保留折叠面板与记录
  }

  function showAssocError(msg) {
    const el = setAssocCard(
      '<div class="zcc-assoc-title">⚠️ 检测失败</div>' +
      '<div class="zcc-assoc-msg">' + (msg || '关联单接口查询失败') + '</div>' +
      '<div class="zcc-assoc-btns">' +
      '  <button type="button" class="zcc-assoc-btn primary" id="zcc-assoc-redetect">🔄 重新检测</button>' +
      '  <button type="button" class="zcc-assoc-btn" id="zcc-assoc-close">我知道了</button>' +
      '</div>', "");
    el.querySelector("#zcc-assoc-redetect").addEventListener("click", rerunCanceledAssocCheck);
    el.querySelector("#zcc-assoc-close").addEventListener("click", function () { el.innerHTML = ''; }); // 清空结果区，保留折叠面板与记录
  }

  // 京巴士未登录专用提示：未登录查不到关联单，必须引导登录而不是显示“无关联”
  function showAssocNotLogin() {
    const el = setAssocCard(
      '<div class="zcc-assoc-title">🔑 京巴士未登录</div>' +
      '<div class="zcc-assoc-msg">未登录京巴士时无法查询采购关联单，检测结果不可信。请先登录京巴士后再重新检测。</div>' +
      '<div class="zcc-assoc-btns">' +
      '  <button type="button" class="zcc-assoc-btn primary" id="zcc-assoc-go-login">去登录京巴士</button>' +
      '  <button type="button" class="zcc-assoc-btn" id="zcc-assoc-redetect">🔄 重新检测</button>' +
      '  <button type="button" class="zcc-assoc-btn" id="zcc-assoc-close">我知道了</button>' +
      '</div>', "");
    el.querySelector("#zcc-assoc-go-login").addEventListener("click", function () {
      window.open('https://pay.jingbashi.com/back.php/index/login?url=%2Fback.php', '_blank', 'noopener');
    });
    el.querySelector("#zcc-assoc-redetect").addEventListener("click", rerunCanceledAssocCheck);
    el.querySelector("#zcc-assoc-close").addEventListener("click", function () { el.innerHTML = ''; }); // 清空结果区，保留折叠面板与记录
  }

  // 检测当前页：直接取本页全部订单号，分批走跟单接口直查关联单（不再滚动识别），汇总后支持逐个定位
  async function runCanceledAssocCheck() {
    const enabled = await getCanceledAssocEnabled();
    if (!enabled) { console.log("[已取消关联单] 开关已关闭，不检测"); return; }
    if (!isCanceledTab()) return;

    const orders = collectCanceledOrders();
    if (!orders.length) { showAssocEmpty(); assocLog('本页未读取到已取消订单'); return; }
    assocLog('开始检测：本页 ' + orders.length + ' 个已取消订单（备注含“备” ' + orders.filter(function (o) { return o.que; }).length + ' 个）');

    const foundMap = new Map(); // oid -> 关联单个数
    const BATCH = 50; // 每批50个订单号，跟单接口 in 精确匹配
    showAssocChecking(0, orders.length, 0);

    for (let i = 0; i < orders.length; i += BATCH) {
      if (!isCanceledTab()) return; // 中途切走标签则中止
      const batch = orders.slice(i, i + BATCH).map(function (o) { return o.oid; });
      const resp = await new Promise(function (resolve) {
        try { chrome.runtime.sendMessage({ type: 'ZCC_AFS_BIND_QUERY', orderIds: batch }, resolve); }
        catch (e) { resolve(null); }
      });
      if (resp && resp.notLogin) { assocLog('京巴士未登录，无法检测'); showAssocNotLogin(); return; }
      if (!resp || !resp.ok) { assocLog('检测失败：' + ((resp && resp.error) || '接口异常')); showAssocError((resp && resp.error) || '关联单接口查询失败，请稍后重试'); return; }
      const rows = (resp.data && resp.data.rows) || [];
      rows.forEach(function (row) {
        const oid = String(row.order_id || '').trim();
        if (!oid) return;
        // 主行 + extra.buy 附加采购单都计入关联单个数
        const extra = row.extra && Array.isArray(row.extra.buy) ? row.extra.buy.length : 0;
        foundMap.set(oid, (foundMap.get(oid) || 0) + 1 + extra);
      });
      showAssocChecking(Math.min(i + BATCH, orders.length), orders.length, foundMap.size);
    }
    if (!isCanceledTab()) return;

    const found = orders.filter(function (o) { return foundMap.has(o.oid); })
      .map(function (o) { return { oid: o.oid, count: foundMap.get(o.oid) }; });
    // 雀手中转仓订单（备注含“备”）：与关联单去重后单独统计
    const que = orders.filter(function (o) { return o.que && !foundMap.has(o.oid); })
      .map(function (o) { return { oid: o.oid }; });
    if (found.length || que.length) {
      renderAssocJumpButton(found.concat(que)); // 逐个定位覆盖关联单 + 雀手订单
      showAssocResult(found, que);
      assocLog('发现 ' + found.length + ' 个仍关联订单（共 ' + found.reduce(function (s, o) { return s + o.count; }, 0) + ' 个关联单）' +
        (que.length ? '，另有 ' + que.length + ' 个雀手中转仓订单' : ''));
      console.log("[已取消关联单] 接口核查完成：发现 " + found.length + " 个仍关联订单，共 " + found.reduce(function (s, o) { return s + o.count; }, 0) + " 个关联单；雀手中转仓订单 " + que.length + " 个");
    } else {
      showAssocEmpty();
      assocLog('核查 ' + orders.length + ' 单，未发现关联单及雀手中转仓订单');
      console.log("[已取消关联单] 接口核查完成：本页 " + orders.length + " 个订单均未发现关联单");
    }
  }

  // 弹窗“重新检测”：清掉旧结果后立即接口重查当前页（翻页后使用，无需再等5秒）
  // 注意：runCanceledAssocCheck 每次都会重新 collectCanceledOrders()，
  // 即重新读取当前页订单号和订单备注（含“备”字雀手订单），不使用任何缓存。
  function rerunCanceledAssocCheck() {
    const b = document.getElementById("jump-assoc-btn"); if (b) b.remove();
    const a = document.getElementById("zcc-assoc-panel"); if (a) a.remove();
    window.__zccGotoNextAssoc = null;
    runCanceledAssocCheck();
  }

  // 点“已取消”或直接进入已取消页：5秒、10秒各直查一遍，兼容慢渲染、提升容错
  function scheduleCanceledAssocCheck() {
    clearTimeout(__assocRunTimer);
    __assocStepTimers.forEach(clearTimeout);
    __assocStepTimers = [];
    ["jump-assoc-btn", "zcc-assoc-panel"].forEach(function (id) { const e = document.getElementById(id); if (e) e.remove(); });
    window.__zccGotoNextAssoc = null;
    __assocRunTimer = setTimeout(runCanceledAssocCheck, 5000);
    // 10秒后补查第二次：订单渲染慢时首轮可能取不全，第二轮覆盖更新结果
    __assocStepTimers.push(setTimeout(function () {
      if (isCanceledTab()) runCanceledAssocCheck();
    }, 10000));
  }

  // ==================== 待出库 · 48小时内未采购订单检测 ====================
  // 找出下单48小时内、但还没有关联采购单的待出库订单，提醒及时采购发货
  let __unboughtRunTimer = null;
  let __unboughtStepTimers = [];
  const UNBOUGHT_HOURS = 48;

  function isWaitOutTab() {
    return window.location.href.indexOf("tabType=waitOut") !== -1;
  }

  // 解析订单行里的下单/付款时间："2026-10-29 16:39:47 下单，2026-10-29 16:39:53 付款"
  function parseOrderTime(card) {
    const box = card.querySelector(".order-time-info");
    if (!box) return null;
    const txt = box.textContent;
    const parseOne = function (str) {
      const d = new Date(str.replace(/-/g, "/"));
      return isNaN(d.getTime()) ? null : d.getTime();
    };
    const orderM = txt.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*下单/);
    const payM = txt.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*付款/);
    const orderTime = orderM ? parseOne(orderM[1]) : null;
    const payTime = payM ? parseOne(payM[1]) : orderTime;
    if (!orderTime && !payTime) return null;
    return { orderTime: orderTime, payTime: payTime };
  }

  // 收集当前页全部待出库订单（与已取消检测同一套订单号采集，不再滚动/视口限制），带距付款小时数；是否已采购由接口判定
  function collectWaitOutOrders() {
    const now = Date.now();
    const out = [];
    collectCanceledOrders().forEach(function (o) {
      const times = parseOrderTime(o.card);
      if (!times) return;
      const refTime = times.payTime || times.orderTime;
      out.push({ oid: o.oid, card: o.card, hours: (now - refTime) / 3600000, bought: false, payTime: refTime });
    });
    return out;
  }

  function removeUnboughtUI() {
    clearTimeout(__unboughtRunTimer);
    __unboughtRunTimer = null;
    __unboughtStepTimers.forEach(clearTimeout);
    __unboughtStepTimers = [];
    const b = document.getElementById("jump-unbought-btn"); if (b) b.remove();
    const a = document.getElementById("zcc-unbought-alert"); if (a) a.remove();
  }

  function setUnboughtCard(inner, cls) {
    let el = document.getElementById("zcc-unbought-alert");
    if (!el) { el = document.createElement("div"); el.id = "zcc-unbought-alert"; document.body.appendChild(el); }
    el.innerHTML = '<div class="zcc-assoc-card ' + (cls || "") + '">' + inner + '</div>';
    makeUnboughtDraggable(el);
    return el;
  }

  // 让未采购检测弹窗可拖动：按住卡片空白处拖动
  function makeUnboughtDraggable(el) {
    if (el.__zccDragBound) return;
    el.__zccDragBound = true;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
    el.addEventListener("mousedown", function (e) {
      // 点在按钮/链接/输入框/列表/折叠内容上不触发拖动
      if (e.target.closest("button, a, input, textarea, .zcc-ub-list, .zcc-ub-fold-body")) return;
      const card = el.querySelector(".zcc-assoc-card");
      if (card) card.style.cursor = "move";
      dragging = true;
      const rect = el.getBoundingClientRect();
      el.style.left = rect.left + "px";
      el.style.top = rect.top + "px";
      el.style.right = "auto"; // 初始右上角定位，拖动开始改为left坐标，避免left/right同时存在拉伸
      el.style.transform = "none";
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      el.style.left = (startLeft + e.clientX - startX) + "px";
      el.style.top = (startTop + e.clientY - startY) + "px";
    });
    document.addEventListener("mouseup", function () { dragging = false; });
  }

  function renderUnboughtJumpBtn(list) {
    const statusEl = document.getElementById("scraper-status");
    const oldBtn = document.getElementById("jump-unbought-btn");
    if (oldBtn) oldBtn.remove();
    if (!statusEl || !list.length) return;
    let idx = -1;
    const btn = document.createElement("button");
    btn.id = "jump-unbought-btn";
    btn.className = "orange-zcc-jump-risk-btn orange-zcc-jump-assoc-btn";
    btn.title = "下单48小时内但还没关联采购单，请及时采购发货";
    btn.textContent = "⏰ 定位未采购单 (0/" + list.length + ")";
    btn.addEventListener("click", function () {
      idx++;
      if (idx >= list.length) idx = 0;
      btn.textContent = "⏰ 下一个未采购单 (" + (idx + 1) + "/" + list.length + ")";
      scrollToAssoc(list[idx].card);
    });
    statusEl.appendChild(btn);
    window.__zccGotoNextUnbought = function () { btn.click(); };
  }

  // 提示卡片（未登录/失败/无订单通用）：带重新检测、关闭，可选去登录京巴士
  function showUnboughtNotice(title, msg, cls, showLogin) {
    const el = setUnboughtCard(
      '<div class="zcc-assoc-title ' + (cls || '') + '">' + title + '</div>' +
      '<div class="zcc-assoc-msg">' + msg + '</div>' +
      '<div class="zcc-assoc-btns">' +
      (showLogin ? '<button type="button" class="zcc-assoc-btn primary" id="zcc-unbought-login">去登录京巴士</button>' : '') +
      '<button type="button" class="zcc-assoc-btn" id="zcc-unbought-redetect2">🔄 重新检测</button>' +
      '<button type="button" class="zcc-assoc-btn" id="zcc-unbought-close2">关闭</button></div>', cls || '');
    if (showLogin) el.querySelector('#zcc-unbought-login').addEventListener('click', function () {
      window.open('https://pay.jingbashi.com/back.php/index/login?url=%2Fback.php', '_blank', 'noopener');
    });
    el.querySelector('#zcc-unbought-redetect2').addEventListener('click', rerunUnboughtCheck);
    el.querySelector('#zcc-unbought-close2').addEventListener('click', function () { el.remove(); });
  }

  let __unboughtRunning = false;
  async function runUnboughtCheck() {
    if (__unboughtRunning) { console.log("[采购巡检] 正在执行中，忽略重复触发"); return; }
    __unboughtRunning = true;
    try {
    if (!(await zccHasToken())) {
      setUnboughtCard(
        '<div class="zcc-assoc-title">⚠️ 请先登录</div>' +
        '<div class="zcc-assoc-msg">采购巡检需要先登录智查查账号，请登录后再使用。</div>' +
        '<div class="zcc-assoc-btns"><button type="button" class="zcc-assoc-btn primary" id="zcc-unbought-close">知道了</button></div>', "");
      const el = document.getElementById("zcc-unbought-alert");
      if (el) el.querySelector("#zcc-unbought-close").addEventListener("click", function () { el.remove(); });
      return;
    }
    if (!isWaitOutTab()) return;
    removeUnboughtUI(); // 每次检测前先清掉上一次结果，不保留数量

    // 直接取本页全部订单号 + 付款时间，分批走跟单接口直查采购关联单（不再滚动识别）
    const map = new Map(); // oid -> {oid,card,hours,bought,payTime}
    collectWaitOutOrders().forEach(function (item) { map.set(item.oid, item); });
    if (!map.size) { showUnboughtNotice('✅ 提示', '本页未读取到待出库订单，请稍后重新检测。', 'is-ok', false); return; }

    const ids = Array.from(map.keys());
    const BATCH = 50;
    let boughtN = 0;
    setUnboughtCard(
      '<div class="zcc-assoc-title is-checking">🔍 正在检测48小时内未采购订单...</div>' +
      '<div class="zcc-assoc-msg">本页共 <b>' + ids.length + '</b> 个待出库订单，接口直查进度 <b>0</b>/<b>' + ids.length + '</b>。</div>',
      "is-checking");

    for (let i = 0; i < ids.length; i += BATCH) {
      if (!isWaitOutTab()) return; // 中途切走标签则中止
      const batch = ids.slice(i, i + BATCH);
      const resp = await new Promise(function (resolve) {
        try { chrome.runtime.sendMessage({ type: 'ZCC_AFS_BIND_QUERY', orderIds: batch }, resolve); }
        catch (e) { resolve(null); }
      });
      if (resp && resp.notLogin) { showUnboughtNotice('🔑 京巴士登录状态已失效', '智查查插件已登录，但京巴士接口仍返回未登录。采购巡检使用的是京巴士登录状态（与插件账号不是同一套），请在京巴士页面重新登录后再检测。', '', true); return; }
      if (!resp || !resp.ok) { showUnboughtNotice('⚠️ 检测失败', (resp && resp.error) || '关联单接口查询失败，请稍后重试。', '', false); return; }
      const rows = (resp.data && resp.data.rows) || [];
      rows.forEach(function (row) {
        const oid = String(row.order_id || '').trim();
        // 主行或 extra.buy 有任意附加采购单都算已采购
        if (map.has(oid) && !map.get(oid).bought) { map.get(oid).bought = true; boughtN++; }
      });
      setUnboughtCard(
        '<div class="zcc-assoc-title is-checking">🔍 正在检测48小时内未采购订单...</div>' +
        '<div class="zcc-assoc-msg">本页共 <b>' + ids.length + '</b> 个待出库订单，接口直查进度 <b>' + Math.min(i + BATCH, ids.length) + '</b>/<b>' + ids.length + '</b>，已确认采购 <b style="color:#67c23a">' + boughtN + '</b>。</div>',
        "is-checking");
    }
    if (!isWaitOutTab()) return;

    // 分组排序：超时未采购(48-120h) → 预警未采购(24-48h) → 24h内未采购 → 已采购>24h
    function groupRank(x) {
      if (!x.bought && x.hours > 48 && x.hours <= 120) return 0; // 超时（紧急）
      if (!x.bought && x.hours > 24 && x.hours <= 48) return 1; // 预警
      if (!x.bought && x.hours <= 24) return 2;                   // 24h内未采购
      if (x.bought && x.hours > 24) return 3;                     // 已采购>24h
      if (x.bought && x.hours <= 24) return 4;                    // 已采购<=24h（折叠）
      if (!x.bought && x.hours > 120) return 5;                  // 超久未采购>120h（无货不发，折叠，最不紧急）
      return 6;
    }
    const list = Array.from(map.values()).sort(function (a, b) {
      const ga = groupRank(a), gb = groupRank(b);
      if (ga !== gb) return ga - gb;
      return (b.payTime || 0) - (a.payTime || 0); // 同组内最新下单在前
    });
    const total = list.length;
    const boughtCount = list.filter(function (x) { return x.bought; }).length;
    const unboughtCount = total - boughtCount;
    const warnCount = list.filter(function (x) { return !x.bought && x.hours > 24 && x.hours <= 48; }).length;
    const overdueCount = list.filter(function (x) { return !x.bought && x.hours > 48; }).length;

    // 供状态栏定位按钮使用：只定位未采购订单
    const unboughtList = list.filter(function (x) { return !x.bought; });
    renderUnboughtJumpBtn(unboughtList);

    function hoursColor(h) { return h > 48 ? "red" : (h > 24 ? "yellow" : "green"); }

    function rowHtml(item) {
      const c = hoursColor(item.hours);
      const statusText = item.bought ? "已采购" : "未采购";
      const statusCls = item.bought ? "zcc-ub-st-bought" : "zcc-ub-st-unbought";
      return '<div class="zcc-ub-row">' +
        '  <span class="zcc-ub-dot zcc-ub-dot-' + c + '"></span>' +
        '  <a href="javascript:;" class="zcc-ub-oid" data-oid="' + item.oid + '">' + item.oid + '</a>' +
        '  <span class="zcc-ub-hours">已付款 ' + item.hours.toFixed(1) + ' 小时</span>' +
        '  <span class="zcc-ub-st ' + statusCls + '">' + statusText + '</span>' +
        '</div>';
    }

    let rowsHtml = "";
    // 非折叠分组（0-3）直接显示
    list.forEach(function (item) { if (groupRank(item) <= 3) rowsHtml += rowHtml(item); });
    // rank 4：已采购<=24h 折叠
    const foldedBought = list.filter(function (x) { return groupRank(x) === 4; });
    if (foldedBought.length) {
      let h = "";
      foldedBought.forEach(function (item) { h += rowHtml(item); });
      rowsHtml += '<div class="zcc-ub-fold-toggle zcc-ub-fold-warn" id="zcc-ub-fold-bought">📦 已采购24h内订单（' + foldedBought.length + '），点击展开</div>';
      rowsHtml += '<div class="zcc-ub-fold-body" id="zcc-ub-fold-bought-body" style="display:none;">' + h + '</div>';
    }
    // rank 5：超久未采购>120h（无货不发）折叠，放最后
    const foldedOld = list.filter(function (x) { return groupRank(x) === 5; });
    if (foldedOld.length) {
      let h2 = "";
      foldedOld.forEach(function (item) { h2 += rowHtml(item); });
      rowsHtml += '<div class="zcc-ub-fold-toggle zcc-ub-fold-old" id="zcc-ub-fold-old">🗄️ 超久未采购订单（>120h，多为无货不发，' + foldedOld.length + '），点击展开</div>';
      rowsHtml += '<div class="zcc-ub-fold-body" id="zcc-ub-fold-old-body" style="display:none;">' + h2 + '</div>';
    }

    const el = setUnboughtCard(
      '<div class="zcc-assoc-title">⏰ 待出库订单采购情况一览</div>' +
      '<div class="zcc-ub-summary">' +
      '  <span>总计 <b>' + total + '</b></span>' +
      '  <span>已采购 <b style="color:#67c23a">' + boughtCount + '</b></span>' +
      '  <span>未采购 <b style="color:#f56c6c">' + unboughtCount + '</b></span>' +
      '  <span>发货预警(<b style="color:#e6a23c">&gt;24h</b>) <b>' + warnCount + '</b></span>' +
      '  <span>超时(<b style="color:#f56c6c">&gt;48h</b>) <b>' + overdueCount + '</b></span>' +
      '</div>' +
      '<div class="zcc-ub-list">' + rowsHtml + '</div>' +
      '<div class="zcc-assoc-btns">' +
      '  <button type="button" class="zcc-assoc-btn" id="zcc-unbought-redetect">🔄 重新检测</button>' +
      '  <button type="button" class="zcc-assoc-btn" id="zcc-unbought-close">关闭</button>' +
      '</div>', "");

    // 点击订单号定位
    el.querySelectorAll(".zcc-ub-oid").forEach(function (aEl) {
      aEl.addEventListener("click", function () {
        const oid = aEl.getAttribute("data-oid");
        const card = document.querySelector('[data-orange-jbs-order-id="' + oid + '"]');
        if (card && typeof scrollToAssoc === "function") scrollToAssoc(card);
      });
    });
    // 折叠/展开：所有折叠按钮通用
    el.querySelectorAll(".zcc-ub-fold-toggle").forEach(function (fb) {
      fb.addEventListener("click", function () {
        const targetId = fb.id + "-body";
        const body = el.querySelector("#" + targetId);
        if (body) body.style.display = body.style.display === "none" ? "block" : "none";
      });
    });
    el.querySelector("#zcc-unbought-redetect").addEventListener("click", rerunUnboughtCheck);
    el.querySelector("#zcc-unbought-close").addEventListener("click", function () { el.remove(); });
    console.log("[未采购检测] 总计 " + total + "，已采购 " + boughtCount + "，未采购 " + unboughtCount + "，预警 " + warnCount + "，超时 " + overdueCount);
    } finally { __unboughtRunning = false; }
  }

  // 小泷桌宠专用静默采购统计：仅在待出库Tab查询，不创建采购巡检弹窗或定位按钮
  async function collectDesktopPetPurchaseStats() {
    if (!isWaitOutTab()) return { skipped: true };
    if (__unboughtRunning) return { skipped: true, busy: true };
    __unboughtRunning = true;
    try {
      const map = new Map();
      collectWaitOutOrders().forEach(function (item) { map.set(item.oid, item); });
      const ids = Array.from(map.keys());
      for (let i = 0; i < ids.length; i += 50) {
        if (!isWaitOutTab()) return { skipped: true };
        const resp = await new Promise(function (resolve) {
          try { chrome.runtime.sendMessage({ type: 'ZCC_AFS_BIND_QUERY', orderIds: ids.slice(i, i + 50) }, resolve); }
          catch (e) { resolve(null); }
        });
        if (resp && resp.notLogin) throw new Error('京巴士未登录，采购数据暂未刷新');
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || '采购关联接口查询失败');
        const rows = (resp.data && resp.data.rows) || [];
        rows.forEach(function (row) {
          const oid = String(row.order_id || '').trim();
          if (map.has(oid)) map.get(oid).bought = true;
        });
      }
      const list = Array.from(map.values());
      const bought = list.filter(function (x) { return x.bought; }).length;
      return {
        total: list.length,
        bought: bought,
        unbought: list.length - bought,
        warn: list.filter(function (x) { return !x.bought && x.hours > 24 && x.hours <= 48; }).length,
        overdue: list.filter(function (x) { return !x.bought && x.hours > 48; }).length
      };
    } finally { __unboughtRunning = false; }
  }
  window.__zccCollectPetPurchaseStats = collectDesktopPetPurchaseStats;

  function rerunUnboughtCheck() {
    const b = document.getElementById("jump-unbought-btn"); if (b) b.remove();
    const a = document.getElementById("zcc-unbought-alert"); if (a) a.remove();
    window.__zccGotoNextUnbought = null;
    runUnboughtCheck();
  }

  function scheduleUnboughtCheck() {
    clearTimeout(__unboughtRunTimer);
    __unboughtStepTimers.forEach(clearTimeout);
    __unboughtStepTimers = [];
    ["jump-unbought-btn", "zcc-unbought-alert"].forEach(function (id) { const e = document.getElementById(id); if (e) e.remove(); });
    window.__zccGotoNextUnbought = null;
    __unboughtRunTimer = setTimeout(runUnboughtCheck, 8000);
  }

  // ==================== 待出库 · 定时任务面板 ====================
  // 任务0：查单发货（由原浮动面板定时查单发货迁入，固定30分钟，不再使用设置中的定时时间与时间范围）
  // 任务：自动切换店铺（固定每1小时10分，执行后重置 查单发货/已取消关联单数量/同步物流状态 的计时并立即重新触发）
  // 任务1：每30分钟按静默标签→100×100小窗→700×700小窗加载“已取消”订单页，取全部订单号后调京巴士跟单接口，统计仍关联采购单数量
  // 任务2：每1小时通过小窗载入京巴士物流状态页，5秒后自动点击“同步物流状态(并发送取件码)”，点击后锁5分钟防重复执行
  // 自动定时执行时段可在面板底部编辑（默认08:00~20:00，本地缓存）；手动“立即执行”不受时段限制；小窗类任务可勾选“显示视图”查看执行过程（约500x600）
  // 任务3：同步当前页订单（固定30分钟，切订单tab立即执行一次）；已取消订单一并采集，后端只覆盖已有记录
  const TASK_AUTO_SHIP_INTERVAL = 30 * 60 * 1000; // 任务0：查单发货固定30分钟一轮
  const TASK_SWITCH_SHOP_INTERVAL = 70 * 60 * 1000; // 自动切换店铺：每1小时10分一轮
  const TASK_CANCELED_INTERVAL = 30 * 60 * 1000; // 任务1：30分钟一轮
  const TASK_EXPRESS_INTERVAL = 60 * 60 * 1000;  // 任务2：1小时一轮
  const TASK_PAGE_SYNC_INTERVAL = 30 * 60 * 1000; // 任务3：同步当前页订单固定30分钟一轮
  const TASK_PET_INTERVAL = 15 * 60 * 1000; // 小泷桌宠：每15分钟刷新采购/台账/关联单/今日数据/京准通广告费用
  const TASK_EXPRESS_LOCK = 5 * 60 * 1000;       // 任务2：同步可能执行5分钟，5分钟内不允许再执行
  let __taskPanelTimer = null;       // 全局仅一个调度唤醒定时器：时段内每分钟对齐检查，时段外睡到下个开始时间
  let __taskPanelVisibilityBound = false; // 是否已监听标签页可见性（回前台重排定时器）
  let __taskGreetingStart = 0;       // 可爱提醒卡片计时起点（本次页面打开至今，每分钟+1）
  let __taskBindCount = 0;           // 已取消订单未处理关联单数量（用于提醒卡片智能提示）
  let __taskCanceledManualHint = false; // 读取失败时提醒用户手动执行一遍；手动执行或自动成功后清除
  function setCanceledManualHint(on) {
    __taskCanceledManualHint = !!on;
    updateTaskGreeting();
  }
  let __taskPanelLoginRefreshed = false; // 页面首次打开10秒后是否已重新获取登录态
  let __taskPanelReadyAt = 0;        // 首轮自动补执行最早时间（页面打开10秒后，手动立即执行不受限）
  let __taskShipRunning = false;     // 任务0防重入
  let __taskSwitchRunning = false;   // 自动切换店铺防重入
  let __taskCanceledRunning = false; // 任务1防重入
  let __taskExpressRunning = false;  // 任务2防重入
  let __taskPageSyncRunning = false; // 任务3：同步当前页订单防重入
  let __taskPetRunning = false;      // 小泷桌宠巡检防重入
  let __taskShowDetails = true;     // 底部“显示任务执行详情”开关，默认开启
  let __taskPageSyncWaitingResult = false; // 是否已上传、正在等待后台真实入库结果
  let __taskPageSyncActiveId = ''; // 本次同步唯一编号，忽略上一轮迟到的SYNC_RESULT回包
  let __taskPageSyncResultTimer = null; // 入库结果超时保护，避免一直显示等待
  let __taskCanceledFrame = null;    // 任务1小窗容器
  let __taskExpressFrame = null;     // 任务2小窗容器

  function getTaskSwitch(key) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(key, function (st) { resolve(!!(st && st[key])); }); }
      catch (e) { resolve(false); }
    });
  }
  // 带默认值的开关读取：仅在从未设置过时采用默认值；用户手动关闭后不会被再次打开
  function getTaskSwitchDefault(key, defaultOn) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(key, function (st) {
          const exists = st && Object.prototype.hasOwnProperty.call(st, key);
          const val = exists ? !!st[key] : !!defaultOn;
          if (!exists) { const o = {}; o[key] = val; chrome.storage.local.set(o); }
          resolve(val);
        });
      } catch (e) { resolve(!!defaultOn); }
    });
  }
  function setTaskSwitch(key, v) {
    try { const o = {}; o[key] = !!v; chrome.storage.local.set(o); } catch (e) {}
  }
  function getTaskLastRun(key) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(key, function (st) { resolve((st && st[key]) || 0); }); }
      catch (e) { resolve(0); }
    });
  }
  function setTaskLastRun(key) {
    try { const o = {}; o[key] = Date.now(); chrome.storage.local.set(o); } catch (e) {}
  }
  // 定时任务仅在 8:00~20:00 自动执行
  // 自动执行时段：本地缓存 zcc_task_time_window，读不到/格式非法时使用默认 08:00~20:00
  const TASK_TIME_WINDOW_KEY = 'zcc_task_time_window';
  const TASK_TIME_WINDOW_DEFAULT = { start: '08:00', end: '20:00' };
  let __taskTimeWindow = { start: TASK_TIME_WINDOW_DEFAULT.start, end: TASK_TIME_WINDOW_DEFAULT.end };
  function isValidTaskTimeText(t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || '')); }
  function taskTimeToMin(t) { const a = String(t).split(':'); return Number(a[0]) * 60 + Number(a[1]); }
  function inTaskTimeWindow() {
    const d = new Date();
    const cur = d.getHours() * 60 + d.getMinutes();
    const start = taskTimeToMin(__taskTimeWindow.start);
    const end = taskTimeToMin(__taskTimeWindow.end);
    if (start === end) return true; // 起止相同视为全天可执行
    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end; // 支持跨天（如 20:00~08:00）
  }
  function updateTaskTimeWindowText() {
    const el = document.getElementById('zcc-tp-time-window');
    if (el) el.textContent = '自动执行仅 ' + __taskTimeWindow.start + '~' + __taskTimeWindow.end;
    const si = document.getElementById('zcc-tp-time-start');
    const ei = document.getElementById('zcc-tp-time-end');
    if (si) si.value = __taskTimeWindow.start;
    if (ei) ei.value = __taskTimeWindow.end;
  }
  // 可爱执行提醒：有未处理关联单时优先提醒；否则时段内累计“已为您执行任务xx分钟/小时”，时段外按时间显示夜深/早安等
  function updateTaskGreeting() {
    const title = document.getElementById('zcc-tp-greeting-title');
    const sub = document.getElementById('zcc-tp-greeting-sub');
    const icon = document.getElementById('zcc-tp-greeting-icon');
    const card = document.getElementById('zcc-tp-greeting');
    if (!title || !sub) return;
    if (!__taskGreetingStart) __taskGreetingStart = Date.now();
    const mins = Math.max(0, Math.floor((Date.now() - __taskGreetingStart) / 60000));
    const h = new Date().getHours();
    if (card) card.classList.toggle('is-alert', __taskBindCount > 0 || __taskCanceledManualHint); // 有待处理订单或读取失败时卡片进入提醒态
    if (__taskCanceledManualHint) {
      // 读取失败：宠物机器人提醒主人手动执行一遍，点卡片即手动重跑
      if (icon) icon.textContent = '🥺';
      title.textContent = '主人，刚才自动读取没成功～';
      sub.textContent = '点我手动执行一遍「已取消订单关联单数量」吧，我陪你一起看';
      return;
    }
    if (__taskBindCount > 0) {
      // 宠物机器人式主动提醒：发现未处理关联单，引导主人展开面板去处理
      if (icon) icon.textContent = '🤖';
      title.textContent = '主人，还有 ' + __taskBindCount + ' 个待处理订单！';
      if (h >= 23 || h < 5) sub.textContent = '夜深了也不放心呀～点我展开面板，处理完再睡好不好';
      else sub.textContent = '有采购关联单或中转仓订单（备注含“备”）没处理～点我展开面板看看吧';
      return;
    }
    if (inTaskTimeWindow()) {
      let text;
      if (mins < 60) text = '已为您执行任务 ' + mins + ' 分钟';
      else {
        const hours = Math.floor(mins / 60);
        const left = mins % 60;
        text = '已为您执行任务 ' + hours + ' 小时' + (left ? ' ' + left + ' 分钟' : '');
      }
      if (icon) icon.textContent = '🐻';
      title.textContent = text;
      sub.textContent = '我会乖乖盯着任务，到点就自动开工～';
      return;
    }
    if (h >= 23 || h < 5) {
      if (icon) icon.textContent = '🌙';
      title.textContent = '夜深了，早点睡';
      sub.textContent = '订单先交给我，到时间我再叫你～';
    } else if (h < 8) {
      if (icon) icon.textContent = '🌅';
      title.textContent = '早安，新的一天开始啦';
      sub.textContent = '先喝口水，执行时段到了我就开工～';
    } else {
      if (icon) icon.textContent = '😴';
      title.textContent = '当前不在执行时段，先休息一下吧';
      sub.textContent = '到点我会自动醒来执行任务～';
    }
    const next = nextTaskWindowStart(Date.now());
    if (next > Date.now()) {
      const d = new Date(next);
      const txt = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      sub.textContent += ' 下次开工 ' + (d.toDateString() !== new Date().toDateString() ? '明天 ' : '') + txt;
    }
  }

  function loadTaskTimeWindow() {
    try {
      chrome.storage.local.get(TASK_TIME_WINDOW_KEY, function (st) {
        const w = st && st[TASK_TIME_WINDOW_KEY];
        // 读不到缓存或格式非法时保持默认，不覆盖已有合法配置
        if (w && isValidTaskTimeText(w.start) && isValidTaskTimeText(w.end)) {
          __taskTimeWindow = { start: w.start, end: w.end };
        }
        updateTaskTimeWindowText();
      });
    } catch (e) { updateTaskTimeWindowText(); }
  }

  // 面板状态同时写入 storage，切换标签重建面板后可恢复上次结果
  const TASK_STATUS_CONF = {
    ship: { el: 'zcc-task-ship-status', store: 'zcc_task_auto_ship_last' },
    switchShop: { el: 'zcc-task-switchShop-status', store: 'zcc_task_switch_shop_last' },
    canceled: { el: 'zcc-task-canceled-status', store: 'zcc_task_canceled_assoc_last' },
    express: { el: 'zcc-task-express-status', store: 'zcc_task_express_last' },
    pageSync: { el: 'zcc-task-pageSync-status', store: 'zcc_task_page_sync_last' },
    pet: { el: 'zcc-task-pet-status', store: 'zcc_desktop_pet_last' }
  };
  function setTaskStatus(kind, text, cls) {
    const conf = TASK_STATUS_CONF[kind];
    const box = document.getElementById(conf.el);
    if (box) { box.textContent = text; box.className = 'zcc-task-status ' + (cls || ''); }
    // 性能：执行中的瞬时进度(is-checking)不落盘，避免每秒写 storage 造成 IPC/磁盘开销；仅持久化最终状态供跨页恢复
    if (cls === 'is-checking') return;
    try { const o = {}; o[conf.store] = { time: Date.now(), text: text, cls: cls || '' }; chrome.storage.local.set(o); } catch (e) {}
  }

  // 面板/小窗拖动：按住把手拖动，位移小于4px视为点击（不影响折叠等点击事件）；ignore 选择器内的元素不触发拖动
  // 性能：mousemove/mouseup 只在拖动期间挂载、松手即移除，避免每次创建小窗都向 document 累积永久监听器导致页面变卡
  function makePanelDraggable(panel, handle, ignore) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;
    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) {
        panel.style.left = (ox + dx) + 'px'; panel.style.top = (oy + dy) + 'px';
        panel.style.right = 'auto'; panel.style.transform = 'none';
      }
    }
    function onUp() {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    handle.addEventListener('mousedown', function (e) {
      if (ignore && e.target.closest(ignore)) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    // 拖动后抑制紧接着的一次点击（避免拖动被当成折叠/关闭）
    handle.addEventListener('click', function (e) {
      if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; }
    }, true);
  }

  // 切换已有任务小窗的显示状态：只调整视图，不重载iframe，避免中断正在执行的同步任务
  function setTaskFrameVisible(ref, visible) {
    if (!ref || !ref.wrap || !ref.iframe) return;
    const wrap = ref.wrap;
    if (visible) {
      wrap.setAttribute('data-visible', '1');
      wrap.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:500px;height:600px;max-width:94vw;max-height:90vh;z-index:2147483646;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.3);display:flex;flex-direction:column;';
      if (ref.bar) ref.bar.style.display = 'flex';
      ref.iframe.style.flex = '1 1 auto';
    } else {
      wrap.removeAttribute('data-visible');
      wrap.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:800px;z-index:-1;';
      if (ref.bar) ref.bar.style.display = 'none';
      ref.iframe.style.flex = '';
    }
  }

  // 通用任务小窗：visible=true 时显示为约500x600的可见弹窗（标题栏可拖动、带关闭按钮），否则屏外隐藏加载
  function createTaskFrame(id, url, visible, title) {
    const old = document.getElementById(id); if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = id;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    iframe.src = url;
    const bar = document.createElement('div');
    bar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#f5f7fa;font-size:12px;color:#606266;cursor:move;user-select:none;';
    const t = document.createElement('span'); t.textContent = title || '任务小窗';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const refresh = document.createElement('button');
    refresh.type = 'button'; refresh.textContent = '↻ 刷新'; refresh.title = '刷新当前小窗页面';
    refresh.style.cssText = 'border:1px solid #dcdfe6;background:#fff;border-radius:4px;padding:2px 10px;font-size:12px;cursor:pointer;color:#606266;';
    refresh.addEventListener('click', function () {
      // 直接重载iframe当前src，兼容京东与京巴士等跨域页面
      iframe.src = iframe.getAttribute('src') || url;
    });
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '✕ 关闭';
    close.style.cssText = 'border:1px solid #dcdfe6;background:#fff;border-radius:4px;padding:2px 10px;font-size:12px;cursor:pointer;color:#606266;';
    close.addEventListener('click', function () { wrap.remove(); });
    actions.appendChild(refresh); actions.appendChild(close);
    bar.appendChild(t); bar.appendChild(actions);
    wrap.appendChild(bar);
    makePanelDraggable(wrap, bar, 'button'); // 标题栏拖动，刷新/关闭按钮除外
    const ref = { wrap: wrap, iframe: iframe, bar: bar };
    setTaskFrameVisible(ref, visible);
    wrap.appendChild(iframe);
    document.body.appendChild(wrap);
    return ref;
  }
  // 任务结束自动关闭小窗（含可见小窗）
  function destroyTaskFrame(ref) {
    if (ref && ref.wrap) ref.wrap.remove();
  }

  // 任务集中配置：名称/图标/间隔/存储键/是否有“显示视图”/是否需登录/执行步骤
  // 未登录智查查时仅查单发货可开启，其余任务开关与按钮禁用且不执行
  const TASK_DEFS = [
    { kind: 'ship', icon: '🚚', name: '查单发货', intervalText: '每30分钟', swKey: 'zcc_task_auto_ship', view: false, needLogin: false,
      steps: ['查找发货按钮并执行', '完成发货'] },
    { kind: 'canceled', icon: '🔗', name: '已取消订单关联单数量', intervalText: '每30分钟', swKey: 'zcc_task_canceled_assoc', view: false, needLogin: true,
      steps: ['静默标签加载已取消订单页', '失败转100/700小窗补采并直查关联单', '汇总结果'] },
    { kind: 'express', icon: '📮', name: '同步物流状态(并发送取件码)', intervalText: '每1小时', swKey: 'zcc_task_express_sync', view: true, viewKey: 'zcc_task_express_view', needLogin: true,
      steps: ['载入物流状态页', '自动点击同步并开始发送', '等待执行(约5分钟)'] },
    { kind: 'switchShop', icon: '🔁', name: '自动切换店铺', intervalText: '每1小时10分', swKey: 'zcc_task_switch_shop', view: false, needLogin: true,
      steps: ['执行店铺切换'] },
    { kind: 'pageSync', icon: '🔄', name: '同步当前页订单', intervalText: '每30分钟', swKey: 'zcc_task_page_sync', view: false, needLogin: true, defaultOn: true,
      steps: ['解析本页订单(含已取消)', '同步到智查查(仅已有取消单覆盖)', '完成'] },
    { kind: 'pet', icon: '🎀', name: '小泷女仆数量与广告巡检', intervalText: '每15分钟', swKey: 'zcc_desktop_pet_task_enabled', view: false, needLogin: true, defaultOn: true,
      steps: ['采购巡检(仅待出库)', '台账/取消关联单', '当前店铺今日单量与金额', '京准通广告费用', '完成'] }
  ];

  function isTaskRunning(kind) {
    if (kind === 'ship') return __taskShipRunning;
    if (kind === 'canceled') return __taskCanceledRunning;
    if (kind === 'express') return __taskExpressRunning;
    if (kind === 'switchShop') return __taskSwitchRunning || isSwitchingShop; // 切换店铺跨页面恢复期间也算执行中
    if (kind === 'pageSync') return __taskPageSyncRunning;
    if (kind === 'pet') return __taskPetRunning;
    return false;
  }
  // 详情区仅任务开启或执行中时显示；底部取消勾选后全部只保留任务标题那一栏
  function updateTaskDetail(kind) {
    const p = document.getElementById('zcc-task-panel'); if (!p) return;
    const sw = p.querySelector('#zcc-task-' + kind + '-switch');
    const detail = p.querySelector('#zcc-task-' + kind + '-detail');
    if (detail) detail.style.display = (__taskShowDetails && ((sw && sw.checked) || isTaskRunning(kind))) ? '' : 'none';
  }
  // 执行中：隐藏立即执行图标、禁用顶部快捷图标、显示“任务执行中”与步骤，避免多次触发
  function setTaskRunning(kind, on) {
    const p = document.getElementById('zcc-task-panel'); if (!p) return;
    const icon = p.querySelector('#zcc-tp-icon-' + kind);
    if (icon) { icon.disabled = on; icon.classList.toggle('is-disabled', on); }
    const runningRow = p.querySelector('#zcc-task-' + kind + '-running');
    if (runningRow) runningRow.style.display = on ? '' : 'none';
    if (!on) { const steps = p.querySelector('#zcc-task-' + kind + '-steps'); if (steps) steps.innerHTML = ''; }
    updateTaskDetail(kind);
  }
  // 按顺序显示执行步骤：已完成✓ / 当前⏳ / 未进行灰点
  function setTaskStep(kind, idx) {
    const def = TASK_DEFS.find(function (t) { return t.kind === kind; });
    const p = document.getElementById('zcc-task-panel'); if (!def || !p) return;
    const box = p.querySelector('#zcc-task-' + kind + '-steps'); if (!box) return;
    box.innerHTML = def.steps.map(function (s, i) {
      const cls = i < idx ? 'is-done' : (i === idx ? 'is-active' : '');
      return '<div class="zcc-tp-step ' + cls + '">' + (i < idx ? '✓' : (i === idx ? '⏳' : '·')) + ' ' + s + '</div>';
    }).join('');
  }
  function runTaskByKind(kind, manual) {
    if (kind === 'ship') runTaskAutoShip();
    else if (kind === 'canceled') runTaskCanceledAssoc(manual);
    else if (kind === 'express') runTaskExpressSync();
    else if (kind === 'switchShop') runTaskSwitchShop();
    else if (kind === 'pageSync') runTaskPageSync(manual);
    else if (kind === 'pet') runTaskPetInspection();
  }

  // 小泷桌宠巡检：复用统一定时器；未登录时不写执行时间、不启动任务状态，也不发任何巡检数据请求
  async function runTaskPetInspection(reason) {
    if (__taskPetRunning) return;
    if (!(await checkLoginStatus())) { setTaskStatus('pet', '未登录智查查，无法执行', 'is-error'); return; }
    __taskPetRunning = true;
    setTaskLastRun('zcc_desktop_pet_last_run');
    setTaskRunning('pet', true);
    setTaskStep('pet', 0);
    try {
      if (typeof window.__zccRunDesktopPetInspection !== 'function') throw new Error('小泷桌宠模块尚未加载');
      setTaskStatus('pet', '小泷正在刷新数量、金额与广告费用...', 'is-checking');
      const summary = await window.__zccRunDesktopPetInspection(reason);
      setTaskStep('pet', 5);
      setTaskStatus('pet', summary || '小泷巡检完成', 'is-done');
    } catch (e) {
      setTaskStatus('pet', '巡检失败：' + ((e && e.message) || e), 'is-error');
    } finally {
      __taskPetRunning = false;
      setTaskRunning('pet', false);
      updateTaskNextTimes(false);
    }
  }
  window.__zccRunPetTask = runTaskPetInspection;

  // 任务3：同步当前页订单。30分钟周期与切tab共用此入口；manual=true 表示用户手动/切tab触发，不受执行时段限制
  async function runTaskPageSync(manual, expectedTabId) {
    if (__taskPageSyncRunning) { setTaskStatus('pageSync', '任务执行中，请稍候...', 'is-checking'); return; }
    // 同步当前页订单全天执行，不受自动执行时段限制（手动/切tab同样直接执行）
    if (!(await zccHasToken())) { setTaskStatus('pageSync', '未登录智查查，无法执行', 'is-error'); return; }
    if (!isTargetPage()) { setTaskStatus('pageSync', '当前不在订单列表页，跳过同步', ''); return; }
    __taskPageSyncRunning = true;
    __taskPageSyncWaitingResult = false;
    __taskPageSyncActiveId = 'page_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    clearTimeout(__taskPageSyncResultTimer);
    setTaskRunning('pageSync', true);
    setTaskStep('pageSync', 0);
    setTaskStatus('pageSync', '正在解析本页订单（含已取消）...', 'is-checking');
    try {
      const result = await handleManualSync(expectedTabId);
      const list = result && result.importList ? result.importList : [];
      if (!list.length) {
        setTaskStatus('pageSync', '本页未解析到可同步订单（待付款/空页不入库）', '');
        return [];
      }
      setTaskStep('pageSync', 1);
      const canceled = list.filter(function (o) { return String(o.order_status || '').indexOf('已取消') !== -1; }).length;
      __taskPageSyncWaitingResult = true;
      setTaskStatus('pageSync', '已采集 ' + list.length + ' 条（已取消状态 ' + canceled + ' 条），等待后台入库结果...', 'is-checking');
      setTaskStep('pageSync', 2);
      return list;
    } catch (e) {
      setTaskStatus('pageSync', '同步失败：' + ((e && e.message) || e), 'is-error');
      return [];
    } finally {
      __taskPageSyncRunning = false;
      setTaskRunning('pageSync', false);
      setTaskLastRun('zcc_task_page_sync_run');
      updateTaskNextTimes(false);
      // 上传后由 SYNC_RESULT 回写真实新增/覆盖/跳过条数；20秒未返回则给出明确提示
      if (__taskPageSyncWaitingResult) {
        clearTimeout(__taskPageSyncResultTimer);
        __taskPageSyncResultTimer = setTimeout(function () {
          if (!__taskPageSyncWaitingResult) return;
          __taskPageSyncWaitingResult = false;
          setTaskStatus('pageSync', '订单已上传，但暂未收到入库结果，请到订单查询中核实', 'is-error');
        }, 20000);
      }
    }
  }

  const __taskPanelState = window.__zccTaskPanelState || (window.__zccTaskPanelState = { creating: null, generation: 0, collapsed: false }); // 页面级创建锁：即使content.js重复注入，也只能创建一个任务面板
  function getSingleTaskPanel() {
    const panels = document.querySelectorAll('#zcc-task-panel');
    for (let i = 1; i < panels.length; i++) panels[i].remove(); // 清理旧版本已经产生的重复面板，仅保留第一个
    return panels[0] || null;
  }
  async function ensureTaskPanel() {
    const existing = getSingleTaskPanel();
    if (existing) return existing;
    if (__taskPanelState.creating) {
      await __taskPanelState.creating;
      return getSingleTaskPanel() || ensureTaskPanel(); // 若创建期间被登录重建移除，等待旧流程结束后重新创建
    }
    const generation = __taskPanelState.generation;
    __taskPanelState.creating = buildTaskPanel(generation);
    try {
      const panel = await __taskPanelState.creating;
      return panel && panel.isConnected ? panel : getSingleTaskPanel();
    } finally {
      __taskPanelState.creating = null;
    }
  }

  async function buildTaskPanel(generation) {
    let p = getSingleTaskPanel();
    if (p) return p;
    const logged = await zccHasToken(); // 未登录仅查单发货可用
    if (generation !== __taskPanelState.generation) return null; // 二次重建已使本次旧创建失效，禁止旧流程继续插入面板
    const petSettings = await new Promise(function (resolve) {
      try { chrome.storage.local.get('jd_settings', function (st) { resolve((st && st.jd_settings) || {}); }); }
      catch (e) { resolve({}); }
    });
    const showPetTask = petSettings.desktopPetTaskVisible === true; // 小泷默认不显示在任务列表，设置中明确开启才显示
    __taskShowDetails = await getTaskSwitchDefault('zcc_task_show_details', true);
    if (generation !== __taskPanelState.generation) return null; // 每次异步读取后都核对代次，避免旧面板在二次加载后重新出现
    const panelTaskDefs = TASK_DEFS.filter(function (t) { return t.kind !== 'pet' || showPetTask; });
    p = document.createElement('div');
    p.id = 'zcc-task-panel';
    let bodyHtml = '';
    // 熊桌宠提醒固定在原面板顶部折叠栏正下方、任务列表上方，不参与折叠，也不形成第二个独立悬浮面板
    const greetingHtml =
      '<div class="zcc-tp-greeting" id="zcc-tp-greeting" title="点击查看相关任务">' +
      '<div class="zcc-tp-greeting-emoji" id="zcc-tp-greeting-icon">🐻</div>' +
      '<div class="zcc-tp-greeting-text"><div class="zcc-tp-greeting-title" id="zcc-tp-greeting-title">已为您执行任务 0 分钟</div>' +
      '<div class="zcc-tp-greeting-sub" id="zcc-tp-greeting-sub">我会乖乖盯着任务，到点就自动开工～</div></div></div>';
    // 折叠时保留标题栏与熊提醒，只隐藏任务列表；提醒不会作为第二个独立面板渲染
    panelTaskDefs.forEach(function (t, i) {
      const disabled = t.needLogin && !logged;
      bodyHtml +=
        (i ? '<div class="zcc-tp-divider"></div>' : '') +
        '<div class="zcc-tp-task" data-kind="' + t.kind + '">' +
        '  <label class="zcc-tp-name" title="' + t.name + (disabled ? '（需登录智查查后使用）' : '') + '"><input type="checkbox" id="zcc-task-' + t.kind + '-switch"' + (disabled ? ' disabled' : '') + '> <span class="zcc-tp-name-text">' + t.icon + ' ' + t.name + '</span></label>' +
        (t.view ? '<label class="zcc-tp-view"><input type="checkbox" id="zcc-task-' + t.kind + '-view"> 视图</label>' : '') +
        '  <span class="zcc-tp-interval">' + t.intervalText + '</span>' +
        '  <span class="zcc-tp-next" id="zcc-task-' + t.kind + '-next"></span>' +
        '</div>' +
        '<div class="zcc-tp-detail" id="zcc-task-' + t.kind + '-detail" style="display:none;">' +
        '  <div class="zcc-tp-running" id="zcc-task-' + t.kind + '-running" style="display:none;">⏳ 任务执行中</div>' +
        (t.kind === 'pageSync' ? '<div class="zcc-tp-steps" id="zcc-task-pageSync-steps"></div>' : '<div class="zcc-tp-steps" id="zcc-task-' + t.kind + '-steps"></div>') +
        '  <div class="zcc-task-status" id="zcc-task-' + t.kind + '-status">尚未执行</div>' +
        '</div>';
    });
    p.innerHTML =
      '<div class="zcc-tp-header" id="zcc-tp-header">⏰ 定时任务<span class="zcc-tp-binds" id="zcc-tp-binds" style="display:none;"></span>' +
      '<span class="zcc-tp-icons">' +
      '<button type="button" class="zcc-tp-icon" id="zcc-tp-icon-unbought" title="采购巡检：扫描待出库订单采购情况">🔍</button>' +
      '<button type="button" class="zcc-tp-icon" id="zcc-tp-icon-clear" title="清除风险提示">🧹</button>' +
      TASK_DEFS.map(function (t) {
        const disabled = t.needLogin && !logged;
        return '<button type="button" class="zcc-tp-icon" id="zcc-tp-icon-' + t.kind + '" title="立即执行：' + t.name + '"' + (disabled ? ' disabled' : '') + '>' + t.icon + '</button>';
      }).join('') +
      '</span><span class="zcc-tp-toggle" id="zcc-tp-toggle">' + (__taskPanelState.collapsed ? '展开 ▼' : '折叠 ▲') + '</span></div>' + greetingHtml +
      '<div class="zcc-tp-body" id="zcc-tp-body"' + (__taskPanelState.collapsed ? ' style="display:none;"' : '') + '>' + bodyHtml +
      '<div class="zcc-tp-footer"><span id="zcc-tp-time-window">自动执行仅 08:00~20:00</span> · 需保持本页打开' +
      '<button type="button" class="zcc-tp-time-edit" id="zcc-tp-time-edit" title="编辑自动执行时间范围">✎</button></div>' +
      '<div class="zcc-tp-time-editor" id="zcc-tp-time-editor" style="display:none;">' +
      '<input type="time" id="zcc-tp-time-start" value="08:00"><span>~</span><input type="time" id="zcc-tp-time-end" value="20:00">' +
      '<button type="button" id="zcc-tp-time-save">保存</button><span class="zcc-tp-time-tip" id="zcc-tp-time-tip"></span></div>' +
      '<div class="zcc-tp-display-options"><label title="关闭后仅显示任务标题那一行，不显示执行步骤与结果"><input type="checkbox" id="zcc-tp-show-details"> 显示任务执行详情</label></div></div>';
    if (generation !== __taskPanelState.generation) return null; // 插入DOM前最后核对，杜绝旧异步流程生成额外面板
    document.body.appendChild(p);
    makePanelDraggable(p, p.querySelector('#zcc-tp-header'), '.zcc-tp-toggle, .zcc-tp-icon'); // 面板标题栏拖动，折叠/快捷图标按钮除外
    // 熊提醒卡片内嵌原面板；折叠与展开统一由原任务面板头部处理
    // 面板仅由用户手动折叠/展开，不再进入页面后自动折叠
    p.querySelector('#zcc-tp-header').addEventListener('click', function (e) {
      if (e.target.closest('.zcc-tp-icon')) return; // 快捷图标不触发折叠
      const body = p.querySelector('#zcc-tp-body');
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      __taskPanelState.collapsed = !collapsed; // 登录态二次重建后继续沿用用户当前的折叠状态
      p.querySelector('#zcc-tp-toggle').textContent = collapsed ? '折叠 ▲' : '展开 ▼';
    });
    // 熊桌宠提醒点击：读取失败时重跑取消单检测；有待处理关联单时定位并高亮对应任务
    p.querySelector('#zcc-tp-greeting').addEventListener('click', function () {
      if (__taskCanceledManualHint) { runTaskCanceledAssoc(true); return; }
      if (__taskBindCount > 0) {
        const target = p.querySelector('.zcc-tp-task[data-kind="canceled"]');
        if (target) {
          target.classList.remove('is-attention');
          void target.offsetWidth;
          target.classList.add('is-attention');
          target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          setTimeout(function () { target.classList.remove('is-attention'); }, 3200);
        }
      }
    });
    // 原“智查查同步助手”浮动面板迁移来的采购巡检 / 清除风险提示；同步当前页保留下方任务项快捷按钮，不再重复显示第一个按钮
    p.querySelector('#zcc-tp-icon-unbought').addEventListener('click', function () { removeUnboughtUI(); runUnboughtCheck(); });
    p.querySelector('#zcc-tp-icon-clear').addEventListener('click', function () { clearRiskMarks(); });
    // 执行时段编辑：展开/收起编辑器；保存到本地缓存后自动刷新浏览器，让新定时计划从首屏重新初始化
    p.querySelector('#zcc-tp-time-edit').addEventListener('click', function () {
      const ed = p.querySelector('#zcc-tp-time-editor');
      ed.style.display = ed.style.display === 'none' ? 'flex' : 'none';
      updateTaskTimeWindowText();
    });
    p.querySelector('#zcc-tp-time-save').addEventListener('click', function () {
      const start = p.querySelector('#zcc-tp-time-start').value;
      const end = p.querySelector('#zcc-tp-time-end').value;
      const tip = p.querySelector('#zcc-tp-time-tip');
      const saveBtn = p.querySelector('#zcc-tp-time-save');
      if (!isValidTaskTimeText(start) || !isValidTaskTimeText(end)) {
        tip.textContent = '时间格式不正确';
        tip.className = 'zcc-tp-time-tip is-error';
        return;
      }
      __taskTimeWindow = { start: start, end: end };
      saveBtn.disabled = true; // 防止保存期间重复点击触发多次刷新
      tip.textContent = '已保存，正在刷新页面...';
      tip.className = 'zcc-tp-time-tip is-ok';
      try {
        chrome.storage.local.set({ zcc_task_time_window: { start: start, end: end } }, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            saveBtn.disabled = false;
            tip.textContent = '保存失败：' + chrome.runtime.lastError.message;
            tip.className = 'zcc-tp-time-tip is-error';
            return;
          }
          location.reload(); // 必须等缓存写入完成再刷新，避免新页面读回旧时段
        });
      } catch (e) {
        saveBtn.disabled = false;
        tip.textContent = '保存失败，请重试';
        tip.className = 'zcc-tp-time-tip is-error';
      }
    });
    // 底部显示详情开关：默认勾选；取消后只显示任务标题行，不影响后台执行
    const showDetails = p.querySelector('#zcc-tp-show-details');
    showDetails.checked = __taskShowDetails;
    showDetails.addEventListener('change', function () {
      __taskShowDetails = showDetails.checked;
      setTaskSwitch('zcc_task_show_details', __taskShowDetails);
      TASK_DEFS.forEach(function (t) { updateTaskDetail(t.kind); });
    });
    // 各任务：顶部快捷图标 + 开关 + 名称后立即执行图标 + 显示视图
    for (const t of TASK_DEFS) {
      p.querySelector('#zcc-tp-icon-' + t.kind).addEventListener('click', function () { runTaskByKind(t.kind, true); }); // 顶部图标=手动执行
      if (t.kind === 'pet' && !showPetTask) continue; // 仅隐藏列表行，不影响后台15分钟调度与顶部快捷图标
      const sw = p.querySelector('#zcc-task-' + t.kind + '-switch');
      sw.checked = (t.needLogin && !logged) ? false : await getTaskSwitchDefault(t.swKey, !!t.defaultOn); // 未登录时其他任务默认关闭；同步当前页订单首次默认开启
      sw.addEventListener('change', function () {
        setTaskSwitch(t.swKey, sw.checked);
        if (sw.checked) runTaskByKind(t.kind, true); // 开启后立即执行一次（视为用户手动触发）
        else setTaskStatus(t.kind, '已关闭', '');
        updateTaskDetail(t.kind);
        updateTaskNextTimes();
      });
      if (t.view) {
        const view = p.querySelector('#zcc-task-' + t.kind + '-view');
        view.checked = await getTaskSwitch(t.viewKey);
        view.addEventListener('change', function () {
          setTaskSwitch(t.viewKey, view.checked);
          // 物流任务执行中也允许随时显示/隐藏小窗，仅切换样式，不重载京巴士页面
          if (t.kind === 'express') setTaskFrameVisible(__taskExpressFrame, view.checked);
        });
      }
      updateTaskDetail(t.kind);
    }
    if (generation !== __taskPanelState.generation) { p.remove(); return null; } // 构建期间发生二次重建时，旧代次节点不得继续生效
    // 恢复各任务的上次执行结果（不覆盖正在显示的状态）
    try {
      chrome.storage.local.get(['zcc_task_auto_ship_last', 'zcc_task_switch_shop_last', 'zcc_task_canceled_assoc_last', 'zcc_task_express_last', 'zcc_task_page_sync_last', 'zcc_desktop_pet_last'], function (st) {
        [['ship', 'zcc_task_auto_ship_last'], ['switchShop', 'zcc_task_switch_shop_last'], ['canceled', 'zcc_task_canceled_assoc_last'], ['express', 'zcc_task_express_last'], ['pageSync', 'zcc_task_page_sync_last'], ['pet', 'zcc_desktop_pet_last']].forEach(function (pair) {
          const last = st && st[pair[1]];
          // 登录状态会变化：“未登录智查查，无法执行”属于当时状态，不应跨页面恢复（已登录时尤其误导；查单发货本身未登录也可执行）
          if (last && last.text && last.text.indexOf('未登录智查查') !== -1) return;
          // 刷新页面后任务不可能仍在执行中：is-checking 类历史状态（含“页面未就绪/正在执行”）不恢复，避免残留卡住假象
          if (last && last.cls === 'is-checking') return;
          const box = document.getElementById(TASK_STATUS_CONF[pair[0]].el);
          if (last && last.text && box && box.textContent === '尚未执行') {
            box.textContent = last.text;
            box.className = 'zcc-task-status ' + (last.cls || '');
          }
        });
      });
    } catch (e) {}
    updateTaskBindBadge();   // 恢复头部关联单数量角标
    updateTaskTimeWindowText(); // 同步执行时段文本（缓存可能先于面板创建完成读取）
    updateTaskGreeting();    // 初始化可爱执行提醒（之后随每分钟调度刷新）
    updateTaskNextTimes();   // 显示各任务下一次预计执行时间
    return p;
  }

  function setupTaskPanel() {
    ensureTaskPanel();
    loadTaskTimeWindow(); // 读取本地执行时段配置（无缓存则默认08:00~20:00）
    // 页面刚打开时登录token/页面DOM可能尚未就绪：首轮自动补执行延后10秒，并在第10秒重新获取登录态、重建面板
    if (!__taskPanelLoginRefreshed) {
      __taskPanelLoginRefreshed = true;
      __taskPanelReadyAt = Date.now() + 10000;
      setTimeout(function () {
        if (document.getElementById('zcc-task-panel')) {
          removeTaskPanel();
          ensureTaskPanel().then(function () { updateTaskNextTimes(); }); // 重新读取最新登录态，恢复各任务开关
        } else {
          updateTaskNextTimes();
        }
      }, 10000);
    }
    // 页面刷新后恢复“切换中”的店铺轮转：京东整页切换、局部切换后的主动reload，都由这里接管（resumeAfterSwitch 内部有防重入锁）
    getShopSwitchState().then(function (s) {
      if (s && s.phase === 'switching' && s.targetShopId) {
        console.log('%c[切换店铺] 检测到切换中状态（页面刚刷新），恢复执行', 'color:#e6a23c;font-weight:bold;');
        // 恢复进展同步到定时任务面板（旧 updateShipStatus 面板已删除，不再只写旧状态）
        setTaskRunning('switchShop', true);
        setTaskStep('switchShop', 0);
        setTaskStatus('switchShop', '检测到切换状态，正在恢复执行...', 'is-checking');
        resumeAfterSwitch(s);
      }
    });
    // 页面刷新时重新判断：时段内启动每分钟检查，时段外睡到下个开始时间；不再固定10分钟轮询
    scheduleTaskWake();
    if (!__taskPanelVisibilityBound) {
      __taskPanelVisibilityBound = true;
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
          scheduleTaskWake();
          updateTaskNextTimes(true, true); // 回前台不补执行桌宠巡检，其他到点任务保持原补执行逻辑
          updateTaskGreeting();
        } // 后台标签页可能节流，回到前台立即重排并补查到点任务
      });
    }
  }
  function removeTaskPanel() {
    const panels = document.querySelectorAll('#zcc-task-panel');
    if (panels.length) {
      const body = panels[0].querySelector('#zcc-tp-body');
      if (body) __taskPanelState.collapsed = body.style.display === 'none'; // 重建前记住折叠状态，避免用户已折叠的面板被强制展开
    }
    __taskPanelState.generation++; // 立即使仍在 await 的旧构建失效，旧流程不能再次插入重复面板
    Array.prototype.forEach.call(panels, function (panel) { panel.remove(); }); // 一次清理所有历史重复节点，后台计时继续
  }

  // 统一调度：单一定时器。全天每分钟对齐检查一次到点任务，不再因超出执行时段而休眠；各任务是否执行仍由自身时段规则决定
  async function taskSchedulerTick() {
    if (Date.now() < __taskPanelReadyAt) { scheduleTaskWake(); return; } // 页面打开前10秒不自动执行
    await ensureTaskPanel();
    updateTaskNextTimes(); // 到点任务会直接补执行；同步当前页订单全天可执行，其余任务仍受时段限制
    updateTaskGreeting();  // 每分钟更新一次可爱提醒的累计执行时长
    scheduleTaskWake(); // 每次检查后安排下一分钟唤醒，不再睡到下个执行时段
  }

  // 计算距离 timestamp 之后最近一个可执行时刻：若本身在时段内返回原时刻，否则返回下一个时段开始时间（支持跨天）
  function nextTaskWindowStart(timestamp) {
    const start = taskTimeToMin(__taskTimeWindow.start);
    const end = taskTimeToMin(__taskTimeWindow.end);
    if (start === end) return timestamp; // 全天
    const d = new Date(timestamp);
    const cur = d.getHours() * 60 + d.getMinutes();
    const startAt = new Date(d);
    startAt.setHours(Math.floor(start / 60), start % 60, 0, 0);
    if (start < end) {
      if (cur < start) return startAt.getTime();          // 时段前：当天开始时间
      if (cur >= end) return startAt.getTime() + 86400000; // 时段后：次日开始时间
      return timestamp;                                    // 已在时段内
    }
    // 跨天（如20:00~08:00）：只有 end~start 之间需要等待当天start
    if (cur >= end && cur < start) return startAt.getTime();
    return timestamp;
  }

  // 重排唯一唤醒定时器：页面刷新、修改执行时段、回到可见标签页时都重排；全天每分钟检查，不再休眠到下个时段
  function scheduleTaskWake() {
    if (__taskPanelTimer) { clearTimeout(__taskPanelTimer); __taskPanelTimer = null; }
    const now = Date.now();
    let delay;
    if (now < __taskPanelReadyAt) {
      delay = __taskPanelReadyAt - now; // 首次进入页面10秒后再启动
    } else {
      // 对齐下一分钟边界，保证任务到点后最多约1分钟内被检查执行；时段外也继续检查（同步当前页订单需要全天运行）
      const d = new Date(now);
      delay = 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 100;
    }
    __taskPanelTimer = setTimeout(taskSchedulerTick, delay);
  }

  // 各任务下一次预计执行时间：未开启不显示；已到点显示“即将执行”并在允许时段内立即补执行，不再等下一轮10分钟检查
  // allowExec=false 时只刷新显示不补执行（切换店铺任务重置其他任务后使用，等页面刷新后自动执行）
  // skipPetInspection=true 时仅跳过桌宠补巡检，用于回前台场景；正常15分钟调度不受影响
  function updateTaskNextTimes(allowExec, skipPetInspection) {
    const canExec = allowExec !== false && Date.now() >= __taskPanelReadyAt; // 页面打开前10秒只显示预计时间，不自动补执行
    const now = Date.now();
    [
      { sw: 'zcc_task_auto_ship', run: 'zcc_task_auto_ship_run', interval: TASK_AUTO_SHIP_INTERVAL, el: 'zcc-task-ship-next', exec: runTaskAutoShip },
      { sw: 'zcc_task_switch_shop', run: 'zcc_task_switch_shop_run', interval: TASK_SWITCH_SHOP_INTERVAL, el: 'zcc-task-switchShop-next', exec: runTaskSwitchShop },
      { sw: 'zcc_task_canceled_assoc', run: 'zcc_task_canceled_assoc_run', interval: TASK_CANCELED_INTERVAL, el: 'zcc-task-canceled-next', exec: runTaskCanceledAssoc },
      { sw: 'zcc_task_express_sync', run: 'zcc_task_express_run', interval: TASK_EXPRESS_INTERVAL, el: 'zcc-task-express-next', exec: runTaskExpressSync },
      { sw: 'zcc_task_page_sync', run: 'zcc_task_page_sync_run', interval: TASK_PAGE_SYNC_INTERVAL, el: 'zcc-task-pageSync-next', exec: runTaskPageSync, allDay: true },
      { sw: 'zcc_desktop_pet_task_enabled', run: 'zcc_desktop_pet_last_run', interval: TASK_PET_INTERVAL, el: 'zcc-task-pet-next', exec: runTaskPetInspection }
    ].forEach(function (t) {
      getTaskSwitch(t.sw).then(function (on) {
        const el = document.getElementById(t.el);
        if (!on) { if (el) el.textContent = ''; return; }
        getTaskLastRun(t.run).then(function (last) {
          const rawNext = last + t.interval;
          if (rawNext <= now && (t.allDay || inTaskTimeWindow())) {
            if (el) { el.textContent = '即将执行'; el.title = '已到达预计执行时间'; }
            // 到点补执行不依赖面板是否存在；函数内有防重入锁与5分钟冷却，重复调用安全
            // 回前台场景仅屏蔽桌宠，避免切换标签触发巡检；其余任务仍正常补执行
            if (canExec && !(skipPetInspection && t.exec === runTaskPetInspection)) t.exec();
            return;
          }
          // 到点但当前不在时段：顺延到下一个时段开始；未到点但预计时间超出时段：同样顺延，不显示错误的23:08等时间
          // 同步当前页订单为全天任务，到点直接执行，预计时间不顺延
          const next = t.allDay ? rawNext : (rawNext <= now ? nextTaskWindowStart(now) : nextTaskWindowStart(rawNext));
          if (el) {
            const d = new Date(next);
            const txt = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
            const isOtherDay = d.toDateString() !== new Date(now).toDateString();
            const show = (isOtherDay ? '明天 ' : '') + txt;
            el.textContent = '· ' + show; // 周期胶囊后小字显示下次时间，不占额外行
            el.title = '下次预计执行 ' + show + (rawNext <= now ? '（已到点，等待执行时段）' : '');
          }
        });
      });
    });
  }

  // 头部“已取消订单关联单数量”角标：数量>0 时显示并闪烁，为0隐藏
  function updateTaskBindBadge() {
    try {
      chrome.storage.local.get('zcc_task_canceled_assoc_binds', function (st) {
        const n = (st && st.zcc_task_canceled_assoc_binds) || 0;
        __taskBindCount = n; // 同步给可爱提醒卡片，用于主动提示未处理关联单
        const el = document.getElementById('zcc-tp-binds');
        updateTaskGreeting();
        if (!el) return;
        if (n > 0) {
          el.style.display = '';
          el.textContent = '🔗 ' + n;
          el.classList.add('is-warn');
          el.title = '已取消订单仍有 ' + n + ' 个待处理（采购关联单 + 备注含“备”的中转仓订单）';
        } else {
          el.style.display = 'none';
          el.classList.remove('is-warn');
        }
      });
    } catch (e) {}
  }
  function setTaskBindCount(n) {
    __taskBindCount = n || 0;
    try { chrome.storage.local.set({ zcc_task_canceled_assoc_binds: n }); } catch (e) {}
    updateTaskBindBadge();
    updateTaskGreeting();
  }

  // 从订单页DOM/文本中健壮提取订单号：兼容旧版 .card 结构，也兼容新版纯文字“订单号：xxxx”
  function extractOrderIdsFromDoc(doc) {
    const ids = new Set();
    if (!doc) return [];
    try {
      doc.querySelectorAll(SELECTORS.orderCard).forEach(function (card) {
        const el = card.querySelector(SELECTORS.orderId);
        const txt = el ? el.textContent.trim() : '';
        const m = txt.match(/\d{6,24}/);
        if (m) ids.add(m[0]);
      });
    } catch (e) {}
    try {
      const text = doc.body ? doc.body.innerText : '';
      const re = /订单号[：:\s]*([0-9]{8,24})/g;
      let m;
      while ((m = re.exec(text))) ids.add(m[1]);
    } catch (e) {}
    return Array.from(ids);
  }

  // 提取已取消订单（订单号 + 备注）：备注含“备”= 雀手中转仓取消订单，无采购关联单也需统计提醒
  function extractCanceledOrdersFromDoc(doc) {
    const map = new Map();
    if (!doc) return [];
    try {
      doc.querySelectorAll(SELECTORS.orderCard).forEach(function (card) {
        const el = card.querySelector(SELECTORS.orderId);
        const txt = el ? el.textContent.trim() : '';
        const m = txt.match(/\d{6,24}/);
        if (!m) return;
        // 独立采集页切换标签期间可能短暂保留旧列表；有明确状态字段时只接收已取消订单
        const statusEl = card.querySelector('.order-status span');
        const statusText = statusEl ? statusEl.textContent.trim() : '';
        if (statusText && statusText.indexOf('已取消') === -1) return;
        const rEl = card.querySelector(SELECTORS.remark);
        const remark = rEl ? rEl.textContent.trim() : '';
        map.set(m[0], { oid: m[0], remark: remark, que: remark.indexOf('备') !== -1 });
      });
    } catch (e) {}
    if (!map.size) {
      // 无 .card 结构时退化为纯文字订单号（此时拿不到备注，que 默认 false）
      try {
        const text = doc.body ? doc.body.innerText : '';
        const re = /订单号[：:\s]*([0-9]{8,24})/g;
        let m;
        while ((m = re.exec(text))) if (!map.has(m[1])) map.set(m[1], { oid: m[1], remark: '', que: false });
      } catch (e) {}
    }
    return Array.from(map.values());
  }

  // 已取消列表采集：统一使用独立标签页加载真实订单页，不再使用 iframe，避免京东限制框架内渲染；
  // 默认由SW统一函数按静默标签→100×100小窗→700×700小窗逐级补采，不再提供单独的视图开关
  async function collectCanceledIdsViaTab() {
    // 无论当前是否已处于已取消Tab都重新打开采集页，避免复用当前页面旧数据或渲染延迟
    return collectCanceledViaBackgroundTab();
  }

  // 独立标签页采集：默认不置前，由 SW 主动轮询读取订单，读完自动关闭，不干扰用户当前页面
  function collectCanceledViaBackgroundTab() {
    return new Promise(function (resolve) {
      let waited = 0;
      const progress = setInterval(function () {
        waited += 2;
        setTaskStatus('canceled', '正在按静默标签/补采小窗读取已取消订单（已等待 ' + waited + 's）...', 'is-checking');
      }, 2000);
      function done(resp) {
        clearInterval(progress);
        resolve(resp || { ok: false, error: '后台采集无响应' });
      }
      try {
        chrome.runtime.sendMessage({ type: 'ZCC_COLLECT_CANCELED_IDS' }, function (resp) {
          try { void chrome.runtime.lastError; } catch (e) {}
          done(resp);
        });
      } catch (e) {
        done({ ok: false, error: (e && e.message) || '后台采集失败' });
      }
    });
  }

  // 任务0：查单发货，复用原 runBatchShipOnce 核心；manual=true 不再使用设置中的时间范围，固定30分钟由统一调度控制
  async function runTaskAutoShip() {
    if (__taskShipRunning) return; // 上一次未结束则跳过本轮
    __taskShipRunning = true; // 立即上锁，防止调度与补执行并发重入
    let retryCd = null; // 30秒重试的倒计时句柄，确保结束时一定清理
    setTaskRunning('ship', true);
    setTaskStep('ship', 0);
    try {
      setTaskLastRun('zcc_task_auto_ship_run'); // 触发即记录本轮时间（失败也顺延，避免到点补执行反复重试）
      // 查单发货只操作京东页面，未登录智查查也可执行
      setTaskStatus('ship', '🚚 正在执行批量查单发货...', 'is-checking');
      let ok = await runBatchShipOnce(true);
      // 找不到“批量查单发货”按钮说明页面还没渲染好：自动等30秒后重试，仅重试一次（其他失败不重试）
      if (ok === false && !findBatchShipBtn()) {
        // 不单纯依赖setTimeout死等（后台标签页会被浏览器节流导致一直卡住）：
        // 1) MutationObserver监听页面渲染，按钮一出现立即重试；2) 每秒按时间戳刷新倒计时，30秒到点兜底重试
        const deadline = Date.now() + 30000;
        setTaskStatus('ship', '页面未就绪，等待渲染后自动重试（剩余 30s）...', 'is-checking');
        await new Promise(function (resolve) {
          let done = false;
          const observer = new MutationObserver(function () { if (findBatchShipBtn()) finish(); });
          function finish() {
            if (done) return;
            done = true;
            try { observer.disconnect(); } catch (e) {}
            if (retryCd) { clearInterval(retryCd); retryCd = null; }
            resolve();
          }
          try { observer.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch (e) {}
          retryCd = setInterval(function () {
            const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            const box = document.getElementById(TASK_STATUS_CONF.ship.el);
            if (box) box.textContent = '页面未就绪，等待渲染后自动重试（剩余 ' + left + 's）...';
            if (findBatchShipBtn() || Date.now() >= deadline) finish();
          }, 1000);
          if (findBatchShipBtn()) finish();
        });
        setTaskStatus('ship', '🚚 正在重试批量查单发货...', 'is-checking');
        ok = await runBatchShipOnce(true);
      }
      const timeText = new Date().toTimeString().slice(0, 5);
      if (ok === true) setTaskStatus('ship', '✅ 查单发货完成 · ' + timeText, 'is-ok');
      else if (ok === false) setTaskStatus('ship', '❌ 查单发货失败，等待下轮 · ' + timeText, 'is-error');
      else setTaskStatus('ship', '本轮未执行（上一次未结束或页面未就绪） · ' + timeText, 'is-error');
      setTaskStep('ship', 1);
    } catch (e) {
      setTaskStatus('ship', '执行异常：' + ((e && e.message) || e), 'is-error');
    } finally {
      if (retryCd) { clearInterval(retryCd); retryCd = null; } // 清理重试倒计时，避免泄漏
      __taskShipRunning = false;
      setTaskRunning('ship', false);
      updateTaskNextTimes();
    }
  }

  // 切换店铺任务执行时调用：重置 查单发货/已取消关联单数量/同步物流状态/同步当前页订单 的上次执行时间（置0）与状态
  // 页面切换刷新后，新页面的到点补执行机制会让它们自动重新执行，无需在本页手动触发
  function resetOtherTaskTimers() {
    try {
      chrome.storage.local.set({
        zcc_task_auto_ship_run: 0,
        zcc_task_canceled_assoc_run: 0,
        zcc_task_express_run: 0,
        zcc_task_page_sync_run: 0,
        zcc_desktop_pet_last_run: 0
      });
    } catch (e) {}
    ['ship', 'canceled', 'express', 'pageSync', 'pet'].forEach(function (kind) {
      setTaskStatus(kind, '计时已重置，待切换店铺后自动执行', '');
    });
  }

  // 任务：自动切换店铺，复用原 manualRunSwitchOnce 轮转流程（force=true 跳过旧设置开关校验）
  async function runTaskSwitchShop() {
    if (__taskSwitchRunning) return; // 上一次未结束则跳过本轮
    __taskSwitchRunning = true; // 立即上锁，防止调度与补执行并发重入
    setTaskRunning('switchShop', true);
    setTaskStep('switchShop', 0);
    try {
      setTaskLastRun('zcc_task_switch_shop_run'); // 触发即记录本轮时间（失败也顺延）
      if (!(await zccHasToken())) { setTaskStatus('switchShop', '未登录智查查，无法执行', 'is-error'); return; }
      const queue = await getSwitchShopQueue();
      if (queue.length < 2) { setTaskStatus('switchShop', '绑定店铺不足2个，无法切换', 'is-error'); return; }
      // 重置其他任务计时移到 performSwitchToShop 真正开始切换时执行，避免倒计时等待期间被误触发
      setTaskStatus('switchShop', '', ''); // 刷新即结束，不留状态文字
      await manualRunSwitchOnce(true);
    } catch (e) {
      setTaskStatus('switchShop', '执行异常：' + ((e && e.message) || e), 'is-error');
    } finally {
      __taskSwitchRunning = false;
      setTaskRunning('switchShop', false);
      updateTaskNextTimes(false); // 只刷新显示，不在本页补执行其他任务（等切换刷新后自动执行）
    }
  }

  async function runTaskCanceledAssoc(manual) {
    if (__taskCanceledRunning) return; // 上一次未结束则跳过本轮
    __taskCanceledRunning = true; // 立即上锁，防止调度与补执行并发重入
    if (manual) setCanceledManualHint(false); // 用户手动执行过即清除“请手动执行”提醒
    setTaskRunning('canceled', true);
    setTaskStep('canceled', 0);
    try {
      setTaskLastRun('zcc_task_canceled_assoc_run'); // 触发即记录本轮时间（失败也顺延，避免到点补执行反复重试）
      if (!(await zccHasToken())) { setTaskStatus('canceled', '未登录智查查，无法执行', 'is-error'); return; }
      setTaskStatus('canceled', '正在读取已取消订单页...', 'is-checking');
      const read = await collectCanceledIdsViaTab();
      if (!read || !read.ok) {
        setTaskStatus('canceled', '读取失败：' + ((read && read.error) || '已取消订单页未加载出列表'), 'is-error');
        if (!manual) setCanceledManualHint(true); // 自动读取失败：机器人提醒用户手动执行一遍
        return;
      }
      const orders = read.orders || (read.ids || []).map(function (oid) { return { oid: oid, remark: '', que: false }; });
      const ids = orders.map(function (o) { return o.oid; });
      if (!ids.length) { setTaskStatus('canceled', '✅ 已取消订单页没有订单（0 个）', 'is-ok'); setTaskBindCount(0); setCanceledManualHint(false); return; }
      setTaskStep('canceled', 1);
      const foundMap = new Map(); // oid -> 关联单个数（主行 + extra.buy 附加采购单）
      const BATCH = 50; // 与已取消检测同一口径：主行 + extra.buy 附加采购单
      for (let i = 0; i < ids.length; i += BATCH) {
        setTaskStatus('canceled', '接口直查进度 ' + i + '/' + ids.length + '，已发现 ' + foundMap.size + ' 个仍关联订单', 'is-checking');
        const resp = await new Promise(function (resolve) {
          try { chrome.runtime.sendMessage({ type: 'ZCC_AFS_BIND_QUERY', orderIds: ids.slice(i, i + BATCH) }, resolve); }
          catch (e) { resolve(null); }
        });
        if (resp && resp.notLogin) { setTaskStatus('canceled', '京巴士未登录，无法查询，请先登录京巴士', 'is-error'); return; }
        if (!resp || !resp.ok) { setTaskStatus('canceled', '查询失败：' + ((resp && resp.error) || '接口异常'), 'is-error'); return; }
        const rows = (resp.data && resp.data.rows) || [];
        rows.forEach(function (row) {
          const oid = String(row.order_id || '').trim();
          if (!oid) return;
          const extra = row.extra && Array.isArray(row.extra.buy) ? row.extra.buy.length : 0;
          foundMap.set(oid, (foundMap.get(oid) || 0) + 1 + extra);
        });
      }
      const foundOrders = foundMap.size;
      let foundBinds = 0;
      foundMap.forEach(function (n) { foundBinds += n; });
      // 雀手中转仓取消订单（备注含“备”）：接口查不到关联单，也需统计提醒；与已关联订单去重
      const queOrders = orders.filter(function (o) { return o.que && !foundMap.has(o.oid); });
      const queCount = queOrders.length;
      const pendingTotal = foundBinds + queCount; // 待处理总数 = 关联单 + 中转仓订单
      const timeText = new Date().toTimeString().slice(0, 5);
      let summary;
      if (foundOrders || queCount) {
        summary = '⚠️ ' + (foundOrders ? foundOrders + ' 个订单仍关联（共 ' + foundBinds + ' 个关联单）' : '无采购关联单') +
          (queCount ? '，另有 ' + queCount + ' 个中转仓订单（备注含“备”）' : '');
      } else {
        summary = '✅ 无未取消关联单及中转仓订单';
      }
      setTaskStatus('canceled', ids.length + ' 个已取消订单：' + summary + ' · ' + timeText, (foundOrders || queCount) ? 'is-warn' : 'is-ok');
      setTaskBindCount(pendingTotal); // 头部角标/提醒卡片：关联单 + 中转仓订单都计入待处理
      setTaskStep('canceled', 2);
      setCanceledManualHint(false); // 自动执行成功完成，清除“请手动执行”提醒
      console.log('[定时任务] 已取消关联单统计：共 ' + ids.length + ' 单，仍关联 ' + foundOrders + ' 单（' + foundBinds + ' 个关联单），中转仓订单（备注含“备”）' + queCount + ' 个');
    } catch (e) {
      setTaskStatus('canceled', '执行异常：' + ((e && e.message) || e), 'is-error');
      if (!manual) setCanceledManualHint(true); // 自动执行异常也提醒手动执行一遍
    } finally {
      __taskCanceledRunning = false;
      setTaskRunning('canceled', false);
      destroyTaskFrame(__taskCanceledFrame); // 任务结束自动关闭小窗
      __taskCanceledFrame = null;
      updateTaskNextTimes();
    }
  }

  // 同步物流结果通过storage跨域回传；runId确保只读取本轮结果，避免误用上一次完成记录
  const EXPRESS_TASK_RESULT_KEY = 'zcc_task_express_result';
  function saveExpressTaskResult(runId, state, text, summary) {
    if (!runId) return;
    try {
      const value = {};
      value[EXPRESS_TASK_RESULT_KEY] = { runId: runId, state: state, text: text || '', summary: summary || '', finishedAt: Date.now() };
      chrome.storage.local.set(value);
    } catch (e) { console.warn('[定时任务] 保存物流执行结果失败', e); }
  }
  function readExpressTaskResult(runId) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([EXPRESS_TASK_RESULT_KEY], function (st) {
          const result = st && st[EXPRESS_TASK_RESULT_KEY];
          resolve(result && result.runId === runId ? result : null);
        });
      } catch (e) { resolve(null); }
    });
  }
  function extractExpressDialogSummary(dialog) {
    const text = String((dialog && (dialog.innerText || dialog.textContent)) || '').replace(/\u00a0/g, ' ');
    const total = text.match(/汇总采购订单\s*[：:]\s*(\d+)\s*条?/);
    const success = text.match(/发送成功\s*[：:]\s*(\d+)\s*条?/);
    const failed = text.match(/发送失败\s*[：:]\s*(\d+)\s*条?/);
    const parts = [];
    if (total) parts.push('汇总采购订单 ' + total[1] + ' 条');
    if (success) parts.push('发送成功 ' + success[1] + ' 条');
    if (failed) parts.push('发送失败 ' + failed[1] + ' 条');
    return parts.join(' · ');
  }
  function formatExpressTaskResult(result) {
    if (!result) return '';
    const stateText = result.text || (result.state === 'success' ? '发送完成' : result.state === 'interrupted' ? '任务中断' : '任务失败');
    const suffix = result.summary || (result.state === 'success' ? '详细数量未获取到' : '未获取到执行结果');
    return stateText + ' · ' + suffix;
  }

  // 任务2：载入京巴士物流状态页（与京东页跨域，按钮由小窗内 content.js 识别 zcc_auto_sync=1 后5秒自动点击）
  async function runTaskExpressSync() {
    if (__taskExpressRunning) return; // 上一次未结束则跳过本轮
    __taskExpressRunning = true; // 立即上锁，防止调度与补执行并发重入
    setTaskRunning('express', true);
    setTaskStep('express', 0);
    try {
      const last = await getTaskLastRun('zcc_task_express_run');
      const remainMs = TASK_EXPRESS_LOCK - (Date.now() - last);
      if (remainMs > 0) { // 5分钟执行窗口内不允许重复执行
        setTaskStatus('express', '同步执行中，约 ' + Math.ceil(remainMs / 60000) + ' 分钟后可再次执行', 'is-checking');
        return;
      }
      setTaskLastRun('zcc_task_express_run'); // 触发即记录本轮时间（失败也顺延，避免到点补执行反复重试）
      if (!(await zccHasToken())) { setTaskStatus('express', '未登录智查查，无法执行', 'is-error'); return; }
      const visible = await getTaskSwitch('zcc_task_express_view');
      const runId = 'express-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const frameUrl = 'https://pay.jingbashi.com/back.php/order/status?addtabs=1&zcc_auto_sync=1&zcc_sync_run=' + encodeURIComponent(runId);
      setTaskStatus('express', '正在通过小窗载入京巴士物流状态页...', 'is-checking');
      __taskExpressFrame = createTaskFrame('zcc-task-express-frame', frameUrl, visible, '京巴士 · 同步物流状态');
      setTaskStep('express', 1);
      setTaskStatus('express', '已载入，5秒后自动点击「同步物流状态(并发送取件码)」，本轮约需5分钟', 'is-checking');
      // 每秒检查小窗与本轮回传结果：完成/失败可提前结束，关闭或超时则明确提示未获取到结果
      const waitStart = Date.now();
      let frameClosed = false;
      let finalResult = null;
      while (Date.now() - waitStart < TASK_EXPRESS_LOCK) {
        const ref = __taskExpressFrame;
        if (!ref || !ref.wrap || !ref.wrap.isConnected) { frameClosed = true; break; }
        finalResult = await readExpressTaskResult(runId);
        if (finalResult) break;
        await zccSleep(1000);
      }
      if (!finalResult) finalResult = await readExpressTaskResult(runId); // 关闭前后可能刚写入结果，最后再补读一次
      const timeText = new Date().toTimeString().slice(0, 5);
      setTaskStep('express', 2);
      if (finalResult) {
        const cls = finalResult.state === 'success' ? 'is-ok' : finalResult.state === 'interrupted' ? 'is-warn' : 'is-error';
        setTaskStatus('express', formatExpressTaskResult(finalResult) + ' · ' + timeText, cls);
        console.log('[定时任务] 同步物流执行结果：', finalResult);
      } else if (frameClosed) {
        setTaskStatus('express', '任务中断 · 小窗已关闭，未获取到执行结果 · ' + timeText, 'is-warn');
        console.log('[定时任务] 同步物流小窗被关闭，未获取到执行结果');
      } else {
        setTaskStatus('express', '任务失败 · 同步超时，未获取到执行结果 · ' + timeText, 'is-error');
        console.log('[定时任务] 同步物流超时，未获取到执行结果');
      }
    } catch (e) {
      setTaskStatus('express', '任务失败 · ' + ((e && e.message) || e) + '，未获取到执行结果', 'is-error');
    } finally {
      __taskExpressRunning = false;
      setTaskRunning('express', false);
      destroyTaskFrame(__taskExpressFrame); // 任务结束自动关闭小窗
      __taskExpressFrame = null;
      updateTaskNextTimes();
    }
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
      if (high + medium > 0) addJumpRiskButton(high + medium);
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
        ? `<div class="orange-zcc-cross-orders">
             <span class="orange-zcc-cross-orders-title">🔄 跨店下单:</span>
             <div class="orange-zcc-cross-orders-list">
               ${risk.crossShopOrders.slice(0, 5).map(o =>
                 `<span class="orange-zcc-cross-order orange-zcc-clickable" data-action="goRiskSearch" title="${maskShopName(o.ownerAccount)}的小店">
                   <span class="orange-zcc-cross-time">${o.time}</span>
                   <span class="orange-zcc-cross-amount">￥${Number(o.amount).toFixed(1)}</span>
                 </span>`
               ).join('')}
             </div>
           </div>` : '';

      // 智查查关联单操作区：紧跟举报按钮增加新增台账入口，订单号直接绑定当前卡片
      const ledgerBtnHtml = risk.orderNo
        ? `<button class="zcc-order-ledger-btn" data-order-no="${risk.orderNo}" title="自动填入当前订单号并新增台账">📒</button>` : '';

      bar.innerHTML = `
        <span class="orange-zcc-risk-icon">${icon}</span>
        <span class="orange-zcc-risk-level">${levelText}</span>
        ${accountHtml}
        ${addressHtml}
        ${similarityHtml}
        ${tagsHtml}
        ${reportBtnHtml}${ledgerBtnHtml}
        ${crossShopOrdersHtml}
      `;

      // 绑定举报按钮点击事件
      const reportBtn = bar.querySelector('.orange-zcc-report-btn');
      if (reportBtn) {
        reportBtn.addEventListener('click', () => {
          openReportModal(risk.orderNo);
        });
      }


      // 绑定跨店订单点击跳转风险检测页
      const crossOrderEls = bar.querySelectorAll('.orange-zcc-clickable');
      crossOrderEls.forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          window.open(CONFIG.riskSearchUrl, '_blank');
        });
      });
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
  // 旧定时调度（autoShip/执行间隔/执行时段/自动同步物流）已随设置项一并移除，定时任务列表独立调度

  let isAutoShipping = false;     // 防止并发执行
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

    // 查单发货只操作京东页面，未登录智查查也可执行；执行时段由定时任务列表统一控制，不再读取旧设置

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

  // ==================== 自动切换店铺批量查单发货 ====================
  // 设计说明：切换店铺会导致页面刷新，内存状态全部丢失，
  // 因此调度进度统一持久化到 chrome.storage.local 的 shop_switch_state，
  // 页面刷新后由定时任务面板检测 phase='switching' 并恢复执行。

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
    // 真正开始切换店铺时才重置其他任务计时与状态（不要在30秒倒计时等待时提前重置，避免等待期间被误触发）
    resetOtherTaskTimers();
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
        console.log('%c[切换店铺] 当前页检测到已切换到目标店铺（局部切换），主动刷新页面后由恢复流程统一发货', 'color:#67c23a;font-weight:bold;');
        updateShipStatus(`🔁 已切换到【${shop.shopName}】，正在刷新页面...`, 'info');
        // 局部切换不会整页刷新：主动reload一次，保持 phase='switching'，由新页面 init 的 resumeAfterSwitch 接管
        // 注意：整页刷新路径不在这里，reload只发生这一次，不会循环刷新
        setTimeout(function () { location.reload(); }, 800);
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
      return;
    }

    // 执行时段由定时任务面板统一控制，此处不再读取旧设置判断

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
        // 2) 页面不刷新（局部切换）→ 由 watchSwitchOnSamePage 持续轮询，店铺一切换到位就主动reload，再由新页面恢复发货。
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
      setTaskStatus('ship', `🚚 正在为【${shop.shopName}】批量查单发货...`, 'is-checking');
      console.log(`%c[切换店铺] 开始为【${shop.shopName}】执行批量查单发货`, 'color:#409eff;font-weight:bold;');
      // 复用既有发货流程：manual=true 跳过时段判断；切换模式不依赖 lastShipTime
      const ok = await runBatchShipOnce(true);
      console.log(`%c[切换店铺]【${shop.shopName}】查单发货结束，结果：${ok ? '成功' : '存在失败'}`, ok ? 'color:#67c23a;' : 'color:#e6a23c;');
      setTaskStatus('ship', (ok ? '✅' : '⚠️') + `【${shop.shopName}】查单发货${ok ? '完成' : '存在失败'} · ` + new Date().toTimeString().slice(0, 5), ok ? 'is-ok' : 'is-error');
    } catch (e) {
      console.error(`[切换店铺]【${shop.shopName}】发货异常:`, e);
      updateShipStatus(`❌【${shop.shopName}】发货异常：${e.message}`, 'error');
      setTaskStatus('ship', `❌【${shop.shopName}】发货异常：${e.message}`, 'is-error');
    } finally {
      isSwitchingShop = false;
      await advanceAfterShop(queue, state, '发货结束');
    }
  }

  /**
   * 页面刷新后恢复：等待店铺切换完成 → 发货 → 推进
   */
  // 轮询等待“批量查单发货”按钮出现（绕过缓存硬刷后页面/微应用重新初始化较慢）
  function waitForBatchShipBtn(timeout) {
    timeout = timeout || 30000;
    return new Promise(function (resolve) {
      const start = Date.now();
      const check = function () {
        try {
          const btn = typeof findBatchShipBtn === "function" ? findBatchShipBtn() : null;
          if (btn) return resolve(btn);
        } catch (e) {}
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(check, 3000); // 每3秒检测一次
      };
      check();
    });
  }

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
      setTaskStatus('switchShop', `正在确认目标店铺【${shop.shopName}】...`, 'is-checking');
      renderSwitchPlan(queue.length ? queue : [shop], state);

      // 等待当前店铺变为目标店铺
      await waitForCurrentShop(shop.shopId, shop.shopName, switchCfg('shopChangeTimeout', 30000));

      console.log(`%c[切换店铺] 已成功切换到【${shop.shopName}】，等待订单页就绪后发货`, 'color:#67c23a;');
      updateShipStatus(`⏳ 已切换到【${shop.shopName}】，等待订单页加载完成...`, 'info');
      setTaskStatus('switchShop', `已切换到【${shop.shopName}】，等待订单页就绪...`, 'is-checking');
      // 轮询等待“批量查单发货”按钮真正渲染出来（最多30秒），避免页面未就绪就发货
      const shipBtnReady = await waitForBatchShipBtn(30000);
      if (!shipBtnReady) {
        throw new Error(`切换到【${shop.shopName}】后，订单页长时间未加载出“批量查单发货”按钮，本次跳过待下轮重试`);
      }
      await new Promise(r => setTimeout(r, 1000)); // 按钮出现后再稳1秒
      updateShipStatus(`✅ 已切换到【${shop.shopName}】，准备发货`, 'success');

      // 用恢复后的完整队列推进；若队列取不到则用单店兜底
      const useQueue = queue.length ? queue : [shop];
      const useState = queue.length ? state : Object.assign({}, state, { index: 0 });
      await shipForShopAndAdvance(useQueue, useState, shop);
      // 恢复流程结束：切换任务刷新即结束，不保留“正在切换”类文字；发货结果在查单发货任务状态中查看
      setTaskRunning('switchShop', false);
      setTaskStatus('switchShop', '', '');
      updateTaskNextTimes();
    } catch (e) {
      console.error('[切换店铺] 恢复切换流程失败:', e);
      updateShipStatus(`❌ ${e.message}`, 'error');
      setTaskStatus('switchShop', '恢复失败：' + ((e && e.message) || e), 'is-error');
      setTaskRunning('switchShop', false);
      isSwitchingShop = false;
      // 容错：切换恢复失败也推进到下一店，避免卡死整个轮转
      if (queue.length) {
        await advanceAfterShop(queue, state, '恢复失败');
      } else {
        state.phase = 'idle';
        state.targetShopId = '';
        await saveShopSwitchState(state);
      }
    }
  }

  /**
   * 手动立即执行一次"切换店铺批量查单发货"（面板按钮触发，不受时段限制）
   * force=true 供定时任务调用：跳过旧设置中"定时查单发货/自动切换店铺"开关校验
   */
  async function manualRunSwitchOnce(force) {
    if (!checkExtensionContext()) return;
    if (isSwitchingShop) {
      updateShipStatus('🔁 店铺切换正在执行中，请勿重复触发', 'info');
      console.log('[切换店铺] 手动触发被拦截：上一次切换尚未结束');
      return;
    }
    if (!(await zccHasToken())) {
      updateShipStatus('⚠️ 未登录或账号已停用，自动切换店铺不可用', 'error');
      return;
    }
    // 旧设置开关（定时查单发货/自动切换店铺）已移除，切换任务由定时任务面板触发
    const queue = await getSwitchShopQueue();
    if (queue.length < 2) {
      updateShipStatus('🔁 绑定店铺不足2个，无法切换，可直接用标题栏🚚发货', 'error');
      console.warn('[切换店铺] 手动触发失败：绑定店铺不足2个', queue);
      return;
    }

    // 取消正在等待的自动调度与倒计时，避免重复
    if (shopSwitchTimer) { clearTimeout(shopSwitchTimer); shopSwitchTimer = null; }
    removeSwitchCountdown();

    const minutes = 70; // 固定每1小时10分，与定时任务面板 TASK_SWITCH_SHOP_INTERVAL 一致
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
    state.shopNextAt = estimateShopNextAt(queue, state.index, Date.now());
    await saveShopSwitchState(state);
    renderSwitchPlan(queue, state);

    const shop = queue[state.index];
    console.log('%c[切换店铺] 手动触发：立即开始切换店铺发货，首个目标【' + (shop ? shop.shopName : '-') + '】', 'color:#f56c6c;font-weight:bold;');
    updateShipStatus(`🔁 手动触发，立即切换到【${shop ? shop.shopName : '-'}】`, 'info');
    await beginCurrentShop(queue, state, {}, true);
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

    // 执行时段由定时任务面板统一控制，此处不再读取旧设置判断
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

      // 记录本次执行时间（保留历史运行时间戳，旧调度已移除）
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

  // ==================== 消息监听 ====================

  // 采集专用页面（小窗 iframe 或后台标签页）：确保切到“已取消”标签，并把读到的订单号主动回传给父页面，
  // 这样即使父页面因跨域/风控读不到 iframe 的 DOM，也能拿到结果
  function setupCanceledCollector() {
    document.title = '正在检测取消单，请勿操作';
    let clicked = false;
    const t0 = Date.now();
    const timer = setInterval(function () {
      document.title = '正在检测取消单，请勿操作'; // 京东SPA可能改写标题，采集期间持续保持警示
      if (!clicked) {
        const ctab = document.getElementById('tab-canceled');
        if (ctab) { clicked = true; try { ctab.click(); } catch (e) {} }
      }
      const orders = extractCanceledOrdersFromDoc(document);
      const ids = orders.map(function (o) { return o.oid; });
      try { window.parent.postMessage({ type: 'ZCC_COLLECT_CANCELED_PAGE_RESULT', orders: orders, ids: ids, url: location.href }, '*'); } catch (e) {}
      try { chrome.runtime.sendMessage({ type: 'ZCC_COLLECT_CANCELED_PAGE_RESULT', orders: orders, ids: ids, url: location.href }); } catch (e) {}
      if (orders.length || Date.now() - t0 > 40000) clearInterval(timer);
    }, 1500);
  }
  
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'ZCC_COLLECT_CANCELED_PAGE': {
        // 后台采集标签页被 SW 轮询读取：返回当前已取消订单页的订单（含备注“备”标记）与就绪信息
        const orders = extractCanceledOrdersFromDoc(document);
        const text = document.body ? document.body.innerText : '';
        sendResponse({
          ok: true,
          orders: orders,
          ids: orders.map(function (o) { return o.oid; }),
          url: location.href,
          hasOrderText: /订单号|暂无|没有.*订单/.test(text),
          emptyList: !document.querySelector(SELECTORS.orderCard) && /暂无.*订单|没有.*订单|暂无数据/.test(text)
        });
        break;
      }
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
        // 每次同步只接收自己的回包；上一轮迟到的结果不得覆盖本轮状态或触发风险检测
        if ((message.payload.syncId || '') !== __taskPageSyncActiveId) {
          console.warn('[订单同步] 忽略非当前任务的回包', message.payload.syncId, __taskPageSyncActiveId);
          break;
        }
        // 同步当前页订单：直接展示后台真实入库结果，不再把“采集到已取消订单”误写成像已录入的数量
        if (__taskPageSyncWaitingResult) {
          __taskPageSyncWaitingResult = false;
          clearTimeout(__taskPageSyncResultTimer);
          if (message.payload.success) {
            const result = message.payload;
            const inserted = Number(result.insert) || 0;
            const updated = Number(result.update) || 0;
            const skipped = Number(result.skipCanceled) || 0;
            const existed = Number(result.skipExisting) || 0;
            const pending = Number(result.skipPending) || 0;
            const strictRules = Array.isArray(result.processOrderNos);
            const statusText = Object.keys(result.statusSummary || {}).map(function (s) { return s + ' ' + result.statusSummary[s] + ' 条'; }).join('、');
            let text = (inserted + updated > 0)
              ? '已录入：新增 ' + inserted + ' 条，' + (strictRules ? '取消覆盖 ' : '覆盖更新 ') + updated + ' 条'
              : '本次无订单入库';
            if (statusText) text = statusText + '；' + text;
            if (skipped) text += '，首次已取消 ' + skipped + ' 条未处理';
            if (existed) text += '，已存在订单 ' + existed + ' 条未重复覆盖';
            if (pending) text += '，待付款 ' + pending + ' 条未入库';
            const doneAt = new Date(), pad = n => String(n).padStart(2, '0');
            const doneTime = doneAt.getFullYear() + '-' + pad(doneAt.getMonth() + 1) + '-' + pad(doneAt.getDate()) + ' ' + pad(doneAt.getHours()) + ':' + pad(doneAt.getMinutes()) + ':' + pad(doneAt.getSeconds());
            setTaskStatus('pageSync', text + ' · ' + doneTime, 'is-done');
          } else {
            setTaskStatus('pageSync', '入库失败：' + (message.payload.message || message.payload.msg || '未知错误'), 'is-error');
          }
        }
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
          // 页面关联单/风险展示与数据库入库限制分开：普通已存在订单虽然不重复覆盖，但仍要正常显示关联单
          // 仅排除待付款和后台明确返回“首次出现已取消、未入库”的订单，这两类不做后续检测
          const skippedCanceledNos = new Set(result.skippedCanceledOrderNos || []);
          const riskOrders = (window.__lastScrapedOrders || []).filter(function (o) {
            const orderNo = o.orderId || o.orderNo;
            return String(o.orderStatus || '').indexOf('待付款') === -1 && !skippedCanceledNos.has(orderNo);
          });
          if (riskOrders.length) setTimeout(function () { batchRiskCheck(riskOrders); }, 300);
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
        // 旧定时调度已移除，设置保存不再重启任何定时器；定时任务面板独立调度
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
      // 登录/退出登录后重建定时任务面板：刷新各任务开关与顶部图标的禁用状态，避免仍按旧登录态显示
      if (isTargetPage() && document.getElementById('zcc-task-panel')) {
        removeTaskPanel();
        setupTaskPanel();
      }
    }
  });

  // ==================== 初始化 ====================
  
  // ==================== 插件版本检查 ====================

  // 比较语义化版本号，v1 > v2 返回 1，相等 0，小于 -1
  function compareVersion(v1, v2) {
    const parts1 = String(v1).split('.').map(n => parseInt(n) || 0);
    const parts2 = String(v2).split('.').map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const a = parts1[i] || 0;
      const b = parts2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  }

  async function checkNewVersion() {
    console.log('[版本检查] 开始检查，当前版本:', CONFIG.version);
    try {
      const msgResp = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'CHECK_LATEST_VERSION' }, r => resolve(r));
      });
      if (!msgResp || !msgResp.success) throw new Error((msgResp && msgResp.msg) || '请求失败');
      const json = msgResp.data;
      console.log('[版本检查] 接口返回:', json);
      if (json.code !== 0 || !json.data) return;
      const latest = json.data;
      if (compareVersion(latest.version, CONFIG.version) <= 0) {
        console.log('[版本检查] 当前已是最新版本，不提示');
        return;
      }
      const snoozeDate = localStorage.getItem('zcc_update_snooze_date');
      const nowD = new Date();
      const todayStr = nowD.getFullYear() + '-' +
        String(nowD.getMonth() + 1).padStart(2, '0') + '-' +
        String(nowD.getDate()).padStart(2, '0');
      if (snoozeDate === todayStr) { console.log('[版本检查] 今日已选择不再提醒'); return; }
      console.log('[版本检查] 发现新版本，弹窗提示');
      showUpdateModal(latest);
    } catch (e) {
      console.error('[版本检查] 失败（不影响使用）:', e);
    }
  }

  function formatVersionDate(d) {
    if (!d) return '-';
    const date = new Date(d);
    if (isNaN(date.getTime())) return String(d).substring(0, 10);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function showUpdateModal(latest) {
    const exist = document.getElementById('zcc-update-toast');
    if (exist) exist.remove();

    const toast = document.createElement('div');
    toast.id = 'zcc-update-toast';
    toast.className = 'zcc-update-toast';
    toast.innerHTML = `
      <button class="zcc-toast-close" id="zcc-toast-close">×</button>
      <div class="zcc-toast-new"><span class="zcc-toast-icon">🎉</span>发现新版本 <b>v${latest.version}</b><span class="zcc-toast-time">更新时间：${formatVersionDate(latest.releaseDate)}</span></div>
      <div class="zcc-toast-desc">${latest.changelog || '-'}</div>
      <div class="zcc-toast-actions">
        <button class="zcc-toast-btn zcc-toast-ignore" id="zcc-toast-ignore">今日不再提醒</button>
        <button class="zcc-toast-btn zcc-toast-primary" id="zcc-toast-go">立即更新</button>
      </div>
      <div class="zcc-toast-footer">智查查风控系统 v${CONFIG.version}</div>`;
    document.body.appendChild(toast);
    // console.log('[版本检查] 通知条已创建，尺寸:', toast.offsetWidth, toast.offsetHeight, '元素:', toast);
    // 强制内联样式兜底，确保可见
    toast.style.cssText += 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#fff;display:block;box-shadow:0 8px 30px rgba(0,0,0,.15);border-radius:10px;';

    let autoCloseTimer;
    const close = () => { clearTimeout(autoCloseTimer); toast.remove(); };
    // 20秒无操作自动关闭
    autoCloseTimer = setTimeout(close, 20000);
    // 鼠标移入暂停自动关闭，移出重新计时
    toast.addEventListener('mouseenter', () => clearTimeout(autoCloseTimer));
    toast.addEventListener('mouseleave', () => { autoCloseTimer = setTimeout(close, 20000); });

    toast.querySelector('#zcc-toast-close').addEventListener('click', close);
    toast.querySelector('#zcc-toast-ignore').addEventListener('click', () => {
      const d = new Date();
      const ds = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      localStorage.setItem('zcc_update_snooze_date', ds);
      console.log('[版本检查] 已设置今日不再提醒:', ds);
      close();
    });
    toast.querySelector('#zcc-toast-go').addEventListener('click', () => {
      window.open(CONFIG.extensionDownloadUrl, '_blank');
      close();
    });
  }

  async function init() {
    console.log('%c[版本检查] init已启动，5秒后检查更新', 'color:#e6a23c;font-weight:bold');
    // 延迟5秒检查插件新版本
    setTimeout(checkNewVersion, 5000);

    // 京巴士物流状态页
    // 京巴士页面：启动辅助手动关联订单（不影响物流页逻辑）
    // 全局绑定辅助手动关联订单（事件委托，仅点到关联按钮才动作，无副作用）
    bindAssistAssociate();
    bindAutoConfirmVirtual();

    if (isExpressPage()) {
      if (document.readyState === 'loading') {
        await new Promise(resolve => {
          document.addEventListener('DOMContentLoaded', resolve);
        });
      }

      // 定时任务小窗模式：由待出库定时任务面板载入，独立轮询按钮（最多40秒），找到后5秒自动点击“同步物流状态(并发送取件码)”，不加载浮动面板与既有定时器
      if (/[?&]zcc_auto_sync=1/.test(window.location.href)) {
        const runMatch = window.location.href.match(/[?&]zcc_sync_run=([^&]+)/);
        const autoRunId = runMatch ? decodeURIComponent(runMatch[1]) : '';
        let autoResultFinished = false;
        let autoResultMonitor = null;
        let autoHadDialog = false;
        const autoMonitorStart = Date.now();
        const finishAutoExpressResult = function (state, text, summary) {
          if (autoResultFinished) return;
          autoResultFinished = true;
          if (autoResultMonitor) { clearInterval(autoResultMonitor); autoResultMonitor = null; }
          saveExpressTaskResult(autoRunId, state, text, summary);
        };
        // 独立监听执行记录：成功/失败立即回传；弹窗中途关闭或超时也回传明确结果
        autoResultMonitor = setInterval(function () {
          if (autoResultFinished) return;
          const dialog = document.querySelector('.jbs-send-express-modal');
          if (dialog) {
            autoHadDialog = true;
            const statusEl = dialog.querySelector('.jbs-sync-buy-log-status');
            const state = statusEl ? (statusEl.getAttribute('data-state') || '') : '';
            const text = statusEl ? statusEl.textContent.trim() : '';
            if (state === 'success' || text.includes('发送完成')) {
              finishAutoExpressResult('success', text || '发送完成', extractExpressDialogSummary(dialog));
              return;
            }
            if (state === 'error' || state === 'warning') {
              finishAutoExpressResult('error', text || '任务失败', extractExpressDialogSummary(dialog));
              return;
            }
          } else if (autoHadDialog) {
            finishAutoExpressResult('interrupted', '任务中断', '同步弹窗已关闭，执行结果未获取到');
            return;
          }
          if (Date.now() - autoMonitorStart >= TASK_EXPRESS_LOCK) {
            finishAutoExpressResult('error', '任务失败', '同步超时，未获取到执行结果');
          }
        }, 1000);
        let waited = 0;
        const findTimer = setInterval(function () {
          waited += 1000;
          const syncBtn = document.querySelector('a.sendExpressPrivacy');
          if (syncBtn) {
            clearInterval(findTimer);
            setTimeout(function () {
              try {
                syncBtn.click();
                console.log('[定时任务] 已自动点击同步物流状态(并发送取件码)');
                // 点击后约3秒弹出 zeromodal 同步弹窗，需再点“开始发送”才真正执行；轮询等待弹窗按钮（最多15秒）
                let modalWaited = 0;
                const modalTimer = setInterval(function () {
                  modalWaited += 1000;
                  const startBtn = document.querySelector('.jbs-send-express-modal .zeromodal-btn-primary');
                  if (startBtn) {
                    clearInterval(modalTimer);
                    startBtn.click();
                    console.log('[定时任务] 已自动点击弹窗“开始发送”，同步开始执行');
                  } else if (modalWaited >= 15000) {
                    clearInterval(modalTimer);
                    console.log('[定时任务] 15秒内未出现同步弹窗，未点击开始发送');
                    finishAutoExpressResult('error', '任务失败', '未出现同步弹窗，未获取到执行结果');
                  }
                }, 1000);
              } catch (e) {
                console.error('[定时任务] 自动点击同步物流状态失败', e);
                finishAutoExpressResult('error', '任务失败', ((e && e.message) || String(e)) + '，未获取到执行结果');
              }
            }, 5000);
          } else if (waited >= 40000) {
            clearInterval(findTimer);
            console.log('[定时任务] 小窗内40秒未找到同步物流按钮，本轮放弃');
            finishAutoExpressResult('error', '任务失败', '未找到同步物流按钮，未获取到执行结果');
          }
        }, 1000);
        return;
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
      // 旧浮动面板与定时同步物流调度已移除，仅保留手动 RUN_SYNC_EXPRESS 入口
      return;
    }

    if (!isTargetPage()) {
      console.log('[京东订单抓取] 当前不是订单页面');
      return;
    }

    // 采集专用页面（?zcc_collect=1）：只提供订单号读取能力，不渲染面板、不启动定时任务，避免重复执行
    if (/[?&]zcc_collect=1/.test(window.location.search)) {
      if (window.top !== window.self) {
        // 小窗 iframe 内：只回传订单号，不注入任何脚本/样式，避免影响京东页渲染
        console.log('[京东订单抓取] 采集小窗页面，仅回传订单号');
      } else {
        console.log('[京东订单抓取] 采集专用页面，跳过面板与任务初始化');
      }
      setupCanceledCollector();
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
      // 旧“智查查同步助手”浮动面板已移除，功能均在定时任务面板

      // 查单发货已迁移到“定时任务”面板（固定30分钟），旧定时调度已全部移除
      // 点击订单标签（全部/待付款/待出库/已出库/暂停/锁定/已完成）5秒后自动同步风险检测
      bindOrderTabClick();
      // 直接打开/刷新“已取消”页：同样5秒/10秒后各检测一遍采购关联单
      if (window.location.href.indexOf('tabType=canceled') !== -1) {
        scheduleCanceledAssocCheck();
      }
      // 订单列表所有标签页（全部/待付款/待出库/已出库/暂停/锁定/已完成/已取消）都显示定时任务面板
      setupTaskPanel();

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
        if (!(await zccHasToken())) {
          updateStatus('⚠️ 未登录或账号已停用，已暂停自动同步', 'warning');
          console.log('[自动同步] 未登录或账号已停用，跳过自动抓取');
          return;
        }
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

  // ==================== 点击订单标签后自动同步风险检测 ====================
  const ORDER_TAB_IDS = ['tab-allOrders', 'tab-notPay', 'tab-waitOut', 'tab-hadOut', 'tab-suspend', 'tab-locked', 'tab-completed', 'tab-canceled'];
  let __tabSyncTimer = null;
  let __tabTickTimer = null;
  let __orderTabVersion = 0; // 每次切换订单tab递增，用于作废切换前尚未上传的旧列表采集结果
  // ==================== 辅助手动关联订单（京巴士） ====================
  function assistToast(msg, type) {
    const exist = document.getElementById('zcc-assist-toast');
    if (exist) exist.remove();
    const t = document.createElement('div');
    t.id = 'zcc-assist-toast';
    t.className = 'zcc-assist-toast ' + (type === 'error' ? 'is-error' : type === 'success' ? 'is-success' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => t.remove(), 2800);
  }

  // 以原生方式赋值并派发事件，确保页面框架（element/layui）能感知
  function setNativeValue(el, value) {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 拼多多采购订单号：6位数字-15位数字，如 260930-572585480502505
  function isValidPddOrderNo(text) {
    return /^\d{6}-\d{15}$/.test(String(text || '').trim());
  }

  async function readClipboardText() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        return await navigator.clipboard.readText();
      }
    } catch (e) {
      console.warn('[辅助关联] 读取剪贴板失败:', e);
    }
    return '';
  }

  function waitForAssistField(selector, timeout) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) { clearInterval(timer); resolve(el); }
        else if (Date.now() - start > timeout) { clearInterval(timer); resolve(null); }
      }, 200);
    });
  }

  async function fillAssistAssociateDialog(pddOrderNo) {
    // 等待弹窗表单出现（页面动态渲染）
    const platform = await waitForAssistField('#j_associationBuyOrderBody-buy-platform', 4000);
    if (!platform) {
      console.log('[辅助关联] 未出现关联弹窗');
      return;
    }
    // 1) 采购来源选 拼多多(value=3)
    setNativeValue(platform, '3');

    // 2) 采购订单号（来自剪贴板，校验格式）
    const orderInput = document.querySelector('#j_associationBuyOrderBody-buy-order-id');
    const no = (pddOrderNo || '').trim();
    if (!no) {
      assistToast('剪贴板没有采购订单号，请先复制拼多多订单号', 'error');
    } else if (!isValidPddOrderNo(no)) {
      assistToast('采购订单号格式不正确（应为 260930-572585480502505 形式）', 'error');
    } else if (orderInput) {
      setNativeValue(orderInput, no);
      assistToast('已选拼多多并填入采购订单号', 'success');
    }

    // 3) 自动勾选商品列表中的第一个
    const checkboxes = document.querySelectorAll('.j_associationBuyOrderBody .association-checkbox-input');
    if (checkboxes.length > 0) {
      const first = checkboxes[0];
      if (!first.checked) first.click();
    }
  }

  function bindAssistAssociate() {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest && e.target.closest('.j_associationBuyOrder');
      if (!btn) return;
      // console.log('[辅助关联] 捕获到手动关联订单按钮点击');
      // 读取开关
      const settings = await new Promise(r =>
        chrome.storage.local.get('jd_settings', s => r(s.jd_settings || {})));
      if (!settings.assistAssociate) { console.log('[辅助关联] 开关未开启，不处理'); return; }
      if (!(await zccHasToken())) { console.log('[辅助关联] 未登录或账号停用，不处理'); return; }
      // console.log('[辅助关联] 开关已开启，开始自动填写');

      assistToast('辅助关联订单已开启，正在自动填写...', 'info');
      // 在用户手势上下文内立即读取剪贴板
      const clip = await readClipboardText();
      const pddOrderNo = (clip || '').replace(/\s+/g, '');
      // 弹窗约1秒后渲染，出现即填写
      setTimeout(() => fillAssistAssociateDialog(pddOrderNo), 600);
    }, true);
    console.log('[辅助关联订单] 已启动');
  }

  // ==================== 自动确认“查看虚拟号”弹窗（点击采购下单后） ====================
  let __virtualConfirmTimer = null;

  function findVirtualMessageBox() {
    const boxes = Array.from(document.querySelectorAll('.jd-message-box'));
    for (const box of boxes) {
      if (box.offsetParent === null) continue;
      const title = box.querySelector(".jd-message-box__title");
      if (title && (title.textContent || "").indexOf("虚拟号") !== -1) return box;
    }
    return null;
  }

  function clickVirtualConfirm(box) {
    let btn = box.querySelector(".jd-message-box__btns button.jd-button--primary");
    if (!btn) {
      const btns = Array.from(box.querySelectorAll(".jd-message-box__btns button"));
      btn = btns.find(function (b) { return (b.textContent || "").trim() === "确定"; }) || btns[0];
    }
    if (btn) { btn.click(); return true; }
    return false;
  }

  // 点击采购下单后：每2秒查一次弹窗，最多10秒
  function startVirtualConfirmWatch() {
    if (__virtualConfirmTimer) clearInterval(__virtualConfirmTimer);
    const start = Date.now();
    __virtualConfirmTimer = setInterval(function () {
      const box = findVirtualMessageBox();
      if (box) {
        clearInterval(__virtualConfirmTimer);
        __virtualConfirmTimer = null;
        if (clickVirtualConfirm(box)) {
          assistToast('已自动确认查看虚拟号', 'success');
          console.log("[自动确认虚拟号] 已点击弹窗“确定”");
        }
        return;
      }
      if (Date.now() - start >= 10000) {
        clearInterval(__virtualConfirmTimer);
        __virtualConfirmTimer = null;
        assistToast('未发现「确定查看虚拟号吗」弹窗', 'error');
        console.log("[自动确认虚拟号] 10秒内未发现弹窗，结束任务");
      }
    }, 2000);
  }

  function bindAutoConfirmVirtual() {
    document.addEventListener('click', async function (e) {
      const btn = e.target.closest && e.target.closest('.j_BuyOrder');
      if (!btn) return; // 仅采购下单按钮（采购下单1/2/3…，事件委托天然支持多个）
      const settings = await new Promise(function (r) {
        chrome.storage.local.get("jd_settings", function (st) { r((st && st.jd_settings) || {}); });
      });
      if (!settings.autoConfirmVirtual) return;
      if (!(await zccHasToken())) return;
      assistToast('已开启自动确认查看虚拟号功能', 'info');
      startVirtualConfirmWatch();
    }, true);
    console.log("[自动确认虚拟号] 已启动");
  }


  function bindOrderTabClick() {
    // 事件委托，标签动态渲染也能生效；捕获阶段确保收到点击
    document.addEventListener('click', (e) => {
      const tab = e.target.closest && e.target.closest('.jd-tabs__item');
      if (!tab || ORDER_TAB_IDS.indexOf(tab.id) === -1) return;
      // console.log('[标签点击] 订单标签:', tab.id);
      if (tab.id === 'tab-canceled') {
        scheduleCanceledAssocCheck(); // 5秒/10秒后各独立检测一遍已取消关联单
      } else {
        removeAssocUI();
      }
      // 订单列表所有标签页都显示定时任务面板，切换标签只确保面板存在，后台计时继续
      setupTaskPanel();
      removeUnboughtUI();
      scheduleTabSync(tab.id);
    }, true);
  }
  function getActiveOrderTabId() {
    const active = document.querySelector('.jd-tabs__item.is-active, .jd-tabs__item[aria-selected="true"]');
    if (active && ORDER_TAB_IDS.indexOf(active.id) !== -1) return active.id;
    const tabType = (window.location.href.match(/[?&]tabType=([^&]+)/) || [])[1] || '';
    const tabMap = { all: 'tab-allOrders', allOrders: 'tab-allOrders', notPay: 'tab-notPay', waitOut: 'tab-waitOut', hadOut: 'tab-hadOut', suspend: 'tab-suspend', locked: 'tab-locked', completed: 'tab-completed', canceled: 'tab-canceled' };
    return tabMap[tabType] || '';
  }

  function getCurrentOrderCards() {
    // 直接读取页面全部订单卡片，由 parseOrderItem 逐行校验订单号并读取状态
    // 不使用可见性、getClientRects或tab状态过滤，避免后台标签页/京东特殊布局被误判为空页
    return Array.from(document.querySelectorAll(SELECTORS.orderCard));
  }

  function getExpectedStatusByTabId(tabId) {
    const statusMap = {
      'tab-notPay': '待付款',
      'tab-waitOut': '待出库',
      'tab-hadOut': '已出库',
      'tab-completed': '已完成',
      'tab-locked': '锁定',
      'tab-canceled': '已取消'
    };
    return statusMap[tabId] || '';
  }

  function getCurrentOrderListSignature() {
    const cards = getCurrentOrderCards();
    return cards.map(function (card) {
      const id = card.getAttribute('data-jbs-order-id') || safeText(card, SELECTORS.orderId);
      const status = safeText(card, SELECTORS.orderStatus);
      return id + ':' + status;
    }).join('|');
  }

  function isCurrentListMatchedTab(tabId) {
    const expectedStatus = getExpectedStatusByTabId(tabId);
    if (!expectedStatus) return true;
    const cards = getCurrentOrderCards();
    return cards.length > 0 && cards.every(function (card) {
      return safeText(card, SELECTORS.orderStatus) === expectedStatus;
    });
  }

  async function waitForTabOrderListReady(tabId, oldSignature) {
    // 京东SPA切tab后旧卡片会短暂保留；按实际页面验证固定等待10秒，再读取当前列表
    // oldSignature 参数保留供调用方记录切换前列表；10秒后不再要求订单号必须变化，因为不同tab可能恰好是同一批订单
    await new Promise(function (r) { setTimeout(r, 10000); });
    // 不再做tab状态匹配，只要当前可见订单卡片已渲染即可；每张卡片独立按订单号和真实状态采集
    return !!getCurrentOrderListSignature();
  }

  // 切换订单标签：立即执行一次「同步当前页订单」定时任务（不再等5秒倒计时）；若页面列表尚未渲染，1.5秒后补一次
  // “立即执行”指点击后马上进入同步流程，实际采集会等京东新列表替换完成，避免把旧tab状态上传
  async function scheduleTabSync(tabId) {
    clearTimeout(__tabSyncTimer);
    clearInterval(__tabTickTimer);
    const oldSignature = getCurrentOrderListSignature();
    const tabVersion = ++__orderTabVersion;
    updateStatus('🔄 已切换订单标签，等待新列表加载后同步...', 'info');
    setTaskStatus('pageSync', '等待当前标签的新订单列表加载...', 'is-checking');
    try {
      const ready = await waitForTabOrderListReady(tabId, oldSignature);
      if (tabVersion !== __orderTabVersion) return; // 等待期间又切换了其他标签，本次直接作废
      if (!ready) {
        const msg = '等待10秒后仍未读取到订单卡片，本次未上传；请列表显示后手动执行同步';
        updateStatus('⚠️ ' + msg, 'warning');
        setTaskStatus('pageSync', msg, 'is-error');
        return;
      }
      // 若切tab前的采集仍在收尾，等其被版本校验丢弃后再启动本轮，避免防重入导致新tab漏同步
      for (let i = 0; i < 40 && __taskPageSyncRunning; i++) {
        await new Promise(function (r) { setTimeout(r, 250); });
      }
      if (tabVersion !== __orderTabVersion) return;
      await runTaskPageSync(true, tabId);
    } catch (err) {
      updateStatus(`❌ 自动同步失败: ${err.message}`, 'error');
      console.error('[标签点击自动同步失败]', err);
    }
  }

  init().catch(e => {
    console.error('[初始化失败]', e);
  });

})();



