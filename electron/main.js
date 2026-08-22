'use strict';

/**
 * DeepSeek Harness 桌面应用 — Electron 主进程
 *
 * 启动流程（带过渡动画）：
 *  1. 显示启动画面（splash）
 *  2. 检查 Node.js —— 未安装则提示用户安装
 *  3. 探测端口：已有 dsh web 在跑则直接复用
 *  4. 定位 dsh —— 找不到则自动执行 `npx --yes @deepseek-ai/dsh web` 完成安装并启动
 *  5. 服务就绪后打开主窗口，关闭 splash
 *
 * 常驻能力：关闭窗口 = 最小化到托盘；单实例锁；退出时清理子进程。
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell, nativeTheme, ipcMain } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HARNESS_URL = process.env.DSH_DESKTOP_URL || 'http://localhost:3080';
const PORT = Number(new URL(HARNESS_URL).port) || 3080;
const SERVER_START_TIMEOUT_MS = 30_000; // 直接启动 dsh 的等待上限
const NPX_START_TIMEOUT_MS = 180_000; // 首次 npx 下载安装的等待上限
const SPLASH_MIN_MS = 3_000; // splash 最短展示时间（保证过渡动画可见）

// 应用图标（base64 data URL，用于自定义标题栏）
const APP_ICON_DATA_URL = (() => {
  try {
    const p = path.join(__dirname, '..', 'build', 'icon.png');
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch {
    return '';
  }
})();

let mainWindow = null;
let splashWindow = null;
let tray = null;
let dshProcess = null;
let isQuitting = false;
let isRestarting = false; // 重启服务期间：抑制"意外退出"弹窗

// 开发/便携模式：自定义用户数据目录（避免写入 %APPDATA%）
if (process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USER_DATA);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 显示状态并执行任务，该条状态至少展示 minMs（实际耗时超过则按实际）
async function statusWhile(text, fn, minMs = 1_000) {
  setSplashStatus(text);
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  if (elapsed < minMs) await delay(minMs - elapsed);
  return result;
}

// ---------------------------------------------------------------------------
// dsh 可执行文件定位
// ---------------------------------------------------------------------------
function findDshCommand() {
  // 0. 特殊值 'npx'：强制走 npx 模式（测试/兜底）
  if (process.env.DSH_DESKTOP_DSH_CMD === 'npx') return 'npx';
  // 1. 显式环境变量
  if (process.env.DSH_DESKTOP_DSH_CMD && fs.existsSync(process.env.DSH_DESKTOP_DSH_CMD)) {
    return process.env.DSH_DESKTOP_DSH_CMD;
  }
  // 2. PATH 中的 dsh（where.exe 定位）
  try {
    const out = execFileSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true });
    const line = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (line && fs.existsSync(line)) return line;
  } catch { /* not on PATH */ }
  // 3. npx 缓存兜底（_npx/<hash>/node_modules/.bin/dsh.cmd）
  try {
    const npxRoot = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
    const dirs = fs.readdirSync(npxRoot).filter((d) => /^[0-9a-f]+$/.test(d));
    dirs.sort().reverse(); // 最新优先
    for (const dir of dirs) {
      const cand = path.join(npxRoot, dir, 'node_modules', '.bin', 'dsh.cmd');
      if (fs.existsSync(cand)) return cand;
    }
  } catch { /* no npx cache */ }
  return null;
}

// ---------------------------------------------------------------------------
// 环境检查
// ---------------------------------------------------------------------------
function checkNode() {
  return new Promise((resolve) => {
    execFile('node', ['--version'], { windowsHide: true, timeout: 8_000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).trim().replace(/^v/i, ''));
    });
  });
}

// winget 是否可用（Windows 自带包管理器）
function checkWinget() {
  return new Promise((resolve) => {
    execFile('where.exe', ['winget'], { windowsHide: true, timeout: 8_000 }, (err) => {
      resolve(!err);
    });
  });
}

// 定位 node 安装目录（winget 装完 PATH 不会刷新到当前进程，需直接探测）
function locateNodeDir() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node.exe'))) return dir;
  }
  return null;
}

// 定位应用内置 Node（随安装包分发，用户无需安装）：
// 打包后位于 resources/node；开发时位于项目 vendor/node
function bundledNodeDir() {
  const candidates = [
    path.join(process.resourcesPath || '', 'node'),
    path.join(__dirname, '..', 'vendor', 'node'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'node.exe'))) return dir;
  }
  return null;
}

// 用指定目录的 node.exe 读取版本
function runNodeVersion(nodeDir) {
  return new Promise((resolve) => {
    execFile(
      path.join(nodeDir, 'node.exe'),
      ['--version'],
      { windowsHide: true, timeout: 8_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).trim().replace(/^v/i, ''));
      }
    );
  });
}

