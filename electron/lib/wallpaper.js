'use strict';

// ---------------------------------------------------------------------------
// 壳窗口背景同步：读取 Harness iframe 的 DSH 标准 CSS 变量（壁纸/主题色），
// 同步给壳窗口 body；在 iframe 注入 MutationObserver，事件驱动、零轮询。
// 与具体插件解耦：只读标准变量，不引用任何插件。
// ---------------------------------------------------------------------------

const { ipcMain } = require('electron');
const { PORT } = require('./config');

function install(ctx) {
  /** 从 Harness iframe 读取壁纸与主题色 CSS 变量，同步给壳窗口 */
  function sync() {
    if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
    try {
      const frames = ctx.mainWindow.webContents.mainFrame.frames;
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
                if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
                  // 防御：仅当 body 声明 data-dsh-bg="image"（壁纸激活）时才同步壁纸，
                  // 避免残留变量导致壳窗口显示过期背景
                  if (obj.bg !== 'image') {
                    obj.img = '';
                    obj.fill = '';
                  }
                  ctx.mainWindow.webContents.send('dsh:wallpaper', obj);
                }
              } catch { /* 忽略 */ }
            })
            .catch(() => {});
          return;
        }
      }
    } catch { /* 帧不可用 */ }
  }

  /**
   * 在 Harness iframe 注入通用 DOM 变化监听（MutationObserver）：
   * 同时监听 documentElement（外观切换 colorScheme/data-theme）与 body（壁纸变量/主题 token），
   * 任何相关属性变化都立即通知壳窗口同步。不依赖任何具体插件。
   */
  function ensureObserver() {
    if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
    try {
      const frames = ctx.mainWindow.webContents.mainFrame.frames;
      for (const f of frames) {
        if (f.url && f.url.indexOf('localhost:' + PORT) !== -1) {
          f.executeJavaScript(`(() => {
            if (window.__dshHarnessObserver) return 'exists';
            const notify = () => {
              try { window.parent.postMessage({ source: 'dsh-harness', type: 'body-changed' }, '*'); } catch (e) {}
            };
            const obs = new MutationObserver(notify);
            obs.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['style', 'class', 'data-theme', 'color-scheme'],
              subtree: false,
            });
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

  // 事件驱动：iframe 内 DOM 变化 → postMessage → nav.html 转发 → 这里触发同步
  ipcMain.on('dsh:wallpaper-changed', () => {
    sync();
  });

  ctx.wallpaper = { sync, ensureObserver };
}

module.exports = { install };
