'use strict';

// ---------------------------------------------------------------------------
// 服务管理：端口探测 / 等待就绪 / 服务身份确认 / 拉起 / 重启 / 退出清理。
// 通过 install(ctx) 挂载到 ctx.server，供 UI 与 IPC 层调用。
// ---------------------------------------------------------------------------

const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { app, dialog } = require('electron');
const { delay } = require('./utils');
const { PORT } = require('./config');

function install(ctx) {
  const { env } = ctx;

  /** 端口是否可连（任意服务） */
  function isPortOpen(port) {
    return new Promise((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(ok);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(800, () => done(false));
    });
  }

  /** 轮询等待端口就绪 */
  function waitForServer(timeoutMs) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (await isPortOpen(PORT)) return resolve(true);
        if (Date.now() - start > timeoutMs) {
          return reject(new Error(`dsh web 未在 ${Math.round(timeoutMs / 1000)}s 内就绪（端口 ${PORT}）。`));
        }
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  /** 确认端口上的服务是 DSH（HTTP 探测页面特征），防止误复用其他程序端口 */
  function isDshService() {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: PORT, path: '/', timeout: 3_000 },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data.includes('__DSH_BOOT__')));
          res.on('error', () => resolve(false));
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /** 强杀占用指定端口的进程（无论谁拉起的） */
  function killPortProcess(port) {
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const re = new RegExp(':' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i');
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(re);
        if (m && String(m[1]) !== String(process.pid)) pids.add(Number(m[1]));
      }
      for (const pid of pids) {
        try { process.kill(pid); } catch { /* already gone */ }
      }
    } catch { /* 忽略 */ }
  }

  /**
   * 拉起 dsh web 并等待服务就绪；viaNpx 时使用 npx 自动安装路径。
   * nodeDir 非空时（winget 刚装完 Node），将其加入子进程 PATH。
   */
  async function launchServer(dshCmd, viaNpx, nodeDir) {
    // 二次确认：spawn 前再次探测端口，若已有 DSH 服务在运行则直接复用，避免竞态产生多个实例
    if (await isPortOpen(PORT)) {
      if (await isDshService()) {
        ctx.dshProcess = null;
        return true;
      }
      throw new Error(`端口 ${PORT} 已被其他程序占用，且不是 DeepSeek Harness 服务。`);
    }

    let launchCmd;
    let launchArgs;
    if (viaNpx) {
      launchCmd = 'npx';
      launchArgs = ['--yes', '@deepseek-ai/dsh', 'web'];
    } else {
      launchCmd = dshCmd;
      launchArgs = ['web'];
    }
    // 禁止 dsh web 自动打开默认浏览器（GUI 由本应用显示）
    launchArgs.push('--no-open');
    if (PORT !== 3080) launchArgs.push('--port', String(PORT));

    const env = { ...process.env };
    if (nodeDir) {
      env.PATH = nodeDir + path.delimiter + (env.PATH || '');
    }

    ctx.dshProcess = spawn(launchCmd, launchArgs, {
      windowsHide: true,
      shell: true,
      stdio: 'ignore',
      env,
    });

    ctx.dshProcess.on('exit', (code) => {
      ctx.dshProcess = null;
      if (ctx.isQuitting || ctx.isRestarting) return;
      // 延迟确认：进程退出后若端口仍通，说明是其他实例在提供服务（端口被占而退出），并非故障，不弹窗
      setTimeout(async () => {
        if (ctx.isQuitting || ctx.isRestarting) return;
        if (await isPortOpen(PORT)) return;
        dialog.showErrorBox(
          'dsh web 已退出',
          `服务器进程意外退出（code=${code}）。请重新打开应用。`
        );
      }, 1_500);
    });

    const { SERVER_START_TIMEOUT_MS, NPX_START_TIMEOUT_MS } = require('./config');
    const timeout = viaNpx ? NPX_START_TIMEOUT_MS : SERVER_START_TIMEOUT_MS;
    return waitForServer(timeout);
  }

  /** 托盘「退出」：无条件停止服务再退出（不管服务是谁拉起的） */
  function quitWithServiceStop() {
    ctx.isQuitting = true;
    try {
      if (ctx.dshProcess && !ctx.dshProcess.killed) {
        try { ctx.dshProcess.kill(); } catch { /* already gone */ }
      }
      killPortProcess(PORT);
    } catch { /* 清理失败不阻塞退出 */ }
    app.quit();
  }

  /** 仅停止服务（窗口保留）：杀掉占用端口的进程 */
  function stopServiceOnly() {
    try {
      if (ctx.dshProcess && !ctx.dshProcess.killed) {
        try { ctx.dshProcess.kill(); } catch { /* already gone */ }
      }
      killPortProcess(PORT);
    } catch { /* 忽略 */ }
  }

  /** 重启 dsh 服务：杀掉当前服务 → 重新拉起 → 返回是否成功（不退出窗口） */
  async function restartService() {
    ctx.isRestarting = true;
    try {
      if (ctx.dshProcess && !ctx.dshProcess.killed) {
        try { ctx.dshProcess.kill(); } catch { /* ignore */ }
      }
      killPortProcess(PORT);
      await delay(1500);
      const dshCmd = env.findDshCommand();
      if (dshCmd && dshCmd !== 'npx') {
        await launchServer(dshCmd, false, null);
      } else {
        await launchServer(null, true, null);
      }
      // 刷新 Harness iframe（跨源 iframe 不能用 reload()，通过重置 src 强制重载）
      setTimeout(() => {
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents
            .executeJavaScript(
              "(function(){var f=document.getElementById('frame-harness');if(!f)return false;var s=f.getAttribute('src')||f.src;f.removeAttribute('src');f.setAttribute('src',s);return true;})()"
            )
            .catch(() => {});
        }
      }, 800);
      return true;
    } catch (e) {
      return e.message || '重启失败';
    } finally {
      ctx.isRestarting = false;
    }
  }

  ctx.server = {
    port: PORT,
    isPortOpen,
    waitForServer,
    isDshService,
    killPortProcess,
    launchServer,
    quitWithServiceStop,
    stopServiceOnly,
    restartService,
  };
}

module.exports = { install };
