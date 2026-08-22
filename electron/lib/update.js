'use strict';

// ---------------------------------------------------------------------------
// 版本检查：对比 npm 上 @deepseek-ai/dsh 最新版本与本地已装版本。
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');

function install(ctx) {
  function getLocalDshVersion() {
    try {
      const dshCmd = ctx.env.findDshCommand();
      if (!dshCmd) return null;
      // dsh.cmd 位于 node_modules/.bin/，包在 node_modules/@deepseek-ai/dsh/
      const pkgPath = path.join(path.dirname(dshCmd), '..', '@deepseek-ai', 'dsh', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.version || null;
    } catch {
      return null;
    }
  }

  async function checkForUpdates() {
    try {
      const local = getLocalDshVersion();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch('https://registry.npmmirror.com/@deepseek-ai/dsh/latest', {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const remote = data.version || null;
      return {
        local,
        remote,
        hasUpdate: !!local && !!remote && local !== remote,
      };
    } catch (e) {
      return { error: e.message || '检查失败' };
    }
  }

  /** 启动完成后自动检查一次（不阻塞），有更新则推送前端提示 */
  function autoCheck() {
    setTimeout(async () => {
      const result = await checkForUpdates();
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('dsh:update-result', result);
      }
    }, 4_000);
  }

  ipcMain.handle('dsh:check-update', async () => checkForUpdates());

  ctx.update = { checkForUpdates, autoCheck };
}

module.exports = { install };
