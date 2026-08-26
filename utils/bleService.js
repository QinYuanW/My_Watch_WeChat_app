// utils/bleService.js
// KT6368A BLE 核心服务：扫描、连接、服务发现、Notify 订阅、Write、拼包、噪声过滤
//
// 使用方式（在页面/逻辑层）：
//   const ble = require('../../utils/bleService.js');
//   ble.init({
//     onLog: (level, text) => {},
//     onConnectionChange: (connected) => {},
//     onRawLine: (text) => {}            // 每行干净回传（去掉模块噪声）
//   });
//   ble.startScan(deviceId => ble.connect(deviceId));
//   ble.send('OV').then(lines => ...);

const app = getApp();

const SERVICE_UUID = '0000FFF0-0000-1000-8000-00805F9B34FB';
const WRITE_CHAR_UUID = '0000FFF1-0000-1000-8000-00805F9B34FB';
const NOTIFY_CHAR_UUID = '0000FFF2-0000-1000-8000-00805F9B34FB';

// 模块噪声行前缀（KT6368A 自身状态信息，跳过）
const NOISE_PREFIXES = ['BLE_STANDBY_', 'RecStr:'];

let _adapterReady = false;
let _deviceId = '';       // 当前连接设备 MAC
let _connected = false;   // 是否处于已连接状态
let _notifyReady = false; // Notify 订阅是否成功
let _cb = null;          // 外部回调：{ onLog, onConnectionChange, onRawLine }

// ---------- 拼包缓冲 ----------
let _buffer = '';        // 还没切出完整行的 Notify 片段拼接缓冲

// ---------- 扫描相关 ----------
let _scanCb = null;       // 每次 startScan 传入的一次性回调：onFinish({devices, timeout})
let _scanMap = {};        // key=deviceId (upper)  value:{ deviceId, name, RSSI }，用于扫描阶段去重
let _scanList = [];       // 按 RSSI 从强到弱排序的候选设备数组（最终返回给 UI 渲染列表）
let _scanTimer = null;    // 扫描超时定时器
let _scanning = false;    // 是否处于扫描中状态，UI 点选设备前先判断
// BLE 是半双工，前一条没回完不能发下一条，所以维护一个串行发送队列
let _queue = [];
let _sending = false;
let _responseLines = []; // 当前这条指令累积的回传行
let _currentResolve = null;
let _currentReject = null;
let _timeoutTimer = null;
let _cmdTimeoutMs = 3000; // 单条指令超时（VO 全量数据慢一点，3 秒够了）

// ---------- Raw 模式（给 OTA Ymodem 用）----------
// Raw 模式下：
//   1. 队列暂停
//   2. handleRawChunk 不再拼包/去噪，每块 Notify 直接喂 _rawCb
//   3. waitRxByte / sendRawBytes 用于单字节时序握手和 20B 分片批量发送
let _rawMode = false;
let _rawCb = null;            // (Uint8Array bytes) => void：每块 Notify 直接推
let _rawByteQueue = [];       // 按顺序累积的单字节队列（按收到先后压入）
let _rawByteWaiter = null;    // { expectByteSet:Set<number>, timeout:number, resolve, reject, timer }
let _rawWriteIntervalMs = 8;   // 每 8ms 一块（SecureCRT 实测约 14ms/包，我们用更小间隔 + 靠 KT6368A 内部缓冲）
let _postSendDelayMs = 10;     // 每次 sendRawBytes 结束后等 10ms（不再大段等待）
let _lastWriteTime = 0;        // 上一次 writeNoResponse 成功的时间戳
let _bleMtu = 23;             // BLE MTU（默认 23，单包有效负载 = MTU - 3 = 20B；协商后可达 247）

// ---------- 异步行监听（手表主动上报，如 HR=xx / HRSTART / HREND）----------
// 这类行不属于任何"请求-响应"配对，需单独摘出来分发给注册的监听器
let _asyncListeners = []; // (line) => void
const ASYNC_PREFIXES = ['HRSTART', 'HR=', 'HREND'];

// ========================= 对外 API =========================

