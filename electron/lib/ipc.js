'use strict';

// ---------------------------------------------------------------------------
// IPC 注册中心：装配各业务模块（managers）与壳层通用 IPC（数据分发/导航/服务重启）。
// managers 各自注册自己的 IPC；这里统一调用，集中管理注册时序。
// ---------------------------------------------------------------------------

const { ipcMain } = require('electron');
const { HARNESS_URL } = require('./config');
const plugins = require('./managers/plugins');
const mcp = require('./managers/mcp');
const skills = require('./managers/skills');

function registerAll(ctx) {
  // 各业务模块注册自己的 IPC
  plugins.install(ctx);
  mcp.install(ctx);
  skills.install(ctx);

  // 管理页数据分发：按当前导航页返回对应列表
  ipcMain.handle('dsh:get-data', async () => {
    if (ctx.currentNavPage === 'plugins') return plugins.listPlugins();
    if (ctx.currentNavPage === 'mcp') return mcp.listMcpServers();
    if (ctx.currentNavPage === 'skills') return skills.listSkills();
    return [];
  });

  // 导航切换（壳页面 preload 转发）
  ipcMain.on('dsh:nav-select', (event, page) => {
    ctx.currentNavPage = page;
  });

  // 管理页：当前导航页 + Harness 地址
  ipcMain.handle('dsh:get-page', () => ctx.currentNavPage);
  ipcMain.handle('dsh:get-harness-url', () => HARNESS_URL);

  // 重启 dsh 服务（不退出窗口）
  ipcMain.handle('dsh:restart-service', async () => {
    return ctx.server.restartService();
  });
}

module.exports = { registerAll };
