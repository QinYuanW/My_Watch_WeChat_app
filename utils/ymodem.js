// utils/ymodem.js —— 标准 Ymodem-1K (CRC16) 发送端
// 协议参考 My_IAP_F411/Ymodem/ymodem.c 的 Ymodem_Receive() 实现
// 用法：
//   const ym = new YmodemSender({
//     sendRaw: async (bytes) => { ... await ble 写 ... },   // 负责把 Uint8Array 透传到 BLE 并做 20B 分片
//     waitByte:  async (timeoutMs, expectByteSet) => singleByte  // 读到 BLE Notify 返回的第一个单字节
//     progress: (percent, pktSeq, totalPkts) => {}
//   });
//   await ym.sendFile(fileBuffer, "OV_Watch.bin");

// Ymodem 控制字
const SOH = 0x01;   // 128B 数据包头
const STX = 0x02;   // 1KB  数据包头
const EOT = 0x04;   // 传输结束
const ACK = 0x06;   // 应答
const NAK = 0x15;   // 否定应答（重传）
const CA  = 0x18;   // 取消会话（收端发两个 CA = 中止）
const CRC_MODE_REQ = 0x43;  // 'C'，收端请求 CRC16 模式
const ABORT = 0x61;         // 'a'，用户中止（Ymodem_Receive 里 GetKey 检测到 ABORT2 就退）

const PACKET_SIZE     = 128;
const PACKET_1K_SIZE  = 1024;
const PACKET_HEADER   = 3;   // SOH/STX + seq + ~seq
const CRC_TRAILER     = 2;   // CRC16 big-endian
const PACKET_OVERHEAD = PACKET_HEADER + CRC_TRAILER;  // 5 字节
const MAX_ERRORS      = 10;  // 连续 10 次 NAK/超时就放弃

// CRC16 (CCITT-FALSE 变种，和固件里 UpdateCRC16/Cal_CRC16 严格一致)
function calCRC16(bytes, offset, length) {
  let crc = 0;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    let inByte = bytes[i] | 0x100;
    do {
      crc <<= 1;
      inByte <<= 1;
      if (inByte & 0x100) crc++;
      if (crc & 0x10000) crc ^= 0x1021;
    } while (!(inByte & 0x10000));
  }
  crc = _updateByte(crc, 0);
  crc = _updateByte(crc, 0);
  return crc & 0xffff;
}
function _updateByte(crcIn, byte) {
  let crc = crcIn;
  let inByte = byte | 0x100;
  do {
    crc <<= 1;
    inByte <<= 1;
    if (inByte & 0x100) crc++;
    if (crc & 0x10000) crc ^= 0x1021;
  } while (!(inByte & 0x10000));
  return crc & 0xffff;
}

// 把数字转 N 位十进制字符串（文件名包里放文件大小用）
function intToStr(n) {
  if (n === 0) return '0';
  let s = '';
  while (n > 0) { s = String.fromCharCode(48 + (n % 10)) + s; n = Math.floor(n / 10); }
  return s;
}

// 构造 Ymodem 包，返回完整 Uint8Array（header + data + crc）
function _buildPacket(seq, payload, offset, payloadLen, use1k) {
  const pktSize = use1k ? PACKET_1K_SIZE : PACKET_SIZE;
  const frameLen = pktSize + PACKET_OVERHEAD;
  const out = new Uint8Array(frameLen);
  out[0] = use1k ? STX : SOH;
  out[1] = seq & 0xff;
  out[2] = (~seq) & 0xff;
  // 数据区，不足填 0x1A (CP/M EOF)
  const end = offset + payloadLen;
  let j = 0;
  for (let i = offset; i < end; i++) {
    out[PACKET_HEADER + j] = payload[i];
    j++;
  }
  for (; j < pktSize; j++) {
    out[PACKET_HEADER + j] = 0x1A;
  }
  const crc = calCRC16(out, PACKET_HEADER, pktSize);
  out[PACKET_HEADER + pktSize] = (crc >> 8) & 0xff;
  out[PACKET_HEADER + pktSize + 1] = crc & 0xff;
  return out;
}

