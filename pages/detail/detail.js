// pages/detail/detail.js — OV Watch 健康数据详情页
const hrStore = require('../../utils/hrStore.js');

// 指标配置
const FEATURE_CONFIG = {
  heartRate: {
    title: '心率',
    subtitle: '心脏跳动频率',
    icon: '❤️',
    unit: 'BPM',
    color: '#e6453b',
    min: 40,
    max: 180,
  },
  spo2: {
    title: '血氧',
    subtitle: '血液中氧气含量',
    icon: '🫁',
    unit: '%',
    color: '#2563eb',
    min: 90,
    max: 100,
  },
  steps: {
    title: '步数',
    subtitle: '今日行走步数',
    icon: '👟',
    unit: '步',
    color: '#16a34a',
    min: 0,
    max: 10000,
  },
  sleep: {
    title: '睡眠',
    subtitle: '夜间睡眠时长',
    icon: '😴',
    unit: '小时',
    color: '#7c3aed',
    min: 0,
    max: 12,
  },
  temperature: {
    title: '温度',
    subtitle: '环境温度',
    icon: '🌡️',
    unit: '°C',
    color: '#ea580c',
    min: 0,
    max: 50,
  },
  humidity: {
    title: '湿度',
    subtitle: '环境湿度',
    icon: '💧',
    unit: '%',
    color: '#0891b2',
    min: 0,
    max: 100,
  },
};

