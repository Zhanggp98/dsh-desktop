'use strict';

// ---------------------------------------------------------------------------
// 启动流程编排：环境检查 → 服务探测 → 启动/复用 → 进入主界面。
// 纯编排层，具体步骤委托 env / server / splash / theme / window / tray / update。
// ---------------------------------------------------------------------------

const { app, dialog } = require('electron');
const { delay } = require('./utils');
const { SPLASH_MIN_MS } = require('./config');

function install(ctx) {
  /** 显示状态并执行任务，该条状态至少展示 minMs（实际耗时超过则按实际） */
  async function statusWhile(text, fn, minMs = 1_000) {
    ctx.splash.setStatus(text);
    const start = Date.now();
    const result = await fn();
    const elapsed = Date.now() - start;
    if (elapsed < minMs) await delay(minMs - elapsed);
    return result;
  }

  async function boot() {
    const bootStart = Date.now();
    ctx.splash.createSplash();

    try {
      // ---------- 第 1 步：检查 Node.js ----------
      const nodeResult = await statusWhile('正在检查 Node.js 环境…', async () => {
        let v = await ctx.env.checkNode();
        let dir = null;
        if (!v) {
          // 系统无 Node → 使用应用内置 Node（随安装包提供，无需用户安装）
          const bDir = ctx.env.bundledNodeDir();
          if (bDir) {
            const bv = await ctx.env.runNodeVersion(bDir);
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
        const hasWinget = await ctx.env.checkWinget();
        if (!hasWinget) {
          ctx.splash.setStatus('Node.js 环境不可用');
          await delay(600);
          dialog.showErrorBox(
            '缺少 Node.js',
            '未检测到 Node.js，且系统没有 winget 也无法自动安装。\n\n请安装 Node.js 后重新打开本应用。'
          );
          app.quit();
          return;
        }
        ctx.splash.setStatus('正在通过 winget 安装 Node.js…\n（如弹出授权窗口请点击"是"）');
        const installed = await ctx.env.installNodeViaWinget();
        if (!installed) {
          ctx.splash.setStatus('Node.js 自动安装失败');
          await delay(600);
          dialog.showErrorBox('Node.js 安装失败', '通过 winget 自动安装 Node.js 失败。请手动安装后重试。');
          app.quit();
          return;
        }
        nodeDir = ctx.env.locateNodeDir();
        if (nodeDir) nodeVer = await ctx.env.runNodeVersion(nodeDir);
        if (!nodeVer) {
          ctx.splash.setStatus('Node.js 已安装但未能定位');
          await delay(600);
          dialog.showErrorBox('Node.js 定位失败', 'Node.js 已安装，但未能在标准目录中找到。请重试。');
          app.quit();
          return;
        }
      }

      // ---------- 第 2 步：检查 dsh / 服务状态 ----------
      const probe = await statusWhile('正在检查 DeepSeek Harness…', async () => {
        const portOpen = await ctx.server.isPortOpen(ctx.server.port);
        if (portOpen) {
          // 端口通：确认是 DSH 服务才复用，防止误连其他程序
          const dshOk = await ctx.server.isDshService();
          if (dshOk) return { running: true, dsh: null };
          return { running: false, conflict: true, dsh: null };
        }
        return { running: false, dsh: ctx.env.findDshCommand() };
      });

      // ---------- 第 3 步：启动 / 复用服务 ----------
      if (probe.running) {
        // 服务已在运行：直接复用（不重复拉起，保证会话一致）
        ctx.splash.setStatus('服务已在运行');
      } else if (probe.conflict) {
        ctx.splash.setStatus('端口被其他程序占用');
        await delay(600);
        dialog.showErrorBox(
          '端口被占用',
          `端口 ${ctx.server.port} 已被其他程序占用，且不是 DeepSeek Harness 服务。\n\n请关闭占用该端口的程序后重试。`
        );
        app.quit();
        return;
      } else {
        // 启动服务
        await statusWhile('正在启动服务…', async () => {
          if (probe.dsh && probe.dsh !== 'npx') {
            await ctx.server.launchServer(probe.dsh, false, nodeDir);
          } else {
            // 无 dsh：先显示安装中
            ctx.splash.setStatus('正在安装 DeepSeek Harness…');
            await ctx.server.launchServer(null, true, nodeDir);
          }
        });
      }

      // ---------- 进入主页面 ----------
      await delay(Math.max(0, SPLASH_MIN_MS - (Date.now() - bootStart)));

      // 预览模式：加载完成后停留在 splash，不进入主页面（DSH_DESKTOP_HOLD_SPLASH=1）
      if (process.env.DSH_DESKTOP_HOLD_SPLASH === '1') {
        return;
      }

      ctx.window.createWindow();
      ctx.trayCtrl.createTray();
      // 启动完成后自动检查更新（不阻塞）
      ctx.update.autoCheck();
      // 等主窗口真正显示后再关闭 splash，避免出现空白间隙
      if (ctx.splashWindow) {
        const closeSplash = () => ctx.splashWindow && ctx.splashWindow.close();
        if (ctx.mainWindow && ctx.mainWindow.isVisible()) {
          closeSplash();
        } else {
          ctx.mainWindow.once('ready-to-show', closeSplash);
        }
      }
    } catch (err) {
      ctx.splash.setStatus('启动失败');
      await delay(500);
      dialog.showErrorBox('启动失败', err.message);
      app.quit();
    }
  }

  ctx.boot = boot;
}

module.exports = { install };
