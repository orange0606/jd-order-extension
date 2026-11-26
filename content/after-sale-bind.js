/**
 * 自主售后（待审核/待收货）页面：显示京东订单对应的关联采购单
 * 仅在 https://shop.jd.com/jdm/trade/after-sale/independent-after-sale/list* 注入。
 * 流程：页面打开5秒后扫描订单编号 → 通过 SW 请求京大师接口（带登录Cookie）→ 每行订单卡片后面渲染关联单信息。
 * 设置项：jd_settings.afterSaleBindShow，默认开启。
 */
(function () {
  'use strict';

  if (window.__zccAfsBindLoaded) return;
  window.__zccAfsBindLoaded = true;

  // ---------- 智查查插件登录闸门：本页功能（关联单/退货中转仓/小窗）仅登录后可用 ----------
  var pluginLoggedIn = false;
  function refreshPluginLogin() {
    try {
      chrome.storage.local.get(['zhichacha_token'], function (r) {
        pluginLoggedIn = !!(r && r.zhichacha_token); // 未登录/账号停用（token被清）时全部功能关闭
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
  // 轻提示（顶部居中，2.5秒消失）
  function zccToast(msg) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'padding:8px 16px;border-radius:4px;font-size:13px;color:#fff;background:#e6a23c;box-shadow:0 2px 8px rgba(0,0,0,.2);';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2500);
  }

  // 小窗网络桥中继：zzc iframe 内 XHR/fetch（桥脚本 postMessage）→ SW → 第一方 zzc 标签页代请求
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'ZCC_XHR_PROXY') return;
    var modal = document.getElementById('zcc-afs-order-modal');
    if (!modal) return;
    var frame = modal.querySelector('iframe');
    if (!frame || e.source !== frame.contentWindow) return;
    function reply(payload) {
      try { frame.contentWindow.postMessage(payload, '*'); } catch (err) {}
    }
    try {
      chrome.runtime.sendMessage({ type: 'ZCC_FRAME_FETCH', method: d.method, url: d.url, headers: d.headers, body: d.body }, function (resp) {
        var runtimeError = chrome.runtime.lastError;
        reply({
          type: 'ZCC_XHR_PROXY_RESULT', id: d.id,
          ok: !!(resp && resp.ok), status: (resp && resp.status) || 0,
          headers: (resp && resp.headers) || [], body: (resp && resp.body) || '',
          error: (resp && resp.error) || (runtimeError && runtimeError.message) || ''
        });
      });
    } catch (err) {
      reply({ type: 'ZCC_XHR_PROXY_RESULT', id: d.id, ok: false, error: String((err && err.message) || err) });
    }
  });

  var SETTING_KEY = 'afterSaleBindShow';
  var BAR_CLASS = 'zcc-afs-bind-bar';
  var SCAN_INTERVAL = 3000;   // 每3秒补扫一次（翻页/切tab/懒加载）
  var CACHE_TTL = 60000;      // 接口结果缓存60秒，避免频繁请求
  var enabled = true;
  var scanTimer = null;
  var fetching = false;
  var cleared = false;      // 点了「清除全部」后暂停自动渲染，直到点「重新匹配」或切换tab
  // orderId -> { time, rows }
  var cache = {};
  // orderId -> { time, state: 'ok'|'notlogin'|'error', rows } 退货中转仓数据
  var returnCache = {};
  var returnFetching = false;

  // ---------- 样式：关联单条淡金边框 + 工具栏按钮 ----------
  function injectStyle() {
    if (document.getElementById('zcc-afs-style')) return;
    var st = document.createElement('style');
    st.id = 'zcc-afs-style';
    st.textContent =
      '.' + BAR_CLASS + ' { border:1px solid #f3d19e !important; box-shadow:none !important; animation:none !important; }' +
      '#zcc-afs-toolbar { display:flex; gap:8px; align-items:center; margin:16px 0 0 0; padding:8px 12px;' +
      '  border:1px solid #ebebeb; border-radius:6px; background:#fafafa; width:fit-content; box-sizing:border-box; }' +
      '#zcc-afs-toolbar button { height:28px; padding:0 14px; border-radius:4px; cursor:pointer; font-size:13px; }' +
      '#zcc-afs-toolbar .zcc-afs-rematch { background:#ecf5ff; color:#409eff; border:1px solid #b3d8ff; }' +
      '#zcc-afs-toolbar .zcc-afs-rematch:hover { background:#d9ecff; }' +
      '#zcc-afs-toolbar .zcc-afs-clear { background:#fef0f0; color:#f56c6c; border:1px solid #fbc4c4; }' +
      '#zcc-afs-toolbar .zcc-afs-clear:hover { background:#fde2e2; }';
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------- 表格前工具栏：重新匹配 / 清除全部 ----------
  function ensureToolbar() {
    if (document.getElementById('zcc-afs-toolbar')) return;
    var table = document.querySelector('.jd-pro-card-table');
    if (!table || !table.parentNode) return;
    injectStyle();
    var bar = document.createElement('div');
    bar.id = 'zcc-afs-toolbar';
    bar.innerHTML =
      '<button type="button" class="zcc-afs-rematch">🔄 重新匹配</button>' +
      '<button type="button" class="zcc-afs-clear">🧹 清除全部</button>';
    bar.querySelector('.zcc-afs-rematch').addEventListener('click', function () {
      cleared = false;
      clearAll();
      scan();
    });
    bar.querySelector('.zcc-afs-clear').addEventListener('click', function () {
      cleared = true;
      clearAll();
    });
    table.parentNode.insertBefore(bar, table);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 剪贴板兜底：老内核/无clipboard权限时用隐藏textarea+execCommand
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (e) {}
  }

  // ---------- 设置开关 ----------
  function readSetting() {
    try {
      chrome.storage.local.get('jd_settings', function (r) {
        var s = (r && r.jd_settings) || {};
        enabled = s[SETTING_KEY] !== false; // 默认开启
        if (enabled) start();
        else stop();
      });
    } catch (e) {}
  }
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.jd_settings) {
        var s = changes.jd_settings.newValue || {};
        enabled = s[SETTING_KEY] !== false;
        if (enabled) start();
        else stop();
      }
    });
  } catch (e) {}

  var readyAt = 0; // 首次扫描时间点：打开页面5秒后
  function start() {
    if (scanTimer) return;
    // 打开页面5秒后首次扫描，之后每3秒补扫新增订单行
    readyAt = Date.now() + 5000;
    scanTimer = setInterval(scan, SCAN_INTERVAL);
  }
  function stop() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    // 关闭开关：移除已渲染的关联单条和工具栏
    document.querySelectorAll('.' + BAR_CLASS).forEach(function (el) { el.remove(); });
    document.querySelectorAll('.card[data-zcc-afs-done]').forEach(function (el) { el.removeAttribute('data-zcc-afs-done'); });
    var tb = document.getElementById('zcc-afs-toolbar');
    if (tb) tb.remove();
  }

  // ---------- 提取订单编号 ----------
  function getOrderId(card) {
    try {
      // 优先：卡片头部「订单编号：」块里的 .jd-link__inner
      var blocks = card.querySelectorAll('.card-header .shop-link-and-copy');
      for (var i = 0; i < blocks.length; i++) {
        if (blocks[i].textContent.indexOf('订单编号') !== -1) {
          var inner = blocks[i].querySelector('.jd-link__inner') || blocks[i].querySelector('.default-type');
          var m = inner && inner.textContent.match(/\d{10,}/);
          if (m) return m[0];
        }
      }
      // 兜底：整个头部文本正则
      var header = card.querySelector('.card-header');
      if (header) {
        var m2 = header.textContent.match(/订单编号[：:]\s*(\d{10,})/);
        if (m2) return m2[1];
      }
    } catch (e) {}
    return '';
  }

  // ---------- 读取退货物流悬浮提示并携带到中转仓 ----------
  function readReturnWaybill() {
    var tips = document.querySelectorAll('.jd-tooltip__popper, [role="tooltip"], .el-tooltip__popper');
    var found = '';
    for (var i = 0; i < tips.length; i++) {
      var el = tips[i];
      try {
        var style = window.getComputedStyle ? window.getComputedStyle(el) : el.style;
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) continue;
        var rect = el.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) continue;
        var text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || !/退货|物流|运单|包裹/.test(text)) continue;
        // 优先按标签取值，避免同提示里的服务单号/订单号被误当成物流单号
        var labelled = text.match(/(?:退货物流单号|退货快递单号|退货单号|包裹运单号|物流单号|运单号)\s*[：:]\s*([A-Za-z0-9-]{6,40})/i);
        var jd = text.match(/JD[A-Za-z0-9]{6,}/i);
        if (labelled || jd) found = (labelled && labelled[1]) || (jd && jd[0]) || '';
      } catch (e) {}
    }
    return found;
  }
  function dispatchReturnHover(trigger, leave) {
    if (!trigger) return;
    var events = leave ? ['mouseleave', 'mouseout'] : ['mouseover', 'mouseenter', 'mousemove'];
    events.forEach(function (name) {
      try { trigger.dispatchEvent(new MouseEvent(name, { bubbles: name !== 'mouseenter' && name !== 'mouseleave', view: window })); } catch (e) {}
    });
  }
  function withReturnPrefill(url, prefill) {
    try {
      var u = new URL(url);
      var orderId = String(prefill && prefill.orderId || '').replace(/\D/g, '');
      var waybill = String(prefill && prefill.waybill || '').trim().replace(/[^A-Za-z0-9-]/g, '');
      if (orderId) u.searchParams.set('zcc_order_id', orderId);
      if (waybill) u.searchParams.set('zcc_package_waybill', waybill);
      return u.href;
    } catch (e) { return url; }
  }
  function openReturnModal(card, url, orderId, done) {
    var prefill = { orderId: orderId || getOrderId(card), waybill: readReturnWaybill() };
    var trigger = card.querySelector('.shop-logistics-info-refer-wrap') || card.querySelector('[prop="logisticsInfo"] .jd-tooltip__trigger');
    var opened = false, timer = null, timeout = null;
    function finish() {
      if (opened) return;
      opened = true;
      if (timer) clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      prefill.waybill = prefill.waybill || readReturnWaybill();
      dispatchReturnHover(trigger, true);
      openOrderModal(withReturnPrefill(url, prefill));
      if (done) done();
    }
    if (prefill.waybill || !trigger) { finish(); return; }
    // 京东物流信息需要悬浮后才渲染tooltip：自动触发悬浮，最多等700ms，读不到也正常打开并带入订单号
    dispatchReturnHover(trigger, false);
    timer = setInterval(function () { if (readReturnWaybill()) finish(); }, 100);
    timeout = setTimeout(finish, 700);
  }

  // ---------- 渲染关联单条 ----------
  function buildBar(orderId, rows) {
    var bar = document.createElement('div');
    bar.className = BAR_CLASS;
    bar.setAttribute('data-zcc-order-id', orderId);
    bar.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:7px 16px;margin:0 0 8px 0;' +
      'border:1px solid #ebebeb;border-top:none;border-radius:0 0 6px 6px;background:transparent;' +
      'font-size:13px;line-height:22px;color:#333;box-sizing:border-box;';

    if (!rows || rows.length === 0) {
      bar.innerHTML = '<span style="color:#999;">📦 未找到关联采购单（' + esc(orderId) + '）</span>';
      return bar;
    }

    var html = '';
    rows.forEach(function (row, idx) {
      var express = [row.buy_express_company, row.buy_express_id].filter(Boolean).join(' ');
      // 快递单号可点击复制
      var expressHtml = esc(express || '暂无');
      if (row.buy_express_id) {
        expressHtml = (row.buy_express_company ? esc(row.buy_express_company) + ' ' : '') +
          '<span class="zcc-afs-copy-express" data-no="' + esc(row.buy_express_id) + '" title="点击复制快递单号"' +
          ' style="color:#3768fa;cursor:pointer;text-decoration:underline dotted;">' + esc(row.buy_express_id) + '</span>';
      }
      var expressStatus = row.buy_express_status_text || '';
      // 拼多多采购单可点击跳转：平台为拼多多，或单号是拼多多格式（如 261120-473337741622505）
      // 清洗单号：转字符串、去首尾及中间空白/不可见字符，防止接口返回带杂质导致链接失效
      var sn = String(row.buy_order_id == null ? '' : row.buy_order_id).replace(/[\s\u200B-\u200D\uFEFF]/g, '');
      var buyOrderHtml = esc(sn || '-');
      var isPdd = String(row.buy_platform_text || '').indexOf('拼多多') !== -1 || /^\d{6}-\d{10,20}$/.test(sn);
      if (sn && isPdd) {
        var orderUrl = 'https://mobile.yangkeduo.com/order.html?order_sn=' + encodeURIComponent(sn);
        buyOrderHtml = '<a class="zcc-afs-buy-link" href="' + orderUrl +
          '" target="_blank" rel="noopener noreferrer" style="color:#3768fa;">' + esc(sn) + '</a>' +
          ' <button type="button" class="zcc-afs-open-win" data-url="' + esc(orderUrl) + '" title="小窗口打开采购单"' +
          ' style="height:20px;padding:0 6px;margin-left:4px;border:1px solid #b3d8ff;background:#ecf5ff;color:#409eff;border-radius:3px;cursor:pointer;font-size:12px;line-height:18px;vertical-align:middle;">🗗 小窗</button>';
      }
      html += '<div style="display:flex;align-items:center;flex-wrap:wrap;column-gap:14px;row-gap:2px;">' +
        '<span style="color:#e6a23c;font-weight:600;white-space:nowrap;">📦 关联采购单' + (rows.length > 1 ? (idx + 1) : '') + '</span>' +
        '<span style="white-space:nowrap;">订单号：<b>' + esc(row.order_id) + '</b></span>' +
        '<span style="white-space:nowrap;">采购账号：<b>' + esc(row.buy_account || '-') + '</b></span>' +
        '<span style="white-space:nowrap;">采购订单：' + buyOrderHtml + '</span>' +
        '<span style="white-space:nowrap;">发货物流：<b>' + expressHtml + '</b>' +
          (expressStatus ? '（' + esc(expressStatus) + '）' : '') + '</span>' +
        '</div>';
    });
    bar.innerHTML = html;
    // 京东售后页是 SPA，全局点击监听可能拦截 <a> 默认跳转；
    // 这里捕获阶段直接 window.open，绕开页面路由劫持，保证能打开拼多多订单页
    bar.querySelectorAll('a.zcc-afs-buy-link').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        window.open(a.href, '_blank', 'noopener');
      }, true);
    });
    // 「小窗」按钮：页面内可拖动弹窗（iframe 内嵌采购单），点击页面其它内容不会消失
    bar.querySelectorAll('.zcc-afs-open-win').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openOrderModal(btn.getAttribute('data-url') || '');
      }, true);
    });
    // 快递单号点击复制到剪贴板，复制成功短暂显示「✓已复制」
    bindCopyExpress(bar);
    return bar;
  }

  // 单号点击复制绑定（发货快递单号 / 退回物流单号共用）
  function bindCopyExpress(root) {
    root.querySelectorAll('.zcc-afs-copy-express').forEach(function (el) {
      if (el.hasAttribute('data-zcc-copy-bound')) return; // 防重复绑定（退货信息追加时会再扫一次整条bar）
      el.setAttribute('data-zcc-copy-bound', '1');
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var no = el.getAttribute('data-no') || '';
        function done() {
          var old = el.textContent;
          el.textContent = '✓已复制';
          el.style.color = '#52c41a';
          setTimeout(function () { el.textContent = old; el.style.color = '#3768fa'; }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(no).then(done).catch(function () { fallbackCopy(no); done(); });
        } else { fallbackCopy(no); done(); }
      }, true);
    });
  }

  // ---------- 退货中转仓信息（鼠标移入显示完整收件/物流信息） ----------
  var RETURNS_URL = 'https://zzc.jingbashi.com/returns?ref=addtabs';
  // 中转仓「小窗」按钮（与采购单小窗同一套弹窗）
  function returnWinBtn() {
    return ' <button type="button" class="zcc-afs-open-win" data-url="' + esc(RETURNS_URL) + '" title="小窗口打开中转仓"' +
      ' style="height:20px;padding:0 6px;margin-left:4px;border:1px solid #b3d8ff;background:#ecf5ff;color:#409eff;border-radius:3px;cursor:pointer;font-size:12px;line-height:18px;vertical-align:middle;">🗗 小窗</button>';
  }
  function buildReturnHtml(orderId) {
    var ret = returnCache[orderId];
    var prefix = '<span style="color:#909399;font-weight:600;white-space:nowrap;">🏬 退货中转仓：</span>';
    if (!ret) return ''; // 还没查到，先不显示
    if (ret.state === 'notlogin') {
      return '<div class="zcc-afs-return-block" style="display:flex;align-items:center;flex-wrap:wrap;column-gap:8px;">' + prefix +
        '<a class="zcc-afs-login-link" href="https://zzc.jingbashi.com/index/login?url=%2Forders%3Fref%3Daddtabs"' +
        ' target="_blank" rel="noopener noreferrer" style="color:#f56c6c;text-decoration:underline;cursor:pointer;">未登录，点击去登录</a></div>';
    }
    if (ret.state === 'error') {
      return '<div class="zcc-afs-return-block" style="display:flex;align-items:center;flex-wrap:wrap;column-gap:8px;">' + prefix +
        '<span style="color:#999;">查询失败</span></div>';
    }
    if (!ret.rows || !ret.rows.length) {
      // 未提交：附「去提交」链接 + 小窗按钮
      return '<div class="zcc-afs-return-block" style="display:flex;align-items:center;flex-wrap:wrap;column-gap:8px;">' + prefix +
        '<span style="color:#999;">未提交</span>' +
        '<a class="zcc-afs-go-submit" href="' + esc(RETURNS_URL) + '" target="_blank" rel="noopener noreferrer"' +
        ' style="color:#409eff;text-decoration:underline;cursor:pointer;">去提交</a>' + returnWinBtn() + '</div>';
    }
    var html = '';
    ret.rows.forEach(function (r) {
      // 悬停提示：完整收件人/电话/地址/寄件物流/退回物流
      var tip = '收件人：' + (r.receive_person || '-') +
        '\n电话：' + (r.receive_phone || '-') +
        '\n地址：' + (r.receive_address || '-') +
        '\n寄件物流：' + (r.package_waybill || '-') +
        '\n退回物流：' + (r.returns_waybill || '-');
      html += '<div class="zcc-afs-return-block" style="display:flex;align-items:center;flex-wrap:wrap;column-gap:14px;row-gap:2px;">' + prefix +
        '<span class="zcc-afs-return-info" title="' + esc(tip) + '" style="cursor:help;text-decoration:underline dotted #c0c4cc;display:inline-flex;align-items:center;flex-wrap:wrap;column-gap:14px;row-gap:2px;">' +
        '<span style="white-space:nowrap;">退回物流：' +
        (r.returns_waybill
          ? '<b class="zcc-afs-copy-express" data-no="' + esc(r.returns_waybill) + '" title="点击复制物流单号"' +
            ' style="color:#3768fa;cursor:pointer;text-decoration:underline dotted;">' + esc(r.returns_waybill) + '</b>' +
            '<a class="zcc-afs-return-link" href="' + esc(RETURNS_URL) + '" data-url="' + esc(RETURNS_URL) + '"' +
            ' target="_blank" rel="noopener noreferrer" title="新标签页打开京巴士中转仓"' +
            ' style="margin-left:6px;color:#409eff;text-decoration:underline;cursor:pointer;">京巴士中转仓</a>' + returnWinBtn()
          : '<b>暂无</b>') +
        '</span>' +
        '<span style="white-space:nowrap;">状态：<b style="color:#409eff;">' + esc(r.status_text || '-') + '</b></span>' +
        '<span style="white-space:nowrap;">收件人：<b>' + esc(r.receive_person || '-') + '</b></span>' +
        '</span></div>';
    });
    return html;
  }

  function renderForCard(card, orderId) {
    // 移除旧条（数据刷新时重建）
    var next = card.nextElementSibling;
    if (next && next.classList && next.classList.contains(BAR_CLASS)) next.remove();
    var entry = cache[orderId];
    var bar = buildBar(orderId, entry ? entry.rows : []);
    // 追加退货中转仓信息（仅待收货/待处理tab）
    var retHtml = needReturn() ? buildReturnHtml(orderId) : '';
    if (retHtml) {
      bar.insertAdjacentHTML('beforeend', retHtml);
      // 发货/退回物流单号点击复制（退回物流另附中转仓链接+小窗按钮）
      bindCopyExpress(bar);
      // 未登录链接 / 去提交 / 退回物流：捕获阶段直接打开，绕开京东SPA路由劫持
      bar.querySelectorAll('a.zcc-afs-login-link, a.zcc-afs-go-submit, .zcc-afs-return-link').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          window.open(a.getAttribute('data-url') || a.href, '_blank', 'noopener');
        }, true);
      });
      // 中转仓「小窗」按钮：复用页面内可拖动弹窗
      bar.querySelectorAll('.zcc-afs-return-block .zcc-afs-open-win').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (btn.getAttribute('data-zcc-opening')) return;
          btn.setAttribute('data-zcc-opening', '1');
          // 携带当前行的订单编号和悬浮提示中的退货物流单号，打开add表单后自动填写
          openReturnModal(card, btn.getAttribute('data-url') || '', orderId, function () {
            btn.removeAttribute('data-zcc-opening');
          });
        }, true);
      });
    }
    card.insertAdjacentElement('afterend', bar);
    card.setAttribute('data-zcc-afs-done', orderId);
  }

  // ---------- 主扫描 ----------
  // 记录当前 tab 地址：waitAudit / waitReceive 切换（SPA 不刷新页面）时清空旧数据
  var lastHref = location.href;
  var lastSig = '';   // 当前列表订单号签名：分页/查询/重置导致列表变化时兜底触发重新匹配
  function clearAll() {
    document.querySelectorAll('.' + BAR_CLASS).forEach(function (el) { el.remove(); });
    document.querySelectorAll('.card[data-zcc-afs-done]').forEach(function (el) { el.removeAttribute('data-zcc-afs-done'); });
    cache = {};
    returnCache = {};
    lastSig = '';
  }

  // 分页/查询/重置/tab点击：清空旧数据，稍等新列表渲染后由定时扫描重新匹配
  function triggerRematch() {
    cleared = false;
    clearAll();
    readyAt = Date.now() + 1200; // 给页面1.2秒渲染新数据
  }
  document.addEventListener('click', function (e) {
    if (!enabled) return;
    try {
      var t = e.target;
      if (!t || !t.closest) return;
      // 分页组件：上一页/下一页/页码/每页条数
      if (t.closest('.jd-pagination')) { triggerRematch(); return; }
      // 查询/重置按钮
      var btn = t.closest('.actions-form-item-content button');
      if (btn) {
        var txt = (btn.textContent || '').trim();
        if (txt === '查询' || txt === '重置') { triggerRematch(); return; }
      }
      // tab 切换（全部/待审核/待收货等）
      if (t.closest('.jd-tabs__item')) { triggerRematch(); return; }
    } catch (err) {}
  }, true);

  function scan() {
    if (!enabled || !pluginLoggedIn) return; // 插件未登录不扫描不渲染
    ensureToolbar();
    if (cleared || fetching) return;
    if (Date.now() < readyAt) return; // 页面打开5秒后才开始查询渲染
    // tab 切换检测：URL 变了就清空之前渲染的关联单条和缓存，重新扫描
    if (location.href !== lastHref) {
      lastHref = location.href;
      cleared = false;
      clearAll();
    }
    var cards = document.querySelectorAll('.table-body .card');
    if (!cards.length) return;

    var pending = [];       // 需要请求接口的订单号
    var cardList = [];      // { card, orderId }
    cards.forEach(function (card) {
      var orderId = getOrderId(card);
      if (!orderId) return;
      cardList.push({ card: card, orderId: orderId });
    });
    if (!cardList.length) return;

    // 兜底：列表订单号组合变化（每页条数切换、查询结果异步刷新等未捕获的场景）→ 自动重新匹配
    var sig = cardList.map(function (it) { return it.orderId; }).join(',');
    if (lastSig && sig !== lastSig) clearAll();
    lastSig = sig;

    cardList.forEach(function (item) {
      var card = item.card, orderId = item.orderId;
      var done = card.getAttribute('data-zcc-afs-done');
      var entry = cache[orderId];
      var fresh = entry && (Date.now() - entry.time < CACHE_TTL);
      if (done === orderId && fresh) return; // 已渲染且缓存新鲜，跳过
      if (fresh) { renderForCard(card, orderId); return; }
      if (pending.indexOf(orderId) === -1) pending.push(orderId);
    });

    // 退货中转仓查询（独立于跟单接口，不互相阻塞）
    queryReturns(cardList);

    if (!pending.length) return;
    fetching = true;
    try {
      chrome.runtime.sendMessage({ type: 'ZCC_AFS_BIND_QUERY', orderIds: pending }, function (resp) {
        fetching = false;
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          console.warn('[智查查-售后关联单] 查询失败:', (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message));
          return;
        }
        var rows = (resp.data && resp.data.rows) || [];
        // 按订单号分组（一个京东单可能有多条采购单）
        var now = Date.now();
        pending.forEach(function (id) { cache[id] = { time: now, rows: [] }; });
        rows.forEach(function (row) {
          var id = String(row.order_id || '').trim();
          if (!cache[id]) return;
          cache[id].rows.push(row);
          // 额外采购单可能放在 extra.buy[] 里，一并展开显示（按采购单号去重）
          var extraBuy = row.extra && Array.isArray(row.extra.buy) ? row.extra.buy : [];
          extraBuy.forEach(function (b) {
            if (!b || typeof b !== 'object') return;
            var merged = Object.assign({}, row, b, { order_id: row.order_id });
            delete merged.extra; // 防止嵌套重复展开
            var sn = String(merged.buy_order_id || '');
            var dup = cache[id].rows.some(function (r) { return String(r.buy_order_id || '') === sn; });
            if (sn && !dup) cache[id].rows.push(merged);
          });
        });
        if (!enabled) return;
        cardList.forEach(function (item) {
          if (cache[item.orderId]) renderForCard(item.card, item.orderId);
        });
      });
    } catch (e) { fetching = false; }
  }

  // ---------- 可拖动弹窗（500×600，非模态：点击页面其它内容不消失） ----------
  // 支持两种内嵌站点：拼多多采购单 / 京巴士中转仓；先让 SW 注入对应登录Cookie规则再加载 iframe
  function modalMode(url) {
    if (String(url).indexOf('yangkeduo.com') !== -1) return 'pdd';
    if (String(url).indexOf('jingbashi.com') !== -1) return 'zzc';
    return '';
  }
  function modalTitle(url) {
    var mode = modalMode(url);
    if (mode === 'pdd') {
      var sn = '';
      try { sn = new URLSearchParams(url.split('?')[1] || '').get('order_sn') || ''; } catch (e) {}
      return '采购单 ' + sn;
    }
    if (mode === 'zzc') return '退货中转仓';
    try { return new URL(url).hostname; } catch (e) { return '小窗'; }
  }
  function loadModalFrame(modal, url) {
    var frame = modal.querySelector('iframe');
    var mode = modalMode(url);
    modal.setAttribute('data-mode', mode);
    if (!mode) { frame.src = url; return; }
    try {
      chrome.runtime.sendMessage({ type: mode === 'pdd' ? 'ZCC_PDD_EMBED_ON' : 'ZCC_ZZC_EMBED_ON' }, function () {
        void chrome.runtime.lastError;
        frame.src = url;
      });
    } catch (e) { frame.src = url; }
  }
  function embedOff(modal) {
    var mode = modal ? (modal.getAttribute('data-mode') || '') : '';
    if (!mode) return;
    try {
      chrome.runtime.sendMessage({ type: mode === 'pdd' ? 'ZCC_PDD_EMBED_OFF' : 'ZCC_ZZC_EMBED_OFF' }, function () { void chrome.runtime.lastError; });
    } catch (e) {}
  }

  function openOrderModal(url) {
    if (!url) return;
    if (!pluginLoggedIn) { zccToast('请先登录智查查后再使用该功能'); return; } // 插件登录闸门
    var modal = document.getElementById('zcc-afs-order-modal');
    if (modal) {
      // 已有弹窗：换单直接更新 iframe 和标题，位置保留
      modal.querySelector('.zcc-afs-modal-title-text').textContent = modalTitle(url);
      modal.querySelector('.zcc-afs-modal-open-tab').setAttribute('data-url', url);
      modal.style.display = 'flex';
      loadModalFrame(modal, url);
      return;
    }
    modal = document.createElement('div');
    modal.id = 'zcc-afs-order-modal';
    modal.style.cssText = 'position:fixed;left:50px;top:50px;width:500px;height:600px;z-index:2147483647;' +
      'background:#fff;border:1px solid #dcdfe6;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.25);' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'resize:both;min-width:360px;min-height:320px;'; // 右下角拖柄可调整宽高
    modal.innerHTML =
      '<div class="zcc-afs-modal-header" style="flex:0 0 34px;display:flex;align-items:center;gap:8px;padding:0 10px;' +
      'background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;cursor:move;user-select:none;font-size:13px;">' +
      '  <span class="zcc-afs-modal-title-text" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(modalTitle(url)) + '</span>' +
      '  <button type="button" class="zcc-afs-modal-refresh" title="刷新当前小窗页面"' +
      '    style="border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:3px;cursor:pointer;font-size:12px;height:22px;padding:0 8px;">↻ 刷新</button>' +
      '  <button type="button" class="zcc-afs-modal-open-tab" data-url="' + esc(url) + '" title="在新标签页打开"' +
      '    style="border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:3px;cursor:pointer;font-size:12px;height:22px;padding:0 8px;">↗ 新标签</button>' +
      '  <button type="button" class="zcc-afs-modal-close" title="关闭"' +
      '    style="border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:3px;cursor:pointer;font-size:14px;height:22px;width:22px;line-height:20px;padding:0;">×</button>' +
      '</div>' +
      '<iframe src="about:blank" style="flex:1;width:100%;border:none;background:#fff;" allow="clipboard-read; clipboard-write"></iframe>';
    document.body.appendChild(modal);
    loadModalFrame(modal, url);

    // 拖动时给 iframe 盖一层透明遮罩，防止鼠标移入 iframe 后丢失 move 事件
    var shield = document.createElement('div');
    shield.style.cssText = 'position:absolute;inset:34px 0 0 0;display:none;z-index:2;';
    modal.appendChild(shield);

    var header = modal.querySelector('.zcc-afs-modal-header');
    var dragging = false, startX = 0, startY = 0, origL = 0, origT = 0;
    header.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      var rect = modal.getBoundingClientRect();
      origL = rect.left; origT = rect.top;
      shield.style.display = 'block';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var l = Math.max(0, Math.min(window.innerWidth - 80, origL + e.clientX - startX));
      var t = Math.max(0, Math.min(window.innerHeight - 40, origT + e.clientY - startY));
      modal.style.left = l + 'px';
      modal.style.top = t + 'px';
    });
    document.addEventListener('mouseup', function () {
      dragging = false;
      shield.style.display = 'none';
    });

    modal.querySelector('.zcc-afs-modal-close').addEventListener('click', function () {
      modal.remove();
      // 关闭弹窗：只移除对应站点的Cookie注入规则，不做Cookie清除/恢复
      embedOff(modal);
    });
    modal.querySelector('.zcc-afs-modal-refresh').addEventListener('click', function () {
      // 刷新仍走原加载链路，保留京巴士srcdoc代理、自动填单和内嵌登录态
      var currentUrl = modal.querySelector('.zcc-afs-modal-open-tab').getAttribute('data-url') || url;
      loadModalFrame(modal, currentUrl);
    });
    modal.querySelector('.zcc-afs-modal-open-tab').addEventListener('click', function () {
      window.open(this.getAttribute('data-url'), '_blank', 'noopener');
    });

    // 离开/刷新页面时若弹窗还开着，也要通知 SW 移除对应注入规则
    if (!window.__zccAfsEmbedUnloadHooked) {
      window.__zccAfsEmbedUnloadHooked = true;
      window.addEventListener('beforeunload', function () {
        embedOff(document.getElementById('zcc-afs-order-modal'));
      });
    }
  }

  // ---------- 退货中转仓查询 ----------
  // 仅「待收货 waitReceive / 待处理 waitProcess」两个tab需要中转仓信息，其它tab不请求不显示
  function needReturn() {
    try {
      var tab = new URLSearchParams(location.search).get('tabCode') || '';
      return tab === 'waitReceive' || tab === 'waitProcess';
    } catch (e) { return false; }
  }

  function queryReturns(cardList) {
    if (returnFetching || !needReturn()) return;
    var now = Date.now();
    var returnPending = [];
    cardList.forEach(function (item) {
      var ret = returnCache[item.orderId];
      // 正常结果缓存60秒；未登录/失败15秒后重试
      var ttl = (ret && ret.state === 'ok') ? CACHE_TTL : 15000;
      if (ret && now - ret.time < ttl) return;
      if (returnPending.indexOf(item.orderId) === -1) returnPending.push(item.orderId);
    });
    if (!returnPending.length) return;
    returnFetching = true;
    try {
      chrome.runtime.sendMessage({ type: 'ZCC_AFS_RETURN_QUERY', orderIds: returnPending }, function (resp) {
        returnFetching = false;
        var t = Date.now();
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          returnPending.forEach(function (id) { returnCache[id] = { time: t, state: 'error', rows: [] }; });
        } else if (resp.notLogin) {
          returnPending.forEach(function (id) { returnCache[id] = { time: t, state: 'notlogin', rows: [] }; });
        } else {
          var rows = (resp.data && resp.data.rows) || [];
          returnPending.forEach(function (id) { returnCache[id] = { time: t, state: 'ok', rows: [] }; });
          rows.forEach(function (r) {
            var id = String(r.order_id || '').trim();
            if (returnCache[id]) returnCache[id].rows.push(r);
          });
        }
        if (!enabled || cleared || !needReturn()) return;
        // 已渲染关联单的卡片：重建以补上退货中转仓信息
        cardList.forEach(function (item) {
          if (item.card.isConnected && cache[item.orderId] && returnCache[item.orderId]) {
            renderForCard(item.card, item.orderId);
          }
        });
      });
    } catch (e) { returnFetching = false; }
  }

  readSetting();
})();