function init(callbacks) {
  _cb = Object.assign({ onLog() {}, onConnectionChange() {}, onRawLine() {} }, callbacks || {});
}

/**
 * 开始扫描 KT6368A 设备（方案 B：扫描列表 + 用户手动点选）。
 *   1. 扫描时长默认 10 秒，期间每发现一台命中设备，都会立即通过 onDeviceFound 推给 UI 增量渲染
 *   2. 10 秒到时或 stopScan() 被手动调用时，通过 onFinish 一次性返回去重+排序后的最终候选列表
 *   3. 命中规则：name 含 KT6368A  **或** MAC 前缀 DE:FF
 *   4. 本函数 **不会自动连接**。连接需要 UI 在 onDeviceFound 或 onFinish 之后调用 connect(deviceId)
 *
 * onDeviceFound(device)  —— 每新发现一台去重后触发（同 MAC 只第一次触发）
 * onFinish({devices, timeout}) —— 扫描结束时触发（10秒超时=timeout:true；手动提前停=timeout:false）
 */
function startScan(onDeviceFound, onFinish) {
  if (_scanning) return;
  _scanCb = onFinish || null;
  _scanMap = {};
  _scanList = [];
  _scanning = true;
  if (_scanTimer) { clearTimeout(_scanTimer); _scanTimer = null; }

  try { wx.offBluetoothDeviceFound && wx.offBluetoothDeviceFound(); } catch (e) {}

  log('info', '初始化蓝牙适配器（干净状态）...');

  // 关键：每次新扫描都强制 close + open，避免上次断连后适配器状态脏掉
  // 这是"断连后再扫就扫不到"的核心修复点
  const openIt = () => new Promise((resolve, reject) => {
    // 先无条件尝试 close（即使当前没开也不会报错，只是 complete 回调会触发）
    wx.closeBluetoothAdapter({
      complete: () => {
        // 等 150ms 让底层完全释放，再 open
        setTimeout(() => {
          wx.openBluetoothAdapter({
            success: () => {
              _adapterReady = true;
              resolve();
            },
            fail: (err) => {
              // 如果 open 还是失败再试一次（某些华为/小米机型需要 2 次）
              setTimeout(() => {
                wx.openBluetoothAdapter({
                  success: () => { _adapterReady = true; resolve(); },
                  fail: reject
                });
              }, 100);
            }
          });
        }, 150);
      }
    });
  });

  let totalAll = 0;   // 扫到的所有设备数（含非目标，用于诊断）
  let totalTarget = 0;

  openIt()
    .then(() => {
      log('ok', '适配器就绪，开始扫描目标设备（最多 10 秒）...');
      return new Promise((resolve, reject) => {
        wx.startBluetoothDevicesDiscovery({
          // 不传 services -> 扫全量广播，过滤在回调里精确做
          allowDuplicatesKey: false,
          interval: 200,
          powerLevel: 'high',
          success: () => resolve(),
          fail: reject
        });
      });
    })
    .then(() => {
      wx.onBluetoothDeviceFound((res) => {
        if (!_scanning) return;
        const devices = res.devices || [];
        for (const d of devices) {
          const rawName = (d.name !== undefined && d.name !== null) ? d.name : '';
          const rawLocal = (d.localName !== undefined && d.localName !== null) ? d.localName : '';
          const name = rawName || rawLocal || '';
          const mac = (d.deviceId || '').toUpperCase();
          const rssi = d.RSSI;

          if (name) totalAll++;

          // 只留目标设备
          const matchName = name.indexOf('KT6368A') >= 0;
          const matchMac  = mac.startsWith('DE:FF');
          if (!(matchName || matchMac)) continue;

          totalTarget++;
          const key = mac;
          if (_scanMap[key]) {
            // 同 MAC 的重复广播，只更新 RSSI（取更强的那个），不触发 onDeviceFound
            if (rssi > _scanMap[key].RSSI) {
              _scanMap[key].RSSI = rssi;
              _scanList.find((x) => x.deviceId.toUpperCase() === key).RSSI = rssi;
              _scanList.sort((a, b) => b.RSSI - a.RSSI);
            }
            continue;
          }
          // 新命中设备
          const info = { deviceId: d.deviceId, name: name || '(无广播名)', RSSI: rssi };
          _scanMap[key] = info;
          _scanList.push(info);
          _scanList.sort((a, b) => b.RSSI - a.RSSI);  // 信号强的排前面
          log('ok', `发现目标：${info.name}  ${mac}  RSSI=${rssi}`);
          try { onDeviceFound && onDeviceFound(info, _scanList.slice()); } catch (e) {}
        }
      });
    })
    .then(() => {
      _scanTimer = setTimeout(() => {
        if (!_scanning) return;
        log('info', `扫描时间到：共扫到其他设备 ${totalAll} 台，命中目标 ${totalTarget} 台`);
        if (totalTarget === 0) {
          log('err',
            totalAll === 0
              ? '10秒内未扫到任何设备（0台/其他）：检查手机定位总开关、微信位置/附近设备权限、手表模块是否上电。'
              : `10秒内未命中目标，但扫到 ${totalAll} 台其他设备：检查手表是否被 nRF Connect 占用（杀后台）、模块是否上电亮灯、距离 < 1米。`
          );
        }
        _finishScan(true);
      }, 10000);
    })
    .catch((err) => {
      _scanning = false;
      if (_scanTimer) { clearTimeout(_scanTimer); _scanTimer = null; }
      log('err', '启动扫描失败：' + JSON.stringify(err) +
        '；常见原因：手机"定位总开关"没开（安卓6-11必备）、微信没有"位置信息/附近的设备"权限、手机蓝牙未开。');
      try { _scanCb && _scanCb({ devices: [], timeout: true }); } catch (e) {}
    });
}

