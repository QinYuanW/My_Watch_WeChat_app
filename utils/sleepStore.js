// utils/sleepStore.js
// 睡眠记录的云端存取层。
// 使用微信云开发（CloudBase）云数据库集合 sleep_records 持久化，
// 权限建议设为「仅创建者可读写」。
//
// 数据模型：一条记录 = 一晚睡眠 { dateKey, onset, wake, dur, turns, awakes, syncedAt }
//  - dateKey: 'MMDD'（如 '0827'），同一晚的唯一键，重复上报覆盖（upsert）
//  - onset/wake/dur: 分钟数（wake 跨 0 点可能 >1440）
//  - turns/awakes: 翻身/觉醒次数
//  - syncedAt: 最近一次上报时间戳
//
// 策略：手表 EEPROM 只存 7 天环形，蓝牙连接时全量上报云端合并；
// 云端最多保留 MAX_KEEP(14) 晚，隔太久未连接丢失的天数不补（只显示已有的）。
const COLLECTION = 'sleep_records';
const MAX_KEEP = 14;

function _db() {
  return wx.cloud.database();
}

/**
 * 上报一批睡眠记录（来自手表 OV+SLEEPGET）。
 * 按 dateKey upsert：已存在则更新，不存在则新增；完成后清理超量旧记录。
 * @param {Array} records [{dateKey:'MMDD', onset, wake, dur, turns, awakes}]
 * @returns {Promise<number>} 实际写入的条数
 */
async function syncRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  // 最新一晚（dateKey 最大）额外保留 turns/awakes 质量指标；历史只存轻字段
  const latestKey = records.reduce((m, r) => (r && r.dateKey > m ? r.dateKey : m), '');
  let written = 0;
  for (const rec of records) {
    if (!rec || !rec.dateKey) continue;
    const doc = {
      dateKey: rec.dateKey,
      onset: rec.onset || 0,
      wake: rec.wake || 0,
      dur: rec.dur || 0,
      syncedAt: Date.now(),
    };
    if (rec.dateKey === latestKey) {
      doc.turns = rec.turns || 0;
      doc.awakes = rec.awakes || 0;
    }
    // upsert：按 dateKey 查已有记录
    const existed = await _db().collection(COLLECTION)
      .where({ dateKey: rec.dateKey })
      .limit(1)
      .get();
    if (existed.data.length > 0) {
      await _db().collection(COLLECTION).doc(existed.data[0]._id).update({ data: doc });
    } else {
      await _db().collection(COLLECTION).add({ data: doc });
    }
    written++;
  }
  try { await _cleanup(MAX_KEEP); } catch (e) {
    console.warn('清理超量睡眠记录失败', e);
  }
  return written;
}

// ---------- 最近一晚 bit 图（单独一条，固定 _id） ----------
// 只保留最近一晚的逐分钟睡眠结构 hex（136字符），断连时小程序可从云端还原时间轴。
const LATEST_BITMAP_ID = 'latest_bitmap';

/**
 * 保存最近一晚的 bit 图。set：存在则整体替换，不存在则创建。
 * @param {string} dateKey 归属日期 'MMDD'
 * @param {string} bitmapHex OK+SLEEPBIT 的 hex 串
 * @param {number} onset 入睡分钟数（时间轴锚点）
 */
async function saveLatestBitmap(dateKey, bitmapHex, onset) {
  if (!dateKey || !bitmapHex) return;
  await _db().collection(COLLECTION).doc(LATEST_BITMAP_ID).set({
    data: { dateKey, bitmapHex, onset: onset || 0, syncedAt: Date.now() },
  });
}

/**
 * 读取最近一晚 bit 图记录。
 * @returns {Promise<{dateKey, bitmapHex, onset}|null>}
 */
async function getLatestBitmap() {
  try {
    const res = await _db().collection(COLLECTION).doc(LATEST_BITMAP_ID).get();
    return res.data || null;
  } catch (e) {
    return null; // 记录不存在（首次使用）等情形
  }
}

/**
 * 拉取云端最近 N 晚睡眠记录，按 dateKey 倒序。
 * @param {number} limit 最多返回条数，默认 MAX_KEEP(14)
 * @returns {Promise<Array>} [{dateKey, onset, wake, dur, turns, awakes, ...}]
 */
async function listRecords(limit = MAX_KEEP) {
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
  // dateKey 'MMDD' 字符串直接倒序即日期倒序
  results.sort((a, b) => (b.dateKey || '').localeCompare(a.dateKey || ''));
  return results.slice(0, limit);
}

async function _cleanup(keep) {
  const col = _db().collection(COLLECTION);
  const PAGE = 20;
  const all = [];
  let skip = 0;
  while (true) {
    const res = await col.skip(skip).limit(PAGE).get();
    all.push(...res.data);
    if (res.data.length < PAGE) break;
    skip += PAGE;
  }
  if (all.length <= keep) return;
  all.sort((a, b) => (b.dateKey || '').localeCompare(a.dateKey || ''));
  const toDelete = all.slice(keep);
  for (const r of toDelete) {
    await col.doc(r._id).remove();
  }
}

module.exports = {
  syncRecords,
  listRecords,
  saveLatestBitmap,
  getLatestBitmap,
  MAX_KEEP,
};
