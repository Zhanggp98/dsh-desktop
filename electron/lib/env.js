'use strict';

// ---------------------------------------------------------------------------
// 环境检测：dsh 命令定位、Node / winget 检测与安装。
// 无 UI 依赖，纯探测逻辑，供 boot 流程调用。
// ---------------------------------------------------------------------------

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');

// 内置 dsh bundle（随安装包分发，resources/dsh-bundle.tar；开发时 build/dsh-bundle.tar）
// 用纯 tar（无压缩）：兼容性最好，任何 Windows 的 bsdtar 都能解，避免 zstd 库缺失导致解压失败
function bundledDshBundlePath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'dsh-bundle.tar'),
    path.join(__dirname, '..', '..', 'build', 'dsh-bundle.tar'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** 内置 dsh 解压目标：用户数据目录/dsh（一次性解压，之后复用） */
function bundledDshInstallDir() {
  return path.join(require('electron').app.getPath('userData'), 'dsh');
}

/**
 * 确保内置 dsh 已解压到用户数据目录（异步，不阻塞主进程），返回解压后的 bin.js 路径。
 * @returns {Promise<string|null>} bin.js 路径，或 null（无内置 bundle）
 */
function ensureBundledDsh() {
  const bundle = bundledDshBundlePath();
  if (!bundle) return Promise.resolve(null);
  const installDir = bundledDshInstallDir();
  const binJs = path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  // 已解压且可用 → 直接复用
  if (fs.existsSync(binJs)) {
    _log('info', 'env: 复用已解压的内置 dsh', binJs);
    return Promise.resolve(binJs);
  }
  _log('info', 'env: 首次解压内置 dsh', { bundle, installDir });
  // 首次：异步解压 bundle 到用户数据目录（不阻塞主进程 UI）
  fs.mkdirSync(installDir, { recursive: true });
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    const doExtract = (attempt) => {
      execFile('tar', ['-xf', bundle, '-C', installDir], { windowsHide: true, timeout: 120_000 }, (err) => {
        if (!err && fs.existsSync(binJs)) {
          _log('info', 'env: 内置 dsh 解压成功', binJs);
          return resolve(binJs);
        }
        _log('warn', 'env: 解压失败（尝试 ' + attempt + '）', err && (err.stderr || err.message));
        // 失败：清理半解压内容，重试一次
        try { fs.rmSync(installDir, { recursive: true, force: true }); fs.mkdirSync(installDir, { recursive: true }); } catch { /* 忽略 */ }
        if (attempt < 2) return doExtract(attempt + 1);
        const detail = err ? (err.stderr || err.message || String(err)) : '未知错误';
        const e = new Error(`内置 DeepSeek Harness 解压失败：${String(detail).slice(0, 300)}`);
        e.code = 'DSH_BUNDLE_EXTRACT_FAILED';
        reject(e);
      });
    };
    doExtract(1);
  });
}

// 可选日志（由 install 注入 ctx.logger；无则静默）
let _log = () => {};
function install(ctx) {
  if (ctx && ctx.logger) _log = (lvl, msg, extra) => ctx.logger.log(lvl, msg, extra);
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

/**
 * 定位 dsh 可执行文件（异步）：内置 → 显式变量 → PATH → npx 缓存兜底。
 * 内置 dsh 首次解压为异步，不阻塞主进程。
 * @returns {Promise<string|null>}
 */
async function findDshCommand() {
  // 0. 特殊值 'npx'：强制走 npx 模式（测试/兜底）
  if (process.env.DSH_DESKTOP_DSH_CMD === 'npx') return 'npx';
  // 0.5 内置 dsh（安装包自带，零下载，最高优先级）；解压失败会抛 DSH_BUNDLE_EXTRACT_FAILED
  const bundled = await ensureBundledDsh();
  if (bundled) return bundled;
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

module.exports = { install };
