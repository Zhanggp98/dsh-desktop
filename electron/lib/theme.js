'use strict';

// ---------------------------------------------------------------------------
// 主题：解析 DSH 外观偏好（light/dark/system），同步到 splash 与主窗口。
// 监听系统外观变化与 DSH settings.yaml 变化，实时跟随。
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const os = require('os');
const { nativeTheme } = require('electron');
const { dshHomeDir } = require('./utils');

function install(ctx) {
  /** 读取 DSH settings.yaml 的 ui-theme.preference */
  function readDshThemePreference() {
    const file = path.join(dshHomeDir(), 'settings.yaml');
    try {
      const text = fs.readFileSync(file, 'utf8');
      const m = text.match(/(?:^|\n)\s*ui-theme:\s*\r?\n\s+preference:\s*["']?([\w-]+)/);
      if (m && m[1]) return m[1];
    } catch { /* 设置文件不存在或不可读 */ }
    return null;
  }

  /** 解析当前主题：light / dark（system 或未设置 → 跟随系统） */
  function resolveTheme() {
    const pref = readDshThemePreference();
    if (pref === 'light') return 'light';
    if (pref === 'dark') return 'dark';
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  /** 同步主题到 splash 与主窗口 */
  function applyTheme() {
    const theme = resolveTheme();
    if (ctx.splashWindow && !ctx.splashWindow.isDestroyed()) {
      ctx.splashWindow.webContents
        .executeJavaScript(`window.__setTheme(${JSON.stringify(theme)})`)
        .catch(() => {});
    }
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      const isDark = theme === 'dark';
      ctx.mainWindow.setBackgroundColor(isDark ? '#111318' : '#f8fafc');
      ctx.mainWindow.webContents.send('dsh:theme', theme);
    }
  }

  // system 偏好下，系统外观变化实时跟随
  nativeTheme.on('updated', applyTheme);

  // 监听 DSH 设置文件：GUI 内切换主题会写入 settings.yaml，实时同步标题栏/按钮颜色
  try {
    fs.watch(dshHomeDir(), (eventType, filename) => {
      if (filename && /^settings\.ya?ml$/i.test(filename)) {
        applyTheme();
      }
    });
  } catch { /* 设置目录不存在或不可监听时忽略 */ }

  ctx.theme = { resolveTheme, applyTheme };
}

module.exports = { install };
