'use strict';

/**
 * 壳页面（标题栏 + 导航栏）preload：
 *  - window.dshWin   自绘标题栏窗口按钮（minimize / toggleMaximize / close）
 *  - window.dshNav   导航切换（select）与主题跟随（onTheme）
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshWin', {
  minimize: () => ipcRenderer.send('dsh:win-control', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('dsh:win-control', 'toggle-maximize'),
  close: () => ipcRenderer.send('dsh:win-control', 'close'),
});

contextBridge.exposeInMainWorld('dshNav', {
  select: (page) => ipcRenderer.send('dsh:nav-select', page),
  getHarnessUrl: () => ipcRenderer.invoke('dsh:get-harness-url'),
  getData: () => ipcRenderer.invoke('dsh:get-data'),
  pluginRemove: (id) => ipcRenderer.invoke('dsh:plugin-remove', id),
  pluginInstall: (name) => ipcRenderer.invoke('dsh:plugin-install', name),
  skillInstall: () => ipcRenderer.invoke('dsh:skill-install'),
  skillUninstall: (path) => ipcRenderer.invoke('dsh:skill-uninstall', path),
  restartService: () => ipcRenderer.invoke('dsh:restart-service'),
  checkUpdate: () => ipcRenderer.invoke('dsh:check-update'),
  onUpdateResult: (cb) => {
    ipcRenderer.on('dsh:update-result', (e, result) => cb(result));
  },
  onWallpaper: (cb) => {
    ipcRenderer.on('dsh:wallpaper', (e, w) => cb(w));
  },
  onTheme: (cb) => {
    ipcRenderer.on('dsh:theme', (e, theme) => cb(theme));
  },
});