// 通过 winget 静默安装 Node.js LTS（会弹 UAC 授权框）
function installNodeViaWinget() {
  return new Promise((resolve) => {
    const child = spawn(
      'winget',
      [
        'install',
        '--id',
        'OpenJS.NodeJS.LTS',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      { windowsHide: true, shell: true, stdio: 'ignore' }
    );
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve(false);
    }, 180_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// 端口探测 / 等待就绪
// ---------------------------------------------------------------------------
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

// 确认端口上的服务是 DeepSeek Harness（HTTP 探测页面特征），防止误复用其他程序占用的端口
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

// ---------------------------------------------------------------------------
// 启动画面（过渡动画）
// ---------------------------------------------------------------------------
function createSplash() {
  splashWindow = new BrowserWindow({
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
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    applySplashTheme();
    splashWindow.show();
  });
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

// 更新启动画面单行状态文字
function setSplashStatus(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`window.__setStatus(${JSON.stringify(text)})`)
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 主题解析：跟随 DeepSeek Harness 的偏好设置（light / dark / system）
//   light  → 浅色版 splash；dark → 深色版；system/未设置 → 跟随 Windows 系统
// ---------------------------------------------------------------------------
function readDshThemePreference() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'settings.yaml');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/(?:^|\n)\s*ui-theme:\s*\r?\n\s+preference:\s*["']?([\w-]+)/);
    if (m && m[1]) return m[1];
  } catch { /* 设置文件不存在或不可读 */ }
  return null;
}

function resolveSplashTheme() {
  const pref = readDshThemePreference();
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  // system 或未设置 → 跟随系统外观
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function applySplashTheme() {
  const theme = resolveSplashTheme();
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`window.__setTheme(${JSON.stringify(theme)})`)
      .catch(() => {});
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    const isDark = theme === 'dark';
    mainWindow.setBackgroundColor(isDark ? '#111318' : '#f8fafc');
    // 推送主题给壳页面（标题栏/导航栏配色）
    mainWindow.webContents.send('dsh:theme', theme);
  }
}
// system 偏好下，系统外观变化实时跟随
nativeTheme.on('updated', applySplashTheme);

// 监听 DSH 设置文件：GUI 内切换主题会写入 settings.yaml，实时同步标题栏/按钮颜色
(function watchDshSettings() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dir = path.join(home);
  try {
    fs.watch(dir, (eventType, filename) => {
      if (filename && /^settings\.ya?ml$/i.test(filename)) {
        applySplashTheme();
      }
    });
  } catch { /* 设置目录不存在或不可监听时忽略 */ }
})();

// ---------------------------------------------------------------------------
// 主窗口 / 托盘
// ---------------------------------------------------------------------------
function createWindow() {
  const theme = resolveSplashTheme();
  const isDark = theme === 'dark';
  mainWindow = new BrowserWindow({
    width: 1640,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: isDark ? '#111318' : '#f8fafc',
    autoHideMenuBar: true,
    title: 'DeepSeek Harness',
    show: false,
    // 完全自绘边框：壳页面 = 标题栏 + 左侧导航栏 + 内容 iframe（单 DOM，无遮挡）
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'nav.html'));
  // 壳页面加载完成后立即推送初始主题（避免首次启动不随主题）
  mainWindow.webContents.on('did-finish-load', () => {
    applySplashTheme();
    // 初始壁纸同步（等 Harness iframe 加载完成）
    setTimeout(syncWallpaper, 1_500);
  });

  // Harness iframe 每次加载完成后重新注入 body 变化监听（observer 随页面销毁）
  mainWindow.webContents.on('did-frame-finish-load', (e, isMainFrame) => {
    if (!isMainFrame) {
      setTimeout(ensureHarnessObserver, 300);
    }
  });

  // 关闭按钮：弹出应用内选择框（勾选 关闭窗口/关闭服务）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.webContents.send('dsh:close-choice', {});
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 托盘「退出」：无条件停止 3080（或自定义端口）上的服务再退出，
// 不管服务是本应用还是浏览器/残留进程拉起的。
// 强杀占用指定端口的进程（无论谁拉起的）
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

function quitWithServiceStop() {
  isQuitting = true;
  try {
    // 1. 本应用拉起的 dsh web 子进程
    if (dshProcess && !dshProcess.killed) {
      try { dshProcess.kill(); } catch { /* already gone */ }
    }
    // 2. 强杀占用服务端口的进程（无论谁拉起的）
    killPortProcess(PORT);
  } catch { /* 清理失败不阻塞退出 */ }
  app.quit();
}

// 重启 dsh 服务：杀掉当前服务 → 重新拉起 → 返回是否成功（不退出窗口）
async function restartService() {
  isRestarting = true;
  try {
    // 1. 杀当前服务
    if (dshProcess && !dshProcess.killed) {
      try { dshProcess.kill(); } catch { /* ignore */ }
    }
    killPortProcess(PORT);
    // 2. 等待端口释放
    await delay(1500);
    // 3. 重新拉起（复用启动逻辑）
    const dshCmd = findDshCommand();
    if (dshCmd && dshCmd !== 'npx') {
      await launchServer(dshCmd, false, null);
    } else {
      await launchServer(null, true, null);
    }
    // 4. 刷新 Harness iframe（跨源 iframe 不能用 reload()，通过重置 src 强制重载）
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents
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
    isRestarting = false;
  }
}

function createTray() {
  let iconPath = path.join(__dirname, '..', 'build', 'tray.png');
  if (!fs.existsSync(iconPath)) iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img);
  tray.setToolTip('DeepSeek Harness');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开主窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            createWindow();
          }
        },
      },
      { type: 'separator' },
      {
        label: '停止服务并退出',
        click: quitWithServiceStop,
      },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ---------------------------------------------------------------------------