/**
 * 提前结束扫描（用户已经够多候选，不想等 10 秒时调用）。
 * 结束时会触发 startScan 传入的 onFinish，timeout=false
 */
function stopScan() {
  if (!_scanning) {
    // 没在扫也做一次清理，防止状态不一致
    try { wx.stopBluetoothDevicesDiscovery({ complete() {} }); } catch (e) {}
    try { wx.offBluetoothDeviceFound && wx.offBluetoothDeviceFound(); } catch (e) {}
    return;
  }
  _finishScan(false);
}

// 内部：统一的扫描收口逻辑（超时 / 手动停共用）
function _finishScan(timeout) {
  _scanning = false;
  if (_scanTimer) { clearTimeout(_scanTimer); _scanTimer = null; }
  try { wx.stopBluetoothDevicesDiscovery({ complete() {} }); } catch (e) {}
  try { wx.offBluetoothDeviceFound && wx.offBluetoothDeviceFound(); } catch (e) {}
  const cb = _scanCb;
  const list = _scanList.slice();
  _scanCb = null;
  try { cb && cb({ devices: list, timeout }); } catch (e) {}
}

function isScanning() { return _scanning; }


/**
 * 连接指定 deviceId，并完成服务发现 + 订阅 Notify
 */
function connect(deviceId) {
  return new Promise((resolve, reject) => {
    _deviceId = deviceId;
    log('info', `连接设备 ${deviceId} ...`);

    wx.createBLEConnection({
      deviceId,
      timeout: 8000,
      success: () => {
        log('ok', '连接成功，开始服务发现...');
        discoverServicesAndNotify()
          .then(() => {
            _connected = true;
            _notifyReady = true;
            _cb.onConnectionChange(true);
            bindNotifyListener();
            // 协商更大 MTU（默认 23，最大可到 247），减少 BLE 包数量
            wx.setBLEMTU({
              deviceId,
              mtu: 247,
              success: (res) => {
                const mtu = res && res.mtu ? res.mtu : 247;
                _bleMtu = mtu;
                log('ok', 'MTU 协商成功：' + mtu + '（单包最大 ' + (mtu - 3) + 'B）');
              },
              fail: (e) => {
                log('warn', 'MTU 协商失败，使用默认 23（单包 20B）：' + JSON.stringify(e));
              }
            });
            log('ok', 'Notify 订阅成功，链路就绪');
            resolve();
          })
          .catch((e) => {
            log('err', '服务发现/订阅失败：' + JSON.stringify(e));
            reject(e);
          });
      },
      fail: (e) => {
        log('err', '连接失败：' + JSON.stringify(e));
        reject(e);
      }
    });
  });
}

