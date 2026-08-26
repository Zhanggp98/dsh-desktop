'use strict';

// ---------------------------------------------------------------------------
// 版本检查：对比内置 dsh 版本（本地）与 npm 上 @deepseek-ai/dsh 最新版本。
// 内置 dsh 后：本地版本 = 客户端 package.json 版本（打包时已与内置 dsh 对齐）。
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');

// 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0
// 支持 x.y.z 与预发布后缀（如 0.1.1-rc.2）
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v || '').trim().replace(/^v/i, '');
    const [core, pre] = s.split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre || '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  // 核心版本相同：无预发布 > 有预发布；预发布按字符串比较
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // 稳定版 > 预发布
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

function install(ctx) {
  async function getLocalDshVersion() {
    try {
      const dshCmd = await ctx.env.findDshCommand();
      if (!dshCmd) return null;
      // 内置 bin.js：.../dsh/node_modules/@deepseek-ai/dsh/lib/bin.js → dirname 上一级即包目录
      // .cmd：node_modules/.bin/dsh.cmd → 上级的 ../@deepseek-ai/dsh
      const pkgDir = String(dshCmd).endsWith('bin.js')
        ? path.join(path.dirname(dshCmd), '..')
        : path.join(path.dirname(dshCmd), '..', '@deepseek-ai', 'dsh');
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      return pkg.version || null;
    } catch {
      return null;
    }
  }

  async function checkForUpdates() {
    try {
      const local = await getLocalDshVersion();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch('https://registry.npmmirror.com/@deepseek-ai/dsh/latest', {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const remote = data.version || null;
      // 语义化比较：仅当远程版本严格大于本地版本才算有更新
      const hasUpdate = !!local && !!remote && compareVersions(remote, local) > 0;
      return {
        local, // 当前内置 dsh 版本
        remote, // npm 最新版本
        hasUpdate,
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
