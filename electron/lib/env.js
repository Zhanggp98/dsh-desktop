'use strict';

// ---------------------------------------------------------------------------
// 环境检测：dsh 命令定位、Node / winget 检测与安装。
// 无 UI 依赖，纯探测逻辑，供 boot 流程调用。
// ---------------------------------------------------------------------------

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');

/** 定位 dsh 可执行文件：显式变量 → PATH → npx 缓存兜底 */
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

/** 系统 Node 版本（PATH 上的 node），无则 null */
function checkNode() {
  return new Promise((resolve) => {
    execFile('node', ['--version'], { windowsHide: true, timeout: 8_000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).trim().replace(/^v/i, ''));
    });
  });
}

/** winget 是否可用（Windows 自带包管理器） */
function checkWinget() {
  return new Promise((resolve) => {
    execFile('where.exe', ['winget'], { windowsHide: true, timeout: 8_000 }, (err) => {
      resolve(!err);
    });
  });
}

/** 定位 node 安装目录（winget 装完 PATH 不会刷新到当前进程，需直接探测） */
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

/** 定位应用内置 Node（打包后 resources/node；开发时项目 vendor/node） */
function bundledNodeDir() {
  const candidates = [
    path.join(process.resourcesPath || '', 'node'),
    path.join(__dirname, '..', '..', 'vendor', 'node'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'node.exe'))) return dir;
  }
  return null;
}

/** 用指定目录的 node.exe 读取版本 */
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

/** 通过 winget 静默安装 Node.js LTS（会弹 UAC 授权框） */
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

/** 挂载到 ctx（env 无共享状态，仅暴露纯函数集合） */
function install(ctx) {
  ctx.env = {
    findDshCommand,
    checkNode,
    checkWinget,
    locateNodeDir,
    bundledNodeDir,
    runNodeVersion,
    installNodeViaWinget,
  };
}

module.exports = { install };
