// utils/watchProtocol.js
// OV Watch 指令层：封装每条指令成 Promise，返回结构化结果
// 底层调用 bleService.send()，这里只做"指令拼装 + 回传行的结构化提取"
//
// 页面里这么用：
//   const proto = require('../../utils/watchProtocol.js');
//   proto.init(bleService);
//   proto.ping().then(result => ...);
//   proto.queryAll().then(data => ...);

let _ble = null;

function init(bleService) {
  _ble = bleService;
}

// ---------- 工具 ----------
function ensureReady() {
  if (!_ble) throw new Error('watchProtocol 未 init，请先 init(bleService)');
  if (!_ble.isConnected()) throw new Error('设备未连接');
}

function findLine(lines, prefix) {
  for (const l of lines) {
    if (l.indexOf(prefix) === 0) return l.slice(prefix.length);
  }
  return null;
}

// ---------- 1. 连接测试 ----------
function ping() {
  ensureReady();
  return _ble.send('OV').then((lines) => {
    if (lines.indexOf('OK') !== -1) return { ok: true, raw: lines };
    return { ok: false, raw: lines };
  });
}

// ---------- 2. 读固件版本 ----------
function getVersion() {
  ensureReady();
  return _ble.send('OV+VERSION').then((lines) => {
    const v = findLine(lines, 'VERSION=');
    return { version: v || null, raw: lines };
  });
}

// ---------- 3. 读背光 ----------
function getLight() {
  ensureReady();
  return _ble.send('OV+GETLIGHT').then((lines) => {
    const s = findLine(lines, 'LIGHT=');
    const n = (s != null) ? parseInt(s, 10) : null;
    return { light: isNaN(n) ? null : n, raw: lines };
  });
}

// ---------- 4. 设置背光 ----------
function setLight(value) {
  ensureReady();
  if (typeof value !== 'number' || value < 0 || value > 100) {
    return Promise.reject(new Error('背光范围 0~100'));
  }
  return _ble.send('OV+SETLIGHT=' + value).then((lines) => {
    const setLine = findLine(lines, 'LIGHT SET=');
    if (setLine != null) {
      const n = parseInt(setLine, 10);
      return { ok: true, light: isNaN(n) ? null : n, raw: lines };
    }
    if (findLine(lines, 'LIGHT ERR FMT') != null) {
      return { ok: false, error: 'FORMAT', raw: lines };
    }
    if (findLine(lines, 'LIGHT ERR RANGE') != null) {
      return { ok: false, error: 'RANGE', raw: lines };
    }
    if (findLine(lines, 'LIGHT ERR') != null) {
      return { ok: false, error: 'GENERAL', raw: lines };
    }
    return { ok: false, error: 'UNKNOWN', raw: lines };
  });
}

// ---------- 5. 查询全量传感器数据 ----------
/**
 * 返回结构化数据 + 原始行：
 * {
 *   data: { date, time, humidity, temperature, heartRate, spo2, steps, light },
 *   raw: string[]
 * }
 */
