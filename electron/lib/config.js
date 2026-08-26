'use strict';

// ---------------------------------------------------------------------------
// 常量配置：URL / 端口 / 超时 / 图标 / 核心 bundle 清单。
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');

const HARNESS_URL = process.env.DSH_DESKTOP_URL || 'http://localhost:3080';
const PORT = Number(new URL(HARNESS_URL).port) || 3080;
const SERVER_START_TIMEOUT_MS = 30_000; // 直接启动 dsh 的等待上限
const NPX_START_TIMEOUT_MS = 600_000; // 首次 npx 下载安装的等待上限（约 194MB 依赖，给足时间）
const SPLASH_MIN_MS = 3_000; // splash 最短展示时间（保证过渡动画可见）

// 应用图标（base64 data URL，用于自定义标题栏）
const APP_ICON_DATA_URL = (() => {
  try {
    const p = path.join(__dirname, '..', '..', 'build', 'icon.png');
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch {
    return '';
  }
})();

// 核心 bundle（系统自带，非第三方插件）
const CORE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
];

// MCP 客户端 bundle 名（DSH 标准）
const MCP_CLIENT_BUNDLE = '@deepseek-ai/dsh-mcp-client';

module.exports = {
  HARNESS_URL,
  PORT,
  SERVER_START_TIMEOUT_MS,
  NPX_START_TIMEOUT_MS,
  SPLASH_MIN_MS,
  APP_ICON_DATA_URL,
  CORE_BUNDLES,
  MCP_CLIENT_BUNDLE,
};
