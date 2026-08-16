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
const SPLASH_MIN_MS = 1_500; // splash 最短展示时间（保证过渡动画可见）
const STEP_MIN_MS = 2_000; // 每一步状态的最短展示时长；实际超过 2s 则按实际时长

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

// 保证异步操作至少展示 minMs；操作实际耗时超过 minMs 则按实际耗时
async function ensureMin(minMs, fn) {
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
    width: 540,
    height: 500,
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

// steps: [{ status: 'pending'|'running'|'done'|'fail', text }] 共 3 项
function setSplashSteps(steps) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`window.__setSteps(${JSON.stringify(steps)})`)
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
    // 同步自定义标题栏的图标/文字配色
    mainWindow.webContents
      .executeJavaScript(
        `(function () { if (window.__dshUpdateBar) window.__dshUpdateBar(${isDark}); })()`
      )
      .catch(() => {});
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
    // 完全自绘标题栏（无系统边框），窗口按钮用页面内 HTML 实现，与蒙版融为一体
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.loadURL(HARNESS_URL);

  // 页面加载完成后：刷新 DSH 主题偏好并同步给 splash；启动期间持续跟随
  mainWindow.webContents.on('did-finish-load', () => {
    applySplashTheme();
    // 自定义标题栏适配：
    //  1. 页面内容下移 40px，为标题栏留白
    //  2. 注入覆盖层拖拽条（含应用图标 + 标题），长按可移动窗口
    mainWindow.webContents
      .insertCSS(
        'html, body { margin: 0 !important; } body { padding-top: 40px !important; box-sizing: border-box !important; }'
      )
      .catch(() => {});
    mainWindow.webContents
      .executeJavaScript(`(function () {
        var bar = document.getElementById('__dsh_drag_bar');
        var isDark = ${resolveSplashTheme() === 'dark'};
        if (!bar) {
          bar = document.createElement('div');
          bar.id = '__dsh_drag_bar';
          bar.style.cssText =
            'position:fixed;top:0;left:0;right:0;height:40px;' +
            '-webkit-app-region:drag;z-index:2147483647;' +
            'display:flex;align-items:center;gap:8px;padding:0 14px;' +
            'font-size:13px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:.3px;' +
            'background:rgba(10,16,30,0.55);' +
            '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);';
          var img = document.createElement('img');
          img.id = '__dsh_drag_logo';
          img.src = ${JSON.stringify(APP_ICON_DATA_URL)};
          img.style.cssText = 'width:18px;height:18px;pointer-events:none;';
          var span = document.createElement('span');
          span.id = '__dsh_drag_title';
          span.textContent = 'DeepSeek Harness';
          span.style.cssText = 'pointer-events:none;user-select:none;';
          // 自绘窗口按钮（右侧，与蒙版同一背景，融入标题栏）
          var controls = document.createElement('div');
          controls.id = '__dsh_drag_controls';
          controls.style.cssText =
            'display:flex;align-items:center;height:40px;margin-left:auto;-webkit-app-region:no-drag;';
          var mkBtn = function (label, cls, action) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.className = 'dsh-win-btn ' + cls;
            btn.style.cssText =
              'width:46px;height:40px;border:none;background:transparent;color:inherit;' +
              'font-size:11px;cursor:default;display:flex;align-items:center;justify-content:center;padding:0;';
            btn.addEventListener('click', function () {
              var c = window.dshWin;
              if (c && c[action]) c[action]();
            });
            return btn;
          };
          controls.appendChild(mkBtn('\u2500', '', 'minimize'));
          controls.appendChild(mkBtn('\u25A1', '', 'toggleMaximize'));
          controls.appendChild(mkBtn('\u2715', 'close', 'close'));
          // 按钮 hover 样式（注入一条小样式表，主题变量控制 hover 背景）
          var st = document.createElement('style');
          st.id = '__dsh_drag_style';
          st.textContent =
            '#__dsh_drag_bar button{transition:background .15s ease;}' +
            '#__dsh_drag_bar button:hover{background:var(--dsh-bar-hover,rgba(255,255,255,0.12)) !important;}' +
            '#__dsh_drag_bar button.close:hover{background:#e81123 !important;color:#fff !important;}';
          document.head.appendChild(st);
          bar.appendChild(img);
          bar.appendChild(span);
          bar.appendChild(controls);
          document.body.appendChild(bar);
        }
        // 读取页面主题背景色：--dsw-alias-bg-base 的 RGB 与透明度
        // （dsh-bg 插件换主题色/调透明度时，标题栏蒙版自动跟随同色）
        window.__dshReadBg = function () {
          var b = document.body;
          if (!b) return { rgb: '10,16,30', alpha: 0.55 };
          var v = (getComputedStyle(b).getPropertyValue('--dsw-alias-bg-base') || '').trim();
          if (!v && b.style) v = b.style.getPropertyValue('--dsw-alias-bg-base') || '';
          var m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
          if (m) {
            var a = m[4] !== undefined ? parseFloat(m[4]) : 1;
            return {
              rgb: m[1] + ',' + m[2] + ',' + m[3],
              alpha: Math.max(0.05, Math.min(1, a))
            };
          }
          // 读不到变量时按主题兜底
          return window.__dshBarTheme === 'dark'
            ? { rgb: '13,17,24', alpha: 0.55 }
            : { rgb: '245,247,251', alpha: 0.55 };
        };
        // 蒙版 = 主题背景色 + 半透明（透明度随背景 alpha 联动，保证标题可读）
        window.__dshSyncBar = function () {
          var b = document.getElementById('__dsh_drag_bar');
          if (!b) return;
          var bg = window.__dshReadBg();
          var alpha = Math.max(0.12, 0.55 * bg.alpha);
          b.style.background = 'rgba(' + bg.rgb + ', ' + alpha.toFixed(3) + ')';
        };
        window.__dshUpdateBar = function (isDark) {
          window.__dshBarTheme = isDark ? 'dark' : 'light';
          var b = document.getElementById('__dsh_drag_bar');
          var im = document.getElementById('__dsh_drag_logo');
          if (b) {
            b.style.color = isDark ? '#e2e8f0' : '#1e293b';
            b.style.setProperty('--dsh-bar-hover', isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.08)');
          }
          if (im) im.style.filter = isDark ? 'brightness(0) invert(1)' : 'none';
          window.__dshSyncBar();
        };
        // 实时监听页面背景变化：
        //  - html/body 的 style/class（CSS 变量 setProperty / overrideTokens 写 :root）
        //  - head 的 childList（插件可能插入 <style> 标签）
        (function () {
          if (window.__dshBgObserver) return;
          window.__dshBgObserver = new MutationObserver(function () {
            if (window.__dshSyncBar) window.__dshSyncBar();
          });
          var obs = window.__dshBgObserver;
          var optAttr = { attributes: true, attributeFilter: ['style', 'class'] };
          if (document.documentElement) obs.observe(document.documentElement, optAttr);
          if (document.body) obs.observe(document.body, optAttr);
          if (document.head) obs.observe(document.head, { childList: true, subtree: true });
        })();
        // 兜底轮询：捕获 CSSOM 直接改样式等 MutationObserver 感知不到的修改
        (function () {
          var last = '';
          window.__dshBgPoll = setInterval(function () {
            if (window.__dshSyncBar && window.__dshReadBg) {
              var bg = window.__dshReadBg();
              var key = bg.rgb + '|' + bg.alpha.toFixed(3);
              if (key !== last) {
                last = key;
                window.__dshSyncBar();
              }
            }
          }, 800);
        })();
        // 创建时就按当前主题设置初始配色，避免首次启动图标为黑色
        window.__dshUpdateBar(isDark);
      })()`)
      .catch(() => {});
    const poll = setInterval(() => {
      if (!splashWindow || splashWindow.isDestroyed()) {
        clearInterval(poll);
        return;
      }
      applySplashTheme();
    }, 500);
  });

  // 固定窗口标题：阻止网页标题（如"你能做什么 — DeepSeek Harness"）覆盖窗口标题
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  // 加载失败兜底提示（服务异常时）
  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    if (code === -3) return; // ERR_ABORTED（正常中断）忽略
    dialog.showErrorBox(
      '加载失败',
      `无法连接到 DeepSeek Harness 服务（${desc}）。\n请关闭后重新打开应用。`
    );
  });

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

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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

  const S1 = (s, t) => ({ status: s, text: t });
  const stepsAll = (s1, s2, s3) => [S1(s1[0], s1[1]), S1(s2[0], s2[1]), S1(s3[0], s3[1])];

  try {
    // ================= 第 1 步：检查 Node.js（至少 2s）=================
    setSplashSteps(stepsAll(['running', '正在检查 Node.js 环境…'], ['pending', '检查 DeepSeek Harness'], ['pending', '启动服务']));
    let nodeVer = await ensureMin(STEP_MIN_MS, checkNode);
    let nodeDir = null;
    let nodeSource = 'system';

    if (!nodeVer) {
      // 系统无 Node → 尝试应用内置 Node（随安装包提供，无需用户安装）
      const bDir = bundledNodeDir();
      if (bDir) {
        const bVer = await runNodeVersion(bDir);
        if (bVer) {
          nodeVer = bVer;
          nodeDir = bDir;
          nodeSource = 'bundled';
        }
      }
    }

    // 内置也缺失（打包异常）→ 尝试 winget 自动安装（系统级，装完其他程序也能用）
    if (!nodeVer) {
      const hasWinget = await checkWinget();
      if (!hasWinget) {
        // 无 winget：不自动安装，全部打叉 + 提示手动安装
        setSplashSteps(stepsAll(['fail', '未安装 Node.js（系统无 winget，无法自动安装）'], ['fail', '检查 DeepSeek Harness（已跳过）'], ['fail', '启动服务（已跳过）']));
        await delay(700);
        const choice = dialog.showMessageBoxSync({
          type: 'error',
          title: '缺少 Node.js',
          message: '未检测到 Node.js',
          detail:
            'DeepSeek Harness 桌面版需要 Node.js 才能运行。\n\n' +
            '当前系统没有 winget，无法自动安装。\n' +
            '请手动安装 Node.js（推荐 LTS 版本），安装完成后重新打开本应用。',
          buttons: ['打开 Node.js 下载页', '退出'],
          defaultId: 0,
          cancelId: 1,
        });
        if (choice === 0) shell.openExternal('https://nodejs.org/zh-cn/download');
        app.quit();
        return;
      }

      // 有 winget：自动安装（会弹 UAC 授权框，需用户点"是"）
      setSplashSteps(stepsAll(['running', '未检测到 Node.js，正在通过 winget 自动安装…\n（如弹出授权窗口请点击"是"）'], ['pending', '检查 DeepSeek Harness'], ['pending', '启动服务']));
      const installed = await installNodeViaWinget();
      if (!installed) {
        setSplashSteps(stepsAll(['fail', 'Node.js 自动安装失败'], ['fail', '检查 DeepSeek Harness（已跳过）'], ['fail', '启动服务（已跳过）']));
        await delay(700);
        dialog.showErrorBox(
          'Node.js 安装失败',
          '通过 winget 自动安装 Node.js 失败（可能取消了授权或网络问题）。\n\n' +
            '请手动安装 Node.js 后重新打开本应用。'
        );
        app.quit();
        return;
      }
      // 安装成功：PATH 未刷新到当前进程，直接探测安装目录
      nodeDir = locateNodeDir();
      if (nodeDir) nodeVer = await runNodeVersion(nodeDir);
      if (!nodeVer) {
        setSplashSteps(stepsAll(['fail', 'Node.js 已安装但未能定位'], ['fail', '检查 DeepSeek Harness（已跳过）'], ['fail', '启动服务（已跳过）']));
        await delay(700);
        dialog.showErrorBox('Node.js 定位失败', 'Node.js 已安装，但未能在标准安装目录中找到。\n请重新打开应用重试。');
        app.quit();
        return;
      }
      nodeSource = 'winget';
    }

    const nodeLabel = () =>
      nodeSource === 'bundled'
        ? `Node.js v${nodeVer} 已内置（免安装）`
        : nodeSource === 'winget'
          ? `Node.js v${nodeVer} 已安装（winget）`
          : `Node.js v${nodeVer} 已安装`;
    setSplashSteps(stepsAll(['done', nodeLabel()], ['running', '正在检查 DeepSeek Harness…'], ['pending', '启动服务']));

    // ================= 第 2 步：检查 dsh / 服务状态（至少 2s）=================
    const probe = await ensureMin(STEP_MIN_MS, async () => {
      const portOpen = await isPortOpen(PORT);
      if (portOpen) {
        // 端口通：再确认是 DeepSeek Harness 服务才复用，防止误连其他程序
        const dshOk = await isDshService();
        if (dshOk) return { running: true, dsh: null };
        return { running: false, conflict: true, dsh: null };
      }
      return { running: false, dsh: findDshCommand() };
    });

    // ================= 第 3 步：启动服务（至少 2s，实际更长按实际）=================
    if (probe.running) {
      // 服务已在运行：直接复用（不重复拉起，保证会话一致）
      setSplashSteps(stepsAll(['done', nodeLabel()], ['done', 'DeepSeek Harness 已就绪'], ['running', '检测到服务已在运行…']));
      await ensureMin(STEP_MIN_MS, async () => {});
      setSplashSteps(stepsAll(['done', nodeLabel()], ['done', 'DeepSeek Harness 已就绪'], ['done', '服务已在运行']));
      await delay(300);
    } else if (probe.conflict) {
      // 端口被其他程序占用：不强行拉起，提示用户
      setSplashSteps(stepsAll(['fail', `端口 ${PORT} 已被其他程序占用`], ['fail', 'DeepSeek Harness 服务不可用'], ['fail', '启动服务（已跳过）']));
      await delay(700);
      dialog.showErrorBox(
        '端口被占用',
        `端口 ${PORT} 已被其他程序占用，且不是 DeepSeek Harness 服务。\n\n` +
          '请关闭占用该端口的程序后重新打开本应用，或通过环境变量 DSH_DESKTOP_URL 指定其他端口。'
      );
      app.quit();
      return;
    } else if (probe.dsh && probe.dsh !== 'npx') {
      // 已安装 dsh：直接启动服务
      setSplashSteps(stepsAll(['done', nodeLabel()], ['done', 'DeepSeek Harness 已安装'], ['running', '正在启动服务…']));
      await ensureMin(STEP_MIN_MS, () => launchServer(probe.dsh, false, nodeDir));
      setSplashSteps(stepsAll(['done', nodeLabel()], ['done', 'DeepSeek Harness 已就绪'], ['done', '服务已启动']));
      await delay(400);
    } else {
      // 未安装 dsh：自动通过 npx 安装（下载完成后服务随即启动）
      setSplashSteps(stepsAll(['done', nodeLabel()], ['running', '未找到 DeepSeek Harness，正在自动安装…'], ['pending', '启动服务']));
      await delay(600);
      await ensureMin(STEP_MIN_MS, () => launchServer(null, true, nodeDir));
      setSplashSteps(stepsAll(['done', nodeLabel()], ['done', 'DeepSeek Harness 安装完成'], ['done', '服务已启动']));
      await delay(400);
    }

    // ================= 进入主页面 =================
    await delay(Math.max(0, SPLASH_MIN_MS - (Date.now() - bootStart)));

    // 预览模式：加载完成后停留在 splash，不进入主页面（DSH_DESKTOP_HOLD_SPLASH=1）
    if (process.env.DSH_DESKTOP_HOLD_SPLASH === '1') {
      // 停留在启动画面，方便查看效果
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
    // 异常：三步统一标红
    setSplashSteps(stepsAll(['fail', 'Node.js 环境检查失败'], ['fail', 'DeepSeek Harness 获取失败'], ['fail', '服务启动失败']));
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
