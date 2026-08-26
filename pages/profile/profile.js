// pages/profile/profile.js — OV Watch 个人中心
const ble = require('../../utils/bleService.js');
const proto = require('../../utils/watchProtocol.js');

Page({
  data: {
    userInfo: {},
    connected: false,
    deviceInfo: null,
    appVersion: 'v1.0.0',
    fwVersion: '',
  },

  onShow() {
    const connected = ble.isConnected();
    // 更新连接状态
    this.setData({
      connected,
      deviceInfo: ble.getDeviceInfo ? ble.getDeviceInfo() : null,
    });

    // 已连接时同步固件版本号
    if (connected) {
      proto.init(ble);
      proto.getVersion().then(r => {
        if (r.version) this.setData({ fwVersion: r.version });
      }).catch(() => {});
    }

    // 同步小程序版本号
    try {
      const info = wx.getAccountInfoSync();
      const v = (info && info.miniProgram && info.miniProgram.version) || '';
      this.setData({ appVersion: v ? 'v' + v : 'v1.0.0' });
    } catch (e) {}

    // 获取用户信息
    try {
      const userInfo = wx.getStorageSync('userInfo') || {};
      this.setData({ userInfo });
    } catch (e) {}
  },

  onTapDeviceInfo() {
    if (this.data.connected) {
      wx.showModal({
        title: '设备详情',
        content: `设备名：My Watch\n开发者：王汤园\n版本号：${this.data.fwVersion || '--'}`,
        showCancel: false,
      });
    } else {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
    }
  },

  onTapSetting(e) {
    const setting = e.currentTarget.dataset.setting;
    const titles = {
      notification: '通知管理',
      display: '显示与亮度',
      unit: '单位设置',
      language: '语言',
    };
    wx.showToast({
      title: `${titles[setting]}开发中`,
      icon: 'none',
    });
  },

  onTapHelp(e) {
    const type = e.currentTarget.dataset.type;
    if (type === 'faq') {
      wx.showToast({ title: '常见问题开发中', icon: 'none' });
    } else if (type === 'contact') {
      wx.showModal({
        title: '联系我们',
        content: '如有任何问题，请通过以下方式联系我们：\n\n邮箱：support@ov-watch.com',
        showCancel: false,
      });
    } else if (type === 'privacy') {
      wx.showModal({
        title: '隐私政策',
        content: '我们非常重视您的隐私。您的所有健康数据仅存储在您的个人云账号中，我们不会分享给任何第三方。\n\n详细隐私政策请访问我们的官网。',
        showCancel: false,
      });
    }
  },

  // 进入开发者模式
  onTapDevMode() {
    wx.navigateTo({ url: '/pages/dev/dev' });
  },
});