function disconnect() {
  if (_deviceId) {
    wx.closeBLEConnection({
      deviceId: _deviceId,
      complete: () => {
        handleDisconnected();
      }
    });
  } else {
    handleDisconnected();
  }
}

/**
 * 发指令，Promise 回传"干净行数组"（已拼包、去噪声）
 *   send('OV')            → Promise<['OK']>
 *   send('VO')            → Promise<['data:...', 'time:...', ..., 'END']>
 *   send('OV+SETLIGHT=50')→ Promise<['LIGHT SET=50']>
 */
function send(cmd) {
  return new Promise((resolve, reject) => {
    _queue.push({ cmd, resolve, reject });
    processQueue();
  });
}

/**
 * 注册"异步行"监听（手表主动上报，如 HR=xx / HRSTART / HREND）。
 * 返回注销函数。监听器不需要等待请求完成，收到即回调。
 */
function onLine(cb) {
  _asyncListeners.push(cb);
  return () => {
    const i = _asyncListeners.indexOf(cb);
    if (i >= 0) _asyncListeners.splice(i, 1);
  };
}

// 判断一行是否为异步行（手表主动上报）
function isAsyncLine(line) {
  for (const p of ASYNC_PREFIXES) {
    if (line.indexOf(p) === 0) return true;
  }
  return false;
}

// ========================= 内部实现 =========================

function log(level, text) {
  if (!_cb) return;
  _cb.onLog(level, text);
}

function discoverServicesAndNotify() {
  return new Promise((resolve, reject) => {
    wx.getBLEDeviceServices({
      deviceId: _deviceId,
      success: () => {
        wx.getBLEDeviceCharacteristics({
          deviceId: _deviceId,
          serviceId: SERVICE_UUID,
          success: () => {
            wx.notifyBLECharacteristicValueChange({
              deviceId: _deviceId,
              serviceId: SERVICE_UUID,
              characteristicId: NOTIFY_CHAR_UUID,
              state: true,
              success: () => resolve(),
              fail: reject
            });
          },
          fail: reject
        });
      },
      fail: reject
    });
  });
}

function bindNotifyListener() {
  wx.onBLECharacteristicValueChange((res) => {
    // 只处理我们自己订阅的 0xFFF2
    if (res.characteristicId.toUpperCase() !== NOTIFY_CHAR_UUID.toUpperCase()) return;
    const bytes = new Uint8Array(res.value);

    if (_rawMode) {
      // Raw 模式：
      //  1) 先把每个字节顺序压入 _rawByteQueue（waitRxByte 会消费）
      //  2) 再调用外部 _rawCb（如果 UI 想把整段打印/解码出来）
      for (let i = 0; i < bytes.length; i++) _rawByteQueue.push(bytes[i]);
      try { _rawCb && _rawCb(bytes); } catch (e) {}
      // 如果有人在等特定字节，立即尝试匹配
      if (_rawByteWaiter) {
        const expectSet = _rawByteWaiter.expectByteSet;
        let found = -1;
        let foundIdx = -1;
        for (let i = 0; i < _rawByteQueue.length; i++) {
          if (expectSet.has(_rawByteQueue[i])) { found = _rawByteQueue[i]; foundIdx = i; break; }
        }
        if (foundIdx >= 0) {
          // 移除 [0..foundIdx]（期间的非期望字节丢弃，通常是菜单文本）
          _rawByteQueue.splice(0, foundIdx + 1);
          const w = _rawByteWaiter;
          _rawByteWaiter = null;
          clearTimeout(w.timer);
          try { w.resolve({ byte: found, aborted: false }); } catch (e) {}
        }
      }
      return;
    }

    const text = ab2str(bytes);
    handleRawChunk(text);
  });

  wx.onBLEConnectionStateChange((res) => {
    if (!res.connected && _connected) {
      log('warn', '蓝牙连接已断开');
      handleDisconnected();
    }
  });
}

