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
    width: 1360,
    height: 860,
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

  // 关闭按钮 = 最小化到托盘（任务继续在后台跑）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (tray && typeof tray.displayBalloon === 'function') {
        tray.displayBalloon({
          title: 'DeepSeek Harness',
          content: '已最小化到托盘，任务仍在后台运行。右键托盘图标可退出。',
        });
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 托盘「退出」：无条件停止 3080（或自定义端口）上的服务再退出，
// 不管服务是本应用还是浏览器/残留进程拉起的。
function quitWithServiceStop() {
  isQuitting = true;
  try {
    // 1. 本应用拉起的 dsh web 子进程
    if (dshProcess && !dshProcess.killed) {
      try { dshProcess.kill(); } catch { /* already gone */ }
    }
    // 2. 查找并强杀占用服务端口的进程（无论谁拉起的）
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const re = new RegExp(':' + PORT + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i');
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(re);
      if (m && String(m[1]) !== String(process.pid)) pids.add(Number(m[1]));
    }
    for (const pid of pids) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  } catch { /* 清理失败不阻塞退出 */ }
  app.quit();
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
    if (isQuitting) return;
    // 延迟确认：进程退出后若端口仍通，说明是其他实例在提供服务（端口被占而退出），并非故障，不弹窗
    setTimeout(async () => {
      if (isQuitting) return;
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

// 插件列表：内建 bundles + profiles node_modules 里的用户/树外插件
function listPlugins() {
  const out = [];
  // 1. 内建 bundles（profiles/web/package.json 的 dsh.profile.bundles）
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dshHomeDir(), 'profiles', 'web', 'package.json'), 'utf8')
    );
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    for (const b of bundles) {
      out.push({ id: b, name: b, detail: '内置 bundle', enabled: true });
    }
  } catch { /* 无 profile 配置 */ }
  // 2. profiles/node_modules 下的插件包（用户安装）
  for (const sub of ['node_modules']) {
    const dir = path.join(dshHomeDir(), 'profiles', sub);
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.') || name === 'node_modules' || name === '.bin') continue;
        const full = path.join(dir, name);
        if (!fs.statSync(full).isDirectory()) continue;
        let detail = '用户插件';
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8'));
          detail = pkg.description || (pkg.version ? 'v' + pkg.version : '用户插件');
        } catch { /* 无 package.json */ }
        out.push({ id: name, name, detail, enabled: true });
      }
    } catch { /* 目录不存在 */ }
  }
  return out;
}

// MCP 服务器：从 DSH settings.yaml 读取 mcp 段（若配置了）
function listMcpServers() {
  const out = [];
  try {
    const text = fs.readFileSync(path.join(dshHomeDir(), 'settings.yaml'), 'utf8');
    const m = text.match(/mcp:\s*\n([\s\S]*?)(?:\n\S[^:]*:|\s*$)/);
    if (m) {
      const re = /^\s{2}([\w-]+):/gm;
      let mm;
      while ((mm = re.exec(m[1])) !== null) {
        out.push({ id: mm[1], name: mm[1], detail: 'MCP 服务器', enabled: true });
      }
    }
  } catch { /* 无配置 */ }
  return out;
}

// Skills：读工作区/用户 skills 目录（SKILL.md 标记）
function listSkills() {
  const out = [];
  const roots = [path.join(dshHomeDir(), 'skills'), path.join(dshHomeDir(), 'workspaces')];
  for (const root of roots) {
    try {
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        const skillMd = path.join(dir, 'SKILL.md');
        let detail = '技能';
        if (fs.existsSync(skillMd)) {
          const head = fs.readFileSync(skillMd, 'utf8').split('\n').slice(0, 3).join(' ');
          detail = head.trim().slice(0, 60);
        }
        out.push({ id: name, name, detail, enabled: true });
      }
    } catch { /* 目录不存在 */ }
  }
  return out;
}

ipcMain.handle('dsh:get-data', async () => {
  if (currentNavPage === 'plugins') return listPlugins();
  if (currentNavPage === 'mcp') return listMcpServers();
  if (currentNavPage === 'skills') return listSkills();
  return [];
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
