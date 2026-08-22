'use strict';

// ---------------------------------------------------------------------------
// 共享上下文：主进程各模块通过 ctx 交换窗口/托盘/进程引用与运行状态。
// 模块间不直接互相 require，统一经 ctx 访问，避免循环依赖、降低耦合。
// ---------------------------------------------------------------------------

const path = require('path');

const ctx = {
  // 窗口与托盘引用
  mainWindow: null,
  splashWindow: null,
  tray: null,
  // dsh web 子进程（本应用拉起的服务）
  dshProcess: null,
  // 运行状态
  isQuitting: false,
  isRestarting: false,
  currentNavPage: 'harness',
  // 模块注册表：由 lib/ipc.js 装配时挂载各业务模块
  env: null,
  server: null,
  theme: null,
  splash: null,
  window: null,
  trayCtrl: null,
  wallpaper: null,
  update: null,
  managers: null,
};

/** 模块目录（lib/），供各模块解析相对路径资源 */
ctx.libDir = __dirname;

/** 应用根目录（electron/ 的上级） */
ctx.appRoot = path.join(__dirname, '..');

module.exports = { ctx };
