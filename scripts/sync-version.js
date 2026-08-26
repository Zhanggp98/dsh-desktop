'use strict';

// ---------------------------------------------------------------------------
// 版本对齐：打包前从内置 dsh 读取版本号，同步到客户端 package.json。
// 保证安装包版本与内置 DeepSeek Harness 版本一致。
// 用法：node scripts/sync-version.js
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const bundleTar = path.join(root, 'build', 'dsh-bundle.tar');

// 从 bundle 中提取 @deepseek-ai/dsh 的 package.json 读取版本（用 tar 读取单个文件）
function readBundledDshVersion() {
  if (!fs.existsSync(bundleTar)) return null;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'tar',
      ['-xOf', bundleTar, 'node_modules/@deepseek-ai/dsh/package.json'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
    );
    const pkg = JSON.parse(out);
    return pkg.version || null;
  } catch {
    return null;
  }
}

function main() {
  const version = readBundledDshVersion();
  if (!version) {
    console.error('[sync-version] 无法从内置 dsh bundle 读取版本（bundle 不存在？），跳过版本对齐。');
    process.exit(0);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.version === version) {
    console.log(`[sync-version] 版本已是最新：${version}`);
    return;
  }
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n', 'utf8');
  console.log(`[sync-version] 客户端版本已对齐：${pkg.version} → ${version}`);
}

main();