function handleDisconnected() {
  _connected = false;
  _notifyReady = false;
  _deviceId = '';
  _buffer = '';
  // 清掉队列中待发送的请求
  while (_queue.length) {
    const item = _queue.shift();
    item.reject && item.reject(new Error('disconnected'));
  }
  _sending = false;
  if (_timeoutTimer) { clearTimeout(_timeoutTimer); _timeoutTimer = null; }
  if (_currentReject) {
    _currentReject(new Error('disconnected'));
    _currentReject = null;
    _currentResolve = null;
  }
  _cb.onConnectionChange(false);
}

/**
 * 处理一块原始 Notify 文本片段：
 *  1. 追加到 _buffer
 *  2. 按 \r\n 切成完整行
 *  3. 过滤 BLE_STANDBY_xxx 或 RecStr:xxx 这类噪声行
 *  4. 剩下的干净行交给当前发送请求
 */
function handleRawChunk(chunk) {
  _buffer += chunk;
  let idx;
  while ((idx = _buffer.indexOf('\r\n')) !== -1) {
    const line = _buffer.slice(0, idx);
    _buffer = _buffer.slice(idx + 2);
    if (!line) continue; // 空行跳过
    if (isNoise(line)) continue;
    // 干净行：先给外部 onRawLine 日志回调
    _cb.onRawLine(line);
    // 手表主动上报的异步行（HRSTART/HR=/HREND）：分发给监听器，不进请求响应累积
    if (isAsyncLine(line)) {
      for (const cb of _asyncListeners.slice()) {
        try { cb(line); } catch (e) {}
      }
      continue;
    }
    // 再喂给当前请求的响应累积器
    if (_sending) {
      _responseLines.push(line);
      // 特殊指令 VO：遇到 END 即响应完成
      if (line === 'END') {
        resolveCurrent();
      } else if (isOneLineResponse(line)) {
        // 单条响应：收完一行直接结算
        resolveCurrent();
      }
    }
  }
}

function isNoise(line) {
  for (const p of NOISE_PREFIXES) {
    if (line.indexOf(p) === 0) return true;
  }
  return false;
}

/**
 * 判断这一行是否意味着"当前请求可以结算了"
 * （单条回复类指令；VO 的 END 已经单独处理）
 */
function isOneLineResponse(line) {
  // 可能的结束行：
  // OK / UNKNOWN / VERSION=xxx / LIGHT=xxx / LIGHT SET=xxx / LIGHT ERR* / TIMESETOK / TIME ERR / OK+UPGRADE / NOTIFY OK / NOTIFY ERR
  if (line === 'OK' || line === 'UNKNOWN' ||
      line === 'TIMESETOK' || line === 'TIME ERR' ||
      line.indexOf('OK+UPGRADE') === 0 ||
      line.indexOf('NOTIFY OK') === 0 ||
      line.indexOf('NOTIFY ERR') === 0) {
    return true;
  }
  if (line.indexOf('VERSION=') === 0 ||
      line.indexOf('LIGHT=') === 0 ||
      line.indexOf('LIGHT SET=') === 0 ||
      line.indexOf('LIGHT ERR') === 0 ||
      line.indexOf('WRIST=') === 0 ||
      line.indexOf('WRIST SET=') === 0 ||
      line.indexOf('WRIST ERR') === 0 ||
      line.indexOf('LTIME=') === 0 ||
      line.indexOf('LTIME SET=') === 0 ||
      line.indexOf('LTIME ERR') === 0 ||
      line.indexOf('TTIME=') === 0 ||
      line.indexOf('TTIME SET=') === 0 ||
      line.indexOf('TTIME ERR') === 0 ||
      line.indexOf('HRREPORT=') === 0) {
    return true;
  }
  return false;
}

// ---------------- 串行发送队列 ----------------