function queryAll() {
  ensureReady();
  return _ble.send('VO').then((lines) => {
    const out = {
      date: null,           // "08-09"
      time: null,           // "20:10:00"
      humidity: null,       // 63
      temperature: null,    // 31
      heartRate: null,      // 0
      spo2: null,           // 99
      steps: null,          // 0
      light: null,          // 50
    };
    for (const line of lines) {
      if (line.indexOf('data:') === 0) {
        // "data: 5-21" —— 前面可能有个空格（%2d 对齐月份<10）
        out.date = line.slice(5).trim();
      } else if (line.indexOf('time:') === 0) {
        out.time = line.slice(5).trim();
      } else if (line.indexOf('humidity:') === 0) {
        const s = line.slice(9).replace('%', '').trim();
        const n = parseInt(s, 10);
        out.humidity = isNaN(n) ? null : n;
      } else if (line.indexOf('temperature:') === 0) {
        const s = line.slice(12).trim();
        const n = parseInt(s, 10);
        out.temperature = isNaN(n) ? null : n;
      } else if (line.indexOf('Heart Rate:') === 0) {
        const s = line.slice(11).replace('%', '').trim();
        const n = parseInt(s, 10);
        out.heartRate = isNaN(n) ? null : n;
      } else if (line.indexOf('SPO2:') === 0) {
        const s = line.slice(5).replace('%', '').trim();
        const n = parseInt(s, 10);
        out.spo2 = isNaN(n) ? null : n;
      } else if (line.indexOf('Step today:') === 0) {
        const s = line.slice(11).trim();
        const n = parseInt(s, 10);
        out.steps = isNaN(n) ? null : n;
      } else if (line.indexOf('light:') === 0) {
        const s = line.slice(6).trim();
        const n = parseInt(s, 10);
        out.light = isNaN(n) ? null : n;
      }
    }
    return { data: out, raw: lines };
  });
}

// ---------- 6. 同步时间 ----------
/**
 * 不传参数就同步手机当前时间；也可手动传 YYYY/MM/DD/HH/mm/ss 数字
 * 返回值会带上实际发送的 cmd 字符串，便于 UI 显示真实指令
 */
function syncTime(year, month, day, hour, minute, second) {
  ensureReady();
  let y, mo, d, h, mi, s;
  if (arguments.length === 0) {
    const now = new Date();
    y = now.getFullYear();
    mo = now.getMonth() + 1;
    d = now.getDate();
    h = now.getHours();
    mi = now.getMinutes();
    s = now.getSeconds();
  } else {
    y = year; mo = month; d = day; h = hour; mi = minute; s = second;
  }
  // 固件期望 OV+ST=YYYYMMDDHHmmss（4位年份），从 str[8] 开始解析
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const cmd = `OV+ST=${pad(y)}${pad(mo)}${pad(d)}${pad(h)}${pad(mi)}${pad(s)}`;
  return _ble.send(cmd).then((lines) => {
    if (lines.indexOf('TIMESETOK') !== -1) {
      return { ok: true, cmd, raw: lines };
    }
    if (lines.indexOf('TIME ERR') !== -1) {
      return { ok: false, error: 'FORMAT', cmd, raw: lines };
    }
    return { ok: false, error: 'UNKNOWN', cmd, raw: lines };
  });
}

// ---------- 7. 进入 OTA（跳 BootLoader） ----------
/**
 * 注意：这条指令响应完后手表会跳 IAP，蓝牙连接会断开，是正常现象。
 */
function enterOTA() {
  ensureReady();
  return _ble.send('OV+UPGRADE').then((lines) => {
    const ok = (findLine(lines, 'OK+UPGRADE') != null);
    return { ok, raw: lines };
  });
}

// ---------- 8. 心率实时上报开关 ----------
/**
 * 开启/关闭手表的实时心率上报。
 * 开启后：进入心率页面时会收到 HRSTART / HR=xx / HREND 上报行。
 */
function setHRReport(on) {
  ensureReady();
  return _ble.send(on ? 'OV+HRREPORT=1' : 'OV+HRREPORT=0');
}

/**
 * 注册心率上报行监听（需 bleService 支持 onLine）。
 * 回调会收到解析后的结构化事件：
 *   { type: 'start' }
 *   { type: 'sample', hr: number }
 *   { type: 'summary', avg, min, max, n }
 *   { type: 'unknown', line }
 * 返回注销函数。
 */
