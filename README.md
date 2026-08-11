# OV Watch 微信小程序控制中心

基于 KT6368A BLE 透传模块，通过蓝牙下发 ASCII 指令控制 STM32 手表固件，实现：
- 连接测试 / 读固件版本
- 读取全量传感器数据（日期、时间、温湿度、心率、血氧、步数、背光）
- 背光滑块调节（0~100，写回即保存到 EEPROM）
- 同步手机时间到 RTC
- 进入 OTA 升级模式（跳 BootLoader）
- 实时通讯日志（可滚动查看 TX/RX）

## 一、准备工作

- **硬件**：STM32 手表（KT6368A 模块已上电并广播），安卓或 iPhone 手机一台
- **软件**：[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（稳定版即可）
- **微信小程序账号**：
  - 如果只是自己调试，**可以不注册 AppID**，直接用"测试号"（开发者工具新建项目时选"测试号"）
  - 正式发布需要登录微信公众平台注册小程序并拿到 AppID，替换 `project.config.json` 里的 `appid` 字段

## 二、导入项目

1. 打开微信开发者工具 → **导入项目**
2. **目录**：选本项目所在的 `WatchApp_MiniProgram` 文件夹
3. **AppID**：点"测试号"一键生成（或填你自己的 AppID）
4. **项目名**：随便，比如 `WatchApp`
5. 点确定导入

## 三、真机调试（微信开发者工具的模拟器里没有蓝牙）

BLE 必须真机跑，有两种方式：

### 方式 A：扫码真机调试（推荐首次）

1. 开发者工具顶部点 **"真机调试"**（那个手机+箭头图标）
2. 选择 **"真机调试 2.0"** / 扫码模式
3. 手机微信扫二维码，会直接进入小程序调试态
4. 手机上的所有操作和日志都会实时回传到开发者工具 Console

### 方式 B：预览

1. 开发者工具顶部点 **"预览"**，生成二维码
2. 手机微信扫二维码，直接运行小程序（没有调试台，但可以正常用）

## 四、使用步骤

1. 手机蓝牙先**打开**（微信小程序不强制开定位，但安卓 12+ 首次会弹"附近的设备"权限，允许即可）
2. 打开小程序 → 点顶部 **「扫描 / 连接」**
3. 自动搜索到 `KT6368A-BLE-2.1` 后会自动连接，右上角状态变成"已连接"
4. 控制面板上按钮随便点：
   - **连通测试**：发 `OV` 看是否回 `OK`
   - **读版本**：`OV+VERSION` → `VERSION=Vx.x.x`
   - **刷新全量传感器数据**：发 `VO`，一次拿回 8 项数据
   - **调节背光滑杆**：松手即 `OV+SETLIGHT=N` 写回，立即生效
   - **同步手机时间**：`OV+ST=YYMMDDHHmmss`，取手机当前时间
   - **OTA 升级模式**：会弹二次确认，确认后手表跳 IAP

5. 底部「通讯日志」能看到每一笔 TX/RX 原始内容，方便排错

## 五、文件结构

```
WatchApp_MiniProgram/
├── app.js / app.json / app.wxss      # 全局配置、全局样式、全局UUID常量
├── project.config.json               # 开发者工具项目配置（appid 改成你自己的）
├── sitemap.json
├── pages/
│   └── index/                        # 单页小程序：主页 = 控制面板
│       ├── index.js                  # 页面逻辑
│       ├── index.wxml                # 页面 UI 结构
│       ├── index.wxss                # 页面样式（留空，复用全局）
│       └── index.json                # 页面窗口配置
└── utils/
    ├── bleService.js                 # BLE 核心：扫描/连接/订阅/发送/拼包/降噪/队列
    └── watchProtocol.js              # 协议层：每条指令 Promise 化 + 回传结构化提取
```

## 六、BLE & 协议关键点

### 1. GATT UUID（KT6368A 实测值）

```
Service:        0000FFF0-0000-1000-8000-00805F9B34FB
Write (TX):     0000FFF1-0000-1000-8000-00805F9B34FB   Write No Response
Notify (RX):    0000FFF2-0000-1000-8000-00805F9B34FB   Notify (不是 Indicate)
```

### 2. 发送队列 & 拼包

- 发送是串行化的：前一条指令收到完整回复后才发下一条（队列自动处理）
- Notify 每次最大 ~20 字节，会拆包。`bleService` 内部按 `\r\n` 切完整行再上抛
- `VO` 全量数据回包以 `END` 行为结束标志

### 3. 噪声过滤

KT6368A 模块会不定期广播自身状态 `BLE_STANDBY_IN` / `BLE_STANDBY_OUT`，`bleService` 会自动过滤这些行，不会混进协议响应。

### 4. 指令表（所有按钮对应关系）

| UI 按钮 | 下发指令 | 期待回传关键字 |
|---|---|---|
| 连通测试 | `OV` | `OK` |
| 读版本 | `OV+VERSION` | `VERSION=` |
| 刷新全量数据 | `VO` | 多行 + `END` |
| 读背光 | `OV+GETLIGHT` | `LIGHT=` |
| 调背光（滑杆） | `OV+SETLIGHT=N` | `LIGHT SET=N` / `LIGHT ERR FMT` / `LIGHT ERR RANGE` |
| 同步时间 | `OV+ST=YYMMDDHHmmss` | `TIMESETOK` / `TIME ERR` |
| OTA 升级 | `OV+UPGRADE` | `OK+UPGRADE` |
| 未知指令兜底 | — | `UNKNOWN` |

## 七、常见坑排查

### Q1：点"扫描 / 连接"提示 15 秒没找到设备

1. 确认手表蓝牙模块已上电（KT6368A 指示灯状态）
2. 确认手机蓝牙已开，微信被允许"附近的设备"权限（安卓 12+）
3. 用 nRF Connect 先验证能扫到 `KT6368A-BLE-2.1`
4. 扫不到的话，打开开发者工具 → 详情 → 本地设置 → 勾选"不校验合法域名..."

### Q2：nRF Connect 能连上，小程序连接失败 / Notify 订阅不上

1. 先断开 nRF Connect（BLE 只能单连接），再回小程序点连接
2. 开发者工具右上角 **清缓存 → 全部清除**，退出小程序重进
3. 点右上角三个点 → **重新进入小程序**

### Q3：数据偶尔丢几行，或滑杆值不对

看底部日志区：
- 如果有 `超时` 提示：手机离手表太远（RSSI < -75dBm 容易丢包）
- 如果 `LIGHT ERR RANGE`：固件当前限制 0~100，UI 滑杆也限制 0~100，一般不会遇到

### Q4：时间同步后表盘没变化

- `OV+ST` 成功回复 `TIMESETOK` 就说明 RTC 已写入成功。表盘刷新是 FreeRTOS 里 `ScrRenewTask` 周期更新的，等 1 秒左右就会刷新。
- 如果始终不更新，检查 [user_MessageSendTask.c](file:///d:\Demo\LVGL_project\LVGL_st\My_Watch_App\My_Watch\User\Tasks\Src\user_MessageSendTask.c) 里 `ui_APPSy_EN` 是否为 1（当前代码是 TRUE，日志里 TIMESETOK 已回说明是 TRUE）。

### Q5：想改回带 RecStr 调试回显？

Keil 里打开 `OV_Watch.uvprojx` → 魔术棒 → C/C++ → Define 框里加 `,BLE_DEBUG_ECHO`（前面是逗号，紧跟已有宏后面）→ 重新编译烧录。APP 层不受影响（Noise 过滤里已包含 `RecStr:` 前缀）。

## 八、后续扩展建议

- **数据图表**：`VO` 返回的温湿度、心率、血氧可以每 5 秒轮询一次（页面里加定时器），用 `ec-canvas` 小程序图表组件画趋势线
- **消息推送**：固件端可以加 `OV+NOTIFY=标题|内容` 指令，手表屏幕弹出一个提示框（用现有 `ui_Megboxes` 组件）
- **OTA Ymodem**：`OV+UPGRADE` 跳到 IAP 后，可以继续在小程序里实现 X/Ymodem 协议分包下发 bin 文件（工作量较大，建议先电脑串口 Ymodem 升级）
