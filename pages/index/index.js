// pages/index/index.js
const ble = require('../../utils/bleService.js');
const proto = require('../../utils/watchProtocol.js');
const { YM_CTL } = require('../../utils/ymodem.js');

const LAST_DEVICE_KEY = 'last_connected_device'; // wx.storageSync 的 key

Page({
  data: {
    // 连接状态
    scanning: false,
    connected: false,
    statusText: '未连接',
    statusClass: 'status-warn',
    deviceInfo: null,
    lastDeviceId: '',        // 上次成功连接的 MAC（本地缓存），用于打"⚡️ 上次连接"标

    // 候选设备列表（扫描结果，按 RSSI 强→弱排）
    deviceList: [],           // [{ deviceId, name, RSSI, isLast }]

    // 协议层结果
    version: '',
    light: 50,
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

    // 控件状态
    busy: false,
    syncTimeText: '同步手机时间',

    // ---- OTA ----
    otaMode: false,            // 当前是否在 OTA/BootLoader 工作区
    otaStep: 'idle',           // idle → jumpBL → reconnect → handshake → sending → done
    otaStepText: '待机',
    fwName: '',                // 已选固件文件名
    fwSize: 0,                 // 字节
    fwSizeKBText: '',          // 已格式化的 KB 字符串（用于 WXML，避免调用 .toFixed）
    otaProgress: 0,            // 0~100
    otaPkt: 0,                 // 当前包序号
    otaPktTotal: 0,            // 总包数
    otaLog: [],                // OTA 专用日志（可打印 BootLoader 菜单文本）

    // 日志
    logs: [],
  },

  // ===================== 生命周期 =====================
  onLoad() {
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
          // 如果刚刚发了 enterOTA，断开是预期的，推进 step
          if (this.data.otaStep === 'jumpBL') {
            this.setOtaStep('reconnect', '预期断开，请重新扫描并连接 BootLoader');
            this.pushOta('💡 手表已跳 BootLoader，等待你重新扫描 + 连接');
          }
        } else {
          // 连接成功：记住这台设备的 MAC，下次在列表里打⚡️标
          const info = this.data.deviceInfo;
          if (info && info.deviceId) {
            try { wx.setStorageSync(LAST_DEVICE_KEY, info.deviceId); } catch (e) {}
            this.markLastDevice(info.deviceId);
          }
          // 连接成功：
          //  - 从 APP 跳 BL 重连（otaStep=reconnect）
          //  - 冷启动长按 KEY1 进 BootLoader 后直连（otaMode=true 且 otaStep=idle）
          // 两种情况都要自动切 Raw 模式
          if (this.data.otaMode && this.data.otaStep !== 'sending' && this.data.otaStep !== 'done') {
            if (this.data.otaStep === 'reconnect' || this.data.otaStep === 'idle' || this.data.otaStep === 'error') {
              this.setOtaStep('handshake', '已连上 BootLoader，可直接点「开始 Ymodem 传输」自动握手');
            }
            if (!ble.isRawMode()) {
              try {
                ble.enterRawMode((bytes) => this._onRawBytes(bytes));
                this.pushOta('🔌 已进入 Raw 字节透传模式（OTA 传输专用）');
              } catch (e) {
                this.pushOta('⚠️ 切 Raw 模式失败：' + (e && e.message));
              }
            }
          }
        }
      },
      onRawLine: (line) => this.pushLog('rx', 'RX  ' + line),
    });
    proto.init(ble);

    // 读缓存的上次设备 MAC，用于⚡️高亮
    try {
      const saved = wx.getStorageSync(LAST_DEVICE_KEY);
      if (saved) {
        this.setData({ lastDeviceId: saved });
        this.markLastDevice(saved);
      }
    } catch (e) {}
  },

  onUnload() {
    try { proto.bootExitRawMode(); } catch (e) {}
    ble.disconnect();
  },

  // 给 deviceList 每一项打 isLast=true/false 标记（配合 WXML 渲染⚡️图标）
  markLastDevice(lastId) {
    if (!lastId) return;
    const upper = ('' + lastId).toUpperCase();
    const list = (this.data.deviceList || []).map((d) =>
      Object.assign({}, d, { isLast: d.deviceId.toUpperCase() === upper })
    );
    this.setData({ deviceList: list });
  },

  // ===================== 日志 =====================
  pushLog(level, text) {
    const t = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const ts = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const line = `[${ts}] ${text}`;
    const logs = this.data.logs.slice(-150);
    logs.push({ level, line });
    this.setData({ logs });
  },

  clearLog() {
    this.setData({ logs: [] });
  },

  // ---- OTA 专属日志（展示 BootLoader 菜单 / Ymodem 握手过程，解码为 ASCII）----
  pushOta(text) {
    const t = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const ts = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const otaLog = this.data.otaLog.slice(-60);
    otaLog.push(`[${ts}] ${text}`);
    this.setData({ otaLog });
  },

  clearOtaLog() { this.setData({ otaLog: [] }); },

  setOtaStep(step, text) {
    const map = {
      idle: '待机',
      jumpBL: '已下发 OV+UPGRADE，等待跳 BootLoader…',
      reconnect: '已断开，请重新扫描 + 连接 BootLoader',
      handshake: '已连 BootLoader，等待「C」握手',
      sending: 'Ymodem 固件传输中…',
      done: '✅ 传输完成，可点「3. 跳回 APP」启动新固件',
      error: '❌ 出错了，详见 OTA 日志',
    };
    this.setData({
      otaStep: step,
      otaStepText: text || (map[step] || step),
    });
    this.pushOta((text || map[step] || step));
  },

  // Raw 回调：把 BootLoader 的菜单 / 状态字符解码成 ASCII 并追加到 OTA 日志
  _onRawBytes(bytes) {
    let s = '';
    let hex = '';
    let printable = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] | 0;
      hex += (b < 16 ? '0' : '') + b.toString(16) + ' ';
      if (b === 0x07) s += '<BEL>';
      else if (b === 0x08) s += '<BS>';
      else if (b === 0x0D) s += '\r';
      else if (b === 0x0A) s += '\n';
      else if (b === 0x1B) s += '<ESC>';
      else if (b >= 0x20 && b <= 0x7E) { s += String.fromCharCode(b); printable++; }
      else s += `<${b.toString(16)}>`;
    }
    if (bytes.length <= 6 && !printable) {
      // 小而不可打印的包（ACK 06 / NAK 15 / C 43 / SOH/STX/EOT）
      const b0 = bytes[0];
      let tag = '';
      if (b0 === 0x06) tag = 'ACK';
      else if (b0 === 0x15) tag = 'NAK';
      else if (b0 === 0x43) tag = 'C(CRC16握手)';
      else if (b0 === 0x01) tag = 'SOH(128B包头)';
      else if (b0 === 0x02) tag = 'STX(1KB包头)';
      else if (b0 === 0x04) tag = 'EOT(结束传输)';
      else if (b0 === 0x18) tag = 'CAN(取消)';
      if (tag) this.pushOta(`← ${tag}  ${hex.trim()}`);
    } else {
      const line = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')[0] || s;
      this.pushOta('← ' + (line ? line : '') + (line ? ' ' : '') + `[${hex.trim()}]`);
    }
  },

  // ===================== 扫描 + 手动选设备 =====================
  onTapScan() {
    // 防御性：如果 busy 卡死了（比如之前的操作没正常结束），先强制解锁
    if (this.data.busy) {
      this.setData({ busy: false });
    }

    // 已连接状态下：点按钮 = 先断连，断完再点一次才会开始新扫描
    if (this.data.connected) {
      this.pushLog('info', '已连接状态下点击扫描按钮 → 先断开连接...');
      try { proto.bootExitRawMode(); } catch (e) {}
      ble.disconnect();
      return;
    }

    // 扫描中途再次点击 = 提前停止
    if (ble.isScanning()) {
      this.pushLog('info', '提前停止扫描...');
      ble.stopScan();
      return;
    }

    // 正常启动一次新扫描
    this.setData({
      scanning: true,
      statusText: '扫描中（点一次可提前停）',
      statusClass: 'status-info',
      deviceList: [],
    });
    this.pushLog('info', '开始扫描 KT6368A 目标设备...');

    ble.startScan(
      // onDeviceFound：每新发现一台增量推
      (newDev, allList) => {
        const lastId = this.data.lastDeviceId;
        const withFlag = allList.map((d) =>
          Object.assign({}, d, { isLast: lastId && d.deviceId.toUpperCase() === ('' + lastId).toUpperCase() })
        );
        this.setData({ deviceList: withFlag });
      },
      // onFinish：扫描结束（10秒超时 或 手动停）
      ({ devices, timeout }) => {
        const lastId = this.data.lastDeviceId;
        const withFlag = devices.map((d) =>
          Object.assign({}, d, { isLast: lastId && d.deviceId.toUpperCase() === ('' + lastId).toUpperCase() })
        );
        this.setData({
          scanning: false,
          statusText:
            devices.length === 0
              ? '扫描结束：未找到目标'
              : (timeout ? '扫描结束：找到 ' + devices.length + ' 台，请点击下方列表连接' : '扫描已停止：找到 ' + devices.length + ' 台'),
          statusClass: devices.length === 0 ? 'status-err' : 'status-info',
          deviceList: withFlag,
        });
      }
    );
  },

  onTapDisconnect() {
    try { proto.bootExitRawMode(); } catch (e) {}
    ble.disconnect();
  },

  // 用户点设备列表里某一行 → 连接它
  onTapDevice(e) {
    if (this.data.busy || this.data.connected) return;
    const deviceId = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const rssi = e.currentTarget.dataset.rssi;
    const info = { deviceId, name, RSSI: rssi };

    if (ble.isScanning()) ble.stopScan();

    this.setData({
      statusText: `连接 ${name || deviceId} ...`,
      statusClass: 'status-info',
    });
    this.pushLog('info', `选择设备：${name || '(无广播名)'}  ${deviceId}  RSSI=${rssi}`);

    ble.connect(deviceId)
      .then(() => {
        this.setData({
          statusText: '已连接',
          statusClass: 'status-ok',
          deviceInfo: info,
        });
        this.pushLog('ok', `连接成功：${name || deviceId}`);
      })
      .catch((err) => {
        this.setData({
          statusText: '连接失败',
          statusClass: 'status-err',
        });
        this.pushLog('err', `连接失败：${err && err.message ? err.message : JSON.stringify(err)}`);
      });
  },

  // ===================== 指令操作 =====================
  withBusy(fn) {
    if (this.data.busy) return Promise.reject(new Error('busy'));
    this.setData({ busy: true });
    return fn()
      .catch((e) => {
        this.pushLog('err', '操作失败：' + (e && e.message));
      })
      .then((r) => {
        this.setData({ busy: false });
        return r;
      });
  },

  onTapPing() {
    this.withBusy(() => {
      this.pushLog('tx', 'TX  OV');
      return proto.ping().then((r) => {
        wx.showToast({ title: r.ok ? 'Ping OK' : 'Ping 失败', icon: r.ok ? 'success' : 'none' });
      });
    });
  },

  onTapVersion() {
    this.withBusy(() => {
      this.pushLog('tx', 'TX  OV+VERSION');
      return proto.getVersion().then((r) => {
        this.setData({ version: r.version || '读取失败' });
      });
    });
  },

  onTapGetLight() {
    this.withBusy(() => {
      this.pushLog('tx', 'TX  OV+GETLIGHT');
      return proto.getLight().then((r) => {
        if (r.light != null) {
          this.setData({ light: r.light, 'sensor.light': r.light });
          wx.showToast({ title: '背光 ' + r.light, icon: 'none' });
        }
      });
    });
  },

  onLightChange(e) {
    const v = e.detail.value;
    this.setData({ light: v });
  },

  onLightChangeEnd(e) {
    const v = e.detail.value;
    this.withBusy(() => {
      this.pushLog('tx', 'TX  OV+SETLIGHT=' + v);
      return proto.setLight(v).then((r) => {
        if (r.ok) {
          wx.showToast({ title: '已设置 ' + v, icon: 'none' });
          this.setData({ light: r.light != null ? r.light : v, 'sensor.light': v });
        } else {
          wx.showToast({ title: '设置失败：' + r.error, icon: 'none' });
          proto.getLight().then((rr) => { if (rr.light != null) this.setData({ light: rr.light }); });
        }
      });
    });
  },

  onTapQueryAll() {
    this.withBusy(() => {
      this.pushLog('tx', 'TX  VO');
      return proto.queryAll().then((r) => {
        const d = r.data;
        this.setData({
          sensor: {
            date: d.date != null ? d.date : '',
            time: d.time != null ? d.time : '',
            humidity: d.humidity != null ? d.humidity + ' %' : '',
            temperature: d.temperature != null ? d.temperature + ' °C' : '',
            heartRate: d.heartRate != null ? d.heartRate + ' %' : '',
            spo2: d.spo2 != null ? d.spo2 + ' %' : '',
            steps: d.steps != null ? d.steps + ' 步' : '',
            light: d.light != null ? d.light : '',
          },
        });
        if (d.light != null) this.setData({ light: d.light });
        wx.showToast({ title: '数据已刷新', icon: 'success' });
      });
    });
  },

  onTapSyncTime() {
    this.withBusy(() => {
      this.pushLog('tx', 'TX  同步时间（自动取手机系统时间）');
      return proto.syncTime().then((r) => {
        // 把真实下发的指令字符串也打印出来，便于排查
        this.pushLog('tx', '    实际指令：' + (r.cmd || '(未知)'));
        if (r.ok) {
          wx.showToast({ title: '时间已同步', icon: 'success' });
          this.pushLog('ok', '手表 RTC 已写入：' + (r.cmd || '').slice(6));
        } else {
          wx.showToast({ title: '同步失败 ' + r.error, icon: 'none' });
        }
      });
    });
  },

  onTapOTA() {
    wx.showModal({
      title: '⚠️ 进入 OTA 升级模式',
      content:
        '此操作会让手表跳入 IAP BootLoader 并自动断开蓝牙。\n\n' +
        '跳入后需要做以下事情恢复 APP：\n' +
        '1. 手表屏幕显示「OTA Upgrade」并弹出 Ymodem 菜单\n' +
        '2. 重连后在下方 OTA 卡片点「1.进入下载」\n' +
        '3. 选择固件 .bin 文件并点击「开始 Ymodem 传输」\n' +
        '4. 传输完成后点「3.跳回新 APP」\n\n' +
        '⚠️ 如果没有准备好新固件 bin 文件，请不要执行！\n' +
        '   （烧录失败可以长按 KEY1 按键重新进入 BootLoader 自救）\n\n' +
        '确定要进入 OTA 升级模式吗？',
      confirmText: '确定进入',
      confirmColor: '#ff4d4f',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        this.withBusy(() => {
          this.setData({
            otaMode: true,
            fwName: this.data.fwName,
            fwSize: this.data.fwSize,
            otaProgress: 0,
            otaPkt: 0,
            otaPktTotal: 0,
            otaLog: [],
          });
          this.setOtaStep('jumpBL', '');
          this.pushOta('⬇️ 下发 OV+UPGRADE 指令让手表跳 BootLoader');
          this.pushLog('tx', 'TX  OV+UPGRADE');
          return proto.enterOTA().then((r) => {
            if (r.ok) {
              wx.showToast({ title: '已进入升级模式', icon: 'none', duration: 3000 });
              this.pushLog('ok', '手表将跳转到 BootLoader，蓝牙连接会自动断开');
              this.pushOta('✅ BootLoader 响应 OK+UPGRADE，马上会自动断开');
            } else {
              wx.showToast({ title: '进入失败', icon: 'none' });
              this.setOtaStep('error', 'OV+UPGRADE 未返回 OK+UPGRADE');
            }
          });
        });
      }
    });
  },

  // ---------- OTA 切换卡片 ----------
  onTapToggleOTACard() {
    const next = !this.data.otaMode;
    this.setData({ otaMode: next });
    if (next && this.data.connected && this.data.otaStep !== 'sending') {
      // 用户手动打开 OTA 卡 + 已连上（可能 BootLoader 一上电就在菜单）
      try {
        ble.enterRawMode((bytes) => this._onRawBytes(bytes));
        if (this.data.otaStep === 'idle' || this.data.otaStep === 'error' || this.data.otaStep === 'done') {
          this.setOtaStep('handshake', '已手动进入 BootLoader 操作区，可选「1.进入下载」');
        }
        this.pushOta('🔌 已进入 Raw 字节透传模式');
      } catch (e) {
        this.pushOta('⚠️ 切 Raw 模式失败：' + (e && e.message));
      }
    } else if (!next) {
      try { proto.bootExitRawMode(); } catch (e) {}
    }
  },

  // ---------- 固件文件选择 ----------
  onTapPickFw() {
    // 小程序里 wx.chooseMessageFile 选"聊天文件"（把 bin 发给自己的文件传输助手即可）
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['bin', 'hex'],
      success: (res) => {
        const f = res.tempFiles[0];
        const size = f.size | 0;
        this.setData({
          fwName: f.name,
          fwSize: size,
          fwSizeKBText: (size / 1024).toFixed(2),
          fwPath: f.path,
        });
        this.pushOta(`📁 已选固件：${f.name}  ${(size / 1024).toFixed(2)} KB  path=${f.path || '(none)'}`);
      },
      fail: (e) => {
        this.pushOta('❌ 选文件失败：' + (e && e.errMsg ? e.errMsg : JSON.stringify(e)));
      },
    });
  },

  // ---------- 快捷按键（对应 BootLoader 菜单 1/3/a）----------
  onTapBLKey1() {
    // 1：进入下载模式（BootLoader 开始周期性发 'C'）
    this.withBusy(async () => {
      if (!ble.isRawMode()) ble.enterRawMode((b) => this._onRawBytes(b));
      this.pushOta('→ 发 "1"（进入下载模式）');
      await proto.bootSendKey('1');
      this.setOtaStep('handshake', '已发 1，等待 BootLoader 周期性发「C」…（超时=8s）');
      this.pushOta('⏳ 等待 CRC16 握手字节 0x43 (C)');
      const r = await proto.bootWaitForHandshakeC(8000);
      if (r.byte === YM_CTL.CRC) {
        this.pushOta('✅ 收到 C（CRC16 握手成功），可点「开始 Ymodem 传输」');
        if (!this.data.fwName) {
          wx.showModal({
            title: '还没选固件',
            content: '请先点「选择固件文件」选一个 .bin',
            showCancel: false,
          });
        }
      } else {
        this.pushOta('❌ 超时未收到 C，检查手表是否显示菜单，或手动按一次电源键/重启再试');
        wx.showToast({ title: '未收到 C 握手', icon: 'none' });
      }
    });
  },

  // 长 Ymodem 传输后 KT6368A 的 GATT 写通道可能卡死（SecureCRT 能跳是因为链路是新的），
  // 发 3 前主动断开重连一次，保证单字节能到 UART。
  async _freshConnectForJump() {
    const devId = (this.data.deviceInfo && this.data.deviceInfo.deviceId) || this.data.lastDeviceId;
    if (!devId) return true;
    this.pushOta('[BLE] 断开并重连，避免长传输后写通道卡死...');
    try { ble.disconnect(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 1500));
    let ok = false;
    for (let i = 0; i < 2 && !ok; i++) {
      try {
        await ble.connect(devId);
        ok = true;
      } catch (e) {
        this.pushOta('[BLE] 重连第 ' + (i + 1) + ' 次失败，再试...');
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (ok) {
      this.pushOta('[BLE] 重连成功，开始发 3');
    } else {
      this.pushOta('[BLE] 重连失败，未发送 3');
    }
    return ok;
  },

  onTapBLKey3() {
    // 3：Run the downloaded program / 跳回 APP
    this.withBusy(async () => {
      if (!ble.isRawMode()) ble.enterRawMode((b) => this._onRawBytes(b));
      const jumpReady = await this._freshConnectForJump();
      if (!jumpReady) {
        this.setOtaStep('error', '重连失败，未发送 3');
        wx.showToast({ title: '重连失败', icon: 'none' });
        return;
      }

      // 与 SecureCRT 保持一致：发完 3 后不再主动 closeBLEConnection。
      // writeNoResponse 的 success 只代表手机侧已提交写请求，立刻断连会把
      // 还没发出去的 '3' 丢掉（之前“停在 Bootload”就是这个原因）。
      // 新版 BootLoader 收到 3 后自己拉低 PA8 关 KT6368A，清 UART 后直接跳 APP，
      // 链路会自然断开；如果链路没断，APP 启动后可手动点“断开连接”。
      this.pushOta('[BLE] 准备发 3 跳 APP...');

      this.pushOta('→ 连发 "3"（跳回 APP 执行已烧录的固件）');
      // writeNoResponse 单次写可能丢，连发 3 次提高 '3' 到达 BootLoader 的概率；
      // 第一次成功跳转后 KT6368A 会断电，后续发送失败忽略即可。
      for (let n = 0; n < 3 && ble.isConnected(); n++) {
        try {
          await proto.bootSendKeyAck('3');
        } catch (e) {
          this.pushOta('[BLE] 第 ' + (n + 1) + ' 次发送未完成，继续...');
        }
        if (n < 2) await new Promise((resolve) => setTimeout(resolve, 80));
      }

      // 等 KT6368A 把 '3' 完整送到 STM32 UART（覆盖 1~2 个 BLE 连接事件）
      this.pushOta('[BLE] 已发 3，等待 KT6368A 透传 + BootLoader 跳转...');
      await new Promise((resolve) => setTimeout(resolve, 300));

      this.pushOta('[BLE] 不再主动断开（与 SecureCRT 一致），等待手表复位');
      if (ble.isConnected()) {
        this.pushOta('[BLE] 如 3~5 秒后仍显示已连接，可手动点“断开连接”');
      }

      this.setOtaStep('idle', '已发 3，手表即将复位并启动新 APP…');
      wx.showToast({ title: '已发 3，手表复位', icon: 'none', duration: 2500 });
    });
  },

  onTapBLKeyA() {
    // a：中止 Ymodem 会话（BootLoader Ymodem_Receive 里检测 'a' 会 cancel）
    this.withBusy(async () => {
      if (!ble.isRawMode()) ble.enterRawMode((b) => this._onRawBytes(b));
      this.pushOta('→ 发 "a"（中止 Ymodem 会话）');
      await proto.bootSendKey('a');
      // 连发两个 CAN 做"双保险"取消
      const can = new Uint8Array([0x18, 0x18]);
      await ble.sendRawBytes(can);
      this.pushOta('→ 连发 2 个 CAN(0x18) 强制取消');
    });
  },

  // ---------- Ymodem 传输 ----------
  onTapStartYmodem() {
    if (!this.data.fwName) {
      wx.showToast({ title: '先选固件文件', icon: 'none' });
      return;
    }
    if (!this.data.connected) {
      wx.showToast({ title: '先连接蓝牙', icon: 'none' });
      return;
    }
    if (this.data.busy) return;

    // 已握手（otaStep === 'handshake' 表示已收到 'C'）→ 直接传输
    if (this.data.otaStep === 'handshake') {
      this._readFileAndSend();
      return;
    }

    // 未握手 → 弹模态：可选"自动握手+传输"或"取消"
    wx.showModal({
      title: '尚未握手',
      content:
        '还没按「1.进入下载」完成 Ymodem 握手。\n\n' +
        '点击「自动握手」将自动发送 "1" 并等待 "C" 握手，成功后立即开始传输固件。\n\n' +
        '（如果你已手动按过「1.进入下载」并看到 ✅ 收到 C，则无需此步骤）',
      confirmText: '自动握手+传输',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this._doHandshakeAndSend();
        }
      },
    });
  },

  // 自动握手：发 '1' → 等 'C' → 成功后读文件传输
  async _doHandshakeAndSend() {
    this.setData({ busy: true, otaProgress: 0, otaPkt: 0, otaPktTotal: 0 });

    // 确保 Raw 模式
    if (!ble.isRawMode()) {
      ble.enterRawMode((b) => this._onRawBytes(b));
      this.pushOta('🔌 已进入 Raw 字节透传模式');
    }

    // 发 '1' 进入下载
    this.pushOta('→ 发 "1"（进入下载模式）');
    try {
      await proto.bootSendKey('1');
    } catch (e) {
      this.setData({ busy: false });
      this.setOtaStep('error', '发送 1 失败：' + (e && e.message));
      return;
    }

    this.setOtaStep('handshake', '已发 1，等待 BootLoader 发「C」握手…');
    this.pushOta('⏳ 等待 CRC16 握手字节 0x43 (C)，超时 8s');

    let r;
    try {
      r = await proto.bootWaitForHandshakeC(8000);
    } catch (e) {
      this.setData({ busy: false });
      this.setOtaStep('error', '等待 C 异常：' + (e && e.message));
      return;
    }

    if (r.byte !== YM_CTL.CRC) {
      this.setData({ busy: false });
      this.setOtaStep('error', '握手失败：超时未收到 C');
      this.pushOta('❌ 握手失败，未收到 C（BootLoader 可能没进入下载模式）');
      wx.showToast({ title: '握手失败', icon: 'none' });
      return;
    }

    this.pushOta('✅ 收到 C，握手成功，开始读取固件并传输…');
    this._readFileAndSend();
  },

  // 读文件 → Ymodem 传输（握手已完成后调用）
  _readFileAndSend() {
    this.setData({ busy: true, otaProgress: 0, otaPkt: 0, otaPktTotal: 0 });
    this.setOtaStep('sending', '');

    const fwPath = this.data.fwPath;
    if (!fwPath) {
      this.pushOta('❌ 没拿到文件临时路径，请重新选择一次固件');
      this.setData({ busy: false });
      this.setOtaStep('error', '缺失 fwPath，请重选文件');
      return;
    }

    const fs = wx.getFileSystemManager();
    this.pushOta('📖 读取固件：' + fwPath);
    fs.readFile({
      filePath: fwPath,
      success: (res) => {
        const buf = new Uint8Array(res.data);
        this.pushOta('✅ 读取成功：' + buf.length + ' 字节，开始 Ymodem-1K 传输…');
        this._runYmodem(buf).then(() => {
          this.setData({ busy: false });
        }).catch((e) => {
          this.setData({ busy: false });
          this.setOtaStep('error', 'Ymodem 异常：' + (e && e.message));
          this.pushOta('❌ ' + (e && e.stack ? e.stack : (e && e.message ? e.message : JSON.stringify(e))));
        });
      },
      fail: (e) => {
        this.setData({ busy: false });
        this.setOtaStep('error', 'readFile fail：' + (e && e.errMsg));
        this.pushOta('❌ 读文件失败：' + (e && e.errMsg));
      },
    });
  },

  async _runYmodem(fileBuf) {
    try {
      const res = await proto.bootStartYmodem(
        fileBuf,
        this.data.fwName || 'OV_Watch.bin',
        (percent, pktSeq, totalPkts) => {
          this.setData({
            otaProgress: Math.round(percent),
            otaPkt: pktSeq,
            otaPktTotal: totalPkts,
          });
        }
      );
      if (res && res.ok) {
        this.setOtaStep('done', `✅ 传输完成：${res.size} 字节 / ${res.packets} 包`);
        wx.showToast({ title: 'OTA 传输成功', icon: 'success', duration: 2500 });
        this.pushOta('💡 下一步：点「3. 跳回新 APP」让手表跑新固件');
      } else {
        this.setOtaStep('error', 'Ymodem 发送返回非 ok：' + JSON.stringify(res || {}));
      }
    } catch (e) {
      this.setOtaStep('error', 'Ymodem 抛出异常');
      throw e;
    }
  },

  // ---- 修正 onTapPickFw：把聊天文件的临时 path 存到 fwPath ----
  //（重写，实际小程序里 chooseMessageFile 会返回 tempFiles[0].path）
});