function onHRData(cb) {
  if (!_ble.onLine) {
    throw new Error('bleService 未提供 onLine 接口');
  }
  return _ble.onLine((line) => {
    let evt = null;
    if (line === 'HRSTART') {
      evt = { type: 'start' };
    } else if (line.indexOf('HR=') === 0) {
      const n = parseInt(line.slice(3), 10);
      evt = { type: 'sample', hr: isNaN(n) ? null : n };
    } else if (line.indexOf('HREND') === 0) {
      // HREND,avg=76,min=72,max=80,n=28
      const cur = {};
      const parts = line.slice(6).split(',');
      for (const p of parts) {
        const m = p.split('=');
        if (m.length === 2) cur[m[0].trim()] = parseInt(m[1], 10);
      }
      evt = {
        type: 'summary',
        avg: isNaN(cur.avg) ? null : cur.avg,
        min: isNaN(cur.min) ? null : cur.min,
        max: isNaN(cur.max) ? null : cur.max,
        n: isNaN(cur.n) ? null : cur.n,
      };
    }
    if (evt) {
      try { cb(evt); } catch (e) {}
    } else {
      try { cb({ type: 'unknown', line }); } catch (e) {}
    }
  });
}

// ---------- 9. 通知推送 ----------
/**
 * 推送一条通知到手表扬声器/通知列表。
 * app: 'WX'（微信）或 'QQ'；sender: 发送人昵称；content: 消息内容
 * 固件侧回复 NOTIFY OK / NOTIFY ERR。
 */
function sendNotify(app, sender, content) {
  ensureReady();
  const cmd = `OV+NOTIFY=${app}|${sender}|${content}`;
  return _ble.send(cmd).then((lines) => {
    if (lines.indexOf('NOTIFY OK') !== -1) return { ok: true, raw: lines };
    if (lines.indexOf('NOTIFY ERR') !== -1) return { ok: false, error: 'GENERAL', raw: lines };
    return { ok: false, error: 'UNKNOWN', raw: lines };
  });
}

// ---------- 10. 抬腕亮屏 ----------
function getWrist() {
  ensureReady();
  return _ble.send('OV+GETWRIST').then((lines) => {
    const s = findLine(lines, 'WRIST=');
    return { on: s === '1', raw: lines };
  });
}

function setWrist(on) {
  ensureReady();
  const v = on ? 1 : 0;
  return _ble.send('OV+SETWRIST=' + v).then((lines) => {
    const setLine = findLine(lines, 'WRIST SET=');
    if (setLine != null) {
      return { ok: true, on: setLine === '1', raw: lines };
    }
    if (findLine(lines, 'WRIST ERR FMT') != null) {
      return { ok: false, error: 'FORMAT', raw: lines };
    }
    return { ok: false, error: 'UNKNOWN', raw: lines };
  });
}

// ---------- 11. 常亮时间 ----------
function getLTime() {
  ensureReady();
  return _ble.send('OV+GETLTIME').then((lines) => {
    const s = findLine(lines, 'LTIME=');
    const n = (s != null) ? parseInt(s, 10) : null;
    return { value: isNaN(n) ? null : n, raw: lines };
  });
}

function setLTime(v) {
  ensureReady();
  if ([10, 15, 20, 30, 45, 60].indexOf(v) === -1) {
    return Promise.reject(new Error('常亮时间范围：10/15/20/30/45/60 秒'));
  }
  return _ble.send('OV+SETLTIME=' + v).then((lines) => {
    const setLine = findLine(lines, 'LTIME SET=');
    if (setLine != null) {
      const n = parseInt(setLine, 10);
      return { ok: true, value: isNaN(n) ? null : n, raw: lines };
    }
    if (findLine(lines, 'LTIME ERR FMT') != null) return { ok: false, error: 'FORMAT', raw: lines };
    if (findLine(lines, 'LTIME ERR RANGE') != null) return { ok: false, error: 'RANGE', raw: lines };
    return { ok: false, error: 'UNKNOWN', raw: lines };
  });
}

// ---------- 12. 熄屏时间 ----------
function getTTime() {
  ensureReady();
  return _ble.send('OV+GETTTIME').then((lines) => {
    const s = findLine(lines, 'TTIME=');
    const n = (s != null) ? parseInt(s, 10) : null;
    return { value: isNaN(n) ? null : n, raw: lines };
  });
}