// 启动流程
// ---------------------------------------------------------------------------
async function boot() {
  const bootStart = Date.now();
  createSplash();

  try {
    // ---------- 第 1 步：检查 Node.js（状态至少停留 1s）----------
    const nodeResult = await statusWhile('正在检查 Node.js 环境…', async () => {
      let v = await checkNode();
      let dir = null;
      if (!v) {
        // 系统无 Node → 使用应用内置 Node（随安装包提供，无需用户安装）
        const bDir = bundledNodeDir();
        if (bDir) {
          const bv = await runNodeVersion(bDir);
          if (bv) {
            v = bv;
            dir = bDir;
          }
        }
      }
      return { v, dir };
    });
    let nodeVer = nodeResult.v;
    let nodeDir = nodeResult.dir;

    // 内置也缺失（打包异常）→ winget 兜底（系统级安装）
    if (!nodeVer) {
      const hasWinget = await checkWinget();
      if (!hasWinget) {
        setSplashStatus('Node.js 环境不可用');
        await delay(600);
        dialog.showErrorBox(
          '缺少 Node.js',
          '未检测到 Node.js，且系统没有 winget 也无法自动安装。\n\n请安装 Node.js 后重新打开本应用。'
        );
        app.quit();
        return;
      }
      setSplashStatus('正在通过 winget 安装 Node.js…\n（如弹出授权窗口请点击"是"）');
      const installed = await installNodeViaWinget();
      if (!installed) {
        setSplashStatus('Node.js 自动安装失败');
        await delay(600);
        dialog.showErrorBox('Node.js 安装失败', '通过 winget 自动安装 Node.js 失败。请手动安装后重试。');
        app.quit();
        return;
      }
      nodeDir = locateNodeDir();
      if (nodeDir) nodeVer = await runNodeVersion(nodeDir);
      if (!nodeVer) {
        setSplashStatus('Node.js 已安装但未能定位');
        await delay(600);
        dialog.showErrorBox('Node.js 定位失败', 'Node.js 已安装，但未能在标准目录中找到。请重试。');
        app.quit();
        return;
      }
    }

    // ---------- 第 2 步：检查 dsh / 服务状态（状态至少停留 1s）----------
    const probe = await statusWhile('正在检查 DeepSeek Harness…', async () => {
      const portOpen = await isPortOpen(PORT);
      if (portOpen) {
        // 端口通：确认是 DSH 服务才复用，防止误连其他程序
        const dshOk = await isDshService();
        if (dshOk) return { running: true, dsh: null };
        return { running: false, conflict: true, dsh: null };
      }
      return { running: false, dsh: findDshCommand() };
    });

    // ---------- 第 3 步：启动 / 复用服务 ----------
    if (probe.running) {
      // 服务已在运行：直接复用（不重复拉起，保证会话一致）
      setSplashStatus('服务已在运行');
    } else if (probe.conflict) {
      setSplashStatus('端口被其他程序占用');
      await delay(600);
      dialog.showErrorBox(
        '端口被占用',
        `端口 ${PORT} 已被其他程序占用，且不是 DeepSeek Harness 服务。\n\n请关闭占用该端口的程序后重试。`
      );
      app.quit();
      return;
    } else {
      // 启动服务（状态至少停留 1s；服务启动通常更久按实际）
      await statusWhile('正在启动服务…', async () => {
        if (probe.dsh && probe.dsh !== 'npx') {
          await launchServer(probe.dsh, false, nodeDir);
        } else {
          // 无 dsh：先显示安装中
          setSplashStatus('正在安装 DeepSeek Harness…');
          await launchServer(null, true, nodeDir);
        }
      });
    }

    // ---------- 进入主页面 ----------
    await delay(Math.max(0, SPLASH_MIN_MS - (Date.now() - bootStart)));

    // 预览模式：加载完成后停留在 splash，不进入主页面（DSH_DESKTOP_HOLD_SPLASH=1）
    if (process.env.DSH_DESKTOP_HOLD_SPLASH === '1') {
      return;
    }

    createWindow();
    createTray();
    // 启动完成后自动检查更新（不阻塞）
    autoCheckUpdate();
    // 等主窗口真正显示后再关闭 splash，避免出现空白间隙
    if (splashWindow) {
      const closeSplash = () => splashWindow && splashWindow.close();
      if (mainWindow && mainWindow.isVisible()) {
        closeSplash();
      } else {
        mainWindow.once('ready-to-show', closeSplash);
      }
    }
  } catch (err) {
    setSplashStatus('启动失败');
    await delay(500);
    dialog.showErrorBox('启动失败', err.message);
    app.quit();
  }
}

