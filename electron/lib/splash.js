'use strict';

// ---------------------------------------------------------------------------
// 启动画面：创建 splash 窗口、更新状态文字。纯 UI，逻辑由 boot 编排。
// ---------------------------------------------------------------------------

const path = require('path');
const { BrowserWindow, app } = require('electron');

function install(ctx) {
  function createSplash() {
    ctx.splashWindow = new BrowserWindow({
      width: 400,
      height: 440,
      frame: false,
      resizable: false,
      movable: true,
      show: false,
      alwaysOnTop: true,
      backgroundColor: '#0a1120',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    ctx.splashWindow.loadFile(path.join(__dirname, '..', 'splash.html'));
    ctx.splashWindow.webContents.on('did-finish-load', () => {
      // 注入版本号（与内置 dsh 版本对齐，来自 package.json）
      ctx.splashWindow.webContents
        .executeJavaScript(`window.__setVersion(${JSON.stringify(app.getVersion())})`)
        .catch(() => {});
    });
    ctx.splashWindow.once('ready-to-show', () => {
      ctx.theme.applyTheme();
      ctx.splashWindow.show();
    });
    ctx.splashWindow.on('closed', () => {
      ctx.splashWindow = null;
    });
  }

  /** 更新启动画面单行状态文字 */
  function setStatus(text) {
    if (ctx.splashWindow && !ctx.splashWindow.isDestroyed()) {
      ctx.splashWindow.webContents
        .executeJavaScript(`window.__setStatus(${JSON.stringify(text)})`)
        .catch(() => {});
    }
  }

  ctx.splash = { createSplash, setStatus };
}

module.exports = { install };
