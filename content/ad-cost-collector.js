/**
 * 小泷京准通广告费用采集：只读取首页当前选中的“总花费”，不点击、不修改任何投放设置
 */
(function () {
  'use strict';
  if (window.top !== window.self) return;
  let sent = false;
  let tries = 0;
  const COLLECTING_TITLE = '正在获取广告费用请勿操作';

  // 静默标签和补采小窗都明确标记当前状态；每次读取时重写，防止京准通SPA覆盖标题
  document.title = COLLECTING_TITLE;

  function parseCost(text) {
    const match = String(text || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const cost = Number(match[0]);
    return isFinite(cost) && cost >= 0 ? cost : null;
  }

  function readCostFromContainer(container) {
    if (!container || !container.querySelector) return null;
    // 优先使用费用节点，兼容京准通首页可能出现的 value/cost 类名组合
    const costEl = container.querySelector('.cost-top-item-value .cost')
      || container.querySelector('.cost-top-item-value')
      || container.querySelector('.cost')
      || container.querySelector('[class*="cost-value"]');
    return parseCost(costEl ? costEl.textContent : container.textContent);
  }

  function readTotalCost() {
    const cards = Array.from(document.querySelectorAll('.cost-top-item'));
    // 优先当前选中的费用卡片；兼容首页未保留 active 类的情况
    const active = cards.filter(function (el) { return el.classList.contains('cost-top-item-active'); });
    const candidates = active.concat(cards.filter(function (el) { return active.indexOf(el) < 0; }));
    for (const card of candidates) {
      const label = card.querySelector('.cost-top-item-label');
      if (!label || label.textContent.replace(/\s/g, '') !== '总花费') continue;
      const cost = readCostFromContainer(card);
      if (cost !== null) return cost;
    }

    // 页面改版导致卡片class变化时，从文字严格等于“总花费”的标签向上找邻近费用，不读取其他指标卡片
    const labels = Array.from(document.querySelectorAll('.cost-top-item-label,[class*="label"]'));
    for (const label of labels) {
      if (String(label.textContent || '').replace(/\s/g, '') !== '总花费') continue;
      let container = label.parentElement;
      for (let depth = 0; container && depth < 3; depth++, container = container.parentElement) {
        const cost = readCostFromContainer(container);
        if (cost !== null) return cost;
      }
    }
    return null;
  }

  function collect() {
    if (sent) return;
    document.title = COLLECTING_TITLE;
    tries++;
    const cost = readTotalCost();
    if (cost !== null) {
      sent = true;
      try {
        chrome.runtime.sendMessage({ type: 'ZCC_AD_COST_COLLECTED', found: true, cost: cost, url: location.href });
      } catch (e) {}
      return;
    }
    // SPA数据可能需要登录或异步加载；持续每秒读取，由后台按静默标签、100×100和700×700阶段统一升级或超时关闭
    // 不在内容脚本提前回报最终失败，避免小窗尚未完成补采就被误判为读取失败
    if (!sent) setTimeout(collect, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', collect, { once: true });
  else collect();
})();