// 拉起 dsh web 并等待服务就绪；viaNpx 时使用 npx 自动安装路径
// nodeDir 非空时（winget 刚装完 Node），将其加入子进程 PATH，保证 dsh/npx 能找到 node
async function launchServer(dshCmd, viaNpx, nodeDir) {
  // 二次确认：spawn 前再次探测端口，若已有 DSH 服务在运行则直接复用，避免竞态产生多个实例
  if (await isPortOpen(PORT)) {
    if (await isDshService()) {
      dshProcess = null;
      return true;
    }
    // 端口被非 DSH 程序占用：无法拉起，交由调用方报错
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

  dshProcess = spawn(launchCmd, launchArgs, {
    windowsHide: true,
    shell: true,
    stdio: 'ignore',
    env,
  });

  dshProcess.on('exit', (code) => {
    dshProcess = null;
    if (isQuitting || isRestarting) return;
    // 延迟确认：进程退出后若端口仍通，说明是其他实例在提供服务（端口被占而退出），并非故障，不弹窗
    setTimeout(async () => {
      if (isQuitting || isRestarting) return;
      if (await isPortOpen(PORT)) return;
      dialog.showErrorBox(
        'dsh web 已退出',
        `服务器进程意外退出（code=${code}）。请重新打开应用。`
      );
    }, 1_500);
  });

  const timeout = viaNpx ? NPX_START_TIMEOUT_MS : SERVER_START_TIMEOUT_MS;
  return waitForServer(timeout);
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
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

// 执行关闭选择：'tray' / 'quit' / 'stop-only' / 'quit-stop'
function executeCloseChoice(choice) {
  if (!mainWindow) return;
  if (choice === 'tray') {
    mainWindow.hide();
    if (tray && typeof tray.displayBalloon === 'function') {
      tray.displayBalloon({
        title: 'DeepSeek Harness',
        content: '已最小化到托盘，任务仍在后台运行。右键托盘图标可退出。',
      });
    }
  } else if (choice === 'quit-stop') {
    quitWithServiceStop();
  } else if (choice === 'quit') {
    isQuitting = true;
    app.quit();
  } else if (choice === 'stop-only') {
    // 只停服务：杀掉占用端口的进程，窗口保留
    try {
      if (dshProcess && !dshProcess.killed) {
        try { dshProcess.kill(); } catch { /* already gone */ }
      }
      killPortProcess(PORT);
    } catch { /* 忽略 */ }
  }
  // 其他：不做事
}

// 关闭选择框回执：{ choice, remember } —— remember 保留兼容（不再使用）
ipcMain.on('dsh:close-choice-respond', (event, payload) => {
  if (!mainWindow) return;
  const choice = payload && payload.choice;
  executeCloseChoice(choice);
});

// 导航切换（壳页面 preload 转发）
ipcMain.on('dsh:nav-select', (event, page) => {
  currentNavPage = page;
});

// 管理页：当前导航页 + Harness 地址
let currentNavPage = 'harness';
ipcMain.handle('dsh:get-page', () => currentNavPage);
ipcMain.handle('dsh:get-harness-url', () => HARNESS_URL);

// ---------------------------------------------------------------------------
// 管理页数据（读本地配置/目录）
// ---------------------------------------------------------------------------
function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 插件列表：读取 dsh.profile.bundles，区分为核心（系统自带）和第三方（用户安装）
const CORE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
];

function listPlugins() {
  const out = [];
  try {
    const pkgPath = path.join(dshHomeDir(), 'profiles', 'web', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    for (const b of bundles) {
      const isCore = CORE_BUNDLES.includes(b);
      // 尝试获取版本/描述
      let detail = isCore ? '核心 bundle' : '第三方插件';
      const scopeDir = b.startsWith('@') ? b.split('/')[0] : null;
      const namePart = b.startsWith('@') ? b.split('/')[1] : b;
      const candidates = [
        path.join(dshHomeDir(), 'profiles', 'node_modules', scopeDir || '', namePart),
        path.join(dshHomeDir(), 'profiles', 'web', 'node_modules', scopeDir || '', namePart),
      ];
      for (const d of candidates) {
        const pj = path.join(d, 'package.json');
        if (fs.existsSync(pj)) {
          try {
            const ip = JSON.parse(fs.readFileSync(pj, 'utf8'));
            detail = ip.description || (ip.version ? 'v' + ip.version : detail);
          } catch { /* 忽略 */ }
          break;
        }
      }
      out.push({ id: b, name: b, detail, isCore, enabled: true });
    }
  } catch { /* 无 profile 配置 */ }
  return out;
}

// 移除第三方插件：从 dsh.profile.bundles 删除 + 删除包目录
function removePlugin(id) {
  const pkgPath = path.join(dshHomeDir(), 'profiles', 'web', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
  if (!bundles) return false;
  const idx = bundles.indexOf(id);
  if (idx < 0) return false;
  bundles.splice(idx, 1);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  // 尝试删除包目录（非致命）
  const scopeDir = id.startsWith('@') ? id.split('/')[0] : null;
  const namePart = id.startsWith('@') ? id.split('/')[1] : id;
  const candidates = [
    path.join(dshHomeDir(), 'profiles', 'node_modules', scopeDir || '', namePart),
    path.join(dshHomeDir(), 'profiles', 'web', 'node_modules', scopeDir || '', namePart),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) {
        // 如果包的父目录（scoped 目录）下面没有其他包了，也删除父目录
        const parent = path.dirname(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        if (scopeDir && parent !== dir && fs.existsSync(parent)) {
          try {
            const remain = fs.readdirSync(parent);
            if (remain.length === 0) fs.rmdirSync(parent);
          } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
// MCP 服务器：读写 profiles/web/cordis.patch.yml（DSH 标准 MCP 配置位置）
// 每个 MCP 服务器是一个 @deepseek-ai/dsh-mcp-client 插件实例
// ---------------------------------------------------------------------------
const MCP_CLIENT_BUNDLE = '@deepseek-ai/dsh-mcp-client';

function mcpPatchPath() {
  return path.join(dshHomeDir(), 'profiles', 'web', 'cordis.patch.yml');
}

// 解析 cordis.patch.yml（YAML 数组），返回 { entries, mcp } —— mcp 为 MCP 实例数组
function parsePatchFile(text) {
  const entries = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let cur = null; // 当前顶层条目 { raw: [lines], id, name, indent }
  const flush = () => {
    if (cur && cur.raw.length > 0) {
      // 判定是否 MCP 条目：name 字段 == MCP_CLIENT_BUNDLE
      const nameMatch = cur.raw.find((l) => /^\s{2}name:\s*/.test(l));
      const name = nameMatch ? nameMatch.replace(/^\s{2}name:\s*/, '').trim().replace(/^['"]|['"]$/g, '') : '';
      const idMatch = cur.raw.find((l) => /^-\s+id:\s*/.test(l));
      const id = idMatch ? idMatch.replace(/^-\s+id:\s*/, '').trim().replace(/^['"]|['"]$/g, '') : '';
      cur.id = id;
      cur.name = name;
      entries.push(cur);
    }
    cur = null;
  };
  for (const line of lines) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      if (cur) cur.raw.push(line);
      continue;
    }
    if (/^-\s/.test(line) || /^-\s*$/.test(line)) {
      flush();
      cur = { raw: [line] };
    } else if (cur) {
      cur.raw.push(line);
    }
    // 顶层非条目行（如注释前的 []）忽略
  }
  flush();
  return entries;
}

function listMcpServers() {
  const out = [];
  try {
    const p = mcpPatchPath();
    if (!fs.existsSync(p)) return out;
    const entries = parsePatchFile(fs.readFileSync(p, 'utf8'));
    for (const e of entries) {
      if (e.name !== MCP_CLIENT_BUNDLE) continue;
      // 解析 config
      const raw = e.raw.join('\n');
      const cfg = {};
      const cfgMatch = raw.match(/^\s{2}config:\s*$/m);
      if (cfgMatch) {
        // 抓 config 缩进块（4 空格字段，args 子项 6 空格）
        const lines = raw.split('\n');
        const startIdx = lines.findIndex((l) => /^\s{2}config:\s*$/.test(l));
        for (let i = startIdx + 1; i < lines.length; i++) {
          const l = lines[i];
          if (/^\s{2}\S/.test(l)) break; // 回到 config 同级（如其他顶层字段）
          const m = l.match(/^\s{4}([\w-]+):\s*(.*)$/);
          if (m) {
            let v = m[2].trim();
            if (v.startsWith('[') || v === '') {
              // 数组或空 → 收集子行
              const arr = [];
              let j = i + 1;
              while (j < lines.length && /^\s{6}-\s/.test(lines[j])) {
                arr.push(lines[j].replace(/^\s{6}-\s*/, '').replace(/^['"]|['"]$/g, ''));
                j++;
              }
              cfg[m[1]] = v.startsWith('[') ? v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : arr;
              i = j - 1;
            } else {
              cfg[m[1]] = v.replace(/^['"]|['"]$/g, '');
            }
          }
        }
      }
      const serverName = cfg.serverName || e.id || '';
      const transport = cfg.transport || 'stdio';
      let detail = '';
      if (transport === 'stdio') {
        detail = [cfg.command, (cfg.args || []).join(' ')].filter(Boolean).join(' ');
      } else {
        detail = cfg.url || '';
      }
      out.push({
        id: e.id,
        name: serverName,
        detail,
        transport,
        command: cfg.command || '',
        args: cfg.args || [],
        url: cfg.url || '',
        headers: cfg.headers || '',
        enabled: true,
        tag: transport === 'stdio' ? 'stdio' : 'HTTP',
      });
    }
  } catch { /* 无配置 */ }
  return out;
}

// 保存（新增或编辑）MCP 服务器；返回 { ok, message }
function saveMcpServer(entry) {
  try {
    const p = mcpPatchPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '[]\n';
    const entries = parsePatchFile(text);
    const serverName = (entry.serverName || '').trim();
    if (!serverName) return { ok: false, message: 'serverName 不能为空' };
    const transport = entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
    if (transport === 'stdio' && !(entry.command || '').trim()) {
      return { ok: false, message: 'stdio 传输需要 command' };
    }
    if (transport === 'streamable-http' && !(entry.url || '').trim()) {
      return { ok: false, message: 'HTTP 传输需要 url' };
    }
    // 生成新条目文本
    let id = (entry.id || '').trim();
    if (id && entries.some((e) => e.name === MCP_CLIENT_BUNDLE && e.id === id && !entry.isEdit)) {
      return { ok: false, message: 'id 已存在: ' + id };
    }
    if (!id) id = 'mcp-' + serverName.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase();
    const lines = ['- id: ' + id, "  name: '" + MCP_CLIENT_BUNDLE + "'", '  config:'];
    lines.push('    serverName: ' + serverName);
    lines.push('    transport: ' + transport);
    if (transport === 'stdio') {
      const cmd = (entry.command || '').trim();
      const cmdQuote = /^[A-Za-z0-9_./\\:-]+$/.test(cmd) ? '' : "'";
      lines.push('    command: ' + cmdQuote + cmd + cmdQuote);
      const args = (Array.isArray(entry.args) ? entry.args : String(entry.args || '').split(/[,\s]+/)).map((s) => String(s).trim()).filter(Boolean);
      if (args.length > 0) {
        lines.push('    args:');
        for (const a of args) {
          const q = /^[A-Za-z0-9_./\\:-]+$/.test(a) ? '' : "'";
          lines.push('      - ' + q + a + q);
        }
      }
    } else {
      lines.push('    url: ' + (entry.url || '').trim());
      const hdr = (entry.headers || '').trim();
      if (hdr) lines.push('    headers: ' + hdr);
    }
    const newRaw = lines.join('\n');
    // 重建文件：非 MCP 条目原样保留；被编辑的 MCP 条目替换；新增追加
    const out = [];
    let replaced = false;
    for (const e of entries) {
      if (e.name === MCP_CLIENT_BUNDLE && (entry.isEdit ? e.id === id : e.id === id)) {
        out.push(newRaw);
        replaced = true;
      } else {
        out.push(e.raw.join('\n'));
      }
    }
    if (!replaced) out.push(newRaw);
    const header = '# Your patch layer for this dsh profile, applied after every bundle layer:\n' +
      '# a top-level YAML array of loader patch entries (id-targeted config\n' +
      '# overrides, disables, and insert lists; `!!js` expressions allowed).\n';
    fs.writeFileSync(p, header + out.join('\n') + '\n', 'utf8');
    return { ok: true, id };
  } catch (e) {
    return { ok: false, message: e.message || '保存失败' };
  }
}

// 删除 MCP 服务器；返回 { ok, message }
function removeMcpServer(id) {
  try {
    const p = mcpPatchPath();
    if (!fs.existsSync(p)) return { ok: false, message: '配置文件不存在' };
    const entries = parsePatchFile(fs.readFileSync(p, 'utf8'));
    const out = [];
    let removed = false;
    for (const e of entries) {
      if (e.name === MCP_CLIENT_BUNDLE && e.id === id) {
        removed = true;
        continue;
      }
      out.push(e.raw.join('\n'));
    }
    if (!removed) return { ok: false, message: '未找到该 MCP 服务器' };
    fs.writeFileSync(p, out.join('\n') + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message || '删除失败' };
  }
}

ipcMain.handle('dsh:mcp-save', async (event, entry) => saveMcpServer(entry));
ipcMain.handle('dsh:mcp-remove', async (event, id) => removeMcpServer(id));

// Skills：按 DSH 标准位置扫描（用户级 + DSH home + 工作区标准子目录），读取名称与描述
function listSkills() {
  const out = [];
  const seen = new Set();
  const roots = [
    path.join(os.homedir(), '.agents', 'skills'), // 用户级（~/.agents/skills）
    path.join(dshHomeDir(), 'skills'), // ~/.dsh/skills
    // 工作区项目级（仅标准子目录约定，不直接扫工作区根）
    path.join(process.cwd(), '.dsh', 'skills'),
    path.join(process.cwd(), '.agents', 'skills'),
  ];
  if (process.env.DSH_WORKSPACE) {
    roots.push(
      path.join(process.env.DSH_WORKSPACE, '.dsh', 'skills'),
      path.join(process.env.DSH_WORKSPACE, '.agents', 'skills'),
    );
  }
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(root, e.name);
        if (e.isDirectory()) {
          // 目录技能：dir/SKILL.md
          const skillMd = path.join(p, 'SKILL.md');
          if (!fs.existsSync(skillMd)) continue;
          const { name, desc } = parseSkillMd(skillMd, e.name);
          if (seen.has(name)) continue;
          seen.add(name);
          out.push({ id: name, name, detail: desc, tag: '目录技能', path: p });
        } else if (e.name.endsWith('.md') && e.name !== 'README.md') {
          // 扁平 markdown 技能：root/name.md（含 frontmatter 才视为技能）
          const content = fs.readFileSync(p, 'utf8');
          const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (!fm) continue;
          const meta = parseFrontmatter(fm[1]);
          if (!meta.name && !meta.description) continue;
          const name = meta.name || e.name.replace(/\.md$/, '');
          if (seen.has(name)) continue;
          seen.add(name);
          out.push({ id: name, name, detail: meta.description || '', tag: '技能', path: p });
        }
      }
    } catch { /* 目录不存在 */ }
  }
  return out;
}

function parseFrontmatter(text) {
  const meta = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

function parseSkillMd(file, fallbackName) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const meta = parseFrontmatter(fm[1]);
      return {
        name: meta.name || fallbackName,
        desc: meta.description || content.split('\n').slice(0, 3).join(' ').trim().slice(0, 80),
      };
    }
  } catch { /* 忽略 */ }
  return { name: fallbackName, desc: '技能' };
}

ipcMain.handle('dsh:get-data', async () => {
  if (currentNavPage === 'plugins') return listPlugins();
  if (currentNavPage === 'mcp') return listMcpServers();
  if (currentNavPage === 'skills') return listSkills();
  return [];
});

// 插件移除
ipcMain.handle('dsh:plugin-remove', async (event, id) => {
  return removePlugin(id);
});

// ---------------------------------------------------------------------------
// Skill 安装 / 卸载（用户技能目录 ~/.agents/skills）
// ---------------------------------------------------------------------------
function userSkillRoot() {
  return path.join(os.homedir(), '.agents', 'skills');
}

// 安装 skill：弹出文件夹选择，校验含 SKILL.md，复制到用户技能目录
async function installSkill(event) {
  try {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: '选择技能文件夹（需包含 SKILL.md）',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, message: '已取消' };
    }
    const srcDir = result.filePaths[0];
    const skillMd = path.join(srcDir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      return { ok: false, message: '所选文件夹中没有 SKILL.md，不是有效的技能目录' };
    }
    // 技能名：SKILL.md frontmatter 的 name，或目录名
    let skillName = path.basename(srcDir);
    try {
      const content = fs.readFileSync(skillMd, 'utf8');
      const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) {
        const m = fm[1].match(/^name:\s*(.+)$/m);
        if (m) skillName = m[1].trim().replace(/^["']|["']$/g, '');
      }
    } catch { /* 忽略 */ }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
      return { ok: false, message: '技能名不合法（需小写字母数字，中划线连接）：' + skillName };
    }
    const targetDir = path.join(userSkillRoot(), skillName);
    fs.mkdirSync(userSkillRoot(), { recursive: true });
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(srcDir, targetDir, { recursive: true });
    return { ok: true, name: skillName };
  } catch (e) {
    return { ok: false, message: e.message || '安装失败' };
  }
}

// 卸载 skill：按列表返回的真实路径删除（仅允许删除技能扫描根目录内的路径）
function skillScanRoots() {
  const roots = [
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(dshHomeDir(), 'skills'),
    path.join(process.cwd(), '.dsh', 'skills'),
    path.join(process.cwd(), '.agents', 'skills'),
  ];
  if (process.env.DSH_WORKSPACE) {
    roots.push(
      path.join(process.env.DSH_WORKSPACE, '.dsh', 'skills'),
      path.join(process.env.DSH_WORKSPACE, '.agents', 'skills'),
    );
  }
  return roots.map((p) => path.resolve(p));
}

function uninstallSkill(nameOrPath) {
  try {
    let target;
    if (typeof nameOrPath === 'string' && (nameOrPath.includes(path.sep) || nameOrPath.includes('/'))) {
      target = path.resolve(nameOrPath);
      // 安全校验：仅允许删除技能扫描根目录内的路径
      const roots = skillScanRoots();
      const allowed = roots.some((root) => target === root || target.startsWith(root + path.sep));
      if (!allowed) return { ok: false, message: '路径不在技能目录范围内，已拒绝' };
    } else {
      // 兼容旧调用：按用户技能根解析
      target = path.join(path.resolve(path.join(os.homedir(), '.agents', 'skills')), nameOrPath);
    }
    if (!fs.existsSync(target)) return { ok: false, message: '技能目录不存在' };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true, name: path.basename(target) };
  } catch (e) {
    return { ok: false, message: e.message || '卸载失败' };
  }
}

ipcMain.handle('dsh:skill-install', async (event) => {
  return installSkill(event);
});
ipcMain.handle('dsh:skill-uninstall', async (event, nameOrPath) => {
  return uninstallSkill(nameOrPath);
});

// 重启 dsh 服务（不退出窗口）
ipcMain.handle('dsh:restart-service', async () => {
  return restartService();
});

// ---------------------------------------------------------------------------
// 检查更新：对比 npm 上 @deepseek-ai/dsh 最新版本与本地已装版本
// ---------------------------------------------------------------------------
function getLocalDshVersion() {
  try {
    const dshCmd = findDshCommand();
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

ipcMain.handle('dsh:check-update', async () => {
  return checkForUpdates();
});

// 启动完成后自动检查一次（不阻塞），有更新则推送前端提示
function autoCheckUpdate() {
  setTimeout(async () => {
    const result = await checkForUpdates();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dsh:update-result', result);
    }
  }, 4_000);
}

// 从 Harness iframe 读取壁纸与主题色 CSS 变量，同步给壳窗口（导航栏/标题栏毛玻璃透出背景）
// 与具体插件解耦：只读 DSH 标准 CSS 变量（壁纸 --dsh-bg-* / 主题 --dsw-alias-* / --dsw-specific-*）
function syncWallpaper() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const frames = mainWindow.webContents.mainFrame.frames;
    for (const f of frames) {
      if (f.url && f.url.indexOf('localhost:' + PORT) !== -1) {
        f.executeJavaScript(`JSON.stringify((function(){
          var s=getComputedStyle(document.body);
          return {
            bg:document.body.getAttribute('data-dsh-bg')||'',
            img:s.getPropertyValue('--dsh-bg-image')||'',
            fill:s.getPropertyValue('--dsh-bg-fill')||'',
            base:s.getPropertyValue('--dsw-alias-bg-base')||'',
            layer1:s.getPropertyValue('--dsw-alias-bg-layer-1')||'',
            layer2:s.getPropertyValue('--dsw-alias-bg-layer-2')||'',
            overlay:s.getPropertyValue('--dsw-alias-bg-overlay')||'',
            sidebar:s.getPropertyValue('--dsw-specific-sidebar-fill')||''
          };
        })())`)
          .then((r) => {
            try {
              const obj = JSON.parse(r);
              if (mainWindow && !mainWindow.isDestroyed()) {
                // 防御：仅当 body 声明 data-dsh-bg="image"（壁纸激活）时才同步壁纸，
                // 避免残留变量导致壳窗口显示过期背景
                if (obj.bg !== 'image') {
                  obj.img = '';
                  obj.fill = '';
                }
                mainWindow.webContents.send('dsh:wallpaper', obj);
              }
            } catch { /* 忽略 */ }
          })
          .catch(() => {});
        return;
      }
    }
  } catch { /* 帧不可用 */ }
}

// 在 Harness iframe 注入通用 body 变化监听（MutationObserver）：
// 监听 DSH 页面本体的 style / data-dsh-bg 属性变化，变化时通知壳窗口立即同步。
// 不依赖任何具体插件——任何修改 body 壁纸变量的机制都会触发。
function ensureHarnessObserver() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const frames = mainWindow.webContents.mainFrame.frames;
    for (const f of frames) {
      if (f.url && f.url.indexOf('localhost:' + PORT) !== -1) {
        f.executeJavaScript(`(() => {
          if (window.__dshHarnessObserver) return 'exists';
          const notify = () => {
            try { window.parent.postMessage({ source: 'dsh-harness', type: 'body-changed' }, '*'); } catch (e) {}
          };
          const obs = new MutationObserver(notify);
          obs.observe(document.body, {
            attributes: true,
            attributeFilter: ['style', 'data-dsh-bg'],
            subtree: false,
          });
          window.__dshHarnessObserver = obs;
          return 'installed';
        })()`)
          .catch(() => {});
        return;
      }
    }
  } catch { /* 帧不可用 */ }
}

// 事件驱动：iframe 内 body 壁纸相关属性变化 → postMessage → nav.html 转发 → 这里触发同步
ipcMain.on('dsh:wallpaper-changed', () => {
  syncWallpaper();
});

// 安装第三方插件：直接用 fetch 从 registry 下载 tarball → tar 解压到 profiles/node_modules
// （不依赖 npm 命令，兼容打包后内置 node 无 npm 的情况；也不触发 npm prune，安全）
async function installPlugin(name) {
  const installRoot = path.join(dshHomeDir(), 'profiles', 'node_modules');
  const pkgPath = path.join(dshHomeDir(), 'profiles', 'web', 'package.json');
  const tmpDir = path.join(os.tmpdir(), 'dsh-install-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    // 1. 查询 registry 获取最新版本与 tarball 地址
    const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name;
    const metaRes = await fetch('https://registry.npmmirror.com/' + encoded + '/latest', {
      signal: AbortSignal.timeout(30_000),
    });
    if (!metaRes.ok) throw new Error('查询包信息失败（HTTP ' + metaRes.status + '）');
    const meta = await metaRes.json();
    if (!meta.dist || !meta.dist.tarball) throw new Error('包不存在或没有 tarball');
    // 2. 下载 tarball
    const tgzRes = await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(120_000) });
    if (!tgzRes.ok) throw new Error('下载失败（HTTP ' + tgzRes.status + '）');
    const tgzBuf = Buffer.from(await tgzRes.arrayBuffer());
    const tgzPath = path.join(tmpDir, 'pkg.tgz');
    fs.writeFileSync(tgzPath, tgzBuf);
    // 3. tar 解压（Windows 自带 tar.exe）
    require('child_process').execFileSync('tar', ['-xzf', tgzPath, '-C', tmpDir], {
      windowsHide: true,
    });
    // 4. 解压出的 package/ 移到目标位置（支持 scoped 包）
    const srcPkg = path.join(tmpDir, 'package');
    if (!fs.existsSync(srcPkg)) throw new Error('解压失败：未找到 package 目录');
    const parts = name.startsWith('@') ? name.split('/') : [null, name];
    const scopeDir = parts[0];
    const pkgName = parts[1];
    let targetDir;
    if (scopeDir) {
      targetDir = path.join(installRoot, scopeDir, pkgName);
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    } else {
      targetDir = path.join(installRoot, pkgName);
    }
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(srcPkg, targetDir);
    // 5. 追加到 bundles 列表
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.dsh) pkg.dsh = {};
    if (!pkg.dsh.profile) pkg.dsh.profile = {};
    if (!pkg.dsh.profile.bundles) pkg.dsh.profile.bundles = [];
    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name);
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) {
    return e.message || '安装失败';
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}
ipcMain.handle('dsh:plugin-install', async (event, name) => {
  return installPlugin(name);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => {
    // 不退出：托盘常驻，任务可后台运行
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    // 只清理"由本应用拉起"的 dsh 进程；若复用了外部已运行的实例则不动
    if (dshProcess && !dshProcess.killed) {
      try {
        dshProcess.kill();
      } catch { /* already gone */ }
    }
  });
}
