/**
 * ==============================================
 * 智查查订单同步助手 - 配置文件
 * 部署时修改这里即可，不用改其他代码
 * ==============================================
 */
const ZHICHACHA_CONFIG = {
  // ====== 云服务器配置（当前使用） ======
  // 后端API接口地址（最后不要加斜杠）
  apiBaseUrl: 'http://81.71.9.134/api',

  // 后台管理页面地址（末尾保留斜杠，代码会拼接 #/路由）
  adminUrl: 'http://81.71.9.134/zhichacha/',

  // 搜索恶人页面地址
  searchBadGuyUrl: 'http://81.71.9.134/zhichacha/#/villainsSearch',

  // 举报页面地址
  reportUrl: 'http://81.71.9.134/zhichacha/#/reportManage?keyword={keyword}&tab=all',

  // ====== 本地开发配置（备用，如需本地调试替换上面的值即可） ======
  // apiBaseUrl: 'http://localhost:3001/api',
  // adminUrl: 'http://localhost:8080/',
  // searchBadGuyUrl: 'http://localhost:8080/#/villainsSearch',
  // reportUrl: 'http://localhost:8080/#/reportManage?keyword={keyword}&tab=all',

  // 自动同步延迟（毫秒）- 进入页面后多久自动抓取
  autoSyncDelay: 10000,

  // 是否开启自动同步
  autoSyncEnabled: true,

  // 是否显示抓取通知
  showNotification: true,

  // 定时批量查单发货（默认关闭，间隔默认30分钟）
  autoShipEnabled: false,
  autoShipInterval: 30,

  // 定时发货时间范围限制（勾选后仅在该时段内执行，格式 HH:MM）
  autoShipTimeRangeEnabled: false,
  autoShipTimeStart: '07:00',
  autoShipTimeEnd: '22:00'
};

// 兼容CommonJS和浏览器全局
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZHICHACHA_CONFIG;
}
