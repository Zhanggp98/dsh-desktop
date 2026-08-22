'use strict';

// ---------------------------------------------------------------------------
// Skills 管理（数据层 + IPC）：扫描 DSH 标准技能位置，安装（文件夹导入）/ 卸载。
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain, dialog, BrowserWindow } = require('electron');
const { dshHomeDir, parseFrontmatter } = require('../utils');

/** 用户技能根目录（~/.agents/skills） */
function userSkillRoot() {
  return path.join(os.homedir(), '.agents', 'skills');
}

/** 技能扫描根目录（DSH 标准位置：用户级 + DSH home + 工作区标准子目录） */
function skillScanRoots() {
  const roots = [
    userSkillRoot(),
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

/** 解析 SKILL.md：frontmatter 的 name/description，缺失时回退目录名 */
function parseSkillMd(file, fallbackName) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const meta = parseFrontmatter(content);
    if (meta) {
      return {
        name: meta.name || fallbackName,
        desc: meta.description || content.split('\n').slice(0, 3).join(' ').trim().slice(0, 80),
      };
    }
  } catch { /* 忽略 */ }
  return { name: fallbackName, desc: '技能' };
}

/** 技能列表：扫描标准根目录，支持目录技能（SKILL.md）与扁平 markdown 技能（frontmatter） */
function listSkills() {
  const out = [];
  const seen = new Set();
  for (const root of skillScanRoots()) {
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
          const meta = parseFrontmatter(fs.readFileSync(p, 'utf8'));
          if (!meta || (!meta.name && !meta.description)) continue;
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

/** 安装 skill：弹出文件夹选择，校验含 SKILL.md，复制到用户技能目录 */
async function installSkill(event) {
  try {
    const win = BrowserWindow.fromWebContents(event.sender) || null;
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
    const meta = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
    if (meta && meta.name) skillName = meta.name;
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

/** 卸载 skill：按列表返回的真实路径删除（仅允许删除技能扫描根目录内的路径） */
function uninstallSkill(nameOrPath) {
  try {
    let target;
    if (typeof nameOrPath === 'string' && (nameOrPath.includes(path.sep) || nameOrPath.includes('/'))) {
      target = path.resolve(nameOrPath);
      const allowed = skillScanRoots().some((root) => target === root || target.startsWith(root + path.sep));
      if (!allowed) return { ok: false, message: '路径不在技能目录范围内，已拒绝' };
    } else {
      // 兼容旧调用：按用户技能根解析
      target = path.join(path.resolve(userSkillRoot()), nameOrPath);
    }
    if (!fs.existsSync(target)) return { ok: false, message: '技能目录不存在' };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true, name: path.basename(target) };
  } catch (e) {
    return { ok: false, message: e.message || '卸载失败' };
  }
}

function registerIpc(ctx) {
  ipcMain.handle('dsh:skill-install', async (event) => installSkill(event));
  ipcMain.handle('dsh:skill-uninstall', async (event, nameOrPath) => uninstallSkill(nameOrPath));
}

module.exports = {
  install: (ctx) => registerIpc(ctx),
  listSkills,
  installSkill,
  uninstallSkill,
};