function processQueue() {
  if (_sending) return;
  const item = _queue.shift();
  if (!item) return;
  if (!_connected || !_notifyReady) {
    item.reject(new Error('not connected'));
    processQueue();
    return;
  }
  _sending = true;
  _responseLines = [];
  _currentResolve = item.resolve;
  _currentReject = item.reject;

  log('info', `发送指令：${item.cmd}`);

  // 固件 UART 接收现在按 \r\n 拼整行，发送时统一补行尾
  const cmdWithCrlf = /(\r\n|\n|\r)$/.test(item.cmd) ? item.cmd : item.cmd + '\r\n';
  const buffer = str2ab(cmdWithCrlf);
  wx.writeBLECharacteristicValue({
    deviceId: _deviceId,
    serviceId: SERVICE_UUID,
    characteristicId: WRITE_CHAR_UUID,
    value: buffer,
    writeType: 'writeNoResponse',
    success: () => {
      // 启动超时定时器
      _timeoutTimer = setTimeout(() => {
        if (!_sending) return;
        // 如果已经收到了一些响应但还没达到结算条件（比如 VO 漏包），也把已收到的返回
        _timeoutTimer = null;
        if (_responseLines.length > 0) {
          log('warn', `指令 ${item.cmd} 超时，但已有部分响应`);
          resolveCurrent();
        } else {
          rejectCurrent(new Error(`指令 ${item.cmd} 超时（${_cmdTimeoutMs}ms 无响应）`));
        }
      }, _cmdTimeoutMs);
    },
    fail: (e) => {
      log('err', `写入失败：${JSON.stringify(e)}`);
      rejectCurrent(new Error('write fail: ' + JSON.stringify(e)));
    }
  });
}

function resolveCurrent() {
  if (!_sending) return;
  if (_timeoutTimer) { clearTimeout(_timeoutTimer); _timeoutTimer = null; }
  const resolve = _currentResolve;
  const lines = _responseLines.slice();
  _sending = false;
  _responseLines = [];
  _currentResolve = null;
  _currentReject = null;
  log('ok', `收到回复：${lines.join(' | ')}`);
  resolve && resolve(lines);
  // 处理下一条
  processQueue();
}

function rejectCurrent(err) {
  if (!_sending) return;
  if (_timeoutTimer) { clearTimeout(_timeoutTimer); _timeoutTimer = null; }
  const reject = _currentReject;
  _sending = false;
  _responseLines = [];
  _currentResolve = null;
  _currentReject = null;
  reject && reject(err);
  processQueue();
}

// ---------------- 字符串 / ArrayBuffer 互转 ----------------

function str2ab(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes.buffer;
}

