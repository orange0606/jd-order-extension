/**
 * 中转仓快速填单（zzc.jingbashi.com）
 * 注册在 /returns*（列表页 + /returns/add?dialog=1 弹窗iframe，同源；
 * FastAdmin addtabs 模式下列表页本身也是iframe，故按URL而非window.top区分角色）：
 * - 列表页（非add）：负责轮询剪贴板（弹窗刚打开时焦点在列表页，iframe 内读不了剪贴板），
 *   读到新内容 postMessage 转发给弹窗iframe；新弹窗打开也会补发最近一次内容。不注入按钮。
 * - 弹窗iframe（或独立打开的add页）：执行填写逻辑 + 手动按钮条。
 * 功能：
 * 1) 仓库名称默认选第一个（selectpage组件：data-source JSON + 隐藏域）；
 * 2) 剪贴板内容按 换行/、/逗号/分号 拆分，逐项识别并填写：
 *    - 地址格式（卢健 18358944144 浙江省金华市东阳市 南市街道里岭头村）
 *      → 收件人、收件号码、所在地区（省/市/区联动），收货地址填完整原文方便核对；
 *    - 纯数字长单号（3690476001770327）→ 订单号；
 *    - JD开头运单号（JDVA49271784852）→ 包裹运单号。
 *    混合粘贴（多行或、/逗号分隔）可一次全部填进。
 */
