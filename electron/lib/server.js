'use strict';

// ---------------------------------------------------------------------------
// 服务管理：端口探测 / 等待就绪 / 服务身份确认 / 拉起 / 重启 / 退出清理。
// 通过 install(ctx) 挂载到 ctx.server，供 UI 与 IPC 层调用。
// ---------------------------------------------------------------------------

const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { app, dialog } = require('electron');
const { delay, dirSize } = require('./utils');
const { PORT } = require('./config');

/** 多编码解码：UTF-8 优先，失败回退 GBK（中文 Windows 的 stderr 常为 GBK） */
function decodeAny(buf) {
  try {
    const s = buf.toString('utf8');
    if (!s.includes('\uFFFD')) return s; // 无替换符 → 有效 UTF-8
  } catch { /* 忽略 */ }
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

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
   * onProgress 可选：下载/安装期间收到进度文本回调（用于 splash 展示）。
   */
  async function launchServer(dshCmd, viaNpx, nodeDir, onProgress) {
    // 二次确认：spawn 前再次探测端口，若已有 DSH 服务在运行则直接复用，避免竞态产生多个实例
    if (await isPortOpen(PORT)) {
      if (await isDshService()) {
        ctx.dshProcess = null;
        return true;
      }
      throw new Error(`端口 ${PORT} 已被其他程序占用，且不是 DeepSeek Harness 服务。`);
    }

    const progress = onProgress || (() => {});
    let launchCmd;
    let launchArgs;
    if (viaNpx) {
      launchCmd = 'npx';
      launchArgs = ['--yes', '@deepseek-ai/dsh', 'web'];
    } else if (String(dshCmd).endsWith('bin.js')) {
      // 内置 dsh（bin.js）：用内置 node 直接运行，零下载、零 npm 解析
      // 优先 nodeDir（boot 检测到的内置/系统 node），否则回退 resources/node
      let nodeExe = nodeDir ? path.join(nodeDir, 'node.exe') : null;
      if (!nodeExe || !fs.existsSync(nodeExe)) {
        const bundled = path.join(process.resourcesPath || '', 'node', 'node.exe');
        nodeExe = fs.existsSync(bundled) ? bundled : 'node';
      }
      launchCmd = nodeExe;
      launchArgs = [dshCmd, 'web'];
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
    // 强制 npm/npx 走国内镜像源，避免官方源慢导致首次下载 dsh 卡很久
    // （用户可通过 DSH_DESKTOP_NPM_REGISTRY 覆盖）
    if (!env.npm_config_registry) {
      env.npm_config_registry = process.env.DSH_DESKTOP_NPM_REGISTRY || 'https://registry.npmmirror.com';
    }
    // 持久缓存目录：首次下载后缓存保留，下次启动走缓存秒开（避免重复下载 194MB）
    // 缓存放在用户数据目录下，随安装持久化
    const npmCache = path.join(app.getPath('userData'), 'npm-cache');
    if (!env.npm_config_cache) {
      env.npm_config_cache = npmCache;
    }
    // npm 输出：非 TTY 下无进度条，用 info 日志解析依赖获取进度
    if (!env.npm_config_loglevel) {
      env.npm_config_loglevel = 'info';
    }

    // spawn 方式区分：
    //  - npx（.cmd）：必须 shell:true，否则 Windows 报 spawn EINVAL
    //  - 内置 node.exe：用 shell:false，避免 shell 拼接导致含空格路径（如 ...\DeepSeek Harness\...）被拆断
    const isNpxSpawn = viaNpx || String(launchCmd).toLowerCase() === 'npx' || String(launchCmd).endsWith('.cmd');
    ctx.logger.log('info', 'server: spawn 服务', { cmd: launchCmd, args: launchArgs, shell: isNpxSpawn });
    ctx.dshProcess = spawn(launchCmd, launchArgs, {
      windowsHide: true,
      shell: isNpxSpawn,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    // 捕获 dsh 启动阶段的 stderr，失败时用于展示真实原因。
    // 注意：中文 Windows 下 dsh 的 stderr 可能是 GBK 编码，不能假设 UTF-8。
    let bootStderrBuf = [];
    let bootStderr = '';
    if (ctx.dshProcess.stderr) {
      ctx.dshProcess.stderr.on('data', (c) => {
        bootStderrBuf.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
        const combined = Buffer.concat(bootStderrBuf.slice(-8));
        bootStderr = decodeAny(combined).slice(-4000);
      });
    }

    // 解析 npm/npx stderr，转发下载/安装进度；同时统计缓存目录大小显示字节级进度
    if (ctx.dshProcess.stderr) {
      let lastProgress = '';
      let lastCacheMB = -1;
      ctx.dshProcess.stderr.setEncoding('utf8');
      ctx.dshProcess.stderr.on('data', (chunk) => {
        const text = String(chunk || '');
        let line = '';
        for (const l of text.split(/\r?\n/)) {
          const t = l.trim();
          if (!t) continue;
          if (/added \d+ packages/i.test(t)) {
            line = t;
          } else if (/reify|idealTree|loadAllDeps/i.test(t)) {
            line = '正在解析依赖…';
          } else if (/up to date|found 0 vulnerabilities/i.test(t)) {
            line = '依赖就绪，正在启动服务…';
          }
        }
        if (line && line !== lastProgress) {
          lastProgress = line;
          progress(line);
        }
      });
      // 字节级进度：统计 npm 缓存目录增长（完整依赖约 194MB）
      const cacheDir = env.npm_config_cache;
      const reportCache = () => {
        try {
          if (!cacheDir || !fs.existsSync(cacheDir)) return;
          const mb = Math.round(dirSize(cacheDir) / (1024 * 1024));
          if (mb !== lastCacheMB) {
            lastCacheMB = mb;
            progress(`正在下载依赖组件… 已下载约 ${mb} MB / 194MB`);
          }
        } catch { /* 目录未就绪 */ }
      };
      const cacheTimer = setInterval(reportCache, 800);
      ctx.dshProcess.once('exit', () => clearInterval(cacheTimer));
      setTimeout(reportCache, 1_000);
    }

    // 服务是否已就绪（waitForServer 成功后置 true）。
    // npx 下载/解析完成后，cmd/npx 壳进程会退出（code=0/1），但 dsh 服务已交接继续运行；
    // 只有"服务就绪后"进程退出才是真正的意外崩溃。
    let serviceReady = false;
    ctx.dshProcess.on('spawn', () => {
      ctx.logger.log('info', 'server: 进程已 spawn');
    });
    ctx.dshProcess.on('error', (err) => {
      ctx.logger.log('error', 'server: spawn 失败', err.message);
    });
    ctx.dshProcess.on('exit', (code) => {
      ctx.logger.log('info', 'server: 进程退出', { code, serviceReady, isQuitting: ctx.isQuitting, isRestarting: ctx.isRestarting });
      ctx.dshProcess = null;
      if (ctx.isQuitting || ctx.isRestarting) return;
      if (!serviceReady) return; // 启动阶段（含 npx 下载）退出属正常交接，不弹窗
      // 延迟确认：进程退出后若端口仍通，说明是其他实例在提供服务，并非故障，不弹窗
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
    // 等待服务就绪。启动阶段（npx 下载/解析、dsh 首次启动）进程退出属正常交接，不立即报错；
    // 只有等待超时后仍无服务，才结合进程状态给出明确提示。
    try {
      await waitForServer(timeout);
      serviceReady = true;
      return true;
    } catch (e) {
      // 超时且进程已退出 → 启动真失败（给出真实原因，区分内置/npx）
      if (!ctx.dshProcess) {
        const detail = (bootStderr || '').trim().slice(0, 300);
        ctx.logger.log('error', 'server: 启动失败（进程已退出）', { detail, viaNpx });
        if (viaNpx) {
          throw new Error(`DeepSeek Harness 下载/启动失败（进程已退出）。${detail ? '\n' + detail : '可能是网络问题导致 npx 下载失败，请重试。'}`);
        }
        throw new Error(`内置 DeepSeek Harness 启动失败（进程已退出）。${detail ? '\n' + detail : '请尝试重新安装。'}`);
      }
      ctx.logger.log('warn', 'server: 等待服务超时（进程仍在）', e && e.message);
      throw e;
    }
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
      const dshCmd = await env.findDshCommand();
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