function ab2str(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

module.exports = {
  SERVICE_UUID,
  WRITE_CHAR_UUID,
  NOTIFY_CHAR_UUID,
  init,
  startScan,
  stopScan,
  connect,
  disconnect,
  send,
  onLine,
  isConnected() { return _connected; },
  getDeviceInfo() {
    if (!_connected || !_deviceId) return null;
    return { deviceId: _deviceId, name: 'OV Watch', RSSI: null };
  },
  isScanning,

  // ---- Raw 模式 API（给 OTA Ymodem 用）----
  enterRawMode(cb) {
    _rawMode = true;
    _rawCb = cb || null;
    _rawByteQueue = [];
    if (_rawByteWaiter) {
      clearTimeout(_rawByteWaiter.timer);
      _rawByteWaiter = null;
    }
    log('info', '[Raw] 进入 Raw 模式（关闭拼包/去噪，字节透传）');
  },
  exitRawMode() {
    _rawMode = false;
    _rawCb = null;
    _rawByteQueue = [];
    if (_rawByteWaiter) {
      clearTimeout(_rawByteWaiter.timer);
      _rawByteWaiter = null;
    }
    _buffer = '';
    log('info', '[Raw] 退出 Raw 模式，恢复正常拼包');
  },
  isRawMode() { return _rawMode; },

  /**
   * 等待 BLE Notify 里收到"第一个属于 expectByteSet 集合内的字节"。
   * 队列里先消费已有的字节；等不到就等 timeoutMs；超时返回 byte=undefined。
   * 期间任何不是期望字节的单字节会被消费掉（因为 BootLoader 会打印菜单文本）。
   */
  waitRxByte(timeoutMs, expectByteSet) {
    return new Promise((resolve) => {
      const expectSet = new Set(expectByteSet);
      const tryConsume = () => {
        while (_rawByteQueue.length > 0) {
          const b = _rawByteQueue.shift();
          if (expectSet.has(b)) {
            if (_rawByteWaiter) { clearTimeout(_rawByteWaiter.timer); _rawByteWaiter = null; }
            resolve({ byte: b, aborted: false });
            return true;
          }
        }
        return false;
      };
      if (tryConsume()) return;
      const timer = setTimeout(() => {
        if (_rawByteWaiter === waiter) {
          _rawByteWaiter = null;
          resolve({ byte: undefined, aborted: false, timeout: true });
        }
      }, timeoutMs);
      const waiter = { expectByteSet: expectSet, resolve, timer };
      _rawByteWaiter = waiter;
    });
  },

  /**
   * 发送原始字节数组（带 BLE 节流 + MTU 自适应）
   *
   * - chunkSize 默认 = MTU - 3（MTU=23 → 20B；MTU=247 → 244B）
   * - 每块间隔 >= intervalMs（8ms，靠 KT6368A 内部缓冲处理速率匹配）
   * - 发完后等 _postSendDelayMs（10ms，给最后一批写入排空）
   */
  async sendRawBytes(uint8Arr, chunkSize, intervalMs, writeType) {
    if (!_connected) throw new Error('not connected');
    // 如果没指定 chunkSize，用 MTU - 3（ATT header 3B），最大 244B
    chunkSize = chunkSize || (_bleMtu > 23 ? _bleMtu - 3 : 20);
    intervalMs = (intervalMs !== undefined) ? intervalMs : _rawWriteIntervalMs;
    writeType = writeType || 'writeNoResponse';
    const total = uint8Arr.length;
    let off = 0;
    let chunkCount = 0;

    while (off < total) {
      const end = Math.min(off + chunkSize, total);
      const piece = uint8Arr.slice(off, end);

      // 节流：强制距上一块 >= intervalMs
      const elapsed = Date.now() - _lastWriteTime;
      if (elapsed < intervalMs) {
        await new Promise(r => setTimeout(r, intervalMs - elapsed));
      }

      await new Promise((resolve, reject) => {
        wx.writeBLECharacteristicValue({
          deviceId: _deviceId,
          serviceId: SERVICE_UUID,
          characteristicId: WRITE_CHAR_UUID,
          value: piece.buffer,
          writeType,
          success: () => { _lastWriteTime = Date.now(); resolve(); },
          fail: (e) => reject(new Error('sendRawBytes fail: ' + JSON.stringify(e))),
        });
      });
      off = end;
      chunkCount++;
    }

    // 发完整个数组后再等 _postSendDelayMs，确保最后一批写入已排空
    if (_postSendDelayMs > 0) {
      await new Promise(r => setTimeout(r, _postSendDelayMs));
    }
  },

  /**
   * 发送单个文本字符（BootLoader 菜单里的 '1'/'3'/'a' 按键）
   */
  async sendChar(ch) {
    const code = typeof ch === 'string' ? ch.charCodeAt(0) : (ch | 0);
    const arr = new Uint8Array([code]);
    await this.sendRawBytes(arr, 20, 0);
  },

  /**
   * 关键按键（如 BootLoader 的 '3'）优先用带响应的 GATT 写：
   * success 表示模块已 ACK，确认字节到达；特征不支持时回退 writeNoResponse。
   */
  async sendCharAck(ch) {
    const code = typeof ch === 'string' ? ch.charCodeAt(0) : (ch | 0);
    const arr = new Uint8Array([code]);
    try {
      await this.sendRawBytes(arr, 20, 0, 'write');
    } catch (e) {
      await this.sendRawBytes(arr, 20, 0, 'writeNoResponse');
    }
  },
};
