// pages/index/index.js — OV Watch 仪表盘逻辑
const ble = require('../../utils/bleService.js');
const proto = require('../../utils/watchProtocol.js');
const hrStore = require('../../utils/hrStore.js');

const LAST_DEVICE_KEY = 'last_connected_device'; // wx.storageSync 的 key

Page({
  data: {
    // 状态
    scanning: false,
    connected: false,
    statusText: '未连接',
    statusClass: 'status-warn',
    deviceInfo: null,
    lastDeviceId: '',

    // 首页展示数据
    currentDate: '',
    overviewProgress: 0, // 0-100
    sleepDuration: '--',

    // 传感器数据
    sensor: {
      date: '',
      time: '',
      humidity: '',
      temperature: '',
      heartRate: '',
      spo2: '',
      steps: '',
      light: '',
    },

    // 交互状态
    busy: false,
  },

  // ===================== 生命周期 =====================
  onLoad() {
    this._offHRListener = null;
    ble.init({
      onLog: (level, text) => this.pushLog(level, text),
      onConnectionChange: (connected) => {
        this.setData({
          connected,
          statusText: connected ? '已连接' : '未连接',
          statusClass: connected ? 'status-ok' : 'status-warn',
        });
        if (!connected) {
          this.setData({ deviceInfo: null, version: '' });
          this._stopHRCapture();
        } else {
          // 连接成功后开启心率上报
          if (!this.data.otaMode) {
            this._startHRCapture();
            this._autoRefreshData(); // 刷新一次数据
          }
        }
      },
      onRawLine: (line) => this.pushLog('rx', 'RX  ' + line),
    });
    proto.init(ble);

    // 显示当前日期
    this._updateCurrentDate();

    // 读取缓存
    try {
      const saved = wx.getStorageSync(LAST_DEVICE_KEY);
      if (saved) {
        this.setData({ lastDeviceId: saved });
        // 自动尝试连接上次设备
        this._autoConnect(saved);
      } else {
        // 首次使用，提示用户或自动扫描
        this._startAutoScan();
      }
    } catch (e) {}
  },

  onShow() {
    // 每次显示时刷新一下数据（如果已连接）
    if (this.data.connected && !this.data.busy) {
      this._autoRefreshData();
    }
  },

  onUnload() {
    this._stopHRCapture();
    try { proto.bootExitRawMode(); } catch (e) {}
    // 不主动断开，允许后台保活
  },

  // ===================== 初始化数据 =====================
  _updateCurrentDate() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const week = weekDays[now.getDay()];
    this.setData({ currentDate: `${month}月${day}日 ${week}` });
  },

  // ===================== 自动连接/扫描 =====================
  _autoConnect(deviceId) {
    this.pushLog('info', `尝试自动连接上次设备: ${deviceId}`);
    this.setData({ statusText: '连接中...', statusClass: 'status-info' });
    
    const timeout = setTimeout(() => {
      // 连接超时，改为扫描模式
      this.pushLog('warn', '自动连接超时，开启扫描...');
      if (!this.data.connected) {
        this._startAutoScan();
      }
    }, 5000);

    ble.connect(deviceId)
      .then(() => {
        clearTimeout(timeout);
        const info = { deviceId, name: 'OV Watch', RSSI: -50 };
        this.setData({
          statusText: '已连接',
          statusClass: 'status-ok',
          deviceInfo: info,
        });
        this.pushLog('ok', `自动连接成功: ${deviceId}`);
        try { wx.setStorageSync(LAST_DEVICE_KEY, deviceId); } catch (e) {}
        this.markLastDevice(deviceId);
        // 连接成功后同步时间
        this._syncTime();
      })
      .catch((err) => {
        clearTimeout(timeout);
        this.pushLog('warn', `自动连接失败: ${err && err.message}`);
        this._startAutoScan();
      });
  },

  _startAutoScan() {
    this.setData({
      scanning: true,
      statusText: '扫描中...',
      statusClass: 'status-info',
      deviceList: [],
    });
    this.pushLog('info', '自动扫描附近设备...');

    ble.startScan(
      (newDev, allList) => {
        // 自动连接第一个可用设备（假设只有一个手表）
        if (allList.length > 0 && !this.data.connected) {
          this.pushLog('info', `发现设备，尝试连接: ${allList[0].name || allList[0].deviceId}`);
          ble.stopScan();
          this._autoConnect(allList[0].deviceId);
        }
      },
      ({ devices, timeout }) => {
        if (!this.data.connected) {
          this.setData({
            scanning: false,
            statusText: timeout ? '扫描超时' : '扫描完成',
            statusClass: devices.length === 0 ? 'status-err' : 'status-info',
          });
          // 如果没找到设备，显示模态提示
          if (devices.length === 0) {
            wx.showModal({
              title: '未检测到设备',
              content: '请确认手表已开机并处于可发现状态（约30秒），然后点击"重新扫描"。',
              confirmText: '重新扫描',
              success: (res) => {
                if (res.confirm) this._startAutoScan();
              }
            });
          }
        }
      }
    );
  },

  // ===================== 数据刷新 =====================
  _autoRefreshData() {
    if (!this.data.connected || this.data.busy) return;
    this.withBusy(() => {
      return proto.queryAll().then((r) => {
        const d = r.data;
        this.setData({
          sensor: {
            date: d.date != null ? d.date : '',
            time: d.time != null ? d.time : '',
            humidity: d.humidity != null ? d.humidity : '',
            temperature: d.temperature != null ? d.temperature : '',
            heartRate: d.heartRate != null ? d.heartRate : '',
            spo2: d.spo2 != null ? d.spo2 : '',
            steps: d.steps != null ? d.steps : '',
            light: d.light != null ? d.light : '',
          },
        });
        if (d.steps != null) {
          // 计算进度 (假设目标 8000 步)
          const progress = Math.min(100, Math.round((d.steps / 8000) * 100));
          this.setData({ overviewProgress: progress });
        }
      });
    });
  },

  // ===================== 同步时间 =====================
  _syncTime() {
    this.withBusy(() => {
      return proto.syncTime().then((r) => {
        if (r.ok) {
          this.pushLog('ok', '时间同步成功');
        }
      });
    });
  },

  // ===================== 心率监听 =====================
  _startHRCapture() {
    if (this._offHRListener) return;
    this._offHRListener = proto.onHRData((evt) => {
      if (evt.type === 'sample' && evt.hr != null) {
        hrStore.saveSample({ hr: evt.hr, ts: Date.now() })
          .catch((e) => console.warn('保存心率失败', e));
      }
    });
    proto.setHRReport(true).catch(() => {});
  },

  _stopHRCapture() {
    if (this._offHRListener) {
      try { this._offHRListener(); } catch (e) {}
      this._offHRListener = null;
    }
    if (ble.isConnected()) {
      try { proto.setHRReport(false); } catch (e) {}
    }
  },

  markLastDevice(lastId) {
    if (!lastId) return;
  },

  // ===================== 日志 =====================
  pushLog(level, text) {
    // 仅写入 console，不显示在 UI 上（用户无需看到）
    console.log(`[OV] ${level}: ${text}`);
  },

  // ===================== 交互事件 =====================

  // 点击顶部状态（手动扫描/断开）
  onTapConnection() {
    if (this.data.connected) {
      wx.showActionSheet({
        itemList: ['断开连接', '重新扫描'],
        success: (res) => {
          if (res.tapIndex === 0) {
            try { proto.bootExitRawMode(); } catch (e) {}
            ble.disconnect();
          } else if (res.tapIndex === 1) {
            try { proto.bootExitRawMode(); } catch (e) {}
            ble.disconnect(() => {
              setTimeout(() => this._startAutoScan(), 500);
            });
          }
        }
      });
    } else {
      this._startAutoScan();
    }
  },

  // 点击概览卡片
  onTapOverview() {
    wx.showToast({ title: '查看今日详情', icon: 'none' });
    // 预留功能
  },

  // 点击同步时间
  onTapSyncTime() {
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
    this._syncTime();
    wx.showToast({ title: '同步成功', icon: 'success' });
  },

  // 点击功能卡片
  onTapFeature(e) {
    const feature = e.currentTarget.dataset.feature;
    wx.navigateTo({
      url: `/pages/detail/detail?feature=${feature}`
    });
  },

  // ===================== 通用工具 =====================
  withBusy(fn) {
    if (this.data.busy) return Promise.reject(new Error('busy'));
    this.setData({ busy: true });
    return fn()
      .catch((e) => {
        console.warn('操作失败:', e);
      })
      .then((r) => {
        this.setData({ busy: false });
        return r;
      });
  },

  // 为保持兼容旧代码调用
  markLastDevice() {},
  onTapScan() { this._startAutoScan(); },
  onTapDisconnect() { try { proto.bootExitRawMode(); } catch (e) {} ble.disconnect(); },
  onTapPing() { wx.navigateTo({ url: '/pages/dev/dev' }); },
  onTapVersion() { wx.navigateTo({ url: '/pages/dev/dev' }); },
  onTapGoHistory() { wx.navigateTo({ url: '/pages/detail/detail?feature=heartRate' }); },
  onTapGetLight() {},
  onLightChange() {},
  onLightChangeEnd() {},
  onTapQueryAll() { this._autoRefreshData(); },
  onTapSyncTime() { this._syncTime(); },
  onTapOTA() { wx.navigateTo({ url: '/pages/dev/dev' }); },
  onTapToggleOTACard() {},
  onTapPickFw() {},
  onTapBLKey1() {},
  onTapBLKey3() {},
  onTapBLKeyA() {},
  onTapStartYmodem() {},
});
