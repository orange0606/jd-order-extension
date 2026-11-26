/* 京东交易后台 · 店铺拒收台账小窗（复用智查查线上台账接口） */
(function () {
  'use strict';
  if (window.top !== window.self || window.__zccLedgerPanelLoaded) return;
  window.__zccLedgerPanelLoaded = true;

  const state = { tab: 'unfinished', page: 1, pageSize: 20, total: 0, shops: [], rows: [], loading: false, shopFilterInitialized: false };
  const emptyForm = () => ({ id: null, shop_id: '', shop_name: '', order_no: '', goods_name: '', buy_order_no: '', express_no: '', express_company: '', resend_no: '', resend_company: '', type: '拒收', status: '待处理', urgency: '低', notified: '未通知', remark: '' });
  const esc = v => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
  const send = msg => new Promise(resolve => chrome.runtime.sendMessage(msg, response => {
    if (chrome.runtime.lastError) resolve({ success: false, msg: chrome.runtime.lastError.message });
    else resolve(response || { success: false, msg: '插件后台无响应' });
  }));
  const api = async (path, options = {}) => {
    const r = await send({ type: 'ZCC_LEDGER_API', path, method: options.method || 'GET', query: options.query, body: options.body });
    if (!r.success) throw new Error(r.msg || '请求失败');
    return r;
  };
  const toast = (text, error) => {
    let el = document.getElementById('zcc-ledger-toast');
    if (!el) { el = document.createElement('div'); el.id = 'zcc-ledger-toast'; document.body.appendChild(el); }
    el.textContent = text; el.className = error ? 'is-error is-show' : 'is-show';
    clearTimeout(el.__timer); el.__timer = setTimeout(() => { el.className = ''; }, 2600);
  };
  const fmt = v => {
    if (!v) return '-';
    const d = new Date(v); if (isNaN(d.getTime())) return String(v);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const copy = async text => {
    if (!text) return;
    try { await navigator.clipboard.writeText(String(text)); toast('已复制：' + text); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = String(text); ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('已复制：' + text);
    }
  };

  function draggable(panel, handle) {
    let start = null;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button,input,select,textarea')) return;
      start = { x: e.clientX, y: e.clientY, left: panel.getBoundingClientRect().left, top: panel.getBoundingClientRect().top };
      const move = ev => {
        if (!start) return;
        panel.style.left = Math.max(0, Math.min(window.innerWidth - 70, start.left + ev.clientX - start.x)) + 'px';
        panel.style.top = Math.max(0, Math.min(window.innerHeight - 42, start.top + ev.clientY - start.y)) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.transform = 'none';
      };
      const up = () => { start = null; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); e.preventDefault();
    });
  }

  function ensureEntry() {
    if (document.getElementById('zcc-ledger-entry')) return;
    const btn = document.createElement('button'); btn.id = 'zcc-ledger-entry'; btn.type = 'button'; btn.innerHTML = '<span>📒</span><b>台账</b>';
    btn.title = '打开店铺拒收台账'; btn.addEventListener('click', openList); document.body.appendChild(btn);
  }

  function ensureList() {
    let panel = document.getElementById('zcc-ledger-list-panel');
    if (panel) return panel;
    panel = document.createElement('section'); panel.id = 'zcc-ledger-list-panel';
    panel.innerHTML = `
      <header class="zcc-ledger-head"><div><strong>▤ 店铺快递补发拒收台账</strong><small>集中管理拒收 / 补发 / 售后快递单据</small></div><div><button data-action="open-admin" title="打开完整台账页面">完整页面 ↗</button><button data-action="refresh" title="刷新当前台账列表">↻ 刷新</button><button data-action="add" title="新增台账">＋ 新增台账</button><button data-action="close" title="关闭">×</button></div></header>
      <div class="zcc-ledger-tabs"><button data-tab="unfinished" class="on">未完结 <b id="zcc-lg-count-u">0</b></button><button data-tab="finished">已完结 <b id="zcc-lg-count-f">0</b></button><button data-tab="all">全部 <b id="zcc-lg-count-a">0</b></button></div>
      <div class="zcc-ledger-filters">
        <input data-query="keyword" placeholder="订单号 / 商品 / 采购单 / 快递单 / 店铺">
        <select data-query="shopId"><option value="">全部店铺</option></select>
        <select data-query="type"><option value="">全部类型</option><option>拒收</option><option>补发</option><option>售后</option><option>其它</option></select>
        <select data-query="urgency"><option value="">紧急程度</option><option>低</option><option>中</option><option>高</option></select>
        <select data-query="status"><option value="">全部状态</option><option>待处理</option><option>已处理</option><option>已完结</option></select>
        <button data-action="search">查询</button><button data-action="reset">重置</button>
      </div>
      <div class="zcc-ledger-list" id="zcc-ledger-list"><div class="zcc-ledger-empty">正在加载...</div></div>
      <footer class="zcc-ledger-pager"><span id="zcc-ledger-total">共 0 条</span><button data-action="prev">上一页</button><span id="zcc-ledger-page">1 / 1</span><button data-action="next">下一页</button></footer>`;
    document.body.appendChild(panel); draggable(panel, panel.querySelector('.zcc-ledger-head'));
    panel.addEventListener('click', async e => {
      const btn = e.target.closest('button'); if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'close') panel.style.display = 'none';
      if (action === 'add') openForm('');
      if (action === 'refresh') loadList(); // 保留当前页签、筛选和页码，仅刷新列表及统计
      if (action === 'open-admin') {
        const r = await send({ type: 'ZCC_LEDGER_OPEN_ADMIN', path: '/expressLedger' });
        if (!r || !r.success) toast((r && r.msg) || '无法打开完整台账页面', true);
      }
      if (action === 'search') { state.page = 1; loadList(); }
      if (action === 'reset') {
        panel.querySelectorAll('[data-query]').forEach(x => { x.value = ''; });
        await applyCurrentShopFilter(panel, true); // 重置恢复默认的当前店铺筛选
        state.page = 1; loadList();
      }
      if (action === 'prev' && state.page > 1) { state.page--; loadList(); }
      if (action === 'next' && state.page < Math.ceil(state.total / state.pageSize)) { state.page++; loadList(); }
      if (btn.dataset.tab) { state.tab = btn.dataset.tab; state.page = 1; loadList(); }
      if (action === 'edit') { const row = state.rows.find(x => String(x.id) === btn.dataset.id); if (row) openForm(row.order_no, row); }
      if (action === 'finish') {
        const row = state.rows.find(x => String(x.id) === btn.dataset.id); if (!row) return;
        if (!confirm('确定将订单号【' + row.order_no + '】的工单状态改为“已完结”吗？')) return;
        btn.disabled = true;
        try {
          await api('/ledger/edit', { method: 'POST', body: Object.assign({}, row, { status: '已完结' }) });
          toast('工单已完结'); loadList();
        } catch (err) { toast(err.message, true); btn.disabled = false; }
      }
      if (action === 'copy') copy(btn.dataset.value);
      if (action === 'open-pdd') {
        if (typeof window.__zccOpenPddModal === 'function') window.__zccOpenPddModal(btn.dataset.value);
        else toast('采购单小窗尚未加载，请刷新订单页后重试', true);
      }
      if (action === 'del') {
        const row = state.rows.find(x => String(x.id) === btn.dataset.id); if (!row || !confirm('确定删除订单号【' + row.order_no + '】的台账吗？删除后不可恢复。')) return;
        try { await api('/ledger/del', { method: 'DELETE', body: { id: row.id } }); toast('删除成功'); loadList(); } catch (err) { toast(err.message, true); }
      }
    });
    panel.querySelector('[data-query="keyword"]').addEventListener('keydown', e => { if (e.key === 'Enter') { state.page = 1; loadList(); } });
    return panel;
  }

  async function getCurrentShop() {
    // 订单页优先实时识别当前店铺，自主售后等页面使用插件最近保存的店铺信息
    if (typeof window.__zccGetCurrentShopInfo === 'function') {
      try {
        const info = await window.__zccGetCurrentShopInfo();
        const shopId = String((info && info.shopId) || '').trim();
        if (shopId) return { shopId, shopName: String((info && info.shopName) || '').trim() };
      } catch (e) {}
    }
    try {
      const settings = await new Promise(resolve => chrome.storage.local.get(['jd_settings'], r => resolve((r && r.jd_settings) || {})));
      return { shopId: String(settings.shopId || '').trim(), shopName: String(settings.shopName || '').trim() };
    } catch (e) { return { shopId: '', shopName: '' }; }
  }
  async function applyCurrentShopFilter(panel, force) {
    if (state.shopFilterInitialized && !force) return;
    state.shopFilterInitialized = true;
    const select = panel.querySelector('[data-query="shopId"]');
    if (!select || (!force && select.value)) return; // 用户已手动选择时不覆盖
    const current = await getCurrentShop();
    const matched = current.shopId && state.shops.some(s => String(s.shop_id) === current.shopId);
    select.value = matched ? current.shopId : ''; // 未绑定或识别不到店铺时回退全部店铺，避免误查空结果
  }

  async function loadShops() {
    if (state.shops.length) return state.shops;
    const r = await api('/shop/list'); state.shops = r.data || [];
    const options = '<option value="">全部店铺</option>' + state.shops.map(s => '<option value="' + esc(s.shop_id) + '">' + esc(s.shop_name) + '</option>').join('');
    const listSelect = document.querySelector('#zcc-ledger-list-panel [data-query="shopId"]'); if (listSelect) listSelect.innerHTML = options;
    return state.shops;
  }
  async function loadCounts() {
    try {
      const panel = ensureList();
      const shopId = panel.querySelector('[data-query="shopId"]').value.trim();
      const r = await api('/ledger/counts', { query: shopId ? { shopId } : {} }); const c = r.data || {};
      panel.querySelector('[data-tab="unfinished"] b').textContent = String(c.unfinished || 0);
      panel.querySelector('[data-tab="finished"] b').textContent = String(c.finished || 0);
      panel.querySelector('[data-tab="all"] b').textContent = String(c.all || 0);
    } catch (e) {}
  }
  async function loadList() {
    if (state.loading) return; state.loading = true;
    const panel = ensureList(), box = panel.querySelector('#zcc-ledger-list'); box.innerHTML = '<div class="zcc-ledger-empty">正在加载...</div>';
    panel.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
    try {
      const query = { tab: state.tab, page: state.page, pageSize: state.pageSize };
      panel.querySelectorAll('[data-query]').forEach(x => { query[x.dataset.query] = x.value.trim(); });
      const r = await api('/ledger/list', { query }); state.rows = (r.data && r.data.list) || []; state.total = (r.data && r.data.total) || 0;
      box.innerHTML = state.rows.length ? state.rows.map(rowHtml).join('') : '<div class="zcc-ledger-empty">暂无台账数据</div>';
      panel.querySelector('#zcc-ledger-total').textContent = '共 ' + state.total + ' 条';
      const pages = Math.max(1, Math.ceil(state.total / state.pageSize)); panel.querySelector('#zcc-ledger-page').textContent = state.page + ' / ' + pages;
      panel.querySelector('[data-action="prev"]').disabled = state.page <= 1; panel.querySelector('[data-action="next"]').disabled = state.page >= pages;
      await loadCounts(); // 等计数回包后再结束本轮加载，避免列表已显示但顶部统计仍停留为0
    } catch (e) { box.innerHTML = '<div class="zcc-ledger-empty is-error">' + esc(e.message) + '</div>'; }
    finally { state.loading = false; }
  }
  function rowHtml(r) {
    const logistics = [r.express_company, r.express_no].filter(Boolean).join(' ');
    const resend = [r.resend_company, r.resend_no].filter(Boolean).join(' ');
    return `<article class="zcc-ledger-card ug-${esc(r.urgency || '低')}">
      <div class="zcc-lg-card-top">
        <span class="zcc-lg-shop">▣ ${esc(r.shop_name || '未指定店铺')}</span><span class="zcc-lg-type">${esc(r.type)}</span>
        <button class="zcc-lg-order-copy" data-action="copy" data-value="${esc(r.order_no)}" title="复制订单号">订单号 ${esc(r.order_no)} ⧉</button><span class="zcc-lg-time">${fmt(r.created_at)}</span>
        ${r.status !== '已完结' ? '<button data-action="finish" data-id="' + r.id + '" class="zcc-lg-finish">完结</button>' : ''}<button data-action="edit" data-id="${r.id}" class="zcc-lg-edit">编辑</button><button data-action="del" data-id="${r.id}" class="zcc-lg-delete">删除</button>
      </div>
      ${r.goods_name ? '<div class="zcc-lg-goods" title="' + esc(r.goods_name) + '">▤ ' + esc(r.goods_name) + '</div>' : ''}
      ${(r.buy_order_no || logistics || resend) ? '<div class="zcc-lg-fields">' +
        (r.buy_order_no ? '<div class="zcc-lg-field-buy"><label>采购单</label><button data-action="open-pdd" data-value="' + esc(r.buy_order_no) + '" title="小窗查看采购单">' + esc(r.buy_order_no) + ' 🗗</button></div>' : '') +
        (logistics ? '<div><label>发货</label><button data-action="copy" data-value="' + esc(r.express_no) + '" title="复制发货快递单号">' + esc(logistics) + (r.express_no ? ' ⧉' : '') + '</button></div>' : '') +
        (resend ? '<div><label>补发</label><button data-action="copy" data-value="' + esc(r.resend_no) + '" title="复制补发快递单号">' + esc(resend) + (r.resend_no ? ' ⧉' : '') + '</button></div>' : '') + '</div>' : ''}
      <div class="zcc-lg-card-foot"><div><span class="zcc-lg-status st-${esc(r.status)}">${esc(r.status)}</span><span class="zcc-lg-urgency">${esc(r.urgency || '低')}优先级</span><span>通知：${esc(r.notified || '未通知')}</span></div>${r.remark ? '<span class="zcc-lg-remark-text" title="' + esc(r.remark) + '">备注：' + esc(r.remark) + '</span>' : ''}</div>
    </article>`;
  }
  async function openList() {
    const panel = ensureList(); panel.style.display = 'flex';
    try {
      await loadShops();
      await applyCurrentShopFilter(panel, false); // 首次打开默认只查询当前店铺，后续保留用户手动选择
    } catch (e) { toast(e.message, true); }
    loadList();
  }

  function field(label, name, type = 'input', options = []) {
    const control = type === 'select'
      ? '<select data-field="' + name + '">' + options.map(x => '<option value="' + esc(x) + '">' + esc(x) + '</option>').join('') + '</select>'
      : type === 'textarea' ? '<textarea data-field="' + name + '" maxlength="200" rows="3"></textarea>'
      : '<input data-field="' + name + '" type="text">';
    return '<label class="zcc-lg-field' + (name === 'goods_name' || name === 'buy_order_no' ? ' zcc-lg-field-wide' : '') + '"><span>' + label + '</span>' + control + '</label>';
  }
  async function openForm(orderNo, row) {
    let panel = document.getElementById('zcc-ledger-form-panel'); if (panel) panel.remove();
    panel = document.createElement('section'); panel.id = 'zcc-ledger-form-panel';
    panel.innerHTML = `<header class="zcc-ledger-head"><strong>${row ? '编辑 / 处理台账' : '新增台账'}</strong><button data-form-action="close">×</button></header>
      <div class="zcc-ledger-form-body"><div class="zcc-lg-form-main"><div class="zcc-lg-form-grid">
      ${field('订单号 *', 'order_no')}${field('店铺名称', 'shop_id', 'select', [''])}${field('商品名称', 'goods_name')}
      ${field('采购订单号', 'buy_order_no')}${field('状态', 'status', 'select', ['待处理', '已处理', '已完结'])}${field('类型', 'type', 'select', ['拒收', '补发', '售后', '其它'])}
      ${field('发货快递公司', 'express_company')}${field('发货快递单号', 'express_no')}${field('补发快递公司', 'resend_company')}${field('补发快递单号', 'resend_no')}
      ${field('紧急程度', 'urgency', 'select', ['低', '中', '高'])}${field('是否已通知', 'notified', 'select', ['未通知', '短信', '客服', '短信+客服'])}
      <div class="zcc-lg-remark">${field('备注', 'remark', 'textarea')}</div></div>
      <div class="zcc-lg-lookup" id="zcc-lg-lookup">智查查订单与京巴士关联单将自动回填，也可手动修改。</div></div>
      <aside class="zcc-lg-jbs-panel"><h4>京巴士关联单</h4><p>查询关联采购单，可点击单号快速复制。</p><div id="zcc-lg-jbs-list"><div class="zcc-lg-jbs-empty">正在查询关联单...</div></div></aside></div>
      <footer class="zcc-ledger-form-foot"><button data-form-action="cancel">取消</button><button data-form-action="save" class="primary">${row ? '保存修改' : '确认新增'}</button></footer>`;
    document.body.appendChild(panel); draggable(panel, panel.querySelector('.zcc-ledger-head'));
    const data = Object.assign(emptyForm(), row || {}, { order_no: orderNo || (row && row.order_no) || '' });
    if (!row && orderNo) { const card = findOrderCard(orderNo); if (card) data.goods_name = ((card.querySelector('.sku-name') || {}).textContent || '').trim(); }
    Object.keys(data).forEach(k => { const el = panel.querySelector('[data-field="' + k + '"]'); if (el) el.value = data[k] === null ? '' : data[k]; });
    const orderInput = panel.querySelector('[data-field="order_no"]'); orderInput.disabled = !!row;
    try { await loadShops(); const shopSelect = panel.querySelector('[data-field="shop_id"]'); shopSelect.innerHTML = '<option value="">自动回填 / 请选择</option>' + state.shops.map(s => '<option value="' + esc(s.shop_id) + '">' + esc(s.shop_name) + '</option>').join(''); shopSelect.value = data.shop_id || ''; } catch (e) { toast(e.message, true); }
    panel.addEventListener('click', async e => {
      const btn = e.target.closest('button'); if (!btn) return; const action = btn.dataset.formAction;
      if (action === 'close' || action === 'cancel') panel.remove();
      if (action === 'copy-jbs') copy(btn.dataset.value);
      if (action === 'save') {
        const payload = {}; panel.querySelectorAll('[data-field]').forEach(el => { payload[el.dataset.field] = el.value.trim(); }); payload.id = data.id;
        payload.shop_name = state.shops.find(s => s.shop_id === payload.shop_id)?.shop_name || data.shop_name || '';
        if (!payload.order_no) { toast('订单号不能为空', true); return; }
        btn.disabled = true; btn.textContent = '保存中...';
        try { await api(row ? '/ledger/edit' : '/ledger/add', { method: 'POST', body: payload }); toast(row ? '修改成功' : '新增台账成功'); panel.remove(); if (document.getElementById('zcc-ledger-list-panel')) loadList(); }
        catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = row ? '保存修改' : '确认新增'; }
      }
    });
    if (orderNo) lookupOrder(panel, data, !row);
    orderInput.addEventListener('blur', () => { if (!row && orderInput.value.trim()) lookupOrder(panel, data, true); });
  }
  function renderJbsRows(panel, rows) {
    const box = panel.querySelector('#zcc-lg-jbs-list'); if (!box) return;
    box.innerHTML = rows && rows.length ? rows.map(function (r, i) {
      return '<div class="zcc-lg-jbs-row"><div class="zcc-lg-jbs-title">关联单 ' + (i + 1) + '<span>' + esc(r.express_status || '待处理') + '</span></div>' +
        ['buy_order_id', 'buy_express_id', 'buy_express_company'].map(function (k) {
          const label = { buy_order_id: '采购订单号', buy_express_id: '发货单号', buy_express_company: '快递公司' }[k];
          return '<div class="zcc-lg-jbs-field"><label>' + label + '</label><button type="button" data-form-action="copy-jbs" data-value="' + esc(r[k] || '') + '">' + esc(r[k] || '-') + ' ⧉</button></div>';
        }).join('') + '</div>';
    }).join('') : '<div class="zcc-lg-jbs-empty">暂无关联采购单，可手动填写左侧信息。</div>';
  }
  async function lookupOrder(panel, data, autofill) {
    const orderNo = panel.querySelector('[data-field="order_no"]').value.trim(), tip = panel.querySelector('#zcc-lg-lookup'); if (!orderNo) return;
    tip.textContent = '正在查询智查查订单与京巴士关联单...';
    let shopName = '', goodsName = '';
    try { const r = await api('/ledger/lookup', { query: { orderNo } }); if (r.data) {
      shopName = r.data.shop_name || ''; goodsName = r.data.goods_name || '';
      if (autofill) { panel.querySelector('[data-field="shop_id"]').value = r.data.shop_id || ''; if (!panel.querySelector('[data-field="goods_name"]').value) panel.querySelector('[data-field="goods_name"]').value = goodsName; }
    } } catch (e) {}
    const jbs = await send({ type: 'ZCC_LEDGER_LOOKUP', orderNo });
    renderJbsRows(panel, jbs.ok ? jbs.rows : []);
    if (jbs.ok && jbs.rows && jbs.rows.length) {
      const first = jbs.rows[0]; if (autofill) ['buy_order_no', 'express_no', 'express_company'].forEach(k => {
        const source = { buy_order_no: 'buy_order_id', express_no: 'buy_express_id', express_company: 'buy_express_company' }[k], el = panel.querySelector('[data-field="' + k + '"]'); if (!el.value) el.value = first[source] || '';
      });
      tip.textContent = '已匹配' + (shopName ? '店铺：' + shopName : '订单') + '；京巴士已查询 ' + jbs.rows.length + ' 条关联单并回填首条。';
    } else tip.textContent = (shopName ? '已匹配店铺：' + shopName + '；' : '智查查未匹配订单；') + (jbs.notLogin ? '京巴士未登录，请手动填写。' : '京巴士无关联单，可手动填写。');
  }

  function findOrderCard(orderNo) {
    return Array.from(document.querySelectorAll('.card')).find(c => c.getAttribute('data-jbs-order-id') === orderNo || c.getAttribute('data-orange-jbs-order-id') === orderNo || (c.textContent || '').includes(orderNo));
  }
  function orderNoOf(card) {
    const direct = card.getAttribute('data-jbs-order-id') || card.getAttribute('data-orange-jbs-order-id') || ((card.querySelector('.shop-order-id .order-info-btn span') || {}).textContent || '').trim();
    if (direct) return direct;
    // 自主售后关联单没有标准订单号节点时，从“关联采购单订单号：xxx”文本读取京东订单号
    const match = (card.textContent || '').match(/(?:关联采购单订单号|订单号)\s*[：:]\s*(\d{6,24})/);
    return match ? match[1] : '';
  }
  function createOrderLedgerButton(orderNo, assoc) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'zcc-order-ledger-btn' + (assoc ? ' zcc-order-ledger-assoc-btn' : '');
    btn.textContent = '📒'; btn.title = '自动填入当前订单号并新增台账'; btn.dataset.orderNo = orderNo;
    return btn;
  }
  function injectAssocOrderButtons(root, orderNo) {
    if (!orderNo) return;
    root.querySelectorAll('.j_buyMsg').forEach(holder => {
      if (holder.querySelector('.zcc-order-ledger-assoc-btn')) return;
      // 京巴士/自主售后关联单的物流信息通常在末尾，图标直接放在整块关联单后面
      holder.appendChild(createOrderLedgerButton(orderNo, true));
    });
  }
  function injectOrderButtons() {
    const isOrderPage = location.href.includes('/jdm/trade/orders/');
    const isAfterSalePage = location.href.includes('/jdm/trade/after-sale/');
    if (!isOrderPage && !isAfterSalePage) return;
    if (isAfterSalePage) {
      // 自主售后关联单由 after-sale-bind.js 生成，订单号保存在 bar 的 data-zcc-order-id 上
      document.querySelectorAll('.zcc-afs-bind-bar[data-zcc-order-id]').forEach(bar => {
        const orderNo = bar.getAttribute('data-zcc-order-id') || '';
        if (!orderNo) return;
        const rows = Array.from(bar.children).filter(el => el.tagName === 'DIV' && (el.textContent || '').includes('关联采购单'));
        (rows.length ? rows : [bar]).forEach(row => {
          if (!row.querySelector('.zcc-order-ledger-assoc-btn')) row.appendChild(createOrderLedgerButton(orderNo, true));
        });
      });
      document.querySelectorAll('.j_buyMsg').forEach(holder => {
        const container = holder.closest('[data-jbs-order-id],[data-orange-jbs-order-id],.card,tr') || holder;
        const orderNo = orderNoOf(container) || orderNoOf(holder);
        if (!holder.querySelector('.zcc-order-ledger-assoc-btn') && orderNo) holder.appendChild(createOrderLedgerButton(orderNo, true));
      });
      return;
    }
    document.querySelectorAll('.card').forEach(card => {
      const orderNo = orderNoOf(card); if (!orderNo) return;
      injectAssocOrderButtons(card, orderNo);
      const targets = Array.from(card.querySelectorAll('.orange-zcc-report-btn,button,a,span')).filter(el => el.classList.contains('orange-zcc-report-btn') || /^(自主售后|发货物流)$/.test((el.textContent || '').trim()));
      // 优先跟随智查查风险/关联单操作区。风险区后渲染时会替换旧按钮，故不能用卡片一次性标记跳过扫描
      const host = targets.length ? targets[targets.length - 1].parentElement : null;
      const oldBtns = Array.from(card.querySelectorAll('.zcc-order-ledger-btn:not(.zcc-order-ledger-assoc-btn)'));
      if (host && host.classList.contains('orange-zcc-risk-bar')) {
        oldBtns.forEach(old => { if (old.parentElement !== host) old.remove(); });
        if (!host.querySelector('.zcc-order-ledger-btn')) {
          const btn = createOrderLedgerButton(orderNo, false);
          const report = host.querySelector('.orange-zcc-report-btn');
          if (report) report.insertAdjacentElement('afterend', btn); else host.appendChild(btn);
        }
        card.setAttribute('data-zcc-ledger-bound', '1');
        return;
      }
      if (card.getAttribute('data-zcc-ledger-bound') === '1') return;
      card.setAttribute('data-zcc-ledger-bound', '1');
      const btn = createOrderLedgerButton(orderNo, false); btn.classList.add('zcc-order-ledger-fallback');
      if (targets.length) targets[targets.length - 1].insertAdjacentElement('afterend', btn);
      else { const fallbackHost = card.querySelector('.card-footer,.card-bottom,.card-content') || card; fallbackHost.appendChild(btn); }
    });
  }
  document.addEventListener('click', e => { const btn = e.target.closest('.zcc-order-ledger-btn'); if (btn) { e.preventDefault(); e.stopPropagation(); openForm(btn.dataset.orderNo); } }, true);

  function init() {
    ensureEntry(); injectOrderButtons();
    let timer = null; new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(injectOrderButtons, 250); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