// 构造文件名包（SOH 类型，128 负载）
function _buildFilenamePacket(fileName, fileSizeBytes) {
  const nameBytes = stringToUtf8Bytes(fileName);
  const sizeStr = intToStr(fileSizeBytes);
  const sizeBytes = stringToUtf8Bytes(sizeStr);
  const payload = new Uint8Array(PACKET_SIZE);
  let p = 0;
  for (let i = 0; i < nameBytes.length && i < 110; i++) payload[p++] = nameBytes[i];
  payload[p++] = 0; // NUL 终止文件名
  payload[p++] = 0x20; // 空格分隔文件名 / 文件大小（固件 for (i=0,file_ptr++;*file_ptr!=' '&&i<...;) 取大小）
  for (let i = 0; i < sizeBytes.length && p < PACKET_SIZE - 1; i++) payload[p++] = sizeBytes[i];
  return _buildPacket(0, payload, 0, PACKET_SIZE, false);
}

// 构造空文件名包（会话结束用）
function _buildEmptyFilenamePacket() {
  const payload = new Uint8Array(PACKET_SIZE);
  return _buildPacket(0, payload, 0, PACKET_SIZE, false);
}

function stringToUtf8Bytes(s) {
  // 小程序支持 TextEncoder
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c>>6)); out.push(0x80 | (c & 0x3f)); }
    else { out.push(0xe0 | (c>>12)); out.push(0x80 | ((c>>6) & 0x3f)); out.push(0x80 | (c & 0x3f)); }
  }
  return new Uint8Array(out);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class YmodemSender {
  constructor({ sendRaw, waitByte, progress }) {
    this.sendRaw = sendRaw;      // async (Uint8Array) => void
    this.waitByte = waitByte;    // async (timeoutMs, [expectedBytes]) => { byte:number, aborted:bool }
    this.progress = progress || function(){};
  }

  async sendFile(fileBuffer, fileName) {
    if (!(fileBuffer instanceof Uint8Array)) fileBuffer = new Uint8Array(fileBuffer);
    const totalBytes = fileBuffer.length;
    // 总共需要多少个 1KB 数据包
    const totalDataPkts = Math.ceil(totalBytes / PACKET_1K_SIZE);
    let progressPkt = 0;
    let aborted = false;

    // ---- Step 0: 等待收端（BootLoader）发出 'C' 握手 ----
    this.progress(0, 0, totalDataPkts);
    let stepOk = await this._waitForCC(5000);
    if (!stepOk) throw new Error('OTA 握手失败：BootLoader 未在 5s 内发出 CRC 握手字节 C');

    // ---- Step 1: 发送文件名包 ----
    {
      let errors = 0;
      let acked = false;
      const pkt = _buildFilenamePacket(fileName, totalBytes);
      while (errors < MAX_ERRORS) {
        await this.sendRaw(pkt);
        const rb = await this.waitByte(4000, [ACK, NAK, CA, ABORT]);
        if (rb.aborted) { aborted = true; break; }
        if (rb.byte === ACK) {
          // 收端 ACK 后会再发一个 'C'
          acked = true;
          break;
        } else if (rb.byte === CA) {
          throw new Error('BootLoader 中止了会话（文件名包阶段）');
        } else {
          errors++;
        }
      }
      if (aborted) throw new Error('用户中止了 OTA');
      if (!acked) throw new Error('文件名包连续 ' + MAX_ERRORS + ' 次失败');
    }

    // 等待 ACK 后的 'C'（固件：send ACK, send CRC16 → 等待第一个数据包）
    await this._waitForCC(4000);

    // ---- Step 2: 发送所有数据 1KB 分包 ----
    let seq = 1;
    let offs = 0;
    let lastAckTime = 0;
    while (offs < totalBytes) {
      const remain = totalBytes - offs;
      const use1k = remain >= PACKET_1K_SIZE;
      const chunkLen = Math.min(remain, PACKET_1K_SIZE);
      const pkt = _buildPacket(seq & 0xff, fileBuffer, offs, chunkLen, use1k);
      const pktCrc = (pkt[pkt.length - 2] << 8) | pkt[pkt.length - 1];

      let errors = 0;
      let acked = false;
      while (errors < MAX_ERRORS) {
        if (errors > 0) {
          console.warn(`[Ymodem] 重传 seq=${seq} 第${errors}次, CRC=${pktCrc.toString(16)}`);
        }
        const t0 = Date.now();
        await this.sendRaw(pkt);
        const rb = await this.waitByte(8000, [ACK, NAK, CA, ABORT]);
        const dt = Date.now() - t0;
        if (rb.aborted) { aborted = true; break; }
        if (rb.byte === ACK) {
          lastAckTime = Date.now();
          console.log(`[Ymodem] seq=${seq} ACK ✓ CRC=0x${pktCrc.toString(16)} dt=${dt}ms`);
          acked = true; break;
        } else if (rb.byte === NAK) {
          console.warn(`[Ymodem] seq=${seq} NAK ✗ CRC=0x${pktCrc.toString(16)} dt=${dt}ms`);
          errors++;
        } else if (rb.byte === CA) {
          throw new Error('BootLoader 中止了会话（数据包 seq=' + seq + '）');
        } else {
          console.warn(`[Ymodem] seq=${seq} 超时/未知响应 byte=${rb?.byte} dt=${dt}ms`);
          errors++;
        }
      }
      if (aborted) throw new Error('用户中止了 OTA');
      if (!acked) throw new Error('数据包 seq=' + seq + ' 连续 ' + MAX_ERRORS + ' 次失败');

      progressPkt++;
      offs += chunkLen;
      seq++;
      this.progress(Math.floor((offs / totalBytes) * 100), progressPkt, totalDataPkts);
    }

    // ---- Step 3: 发 EOT（1+2 握手，和 ymodem.c 收端行为严格对齐）----
    // EOT 第一次
    {
      let errors = 0;
      let acked = false;
      while (errors < 2) {
        await this.sendRaw(new Uint8Array([EOT]));
        const rb = await this.waitByte(6000, [ACK, NAK]);
        if (rb.byte === ACK) { acked = true; break; }
        errors++;
      }
      if (!acked) throw new Error('EOT 阶段未收到 ACK');
    }

    // ACK 后收端发 'C' 要结束会话空包
    await this._waitForCC(4000);

    // ---- Step 4: 发空文件名包关闭会话 ----
    {
      const pkt = _buildEmptyFilenamePacket();
      let errors = 0;
      let acked = false;
      while (errors < MAX_ERRORS) {
        await this.sendRaw(pkt);
        const rb = await this.waitByte(4000, [ACK, NAK]);
        if (rb.byte === ACK) { acked = true; break; }
        errors++;
      }
      if (!acked) throw new Error('结束会话空包未收到 ACK');
    }

    // ---- Step 5: 最后再发一个 EOT（兼容某些收端）----
    // 注意：当前 BootLoader 的 Ymodem_Receive 在"空文件名包 ACK"后会立即退会话回到菜单，
    //       不会再响应额外的 EOT。因此此处失败只记录警告，不抛异常（空包 ACK 成功即视为完成）。
    {
      let errors = 0;
      let acked = false;
      while (errors < 1) {
        await this.sendRaw(new Uint8Array([EOT]));
        const rb = await this.waitByte(1500, [ACK, NAK]);
        if (rb.byte === ACK) { acked = true; break; }
        errors++;
      }
      if (!acked) {
        console.warn('[Ymodem] 会话关闭 EOT 未收到 ACK（已忽略，主文件已写入 Flash 成功）');
      }
    }

    this.progress(100, progressPkt, totalDataPkts);
    return { ok: true, size: totalBytes, packets: progressPkt };
  }

  // 等待 BootLoader 发出的 'C'（CRC 握手字节），允许中间穿插其他字节（比如菜单文本）
  async _waitForCC(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const left = deadline - Date.now();
      // 每次等最多 800ms，允许穿插非 C 字节
      const rb = await this.waitByte(Math.min(left + 10, 810), [CRC_MODE_REQ, CA, ABORT]);
      if (rb.byte === CRC_MODE_REQ) return true;
      if (rb.byte === ABORT) return false;
      if (rb.byte === CA) return false;
      if (left <= 0) break;
    }
    return false;
  }
}

module.exports = {
  YmodemSender,
  calCRC16,
  YM_CTL: { SOH, STX, EOT, ACK, NAK, CA, CRC: CRC_MODE_REQ, ABORT },
};
