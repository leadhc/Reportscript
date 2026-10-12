// 指纹模块：MD5 计算 + 与 terrain 指纹库比对。
// 语义纪律（规格书第 2 节）：哈希相同 ⇒ 同一份前端产物（逐字节一致），
// 不能单独证明「同一运营主体」——措辞约束在 letter 层强制。

const crypto = require('crypto');

function md5(buf) {
  return crypto.createHash('md5').update(Buffer.from(buf)).digest('hex');
}

/**
 * 与已知指纹库比对。
 * @returns {Array<{pageName, md5, price, capturedAt}>} 命中列表（空数组=无命中）
 */
function fingerprintMatches(md5s, terrain) {
  if (!Array.isArray(md5s) || md5s.length === 0) return [];
  const set = new Set(md5s.filter(Boolean));
  return (terrain.fingerprints || []).filter(f => set.has(f.md5));
}

module.exports = { md5, fingerprintMatches };
