// pages/dev/dev.js — OV Watch 开发者控制面板
const ble = require('../../utils/bleService.js');
const proto = require('../../utils/watchProtocol.js');
const { YM_CTL } = require('../../utils/ymodem.js');

const LAST_DEVICE_KEY = 'last_connected_device';

Page({
  data: {
    // 连接状态
    scanning: false,
    connected: false,
    deviceInfo: null,
    deviceList: [],
    lastDeviceId: '',

    // 数据
    version: '',
    light: 50,
    sensor: {
      date: '', time: '', humidity: '', temperature: '',
      heartRate: '', spo2: '', steps: '', light: '',
    },

    // OTA 状态
    otaStep: 'idle',
    otaStepText: '待机',
    fwName: '',
    fwSize: 0,
    fwPath: '',
    otaProgress: 0,
    otaPkt: 0,
    otaPktTotal: 0,
    otaLog: [],

    // 交互
    busy: false,
    logs: [],
  },

  onLoad() {
    ble.init({
      onLog: (level, text) => this.pushLog(level, text),
      onConnectionChange: (connected) => {
        this.setData({
          connected,
          deviceInfo: ble.getDeviceInfo ? ble.getDeviceInfo() : null,
        });
        if (!connected) {
          this.setData({ otaStep: 'idle', otaStepText: '断开连接' });
        }
      },
      onRawLine: (line) => this.pushLog('rx', 'RX  ' + line),
    });
    proto.init(ble);

    // 读取上次设备
    try {
      const saved = wx.getStorageSync(LAST_DEVICE_KEY);
      if (saved) this.setData({ lastDeviceId: saved });
    } catch (e) {}
  },

  // ===================== 日志 =====================
  pushLog(level, text) {
    const t = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const ts = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const logs = this.data.logs.slice(-200);
    logs.push({ level, line: `[${ts}] ${text}` });
    this.setData({ logs });
  },

  clearLog() { this.setData({ logs: [] }); },

  pushOta(text) {
    const t = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const ts = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const otaLog = this.data.otaLog.slice(-60);
    otaLog.push(`[${ts}] ${text}`);
    this.setData({ otaLog });
  },

  // ===================== 连接 =====================
  onTapScan() {
    if (this.data.busy) return;

    if (this.data.connected) {
      try { proto.bootExitRawMode(); } catch (e) {}
      ble.disconnect();
      return;
    }

    if (ble.isScanning()) {
      ble.stopScan();
      this.setData({ scanning: false });
      return;
    }

    this.setData({ scanning: true, deviceList: [] });
    this.pushLog('info', '开始扫描...');

    ble.startScan(
      (newDev, allList) => {
        const list = allList.map(d => ({
          ...d,
          isLast: d.deviceId === this.data.lastDeviceId,
        }));
        this.setData({ deviceList: list });
      },
      ({ devices, timeout }) => {
        this.setData({ scanning: false });
        const list = devices.map(d => ({
          ...d,
          isLast: d.deviceId === this.data.lastDeviceId,
        }));
        this.setData({ deviceList: list });
        this.pushLog(timeout ? 'warn' : 'info', timeout ? '扫描超时' : `扫描完成: ${devices.length} 台`);
      }
    );
  },

  onTapDevice(e) {
    if (this.data.busy || this.data.connected) return;
    const deviceId = e.currentTarget.dataset.id;
    const dev = this.data.deviceList.find(d => d.deviceId === deviceId);
    if (ble.isScanning()) ble.stopScan();

    this.pushLog('info', `连接: ${dev ? dev.name : deviceId}`);
    ble.connect(deviceId).then(() => {
      this.pushLog('ok', '连接成功');
      try { wx.setStorageSync(LAST_DEVICE_KEY, deviceId); } catch (e) {}
      this.setData({ 
        connected: true, 
        deviceInfo: dev || { deviceId, name: 'Unknown', RSSI: 0 }
      });
    }).catch(err => {
      this.pushLog('err', '连接失败: ' + (err.message || err));
    });
  },

  // ===================== 指令 =====================
  withBusy(fn) {
    if (this.data.busy) return Promise.reject(new Error('busy'));
    this.setData({ busy: true });
    return fn().catch(e => { this.pushLog('err', e.message || e); })
      .then(r => { this.setData({ busy: false }); return r; });
  },

  onTapPing() {
    this.withBusy(() => {
      this.pushLog('tx', 'TX  OV');
      return proto.ping().then(r => {
        wx.showToast({ title: r.ok ? 'Ping OK' : 'Ping 失败', icon: r.ok ? 'success' : 'none' });
      });
    });
  },

  onTapVersion() {
    this.withBusy(() => {
      this.pushLog('tx', 'TX  OV+VERSION');
      return proto.getVersion().then(r => {
        this.setData({ version: r.version || '读取失败' });
      });
    });
  },

  onTapQueryAll() {
    this.withBusy(() => {
      this.pushLog('tx', 'TX  VO');
      return proto.queryAll().then(r => {
        const d = r.data;
        this.setData({
          sensor: {
            date: d.date || '', time: d.time || '',
            humidity: d.humidity || '', temperature: d.temperature || '',
            heartRate: d.heartRate || '', spo2: d.spo2 || '',
            steps: d.steps || '', light: d.light || '',
          },
          light: d.light != null ? d.light : 50,
        });
        wx.showToast({ title: '已刷新', icon: 'success' });
      });
    });
  },

  onTapSyncTime() {
    this.withBusy(() => {
      this.pushLog('tx', 'TX  同步时间');
      return proto.syncTime().then(r => {
        if (r.ok) wx.showToast({ title: '同步成功', icon: 'success' });
        else wx.showToast({ title: '同步失败', icon: 'none' });
      });
    });
  },

  onLightChangeEnd(e) {
    const v = e.detail.value;
    this.withBusy(() => {
      return proto.setLight(v).then(r => {
        if (r.ok) {
          this.setData({ light: r.light || v });
          wx.showToast({ title: '已设置 ' + v, icon: 'none' });
        }
      });
    });
  },

  // ===================== OTA =====================
  onTapOTA() {
    wx.showModal({
      title: '进入 OTA 模式',
      content: '将跳转到 BootLoader 并断开蓝牙，继续?',
      confirmText: '确定',
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (!res.confirm) return;
        this.withBusy(() => {
          this.setData({ otaStep: 'jumpBL', otaStepText: '跳转 BootLoader' });
          this.pushOta('下发 OV+UPGRADE');
          return proto.enterOTA().then(r => {
            if (r.ok) {
              this.pushOta('BootLoader 响应 OK+UPGRADE');
              wx.showToast({ title: '已进入升级模式', icon: 'none' });
            }
          });
        });
      }
    });
  },

  onTapPickFw() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['bin', 'hex'],
      success: (res) => {
        const f = res.tempFiles[0];
        this.setData({ fwName: f.name, fwSize: f.size, fwPath: f.path });
        this.pushOta(`已选: ${f.name}`);
      },
      fail: (e) => this.pushOta('选文件失败: ' + (e.errMsg || e)),
    });
  },

  onTapBLKey3() {
    this.withBusy(async () => {
      if (!ble.isRawMode()) ble.enterRawMode(b => this._onRawBytes(b));
      if (!ble.isConnected()) return;
      this.pushOta('发送 3 跳回 APP');
      for (let n = 0; n < 3 && ble.isConnected(); n++) {
        try { await proto.bootSendKeyAck('3'); } catch (e) {}
        if (n < 2) await new Promise(r => setTimeout(r, 80));
      }
      this.setData({ otaStep: 'idle', otaStepText: '已跳回 APP' });
    });
  },

  onTapStartYmodem() {
    if (!this.data.fwName) {
      wx.showToast({ title: '请先选择固件', icon: 'none' });
      return;
    }
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
    this.withBusy(async () => {
      this.setData({ otaStep: 'handshake', otaStepText: '握手中' });
      if (!ble.isRawMode()) ble.enterRawMode(b => this._onRawBytes(b));
      this.pushOta('发送 1 进入下载模式');
      await proto.bootSendKey('1');
      this.pushOta('等待 C 握手...');
      try {
        const r = await proto.bootWaitForHandshakeC(8000);
        if (r.byte !== YM_CTL.CRC) {
          this.setData({ otaStep: 'error', otaStepText: '握手超时' });
          return;
        }
        this.pushOta('握手成功，开始传输');
        this._runYmodem();
      } catch (e) {
        this.setData({ otaStep: 'error', otaStepText: '握手异常' });
      }
    });
  },

  _runYmodem() {
    const fs = wx.getFileSystemManager();
    this.setData({ otaStep: 'sending', otaStepText: '传输中' });
    fs.readFile({
      filePath: this.data.fwPath,
      success: (res) => {
        const buf = new Uint8Array(res.data);
        proto.bootStartYmodem(buf, this.data.fwName, (percent, pkt) => {
          this.setData({ otaProgress: percent, otaPkt: pkt });
        }).then(r => {
          this.setData({ otaProgress: 100, otaStep: 'done', otaStepText: '传输完成' });
          this.pushOta(`传输完成: ${r.size}B, ${r.packets}包`);
          wx.showToast({ title: 'OTA 成功', icon: 'success' });
        }).catch(e => {
          this.setData({ otaStep: 'error', otaStepText: '传输失败' });
          this.pushOta('失败: ' + (e.message || e));
        });
      },
      fail: (e) => {
        this.pushOta('读文件失败: ' + e.errMsg);
      },
    });
  },

  _onRawBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] | 0;
      if (b >= 0x20 && b <= 0x7E) s += String.fromCharCode(b);
      else if (b === 0x0A) s += '\n';
      else if (b === 0x0D) s += '\r';
    }
    if (s.trim()) this.pushOta('RX: ' + s.trim());
  },
});