Page({
  data: {
    feature: 'heartRate',
    title: '',
    subtitle: '',
    icon: '',
    unit: '',
    color: '',
    min: 0,
    max: 100,

    currentValue: '--',
    historyList: [],
    stats: {
      avg: '--',
      min: '--',
      max: '--',
      count: 0,
    },
    dateRange: '',
  },

  onLoad(options) {
    const feature = options.feature || 'heartRate';
    const config = FEATURE_CONFIG[feature] || FEATURE_CONFIG.heartRate;
    
    this.setData({
      feature,
      title: config.title,
      subtitle: config.subtitle,
      icon: config.icon,
      unit: config.unit,
      color: config.color,
      min: config.min,
      max: config.max,
    });

    // 设置导航栏标题
    wx.setNavigationBarTitle({ title: config.title });

    this._loadData();
  },

  onShow() {
    if (this.data._loaded) {
      this._loadData();
    }
  },

  _loadData() {
    this._loaded = true;
    const feature = this.data.feature;
    const config = FEATURE_CONFIG[feature];

    // 从云端加载数据
    hrStore.listSamples(50)
      .then((list) => {
        // 模拟数据（因为只有心率的采样，其他指标需要后续扩展）
        // 为了演示，我们使用心率数据，并根据 feature 转换
        const processedList = this._processData(list, feature);
        
        const historyList = processedList.map((item) => ({
          ts: item.ts,
          value: item.value,
          timeText: this._formatTime(item.ts),
        }));

        // 计算统计
        const values = historyList.map(i => i.value).filter(v => typeof v === 'number' && !isNaN(v));
        let avg = '--', min = '--', max = '--';
        if (values.length > 0) {
          avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
          min = Math.min(...values);
          max = Math.max(...values);
        }

        // 当前值 = 最新一条
        const currentValue = historyList.length > 0 ? historyList[0].value : '--';

        // 日期范围
        let dateRange = '';
        if (historyList.length >= 2) {
          const first = new Date(historyList[historyList.length - 1].ts);
          const last = new Date(historyList[0].ts);
          dateRange = `${this._formatShortDate(first)} - ${this._formatShortDate(last)}`;
        } else if (historyList.length === 1) {
          dateRange = this._formatShortDate(new Date(historyList[0].ts));
        }

        this.setData({
          currentValue,
          historyList,
          stats: {
            avg,
            min,
            max,
            count: historyList.length,
          },
          dateRange,
        });

        // 绘制图表
        this._drawChart(processedList);
      })
      .catch((err) => {
        console.error('加载历史数据失败', err);
        // 如果加载失败，尝试绘制空图表
        this.setData({
          currentValue: '--',
          historyList: [],
          stats: { avg: '--', min: '--', max: '--', count: 0 },
        });
        this._drawChart([]);
      });
  },

  // 数据转换逻辑（目前仅心率有真实数据，其他指标生成模拟数据）
  _processData(list, feature) {
    if (feature === 'heartRate') {
      return list.map(item => ({
        ts: item.ts,
        value: item.hr,
      }));
    }

    // 其他指标：生成模拟数据（基于时间戳的随机值）
    // TODO: 后续扩展真实传感器数据的存储和读取
    return list.map(item => ({
      ts: item.ts,
      value: this._generateMockData(feature, item.ts),
    }));
  },

  // 生成模拟数据（演示用）
  _generateMockData(feature, ts) {
    const seed = ts % 1000;
    const config = FEATURE_CONFIG[feature];
    const range = config.max - config.min;
    
    switch (feature) {
      case 'spo2':
        return Math.round(95 + (seed % 5)); // 95-100
      case 'steps':
        return Math.round(3000 + (seed * 10) % 5000);
      case 'sleep':
        return parseFloat((5 + (seed % 40) / 10).toFixed(1));
      case 'temperature':
        return parseFloat((24 + (seed % 20) / 10).toFixed(1));
      case 'humidity':
        return Math.round(50 + (seed % 40));
      default:
        return config.min + (seed % range);
    }
  },

  // ===================== 时间格式化 =====================
  _formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  _formatShortDate(date) {
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  },

  // ===================== 绘制图表 =====================
  _drawChart(data) {
    if (!this._canvasReady) {
      this._initCanvas(() => this._drawChart(data));
      return;
    }

    const ctx = this._ctx;
    const W = this._cw;
    const H = this._ch;
    const dpr = this._dpr;
    const config = FEATURE_CONFIG[this.data.feature];

    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const padL = 50, padR = 20, padT = 20, padB = 40;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // 绘制网格
    ctx.strokeStyle = '#f0f0f0';
    ctx.lineWidth = 1;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#999';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const Y_MIN = this.data.min;
    const Y_MAX = this.data.max;
    const Y_STEPS = 5;
    
    for (let i = 0; i <= Y_STEPS; i++) {
      const y = padT + (plotH / Y_STEPS) * i;
      const val = Y_MAX - ((Y_MAX - Y_MIN) / Y_STEPS) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillText(val.toFixed(0), padL - 8, y);
    }

    if (data.length === 0) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ccc';
      ctx.font = '12px sans-serif';
      ctx.fillText('暂无数据', W / 2, H / 2);
      return;
    }

    // 绘制折线
    const n = data.length;
    const sortedData = data.slice().reverse(); // 正序

    const points = sortedData.map((s, i) => {
      const x = padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
      const val = Math.max(Y_MIN, Math.min(Y_MAX, s.value));
      const y = padT + plotH - ((val - Y_MIN) / (Y_MAX - Y_MIN)) * plotH;
      return { x, y, s };
    });

    // 填充区域
    const gradient = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    gradient.addColorStop(0, this._hexToRgba(config.color, 0.2));
    gradient.addColorStop(1, this._hexToRgba(config.color, 0));

    ctx.beginPath();
    ctx.moveTo(points[0].x, padT + plotH);
    for (const p of points) {
      ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(points[points.length - 1].x, padT + plotH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 绘制线条
    ctx.strokeStyle = config.color;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // 绘制数据点
    for (const p of points) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = config.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // X轴时间标签
    ctx.fillStyle = '#999';
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, n);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.round((n - 1) * (i / (labelCount - 1 || 1)));
      const p = points[idx];
      const d = new Date(p.s.ts);
      const timeStr = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
      ctx.fillText(timeStr, p.x, padT + plotH + 20);
    }
  },

  _initCanvas(cb) {
    const query = wx.createSelectorQuery();
    query.select('#trendChart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const dpr = wx.getSystemInfoSync().pixelRatio || 1;
      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      const ctx = canvas.getContext('2d');
      this._ctx = ctx;
      this._cw = res[0].width;
      this._ch = res[0].height;
      this._dpr = dpr;
      this._canvasReady = true;
      cb && cb();
    });
  },

  // 辅助：16进制颜色转 rgba
  _hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  },
});
