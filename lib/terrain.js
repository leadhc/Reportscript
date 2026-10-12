// 地形库模块：加载 terrain.json + 按规格书 7.4 强度排序的多维关联比对。
// 只读，永不发起网络请求，永不回写 terrain.json（快照库人工维护）。

const fs = require('fs');
const path = require('path');
const { fingerprintMatches } = require('./fingerprint');

const TERRAIN_PATH = path.join(__dirname, '..', 'terrain.json');

function loadTerrain() {
  return JSON.parse(fs.readFileSync(TERRAIN_PATH, 'utf8'));
}

/**
 * 关联比对：观测特征 → 按强度排序的命中列表。
 * @param {object} obs 观测特征集合
 *   { ips: string[], cnameChain: string[], md5s: string[],
 *     icpNumber?: string, registrantEmail?: string, pageTitle?: string }
 * @returns {{ matches: Array<{kind, rank, evidence, detail}>, note: string }}
 */
function matchTerrain(obs, terrain) {
  const matches = [];

  // rank 1 icp：同一 ICP 备案号（terrain 无备案号数据，为 beian provider 恢复后预留）
  // rank 3 email：同 whois 注册邮箱（terrain 无邮箱数据，预留）
  // —— 两个通道 v1 无数据源，保持接口位，不产生命中。

  // rank 2 md5：页面文件哈希完全相同
  for (const hit of fingerprintMatches(obs.md5s, terrain)) {
    matches.push({
      kind: 'md5', rank: 2,
      evidence: '页面文件哈希完全相同（同一份前端产物）',
      detail: `MD5 ${hit.md5} 与 ${hit.capturedAt} 快照中「${hit.pageName}」页面（标价 ${hit.price || '未知'}）逐字节一致，系同一套系统在多个域名部署`,
    });
  }

  // rank 4 cname：同 CNAME 分发域
  if (Array.isArray(obs.cnameChain) && obs.cnameChain.length > 0) {
    const chain = new Set(obs.cnameChain.map(d => d.toLowerCase()));
    for (const s of terrain.servers || []) {
      for (const cd of s.cnameDispatchDomains || []) {
        if (chain.has(cd.toLowerCase())) {
          matches.push({
            kind: 'cname', rank: 4,
            evidence: '同CNAME分发域',
            detail: `CNAME 链经 ${cd}（${s.capturedAt} 快照中 ${s.role}，IP ${s.ip}）分发`,
          });
        }
      }
    }
  }

  // rank 5 ip：同服务器 IP
  if (Array.isArray(obs.ips) && obs.ips.length > 0) {
    for (const s of terrain.servers || []) {
      if (obs.ips.includes(s.ip)) {
        const carried = (s.domains || []).join('、') || '（未记录）';
        matches.push({
          kind: 'ip', rank: 5,
          evidence: '同服务器IP',
          detail: `IP ${s.ip} 与 ${s.capturedAt} 快照中「${s.role}」服务器相同，当时承载：${carried}`,
        });
      }
    }
  }

  // rank 6 copytext：相同页面文案（最弱，仅提示）
  if (obs.pageTitle) {
    const t = obs.pageTitle.trim();
    for (const f of terrain.fingerprints || []) {
      if (f.pageName && (t === f.pageName || t.includes(f.pageName) || f.pageName.includes(t))) {
        matches.push({
          kind: 'copytext', rank: 6,
          evidence: '相同页面文案（最弱，能被说成抄的）',
          detail: `页面标题「${t}」与 ${f.capturedAt} 快照已知页面「${f.pageName}」文案相近，仅作线索提示`,
        });
      }
    }
  }

  matches.sort((a, b) => a.rank - b.rank);
  return {
    matches,
    note: '以上为与历史快照的关联比对，快照会漂移，用于举报前必须当场复测。'
      + '措辞口径：只可表述「同一套系统在多个域名部署」「同一批页面被部署在多个不同公司主体的域名下」，'
      + '不得断言「同一家公司」。',
  };
}

module.exports = { loadTerrain, matchTerrain, TERRAIN_PATH };
