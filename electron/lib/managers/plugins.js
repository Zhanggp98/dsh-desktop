'use strict';

// ---------------------------------------------------------------------------
// 插件管理（数据层 + IPC）：读写 dsh.profile.bundles，安装/移除第三方插件。
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain } = require('electron');
const { dshHomeDir, splitPackage, pkgInstallCandidates, readJson } = require('../utils');
const { CORE_BUNDLES } = require('../config');

function profilePkgPath() {
  return path.join(dshHomeDir(), 'profiles', 'web', 'package.json');
}

/** 插件列表：读取 dsh.profile.bundles，区分为核心（系统自带）和第三方（用户安装） */
function listPlugins() {
  const out = [];
  try {
    const pkg = readJson(profilePkgPath());
    const bundles = (pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    for (const b of bundles) {
      const isCore = CORE_BUNDLES.includes(b);
      let detail = isCore ? '核心 bundle' : '第三方插件';
      for (const d of pkgInstallCandidates(dshHomeDir(), b)) {
        const ip = readJson(path.join(d, 'package.json'));
        if (ip) {
          detail = ip.description || (ip.version ? 'v' + ip.version : detail);
          break;
        }
      }
      out.push({ id: b, name: b, detail, isCore, enabled: true });
    }
  } catch { /* 无 profile 配置 */ }
  return out;
}

/** 移除第三方插件：从 dsh.profile.bundles 删除 + 删除包目录 */
function removePlugin(id) {
  const pkg = readJson(profilePkgPath());
  const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
  if (!bundles) return false;
  const idx = bundles.indexOf(id);
  if (idx < 0) return false;
  bundles.splice(idx, 1);
  fs.writeFileSync(profilePkgPath(), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  // 尝试删除包目录（非致命）
  for (const dir of pkgInstallCandidates(dshHomeDir(), id)) {
    try {
      if (fs.existsSync(dir)) {
        const parent = path.dirname(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        // 如果包的父目录（scoped 目录）下面没有其他包了，也删除父目录
        if (parent !== dir && fs.existsSync(parent)) {
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

/**
 * 安装第三方插件：直接用 fetch 从 registry 下载 tarball → tar 解压到 profiles/node_modules。
 * （不依赖 npm 命令，兼容打包后内置 node 无 npm 的情况；也不触发 npm prune，安全）
 */
async function installPlugin(name) {
  const installRoot = path.join(dshHomeDir(), 'profiles', 'node_modules');
  const pkgPath = profilePkgPath();
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
    const [scopeDir, pkgName] = splitPackage(name);
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
    const pkg = readJson(pkgPath) || {};
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

function registerIpc(ctx) {
  ipcMain.handle('dsh:plugin-remove', async (event, id) => removePlugin(id));
  ipcMain.handle('dsh:plugin-install', async (event, name) => installPlugin(name));
}

module.exports = { install: (ctx) => registerIpc(ctx), listPlugins, removePlugin, installPlugin };
