// app.js
App({
  onLaunch() {
    // 启动时检查蓝牙适配器是否可用；Windows 模拟器会报"暂不支持"，直接忽略不打日志
    wx.openBluetoothAdapter({
      success: () => {
        // 真机可用时静默，避免启动日志噪音
      },
      fail: () => {
        // 启动时的失败不影响：点"扫描/连接"按钮时 bleService 内部会再尝试一次 open + close 兜底
      }
    });
  },

  globalData: {
    // KT6368A 透传服务 UUID（nRF Connect 实测得出）
    SERVICE_UUID: '0000FFF0-0000-1000-8000-00805F9B34FB',
    // 写特征值（下发指令）
    WRITE_CHAR_UUID: '0000FFF1-0000-1000-8000-00805F9B34FB',
    // 通知特征值（接收回传）
    NOTIFY_CHAR_UUID: '0000FFF2-0000-1000-8000-00805F9B34FB'
  }
});
