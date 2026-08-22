'use strict';

// ---------------------------------------------------------------------------
// 主窗口：创建壳窗口、关闭选择框处理、窗口控制 IPC。
// UI 层：只负责窗口生命周期与事件转发，业务动作委托 ctx.server。
// ---------------------------------------------------------------------------

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

function install(ctx) {
  /** 创建主窗口（壳页面 = 标题栏 + 左侧导航栏 + 内容 iframe） */
  function createWindow() {
    const isDark = ctx.theme.resolveTheme() === 'dark';
    ctx.mainWindow = new BrowserWindow({
      width: 1640,
      height: 960,
      minWidth: 900,
      minHeight: 600,
      icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
      backgroundColor: isDark ? '#111318' : '#f8fafc',
      autoHideMenuBar: true,
      title: 'DeepSeek Harness',
      show: false,
      frame: false, // 完全自绘边框
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, '..', 'preload.js'),
      },
    });

    ctx.mainWindow.once('ready-to-show', () => ctx.mainWindow.show());
    ctx.mainWindow.loadFile(path.join(__dirname, '..', 'nav.html'));
    // 壳页面加载完成后立即推送初始主题；等 Harness iframe 加载完成做初始壁纸同步
    ctx.mainWindow.webContents.on('did-finish-load', () => {
      ctx.theme.applyTheme();
      setTimeout(ctx.wallpaper.sync, 1_500);
    });

    // Harness iframe 每次加载完成后重新注入 body 变化监听（observer 随页面销毁）
    ctx.mainWindow.webContents.on('did-frame-finish-load', (e, isMainFrame) => {
      if (!isMainFrame) {
        setTimeout(ctx.wallpaper.ensureObserver, 300);
      }
    });

    // 关闭按钮：弹出应用内选择框（勾选 关闭窗口/关闭服务）
    ctx.mainWindow.on('close', (e) => {
      if (!ctx.isQuitting) {
        e.preventDefault();
        ctx.mainWindow.webContents.send('dsh:close-choice', {});
      }
    });

    ctx.mainWindow.on('closed', () => {
      ctx.mainWindow = null;
    });
  }

  /** 执行关闭选择：'tray' / 'quit' / 'stop-only' / 'quit-stop' */
  function executeCloseChoice(choice) {
    if (!ctx.mainWindow) return;
    if (choice === 'tray') {
      ctx.mainWindow.hide();
      if (ctx.tray && typeof ctx.tray.displayBalloon === 'function') {
        ctx.tray.displayBalloon({
          title: 'DeepSeek Harness',
          content: '已最小化到托盘，任务仍在后台运行。右键托盘图标可退出。',
        });
      }
    } else if (choice === 'quit-stop') {
      ctx.server.quitWithServiceStop();
    } else if (choice === 'quit') {
      ctx.isQuitting = true;
      require('electron').app.quit();
    } else if (choice === 'stop-only') {
      ctx.server.stopServiceOnly();
    }
  }

  // 自绘标题栏窗口按钮（preload 转发）
  ipcMain.on('dsh:win-control', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
  });

  // 关闭选择框回执：{ choice } —— 由渲染进程选择后回传执行
  ipcMain.on('dsh:close-choice-respond', (event, payload) => {
    if (!ctx.mainWindow) return;
    executeCloseChoice(payload && payload.choice);
  });

  ctx.window = { createWindow, executeCloseChoice };
}

module.exports = { install };