(function () {
  'use strict';
  if (window.__zccReturnsQuickFill) return;
  window.__zccReturnsQuickFill = true;

  function zccQfStart() {

  // srcdoc 弹层（小窗内嵌套iframe）URL 为 about:srcdoc，由注入方置 __ZCC_QF_ROLE='fill' 强制填写模式
  var isAddPage = /\/returns\/add/.test(location.pathname) || window.__ZCC_QF_ROLE === 'fill';

  // ---------- 列表页：剪贴板中继 ----------
  // 注意：FastAdmin addtabs 模式下列表页本身也是后台主框架里的iframe，不能用 window.top 判断。
  // 凡是非 /returns/add 的 /returns* 页面都做中继：代读剪贴板（弹窗刚打开时焦点在列表页，
  // 弹窗iframe未聚焦读不了剪贴板），postMessage 转发给弹窗iframe；新弹窗打开也会补发最近内容。
  if (!isAddPage) {
    var lastRelay = '';
    setInterval(function () {
      try {
        if (!(navigator.clipboard && navigator.clipboard.readText)) return;
        // 不做 hasFocus 门槛：焦点在后台壳/弹窗时读取可能失败，静默忽略，聚焦回列表页即恢复
        navigator.clipboard.readText().then(function (t) {
          t = String(t || '').trim();
          if (!t) return;
          lastRelay = t;
          // 发给所有尚未收到该内容的同源iframe（新打开的弹窗也能补发）
          var frames = document.querySelectorAll('iframe');
          for (var i = 0; i < frames.length; i++) {
            try {
              var w = frames[i].contentWindow;
              if (w && w.__zccQuickFillGot !== t) {
                w.postMessage({ type: 'ZCC_QUICK_FILL_TEXT', text: t }, '*');
              }
            } catch (e) {}
          }
        }).catch(function () {});
      } catch (e) {}
    }, 1500); // 性能：剪贴板轮询 800ms→1500ms，粘贴事件仍即时响应
    return;
  }

  // ---------- 以下运行在弹窗iframe / 独立add页 ----------
  function fire(el, type) {
    try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) {}
  }
  function setVal(el, val) {
    if (!el) return false;
    el.value = val;
    fire(el, 'input');
    fire(el, 'change');
    return true;
  }
  // 按 name/id 关键字找表单控件，找不到再按 label 文字找
  function findField(keywords, labels) {
    var nodes = document.querySelectorAll('input, textarea, select');
    var i, n;
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      var key = ((n.name || '') + ' ' + (n.id || '')).toLowerCase();
      for (var k = 0; k < keywords.length; k++) {
        if (key.indexOf(keywords[k]) !== -1) return n;
      }
    }
    if (labels) {
      var ls = document.querySelectorAll('label');
      for (i = 0; i < ls.length; i++) {
        var txt = (ls[i].textContent || '').trim();
        for (var j = 0; j < labels.length; j++) {
          if (txt.indexOf(labels[j]) !== -1) {
            // label 的 for，或同一 form-group 内的控件
            var forId = ls[i].getAttribute('for');
            var target = forId ? document.getElementById(forId) : null;
            if (!target) {
              var group = ls[i].closest('.form-group') || ls[i].parentElement;
              if (group) target = group.querySelector('input, textarea, select');
            }
            if (target) return target;
          }
        }
      }
    }
    return null;
  }
  // 下拉框按选项文字选中（兼容全称/简称），返回是否命中
  function selectOptionByText(sel, text) {
    if (!sel || !text) return false;
    var opts = sel.options || [];
    for (var i = 0; i < opts.length; i++) {
      var t = (opts[i].textContent || '').trim();
      if (!t || !opts[i].value) continue;
      if (t === text || t.indexOf(text) === 0 || text.indexOf(t) === 0) {
        sel.value = opts[i].value;
        fire(sel, 'input');
        fire(sel, 'change');
        return true;
      }
    }
    return false;
  }
  // 轻提示（iframe 内右上角，2秒消失；避开顶部按钮条）
  function toast(msg, color) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:44px;right:8px;z-index:2147483647;padding:6px 12px;border-radius:4px;' +
      'font-size:12px;color:#fff;background:' + (color || '#67c23a') + ';box-shadow:0 2px 8px rgba(0,0,0,.2);';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2000);
  }

  // ---------- 1) 仓库名称默认选第一个 ----------
  // 仓库是 selectpage 组件：文本框(data-source JSON) + 隐藏域，不是原生select
  function fillWarehouseSelectpage() {
    var textInput = document.querySelector('input.selectpage[id*="warehouse"], input#c-warehouse_id_text');
    if (!textInput) return false;
    var hidden = document.querySelector('input.sp_hidden[name*="warehouse"], input#c-warehouse_id');
    if (hidden && hidden.value) return true; // 已选过，不动
    var source = [];
    try { source = JSON.parse(textInput.getAttribute('data-source') || '[]'); } catch (e) {}
    if (!source.length) return false;
    var first = source[0];
    var field = textInput.getAttribute('data-field') || 'name';
    var pk = textInput.getAttribute('data-primary-key') || 'id';
    textInput.value = first[field] != null ? String(first[field]) : '';
    fire(textInput, 'input');
    fire(textInput, 'change');
    if (hidden) {
      hidden.value = first[pk] != null ? String(first[pk]) : '';
      fire(hidden, 'input');
      fire(hidden, 'change');
    }
    return true;
  }
  var warehouseTries = 0;
  var warehouseTimer = setInterval(function () {
    warehouseTries++;
    if (warehouseTries > 30) { clearInterval(warehouseTimer); return; }
    // 优先 selectpage 组件
    if (fillWarehouseSelectpage()) { clearInterval(warehouseTimer); return; }
    // 兜底：原生下拉框
    var sel = findField(['warehouse'], ['仓库']);
    if (!sel || sel.tagName !== 'SELECT') return;
    // 已有值就不动（用户可能手动选过）
    if (sel.value) { clearInterval(warehouseTimer); return; }
    var opts = sel.options || [];
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].value) {
        sel.value = opts[i].value;
        fire(sel, 'input');
        fire(sel, 'change');
        clearInterval(warehouseTimer);
        return;
      }
    }
  }, 500);

  // ---------- 2) 地址解析 ----------
  function parseAddress(text) {
    var phoneMatch = text.match(/1[3-9]\d{9}/);
    if (!phoneMatch) return null;
    var phone = phoneMatch[0];
    var name = text.slice(0, text.indexOf(phone)).trim();
    var addrPart = text.slice(text.indexOf(phone) + phone.length).trim();
    if (!/[\u4e00-\u9fa5]/.test(addrPart)) return null;
    var province = '', city = '', district = '';
    var pm = addrPart.match(/^(.*?(?:省|自治区)|北京市|天津市|上海市|重庆市)/);
    if (pm) {
      province = pm[1];
      var rest = addrPart.slice(province.length);
      var cm = rest.match(/^(.*?(?:市|自治州|地区|盟))/);
      if (cm) {
        city = cm[1];
        var rest2 = rest.slice(city.length);
        var dm = rest2.match(/^(.*?(?:区|县|市|旗))/);
        if (dm) district = dm[1];
      }
    }
    return { name: name, phone: phone, province: province, city: city, district: district, raw: text };
  }

  // 省/市/区联动填写：优先三个独立下拉框，其次 city-picker 单控件
  function fillRegion(info) {
    var selects = document.querySelectorAll('select');
    var provSel = null, citySel = null, distSel = null;
    // 先按 name/id 关键字定位
    for (var i = 0; i < selects.length; i++) {
      var key = ((selects[i].name || '') + ' ' + (selects[i].id || '')).toLowerCase();
      if (/province|prov/.test(key)) provSel = selects[i];
      else if (/city/.test(key)) citySel = selects[i];
      else if (/district|area|county/.test(key)) distSel = selects[i];
    }
    // 兜底：按选项内容识别省级下拉框
    if (!provSel && info.province) {
      for (var j = 0; j < selects.length; j++) {
        if (selectOptionByText(selects[j], info.province)) { provSel = selects[j]; break; }
      }
    }
    if (provSel) {
      selectOptionByText(provSel, info.province);
      // 等级联加载后再选市、区
      setTimeout(function () {
        var cs = citySel || findField(['city'], ['城市']);
        if (cs && cs.tagName === 'SELECT') selectOptionByText(cs, info.city);
        setTimeout(function () {
          var ds = distSel || findField(['district', 'area', 'county'], ['区县', '地区']);
          if (ds && ds.tagName === 'SELECT') selectOptionByText(ds, info.district);
        }, 500);
      }, 500);
      return true;
    }
    // city-picker 单控件（FastAdmin 常用）：值格式 省/市/区
    var picker = document.querySelector('input[data-toggle="city-picker"], input.city-picker');
    if (picker && info.province) {
      var parts = [info.province, info.city, info.district].filter(Boolean);
      setVal(picker, parts.join('/'));
      return true;
    }
    return false;
  }

  function fillAddress(info) {
    var okPerson = setVal(findField(['receive_person', 'person', 'receiver'], ['收件人']), info.name);
    var okPhone = setVal(findField(['receive_phone', 'phone', 'mobile'], ['收件号码', '电话', '手机']), info.phone);
    var okRegion = fillRegion(info);
    // 收货地址填完整原文，方便核对
    var okAddr = setVal(findField(['receive_address', 'address'], ['收货地址', '地址']), info.raw);
    return (okPerson || okPhone || okAddr) ? (okRegion ? '地址(' + (info.name || '-') + ')' : '地址(地区未识别请手选)') : '';
  }
  function fillOrder(text) {
    return setVal(findField(['order_id', 'orderid'], ['订单号', '订单编号']), text) ? '订单号' : '';
  }
  function fillWaybill(text) {
    return setVal(findField(['package_waybill', 'waybill'], ['包裹运单号', '运单号']), text) ? '运单号' : '';
  }

  // ---------- 3) 剪贴板内容拆分识别（支持混合粘贴） ----------
  // 按 换行/、/逗号/分号 拆分，逐项识别：地址 / 纯数字订单号 / JD运单号
  function splitSegments(text) {
    return String(text || '').split(/[\r\n、，,;；]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function classify(seg) {
    if (/^\d{12,20}$/.test(seg)) return 'order';
    if (/^JD[A-Za-z0-9]{6,}$/i.test(seg)) return 'waybill';
    if (parseAddress(seg)) return 'addr';
    return '';
  }
  var lastText = '';
  function handleClipboard(text) {
    text = String(text || '').trim();
    if (!text || text === lastText) return;
    lastText = text;
    window.__zccQuickFillGot = text; // 顶层中继据此判断是否需要补发
    var segs = splitSegments(text);
    var done = [];
    segs.forEach(function (seg) {
      var type = classify(seg);
      var r = '';
      if (type === 'order') r = fillOrder(seg);
      else if (type === 'waybill') r = fillWaybill(seg);
      else if (type === 'addr') r = fillAddress(parseAddress(seg));
      if (r) done.push(r);
    });
    if (done.length) toast('已填：' + done.join('、'));
  }

  // 顶层中继转发（弹窗未聚焦时的主通道）
  window.addEventListener('message', function (e) {
    try {
      if (e.data && e.data.type === 'ZCC_QUICK_FILL_TEXT' && String(e.origin).indexOf('jingbashi.com') !== -1) {
        handleClipboard(e.data.text);
      }
    } catch (err) {}
  });
  // iframe 自身轮询兜底（iframe已聚焦时可用）
  setInterval(function () {
    try {
      if (!document.hasFocus()) return;
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(handleClipboard).catch(function () {});
      }
    } catch (e) {}
  }, 1500); // 性能：剪贴板轮询 800ms→1500ms，粘贴事件仍即时响应
  // 粘贴事件即时响应（比轮询更快）
  document.addEventListener('paste', function (e) {
    try {
      var t = e.clipboardData && e.clipboardData.getData('text');
      if (t) handleClipboard(t);
    } catch (err) {}
  }, true);

  // ---------- 4) 手动按钮条：点击即读剪贴板填写（点击自带焦点/手势） ----------
  function forceFill(type, text) {
    text = String(text || '').trim();
    if (!text) { toast('剪贴板为空', '#e6a23c'); return; }
    lastText = text; // 同步去重标记，避免轮询重复填
    window.__zccQuickFillGot = text;
    // 混合内容时优先取对应类型的片段，取不到再用整段
    var segs = splitSegments(text);
    var seg = '';
    for (var i = 0; i < segs.length; i++) {
      if (classify(segs[i]) === type) { seg = segs[i]; break; }
    }
    if (!seg) seg = text;
    var r = '';
    if (type === 'order') r = fillOrder(seg);
    else if (type === 'waybill') r = fillWaybill(seg);
    else {
      var info = parseAddress(seg);
      if (info) r = fillAddress(info);
      else { toast('剪贴板内容不是地址格式（需含手机号+中文地址）', '#e6a23c'); return; }
    }
    if (r) toast('已填：' + r);
    else toast('未找到对应输入框', '#f56c6c');
  }
  function readAndFill(type) {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (t) { forceFill(type, t); })
          .catch(function () { toast('读取剪贴板失败，请先复制内容', '#f56c6c'); });
      } else {
        toast('当前环境不支持读取剪贴板，请直接Ctrl+V粘贴', '#e6a23c');
      }
    } catch (e) { toast('读取剪贴板失败', '#f56c6c'); }
  }
  function buildButtons() {
    if (!document.body || document.getElementById('zcc-quick-fill-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'zcc-quick-fill-bar';
    bar.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483646;display:flex;gap:6px;';
    var defs = [
      { label: '📋 填地址', type: 'addr', bg: '#67c23a' },
      { label: '填订单号', type: 'order', bg: '#409eff' },
      { label: '填运单号', type: 'waybill', bg: '#e6a23c' }
    ];
    defs.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.label;
      b.style.cssText = 'border:none;border-radius:4px;padding:4px 10px;font-size:12px;color:#fff;cursor:pointer;' +
        'background:' + d.bg + ';box-shadow:0 1px 4px rgba(0,0,0,.2);';
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        readAndFill(d.type);
      }, true);
      bar.appendChild(b);
    });
    document.body.appendChild(bar);
  }
  buildButtons();
  // ---------- 5) 售后小窗携带值自动填单：订单号 + 退货物流单号 ----------
  var orderPrefillApplied = { orderId: '', waybill: '' };
  function applyOrderPrefill() {
    var data = window.__ZCC_ORDER_PREFILL || {};
    var pending = false;
    if (data.orderId && orderPrefillApplied.orderId !== data.orderId) {
      if (fillOrder(data.orderId)) orderPrefillApplied.orderId = data.orderId;
      else pending = true;
    }
    if (data.waybill && orderPrefillApplied.waybill !== data.waybill) {
      if (fillWaybill(data.waybill)) orderPrefillApplied.waybill = data.waybill;
      else pending = true;
    }
    return !pending;
  }
  var orderPrefillTries = 0;
  var orderPrefillTimer = setInterval(function () {
    orderPrefillTries++;
    // 每个值只自动填一次，后续不覆盖用户手动修改；DOM未就绪时最多重试10秒
    if (applyOrderPrefill() || orderPrefillTries > 40) clearInterval(orderPrefillTimer);
  }, 250);
  // body 尚未就绪时兜底重试
  var btnTries = 0;
  var btnTimer = setInterval(function () {
    btnTries++;
    if (document.getElementById('zcc-quick-fill-bar') || btnTries > 20) { clearInterval(btnTimer); return; }
    buildButtons();
  }, 500);
  } // end zccQfStart

  // 智查查插件登录闸门：快速填单仅登录后可用（未登录/账号停用不注入按钮、不做中继）。
  // srcdoc 弹层（小窗内）无 chrome API，入口小窗已做登录闸门，直接放行。
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['zhichacha_token'], function (r) {
        if (r && r.zhichacha_token) zccQfStart();
      });
      return;
    }
  } catch (e) {}
  zccQfStart();
})();