function setTTime(v) {
  ensureReady();
  if ([15, 20, 25, 35, 50, 65].indexOf(v) === -1) {
    return Promise.reject(new Error('熄屏时间范围：15/20/25/35/50/65 秒'));
  }
  return _ble.send('OV+SETTTIME=' + v).then((lines) => {
    const setLine = findLine(lines, 'TTIME SET=');
    if (setLine != null) {
      const n = parseInt(setLine, 10);
      return { ok: true, value: isNaN(n) ? null : n, raw: lines };
    }
    if (findLine(lines, 'TTIME ERR FMT') != null) return { ok: false, error: 'FORMAT', raw: lines };
    if (findLine(lines, 'TTIME ERR RANGE') != null) return { ok: false, error: 'RANGE', raw: lines };
    return { ok: false, error: 'UNKNOWN', raw: lines };
  });
}

// ---------- 13. 睡眠记录拉取 ----------
/**
 * 拉取手表存储的睡眠记录（7天摘要 + 最近一晚逐分钟bit图）。
 * 发送 OV+SLEEPGET，固件回：
 *   OK+SLEEPREC BEGIN
 *   OK+SLEEPREC MMDD,onset,wake,dur,turns,awakes    （每晚一行，最多7行）
 *   OK+SLEEPBIT HHHH...                              （bit图，16字节/行，共5行68B）
 *   OK+SLEEPREC END
 *
 * 返回结构：
 * {
 *   ok: true,
 *   records: [ { dateKey:'MMDD', onset, wake, dur, turns, awakes,
 *                onsetHM:'23:41', wakeHM:'06:12', durHM:'6h31m' } ],
 *   bitmap: [0/1,...],        // 最近一晚逐分钟状态（入睡后第0分钟起），1=醒/活动
 *   raw: lines
 * }
 */
function getSleepData() {
  ensureReady();
  return _ble.send('OV+SLEEPGET').then((lines) => {
    if (lines.indexOf('ERR+SLEEPREC') !== -1) {
      return { ok: false, error: 'EEPROM', raw: lines };
    }
    if (lines.indexOf('OK+SLEEPREC END') === -1) {
      return { ok: false, error: 'TIMEOUT', raw: lines };
    }

    const records = [];
    for (const l of lines) {
      if (l.indexOf('OK+SLEEPREC ') !== 0) continue; // 跳过 BEGIN/END 行
      const parts = l.slice('OK+SLEEPREC '.length).split(',');
      if (parts.length !== 6) continue;
      const onset = parseInt(parts[1], 10);
      const wake = parseInt(parts[2], 10);
      const dur = parseInt(parts[3], 10);
      if ([onset, wake, dur].some(isNaN)) continue;
      records.push({
        dateKey: parts[0],              // MMDD 十六进制字符串
        onset, wake, dur,
        turns: parseInt(parts[4], 10) || 0,
        awakes: parseInt(parts[5], 10) || 0,
        onsetHM: minutesToHM(onset),
        wakeHM: minutesToHM(wake % 1440), // wake 可能跨0点折算超过1440
        durHM: minutesToHM(dur),
      });
    }

    // bit 图：所有 OK+SLEEPBIT 行的 hex 串拼接，每字节8位展开（LSB在前：位m → 字节m/8的第m%8位）
    let bitmap = [];
    let bitmapHex = '';
    for (const l of lines) {
      if (l.indexOf('OK+SLEEPBIT ') !== 0) continue;
      const hex = l.slice('OK+SLEEPBIT '.length).replace(/\s+/g, '');
      bitmapHex += hex;
      for (let i = 0; i + 1 < hex.length; i += 2) {
        const byte = parseInt(hex.substr(i, 2), 16);
        if (isNaN(byte)) continue;
        for (let b = 0; b < 8; b++) bitmap.push((byte >> b) & 1);
      }
    }

    return { ok: true, records, bitmap, bitmapHex, raw: lines };
  });
}

