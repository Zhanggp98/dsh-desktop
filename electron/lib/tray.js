'use strict';

// ---------------------------------------------------------------------------
// 托盘：创建托盘图标与菜单。菜单动作委托 ctx.window / ctx.server。
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { Tray, Menu, nativeImage, app } = require('electron');

function install(ctx) {
  function createTray() {
    let iconPath = path.join(__dirname, '..', '..', 'build', 'tray.png');
    if (!fs.existsSync(iconPath)) iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
    const img = nativeImage.createFromPath(iconPath);
    ctx.tray = new Tray(img);
    ctx.tray.setToolTip('DeepSeek Harness');
    ctx.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '打开主窗口',
          click: () => {
            if (ctx.mainWindow) {
              ctx.mainWindow.show();
              ctx.mainWindow.focus();
            } else {
              ctx.window.createWindow();
            }
          },
        },
        { type: 'separator' },
        {
          label: '停止服务并退出',
          click: ctx.server.quitWithServiceStop,
        },
        {
          label: '退出',
          click: () => {
            ctx.isQuitting = true;
            app.quit();
          },
        },
      ])
    );
    ctx.tray.on('double-click', () => {
      if (ctx.mainWindow) {
        ctx.mainWindow.show();
        ctx.mainWindow.focus();
      } else {
        ctx.window.createWindow();
      }
    });
  }

  ctx.trayCtrl = { createTray };
}

module.exports = { install };
