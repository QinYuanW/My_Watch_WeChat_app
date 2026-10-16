// pages/sleep/sleep.js — OV Watch 睡眠报告页
const ble = require('../../utils/bleService.js');
const proto = require('../../utils/watchProtocol.js');
const sleepStore = require('../../utils/sleepStore.js');

Page({
  data: {
    loading: true,
    connected: false,
    // 最近一晚摘要
    latest: null,
    // 7天记录列表（新→旧）
    records: [],
    // 逐分钟色块条（最近一晚）
    timeline: [],
    timelineStartHM: '',
    timelineEndHM: '',
    // 历史睡眠趋势折线图（近14天，旧→新）
    historyPoints: [],
    historyLines: [],
    historyGrids: [],
    historyFirstDate: '',
    historyLastDate: '',
    showHistory: false,
    // 错误提示
    errorMsg: '',
    // 周统计（近7天均值/最长/最短）
    weekAvgHM: '',
    weekMaxHM: '',
    weekMinHM: '',
    weekCount: 0,
  },

  onLoad() {
    proto.init(ble);
    this._renderPlaceholder();
    // 订阅连接状态：断连瞬间立即切换到错误态（不等下次 onShow）
    this._offConn = ble.onConnChange((connected) => {
      if (!connected) {
        // 断连不清已显示的数据（云端/手表记录都保留），只更新状态提示
        this.setData({
          connected: false,
          loading: false,
          errorMsg: this.data.records.length > 0
            ? '手表未连接，当前显示云端记录'
            : '手表未连接，请先在首页连接设备',
        });
      } else {
        this.setData({ connected: true });
      }
    });
  },

  onUnload() {
    this._offConn && this._offConn();
    this._offConn = null;
  },

  onShow() {
    // 走统一加载入口：不论蓝牙是否连接，都先读云端历史；
    // 蓝牙在线时再叠加手表实时数据（含 bit 图时间轴）。
    this.setData({ connected: ble.isConnected() });
    this._loadData();
  },

  onPullDownRefresh() {
    if (ble.isConnected()) {
      this._loadData(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  // ===================== 数据加载 =====================
  // 云数据优先：先读云数据库 14 天记录（不依赖蓝牙连接）；
  // 手表在线时再拉 EEPROM 7 天实时数据合并（手表数据新，覆盖同 dateKey 云记录），
  // 并把最新一晚的 bit 图时间轴渲染出来。
  _loadData(done) {
    this.setData({ loading: true, errorMsg: '' });
    const cloudReady = sleepStore.listRecords(14)
      .then((cloudRecords) => this._renderCloud(cloudRecords))
      .catch((e) => console.warn('云数据读取失败', e));

    if (!ble.isConnected()) {
      cloudReady.then(() => {
        // 云数据已渲染；蓝牙未连接时给出提示但仍显示云端内容
        this.setData({
          loading: false,
          errorMsg: this.data.records.length > 0 ? '' : '手表未连接，云端暂无睡眠记录',
        });
        done && done();
      });
      return;
    }

    proto.getSleepData()
      .then((r) => cloudReady.then(() => {
        // 等云端渲染完成后再渲染手表数据，固定顺序：
        // 云端（兜底，无时间轴）→ 手表（覆盖，含 bit 图时间轴）。
        // 不等的话两者并行竞态，云端慢时会用空 timeline 覆盖手表渲染结果
        if (!r.ok) {
          this.setData({
            errorMsg: r.error === 'EEPROM' ? '手表读取睡眠数据失败' : '响应超时，已显示云端记录',
          });
          return;
        }
        this._renderData(r);
      }))
      .catch((e) => {
        this.setData({ errorMsg: '数据拉取失败，已显示云端记录：' + (e.message || e) });
      })
      .then(() => {
        this.setData({ loading: false });
        done && done();
      });
  },

  // 渲染云端 14 天记录（无 bit 图，仅列表；latest 取时间最新一晚做摘要卡）
  _renderCloud(cloudRecords) {
    const records = (cloudRecords || []).map((rec) => ({
      dateKey: rec.dateKey,
      onset: rec.onset,
      wake: rec.wake,
      dur: rec.dur,
      turns: rec.turns,
      awakes: rec.awakes,
      onsetHM: this._minToHM(rec.onset),
      wakeHM: this._minToHM(rec.wake % 1440),
      durHM: this._minToHM(rec.dur),
      dateText: this._dateKeyToText(rec.dateKey),
    }));
    this._cloudRecords = records; // 保存供 _renderData 合并（手表7天 + 云端更旧记录 = 14天）
    const latest = records.length > 0 ? records[0] : null; // listRecords 已按日期倒序
    this.setData({
      latest: this._decorateLatest(latest),
      records,
      timeline: [],
      timelineStartHM: '',
      timelineEndHM: '',
    });
    this._applyHistory(records);
    this._applyWeekStats(records);
    // 蓝牙不在线时，尝试从云端 latest_bitmap 还原最近一晚时间轴
    if (latest && !ble.isConnected()) {
      sleepStore.getLatestBitmap()
        .then((bm) => {
          if (!bm || bm.dateKey !== latest.dateKey || !bm.bitmapHex) return;
          if (this.data.latest !== latest) return; // 页面已被手表数据覆盖
          const bits = this._hexToBitmap(bm.bitmapHex);
          this.setData({
            timeline: this._buildTimeline(latest, bits),
            timelineStartHM: latest.onsetHM,
            timelineEndHM: latest.wakeHM,
          });
        })
        .catch(() => {});
    }
  },

  // hex 串 → 逐分钟 0/1 数组（LSB 在前，与固件写入序一致）
  _hexToBitmap(hex) {
    const bits = [];
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const byte = parseInt(hex.substr(i, 2), 16);
      if (isNaN(byte)) continue;
      for (let b = 0; b < 8; b++) bits.push((byte >> b) & 1);
    }
    return bits;
  },

  // 折线图数据构建：记录（新→旧）→ 绘图点/连线/网格（旧→新，从左到右）
  _applyHistory(records) {
    const list = (records || []).filter((r) => r && r.dateKey && r.dur > 0);
    if (list.length === 0) {
      this.setData({ showHistory: false, historyPoints: [], historyLines: [], historyGrids: [] });
      return;
    }
    const W = 600;   // 绘图区宽度 rpx
    const H = 150;   // 绘图区高度 rpx
    const pts = list.slice().reverse(); // 旧 → 新，从左到右
    const n = pts.length;
    const maxDurMin = Math.max.apply(null, pts.map((p) => p.dur));
    const maxH = Math.max(8, Math.ceil(maxDurMin / 60 / 2) * 2); // y轴顶（小时，取偶数留余量）
    const y = (dur) => (dur / 60 / maxH) * H; // 底部为0
    const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);

    const historyPoints = pts.map((p, i) => ({
      left: Math.round(x(i)),
      bottom: Math.round(y(p.dur)),
      hours: (p.dur / 60).toFixed(1),
      isLatest: i === n - 1,
    }));
    const historyLines = [];
    for (let i = 0; i + 1 < n; i++) {
      const dx = x(i + 1) - x(i);
      const dy = y(pts[i + 1].dur) - y(pts[i].dur);
      const len = Math.sqrt(dx * dx + dy * dy);
      historyLines.push({
        left: Math.round(x(i)),
        bottom: Math.round(y(pts[i].dur)),
        width: Math.round(len),
        rotate: Math.round(-Math.atan2(dy, dx) * 180 / Math.PI), // 屏幕y向下，bottom增大=向上=逆时针
      });
    }
    const historyGrids = [0, 0.5, 1].map((f) => ({
      bottom: Math.round(f * H),
      label: (maxH * f).toFixed(f === 0.5 && maxH % 2 ? 1 : 0) + 'h',
    }));
    this.setData({
      showHistory: true,
      historyPoints,
      historyLines,
      historyGrids,
      historyFirstDate: pts[0].dateText,
      historyLastDate: pts[n - 1].dateText,
    });
  },

  // 分钟数 → "HH:MM"
  _minToHM(min) {
    const m = ((min % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60);
    return (h < 10 ? '0' + h : '' + h) + ':' + (m % 60 < 10 ? '0' + (m % 60) : '' + (m % 60));
  },

  _renderData(r) {
    // 合并：手表 7 天（新鲜数据优先）+ 云端独有的更旧记录 = 最多 14 天
    const watchKeys = {};
    r.records.forEach((rec) => { watchKeys[rec.dateKey] = 1; });
    const merged = r.records.slice()
      .concat((this._cloudRecords || []).filter((rec) => !watchKeys[rec.dateKey]))
      .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
      .slice(0, 14);
    const latest = merged.length > 0 ? merged[0] : null;

    this.setData({
      latest: this._decorateLatest(latest),
      records: merged.map((rec) => ({
        ...rec,
        dateText: rec.dateText || this._dateKeyToText(rec.dateKey),
      })),
      timeline: latest ? this._buildTimeline(latest, r.bitmap) : [],
      timelineStartHM: latest ? latest.onsetHM : '',
      timelineEndHM: latest ? latest.wakeHM : '',
    });
    this._applyHistory(merged);
    this._applyWeekStats(merged);
  },

  // 最近一晚附加指标：睡眠评分(0-100) + 睡眠效率(%)
  // 效率 = 时长/在床时段；评分 = 时长得分(时长达标60分)+效率得分(40分)加权，
  // 翻身频率超阈值扣分（参考商业手环的简化版）
  _decorateLatest(latest) {
    if (!latest || !latest.dur) return latest;
    const out = { ...latest };
    const inBed = (latest.wake >= latest.onset) ? (latest.wake - latest.onset) : (latest.wake + 1440 - latest.onset);
    out.efficiency = inBed > 0 ? Math.round(latest.dur / inBed * 100) : null;

    // 评分：时长以7.5h为满，效率以95%为满，翻身按每小时>6次开始扣
    const durScore = Math.min(1, latest.dur / 450) * 60;
    const effScore = (out.efficiency == null ? 0.5 : Math.min(1, out.efficiency / 95)) * 40;
    const hours = latest.dur / 60;
    const turnPenalty = Math.min(15, Math.max(0, ((latest.turns || 0) / Math.max(hours, 0.1)) - 6) * 3);
    out.score = Math.max(0, Math.min(100, Math.round(durScore + effScore - turnPenalty)));
    return out;
  },

  // 周统计：近7天有效记录的均值/最长/最短（新→旧列表）
  _applyWeekStats(records) {
    const list = (records || []).filter((r) => r && r.dur > 0).slice(0, 7);
    if (list.length === 0) {
      this.setData({ weekAvgHM: '', weekMaxHM: '', weekMinHM: '', weekCount: 0 });
      return;
    }
    const durs = list.map((r) => r.dur);
    const avg = durs.reduce((a, b) => a + b, 0) / durs.length;
    this.setData({
      weekAvgHM: this._minToHM(Math.round(avg)),
      weekMaxHM: this._minToHM(Math.max.apply(null, durs)),
      weekMinHM: this._minToHM(Math.min.apply(null, durs)),
      weekCount: list.length,
    });
  },

  // bit图 → 时间轴色块数组
  // 每个元素 { state: 'sleep'|'wake' }，索引 = 入睡后第N分钟
  _buildTimeline(latest, bitmap) {
    if (!bitmap || bitmap.length === 0) return [];
    const n = Math.min(latest.dur, bitmap.length, 540);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ state: bitmap[i] ? 'wake' : 'sleep' });
    }
    return out;
  },

  _renderPlaceholder() {
    this.setData({
      latest: null,
      records: [],
      timeline: [],
      timelineStartHM: '',
      timelineEndHM: '',
    });
  },

  // MMDD十六进制字符串 → "5月21日"
  _dateKeyToText(key) {
    if (!key || key.length !== 4) return key || '';
    const month = parseInt(key.slice(0, 2), 16);
    const day = parseInt(key.slice(2), 16);
    if (isNaN(month) || isNaN(day)) return key;
    return month + '月' + day + '日';
  },

  // ===================== 交互 =====================
  onTapRetry() {
    if (ble.isConnected()) {
      this._loadData();
    } else {
      wx.navigateTo({ url: '/pages/index/index' });
    }
  },
});
