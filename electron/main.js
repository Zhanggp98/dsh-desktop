'use strict';

// ---------------------------------------------------------------------------
// DeepSeek Harness 桌面客户端 — 主进程入口
// ---------------------------------------------------------------------------
// 职责：装配各功能模块（lib/*）到共享上下文 ctx，处理应用生命周期。
// 业务逻辑按层拆分：
//   lib/env.js        环境检测（node/dsh/winget）
//   lib/server.js     服务管理（端口/启动/重启/退出）
//   lib/theme.js      主题解析与同步
//   lib/splash.js     启动画面
//   lib/window.js     主窗口与关闭选择
//   lib/tray.js       托盘
//   lib/wallpaper.js  壳窗口背景同步
//   lib/update.js     版本检查
//   lib/boot.js       启动流程编排
//   lib/managers/*    插件/MCP/Skills 数据层 + IPC
//   lib/ipc.js        IPC 注册中心
// ---------------------------------------------------------------------------

const { app } = require('electron');
const { ctx } = require('./lib/context');

// 开发/便携模式：自定义用户数据目录（避免写入 %APPDATA%）
if (process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USER_DATA);
}

// 装配各功能模块（顺序即依赖顺序；managers 的 IPC 由 lib/ipc.js 统一注册）
require('./lib/env').install(ctx);
require('./lib/server').install(ctx);
require('./lib/theme').install(ctx);
require('./lib/splash').install(ctx);
require('./lib/wallpaper').install(ctx);
require('./lib/update').install(ctx);
require('./lib/window').install(ctx);
require('./lib/tray').install(ctx);
require('./lib/ipc').registerAll(ctx);
require('./lib/boot').install(ctx);

// ---------------------------------------------------------------------------
// 应用生命周期：单实例锁 + ready 启动 + 退出清理
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (ctx.mainWindow) {
      ctx.mainWindow.show();
      ctx.mainWindow.focus();
    }
  });

  app.whenReady().then(ctx.boot);

  app.on('window-all-closed', () => {
    // 不退出：托盘常驻，任务可后台运行
  });

  app.on('before-quit', () => {
    ctx.isQuitting = true;
  });

  app.on('will-quit', () => {
    // 只清理"由本应用拉起"的 dsh 进程；若复用了外部已运行的实例则不动
    if (ctx.dshProcess && !ctx.dshProcess.killed) {
      try {
        ctx.dshProcess.kill();
      } catch { /* already gone */ }
    }
  });
}
