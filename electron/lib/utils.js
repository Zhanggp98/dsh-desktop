'use strict';

// ---------------------------------------------------------------------------
// 通用工具：无业务依赖的纯函数（延时 / 路径 / scoped 包解析 / 简单解析）。
// ---------------------------------------------------------------------------

const path = require('path');
const os = require('os');

/** 延时 */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** DSH 数据目录（~/.dsh 或 DSH_HOME） */
function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * scoped 包名拆分为 [scope, name]：
 *   '@scope/pkg'  → ['@scope', 'pkg']
 *   'pkg'         → [null, 'pkg']
 */
function splitPackage(name) {
  return name.startsWith('@') ? [name.split('/')[0], name.split('/')[1]] : [null, name];
}

/** 在 node_modules 下定位一个包可能的安装目录（顶层 + web profile 两层） */
function pkgInstallCandidates(home, name) {
  const [scope, pkgName] = splitPackage(name);
  const dir = scope ? path.join(scope, pkgName) : pkgName;
  return [
    path.join(home, 'profiles', 'node_modules', dir),
    path.join(home, 'profiles', 'web', 'node_modules', dir),
  ];
}

/** 读取 JSON 文件，失败返回 null */
function readJson(file) {
  try {
    return JSON.parse(require('fs').readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 递归统计目录总大小（字节） */
function dirSize(dir) {
  const fs = require('fs');
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  } catch { /* 目录不存在/无权限 */ }
  return total;
}

/** 去除 YAML/字符串值的引号包裹 */
function unquote(str) {
  return String(str || '').trim().replace(/^['"]|['"]$/g, '');
}

/**
 * 解析 SKILL.md / markdown 前导 frontmatter（--- 包裹的简单键值段）。
 * @returns {object|null} { name, description, ... } 或 null
 */
function parseFrontmatter(text) {
  const fm = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const meta = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = unquote(m[2]);
  }
  return meta;
}

module.exports = {
  delay,
  dshHomeDir,
  splitPackage,
  pkgInstallCandidates,
  readJson,
  dirSize,
  unquote,
  parseFrontmatter,
};