// 分钟数转 HH:MM 显示（兼容超过24h的折算值）
function minutesToHM(m) {
  const mm = ((m % 60) + 60) % 60;
  const hh = Math.floor(m / 60);
  return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}

// ==================== BootLoader / OTA 流程（Raw 模式） ====================
//  工作流：
//   1. enterOTA() 手表跳到 BootLoader，BLE 自动断开 + 重启广播
//   2. 用户重新扫描 + connect
//   3. bootEnterRawMode() 打开 Raw 模式
//   4. bootSendKey('1') 进入下载，bootWaitForHandshakeC() 等 'C' 握手
//   5. bootStartYmodem(fileBytes, fileName, progressCb) 传固件
//   6. bootSendKey('3') 跳回新 APP
// -------------------------------------------------------------------------

const { YmodemSender, YM_CTL } = require('./ymodem.js');

let _ym = null;

function bootEnterRawMode() {
  ensureReady();
  _ble.enterRawMode();
}

function bootExitRawMode() {
  if (_ble.isRawMode()) _ble.exitRawMode();
  _ym = null;
}

/**
 * 给 BootLoader 菜单按键：'1' 下载, '2' 上传, '3' 执行APP, 'a' 中止
 * Ymodem_Receive 里 GetKey() 检测 'a' 会 abort session
 */
async function bootSendKey(ch) {
  ensureReady();
  if (!_ble.isRawMode()) _ble.enterRawMode();
  await _ble.sendChar(ch);
}

/**
 * 关键按键带响应发送：优先 write-with-response（模块 ACK 后 success），
 * 用于 '3' 跳回 APP 这种不能丢的按键。
 */
async function bootSendKeyAck(ch) {
  ensureReady();
  if (!_ble.isRawMode()) _ble.enterRawMode();
  await _ble.sendCharAck(ch);
}

/**
 * 等待 BootLoader 的 Ymodem 'C' 握手字节（CRC16模式）。
 * 同时允许等待 ACK/NAK 做一般调试。
 */
function bootWaitForByte(timeoutMs, expectCodes) {
  ensureReady();
  if (!_ble.isRawMode()) _ble.enterRawMode();
  return _ble.waitRxByte(timeoutMs, expectCodes);
}

/**
 * 便捷封装：等 'C'（BootLoader 菜单里按了 1 就反复发 'C'）
 */
function bootWaitForHandshakeC(timeoutMs) {
  return bootWaitForByte(timeoutMs || 8000, [YM_CTL.CRC]);
}

/**
 * 用 Ymodem 发送固件。progressCb(percent, pktSeq, totalPkts)
 * 返回 { ok, size, packets }
 */
async function bootStartYmodem(fileBuffer, fileName, progressCb) {
  ensureReady();
  if (!_ble.isRawMode()) _ble.enterRawMode();

  _ym = new YmodemSender({
    sendRaw: async (uint8Arr) => { await _ble.sendRawBytes(uint8Arr, null, 8); },
    waitByte: async (timeoutMs, expectByteSet) => _ble.waitRxByte(timeoutMs, expectByteSet),
    progress: progressCb || function() {},
  });

  return _ym.sendFile(fileBuffer, fileName || 'OV_Watch.bin');
}

module.exports = {
  init,
  ping,
  getVersion,
  getLight,
  setLight,
  queryAll,
  syncTime,
  enterOTA,
  setHRReport,
  onHRData,
  sendNotify,
  getWrist,
  setWrist,
  getLTime,
  setLTime,
  getTTime,
  setTTime,
  getSleepData,

  // ---- BootLoader 操作 ----
  bootEnterRawMode,
  bootExitRawMode,
  bootSendKey,
  bootSendKeyAck,
  bootWaitForByte,
  bootWaitForHandshakeC,
  bootStartYmodem,
};
