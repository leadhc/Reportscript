// RDAP whois 模块：rdap.org 引导查询 + 解析 + 原始 JSON 落盘留档。
// 永不抛异常：失败返回 { status: 'unavailable', error }，主流程继续。

const fs = require('fs');
const path = require('path');
const { fetchJson } = require('./net');
const { TIMEOUTS, REGISTRAR_NAMES } = require('./constants');

/**
 * @param {string} domain 注册域
 * @param {string} outDir 报告目录（rdap_<域名>.json 落盘处）
 * @returns {{status:'ok', registrar, registrarName, registeredAt, expiresAt,
 *            lastChangedAt, registrantName, registrantEmail, nameservers, rawFile}
 *          | {status:'unavailable', error}}
 */
async function whoisLookup(domain, outDir) {
  const r = await fetchJson(`https://rdap.org/domain/${domain}`, {
    timeoutMs: TIMEOUTS.rdap,
  });
  if (!r.ok) {
    return { status: 'unavailable', error: r.error };
  }
  const j = r.data;

  // 原始返回留档（审计链）
  const rawFile = `rdap_${domain}.json`;
  try {
    fs.writeFileSync(path.join(outDir, rawFile), JSON.stringify(j, null, 2));
  } catch { /* 落盘失败不阻塞解析 */ }

  const result = {
    status: 'ok',
    registrar: null,
    registrarName: null,       // 中文名映射（信件行文用）
    registeredAt: null,
    expiresAt: null,
    lastChangedAt: null,
    registrantName: null,      // 通常隐私保护为 null，如实记录
    registrantEmail: null,
    nameservers: [],
    rawFile,
  };

  for (const ev of j.events || []) {
    if (ev.eventAction === 'registration') result.registeredAt = String(ev.eventDate).slice(0, 10);
    if (ev.eventAction === 'expiration') result.expiresAt = String(ev.eventDate).slice(0, 10);
    if (ev.eventAction === 'last changed') result.lastChangedAt = String(ev.eventDate).slice(0, 10);
  }
  for (const ns of j.nameservers || []) {
    if (ns.ldhName) result.nameservers.push(ns.ldhName.toLowerCase());
  }

  // 递归遍历 entities（含 registrar→abuse 嵌套），提取 vCard 字段
  const walkEntities = (entities) => {
    for (const e of entities || []) {
      const roles = e.roles || [];
      const vcard = e.vcardArray && Array.isArray(e.vcardArray[1]) ? e.vcardArray[1] : [];
      for (const v of vcard) {
        if (roles.includes('registrar') && v[0] === 'fn' && !result.registrar) {
          result.registrar = v[3];
        }
        if (roles.includes('registrant')) {
          if (v[0] === 'fn' && !result.registrantName) result.registrantName = v[3];
          if (v[0] === 'email' && !result.registrantEmail) result.registrantEmail = v[3];
        }
      }
      if (e.entities) walkEntities(e.entities);
    }
  };
  walkEntities(j.entities);

  if (result.registrar) {
    result.registrarName = REGISTRAR_NAMES[result.registrar] || null;
  }
  return result;
}

module.exports = { whoisLookup };
