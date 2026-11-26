/**
 * ==============================================
 * 智查查订单同步助手 - 配置文件
 * 部署时修改这里即可，不用改其他代码
 * ==============================================
 */
const ZHICHACHA_CONFIG = {
  // ====== 插件版本号（更新插件时同步修改，用于检测新版本） ======
  version: '3.0.1',
  // 后端API接口地址（最后不要加斜杠）
  apiBaseUrl: 'http://81.71.9.134/api',
  // 本地开发调试时解开下面这行，注释上面线上地址
  // apiBaseUrl: 'http://localhost:3001/api',

  // 后台管理页面地址（末尾保留斜杠，代码会拼接 #/路由）
  adminUrl: 'http://81.71.9.134/zhichacha/',
  // 本地开发调试时解开下面这行，注释上面线上地址
  // adminUrl: 'http://localhost:8080/',

  // 风险检测页面地址（点击跨店订单跳转）
  riskSearchUrl: 'http://81.71.9.134/zhichacha/#/riskSearch',

  // 浏览器插件下载页面地址（检测到新版本跳转）
  extensionDownloadUrl: 'http://81.71.9.134/zhichacha/#/extension/download',

  // 搜索恶人页面地址
  searchBadGuyUrl: 'http://81.71.9.134/zhichacha/#/villainsSearch',

  // 京巴士订单状态页（同步物流状态并发送取件码）
  jbsExpressUrl: 'https://pay.jingbashi.com/back.php/order/status?ref=addtabs',

  // 举报页面地址
  reportUrl: 'http://81.71.9.134/zhichacha/#/reportManage?keyword={keyword}&tab=all',

  // ====== 本地开发配置（备用，如需本地调试替换上面的值即可） ======
  // apiBaseUrl: 'http://localhost:3001/api',
  // adminUrl: 'http://localhost:8080/',
  // riskSearchUrl: 'http://localhost:8080/#/riskSearch',
  // extensionDownloadUrl: 'http://localhost:8080/#/extension/download',
  // searchBadGuyUrl: 'http://localhost:8080/#/villainsSearch',
  // reportUrl: 'http://localhost:8080/#/reportManage?keyword={keyword}&tab=all',

  // 自动同步延迟（毫秒）- 进入页面后多久自动抓取
  autoSyncDelay: 10000,

  // 是否开启自动同步
  autoSyncEnabled: true,

  // 是否显示抓取通知
  showNotification: true,

  // 定时查单发货/执行间隔/自动同步物流/执行时段等默认配置已移除，统一由订单页“定时任务”面板独立管理

  // 自动切换店铺流程参数（切换任务由定时任务面板触发）
  shopSwitchCountdown: 30,        // 切换前提示倒计时（秒），即预留的切换时间
  shopSwitchGap: 30000,           // 同一轮内，上一店发货完成到下一店开始切换的间隔（毫秒）
  shopListDialogTimeout: 8000,    // 点击店铺列表按钮后，等待店铺列表面板出现的超时（毫秒）
  shopChangeTimeout: 30000,       // 点击目标店铺后，等待页面刷新并切换到该店铺的超时（毫秒）
  perShopShipTimeout: 120000      // 单个店铺批量查单发货最长执行时间（毫秒，2分钟）
};

// 兼容CommonJS和浏览器全局
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZHICHACHA_CONFIG;
}
