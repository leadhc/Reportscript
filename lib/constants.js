// 常量母本：所有值来自《举报工作提示词.md》规格书，单点定义，禁止散落复制。

// 微信 UA（规格书第 1 节，逐字）
const WXUA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN';

// 裸桌面 UA（blocked 时换 UA 重试用）
const PLAIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 业务路径清单（规格书第 2 节，23 条，按命中率排序）
const BUSINESS_PATHS = [
  'name_scope', 'mzdftf', 'sxystfa', 'txv',
  'sxysmp', 'xmb', 'xmc', 'xmd', 'xma', 'xme',
  'name-score',
  'yuelao', 'ziwei', 'bazijingpi', 'caishen', 'guandi', 'jdhy', 'gryytfb',
  'tnystf', 'xmpdtf8', 'xmxptf8', 'yanxuanqiming',
  'wisdomtest',
];

// 超时表（对齐规格书 curl --max-time）
const TIMEOUTS = {
  probe: 15000,        // 主探测 / 最终页抓取
  path: 8000,          // 业务路径单条
  rdap: 15000,         // RDAP whois
  beianProvider: 15000,// 备案单渠道
  beianBudget: 45000,  // 备案整体预算
  render: 35000,       // Playwright goto
};

const MAX_REDIRECTS = 5;      // 跳转链跟踪上限（防环）
const CNAME_MAX_HOPS = 5;     // CNAME 链跟随上限

// 注册商中文名映射（信件行文用，未命中原样输出）
const REGISTRAR_NAMES = {
  'eName Technology Co., Ltd.': '厦门易名科技',
  'Dynadot Inc': '境外注册商Dynadot',
  'Alibaba Cloud Computing Co., Ltd.': '阿里云',
  'Beijing Innovative Linkage Technology Ltd. dba www.com': '新网',
  'Chengdu West Dimension Technology Co., Ltd.': '西部数码',
  'Gname.com Pte. Ltd.': '境外注册商Gname',
  'GoDaddy.com, LLC': '境外注册商GoDaddy',
  'NameSilo, LLC': '境外注册商NameSilo',
  'Porkbun LLC': '境外注册商Porkbun',
};

// 常见二级后缀表（注册域提取的零依赖方案；表外后缀兜底取最后两段并标记启发式）
const SECOND_LEVEL_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'com.tw', 'com.sg', 'com.au', 'co.uk', 'co.jp',
]);

// 备案查询降级固定行（逐字，信件口径）
const BEIAN_DEGRADED_LINE = '公开渠道未查询到该域名ICP备案信息';

module.exports = {
  WXUA, PLAIN_UA, BUSINESS_PATHS, TIMEOUTS,
  MAX_REDIRECTS, CNAME_MAX_HOPS,
  REGISTRAR_NAMES, SECOND_LEVEL_SUFFIXES, BEIAN_DEGRADED_LINE,
};
