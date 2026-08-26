// pages/device/device.js — OV Watch 设备控制页
const ble = require('../../utils/bleService.js');
const proto = require('../../utils/watchProtocol.js');

const WATCH_FACE_KEY = 'watch_face';

Page({
  data: {
    connected: false,
    version: '',
    deviceName: 'OV Watch',
    light: 50,
    busy: false,

    // 表盘
    selectedFace: 0,
    faces: [
      { name: '经典', emoji: '🕐', bg: 'linear-gradient(145deg, #1e293b, #334155)' },
      { name: '极简', emoji: '⏱', bg: 'linear-gradient(145deg, #eff4ff, #dbeafe)' },
      { name: '运动', emoji: '🏃', bg: 'linear-gradient(145deg, #dcfce7, #bbf7d0)' },
      { name: '科技', emoji: '🛰', bg: 'linear-gradient(145deg, #111827, #374151)' },
      { name: '简约', emoji: '🌙', bg: 'linear-gradient(145deg, #ede9fe, #ddd6fe)' },
      { name: '活力', emoji: '🔥', bg: 'linear-gradient(145deg, #ffedd5, #fed7aa)' },
    ],

    // 通知
    notifySender: '',
    notifyContent: '',

    // 手表设置
    wristOn: false,
    ltimeOptions: [10, 15, 20, 30, 45, 60],
    ltimeIndex: 0,
    ltime: 10,
    ttimeOptions: [15, 20, 25, 35, 50, 65],
    ttimeIndex: 0,
    ttime: 15,
  },

  onLoad() {
    proto.init(ble);
    // 读取本地保存的表盘选中态
    try {
      const saved = wx.getStorageSync(WATCH_FACE_KEY);
      if (typeof saved === 'number') this.setData({ selectedFace: saved });
    } catch (e) {}
  },

  onShow() {
    this._refreshStatus();
  },

  _refreshStatus() {
    const connected = ble.isConnected();
    this.setData({ connected });
    if (connected) {
      // 读固件版本 + 背光当前值
      proto.getVersion().then(r => {
        if (r.version) this.setData({ version: r.version });
      }).catch(() => {});
      proto.getLight().then(r => {
        if (r.light != null) this.setData({ light: r.light });
      }).catch(() => {});
      proto.getWrist().then(r => {
        this.setData({ wristOn: r.on });
      }).catch(() => {});
      proto.getLTime().then(r => {
        if (r.value != null) {
          const idx = this.data.ltimeOptions.indexOf(r.value);
          this.setData({ ltime: r.value, ltimeIndex: idx >= 0 ? idx : 0 });
        }
      }).catch(() => {});
      proto.getTTime().then(r => {
        if (r.value != null) {
          const idx = this.data.ttimeOptions.indexOf(r.value);
          this.setData({ ttime: r.value, ttimeIndex: idx >= 0 ? idx : 0 });
        }
      }).catch(() => {});
    }
  },

  // 去首页连接
  onGoConnect() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // 表盘选择（UI 占位，无协议下发）
  onSelectFace(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ selectedFace: index });
    try { wx.setStorageSync(WATCH_FACE_KEY, index); } catch (err) {}
    wx.showToast({ title: '将在固件支持后生效', icon: 'none' });
  },

  // 背光
  onLightChanging(e) {
    this.setData({ light: e.detail.value });
  },
  onLightChange(e) {
    const v = e.detail.value;
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    this.setData({ busy: true });
    proto.setLight(v).then(r => {
      if (r.ok) {
        this.setData({ light: r.light != null ? r.light : v });
        wx.showToast({ title: '背光已设为 ' + (r.light != null ? r.light : v), icon: 'none' });
      } else {
        wx.showToast({ title: '设置失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '设置失败', icon: 'none' });
    }).then(() => this.setData({ busy: false }));
  },

  // 通知
  onSenderInput(e) { this.setData({ notifySender: e.detail.value }); },
  onContentInput(e) { this.setData({ notifyContent: e.detail.value }); },

  onSendNotify() {
    const sender = (this.data.notifySender || '').trim();
    const content = (this.data.notifyContent || '').trim();
    if (!sender || !content) {
      wx.showToast({ title: '请填写昵称和内容', icon: 'none' });
      return;
    }
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    this.setData({ busy: true });
    proto.sendNotify('WX', sender, content).then(r => {
      if (r.ok) {
        wx.showToast({ title: '已推送', icon: 'success' });
        this.setData({ notifyContent: '' });
      } else {
        wx.showToast({ title: '推送失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '推送失败', icon: 'none' });
    }).then(() => this.setData({ busy: false }));
  },

  // 手表设置：抬腕亮屏
  onWristChange(e) {
    const on = e.detail.value;
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    this.setData({ busy: true });
    proto.setWrist(on).then(r => {
      if (r.ok) {
        this.setData({ wristOn: r.on });
        wx.showToast({ title: r.on ? '已开启抬腕亮屏' : '已关闭抬腕亮屏', icon: 'none' });
      } else {
        wx.showToast({ title: '设置失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '设置失败', icon: 'none' });
    }).then(() => this.setData({ busy: false }));
  },

  // 手表设置：常亮时间
  onLTimeChange(e) {
    const idx = Number(e.detail.value);
    const v = this.data.ltimeOptions[idx];
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    this.setData({ busy: true });
    proto.setLTime(v).then(r => {
      if (r.ok) {
        this.setData({ ltime: r.value != null ? r.value : v, ltimeIndex: idx });
        wx.showToast({ title: '常亮时间已设为 ' + (r.value != null ? r.value : v) + 's', icon: 'none' });
      } else {
        wx.showToast({ title: '设置失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '设置失败', icon: 'none' });
    }).then(() => this.setData({ busy: false }));
  },

  // 手表设置：熄屏时间
  onTTimeChange(e) {
    const idx = Number(e.detail.value);
    const v = this.data.ttimeOptions[idx];
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    this.setData({ busy: true });
    proto.setTTime(v).then(r => {
      if (r.ok) {
        this.setData({ ttime: r.value != null ? r.value : v, ttimeIndex: idx });
        wx.showToast({ title: '熄屏时间已设为 ' + (r.value != null ? r.value : v) + 's', icon: 'none' });
      } else {
        wx.showToast({ title: '设置失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '设置失败', icon: 'none' });
    }).then(() => this.setData({ busy: false }));
  },

  // 同步时间
  onSyncTime() {
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    this.setData({ busy: true });
    proto.syncTime().then(r => {
      if (r.ok) {
        wx.showToast({ title: '时间已同步', icon: 'success' });
      } else {
        wx.showToast({ title: '同步失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '同步失败', icon: 'none' });
    }).then(() => this.setData({ busy: false }));
  },
});