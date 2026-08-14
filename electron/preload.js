'use strict';

/**
 * 主窗口 preload：向页面暴露窗口控制接口（自绘标题栏按钮使用）。
 * 页面通过 window.dshWin.minimize() / toggleMaximize() / close() 控制窗口。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshWin', {
  minimize: () => ipcRenderer.send('dsh:win-control', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('dsh:win-control', 'toggle-maximize'),
  close: () => ipcRenderer.send('dsh:win-control', 'close'),
});
