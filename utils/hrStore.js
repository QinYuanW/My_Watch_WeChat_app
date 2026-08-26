// utils/hrStore.js
// 历史心率采样点的云端存取层。
// 使用微信云开发（CloudBase）云数据库集合 hr_samples 持久化，
// 权限建议设为「仅创建者可读写」，这样 add 自动带 _openid、get 自动只返回本人数据。
//
// 数据模型：一条记录 = 一个真实计算出的心率值 { hr, ts }。
// 每次进入心率页面测出的每个真实心率都会叠加写入，只保留最近 MAX_KEEP 条。
const COLLECTION = 'hr_samples';

// 只保留最近 N 条心率采样点，超出则删除最旧的
const MAX_KEEP = 25;

function _db() {
  return wx.cloud.database();
}

/**
 * 保存一个真实心率采样点，并清理超量旧记录（只保留最新 MAX_KEEP 条）。
 * @param {Object} record { hr, ts } ，hr 为心率值，ts 为毫秒时间戳
 * @returns {Promise}
 */
async function saveSample(record) {
  const addRes = await _db().collection(COLLECTION).add({ data: record });
  try {
    await _cleanup(MAX_KEEP);
  } catch (e) {
    // 清理失败不阻塞主流程，仅记录
    console.warn('清理超量历史失败', e);
  }
  return addRes;
}

/**
 * 拉取全部记录并按 ts 倒序，删除 keep 条之外的最旧记录。
 * 小程序端云数据库 doc().remove() 逐条删除，数据量小（<=几十条）可接受。
 * @param {number} keep 保留条数
 */
async function _cleanup(keep) {
  const col = _db().collection(COLLECTION);
  const PAGE = 20;
  const all = [];
  let skip = 0;
  // 分页拉满全部记录
  while (true) {
    const res = await col.skip(skip).limit(PAGE).get();
    all.push(...res.data);
    if (res.data.length < PAGE) break;
    skip += PAGE;
  }
  if (all.length <= keep) return;
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const toDelete = all.slice(keep);
  for (const r of toDelete) {
    await _db().collection(COLLECTION).doc(r._id).remove();
  }
}

/**
 * 按时间倒序分页拉取心率采样点列表。
 * @param {number} limit 最多返回条数，默认 MAX_KEEP(25)
 * @returns {Promise<Array>} 按 ts 倒序的记录数组（每条含 _id/_openid/hr/ts）
 */
async function listSamples(limit = MAX_KEEP) {
  const col = _db().collection(COLLECTION);
  const PAGE = 20;
  const results = [];
  let skip = 0;
  while (results.length < limit) {
    const res = await col.skip(skip).limit(PAGE).get();
    results.push(...res.data);
    if (res.data.length < PAGE) break;
    skip += PAGE;
  }
  // 客户端按 ts 倒序排序，避免 orderBy 需要额外索引
  results.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return results.slice(0, limit);
}

module.exports = {
  saveSample,
  listSamples,
};