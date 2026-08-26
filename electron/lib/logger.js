'use strict';

// ---------------------------------------------------------------------------
// 轻量日志：写入用户数据目录 logs/app.log，便于远程排查。
// 记录启动流程关键节点、spawn 命令、错误详情（含编码修正）。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

let logFile = null;
let logStream = null;
let logDir = null;

/**
 * 初始化日志：优先写入安装目录 logs/app.log（卸载时随程序删除），
 * 若安装目录不可写（如 Program Files 权限不足）则回退用户数据目录。
 */
function init(userDataDir) {
  // 候选目录：安装根目录/logs（resourcesPath 上一级）→ userData/logs
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, '..', 'logs'));
  }
  candidates.push(path.join(userDataDir, 'logs'));
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 测试可写：创建临时文件
      const probe = path.join(dir, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      logFile = path.join(dir, 'app.log');
      logStream = fs.createWriteStream(logFile, { flags: 'a' });
      logFile = logFile;
      break;
    } catch {
      logStream = null;
    }
  }
  // 暴露日志目录（供 UI/卸载提示使用）
  if (logFile) logDir = path.dirname(logFile);
}

/** 格式化时间戳 */
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * 记录日志。
 * @param {string} level - info / warn / error
 * @param {string} msg - 消息
 * @param {*} extra - 可选附加数据（对象将被 JSON 序列化）
 */
function log(level, msg, extra) {
  let line = `[${ts()}] [${level}] ${msg}`;
  if (extra !== undefined) {
    try {
      line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
    } catch {
      line += ' [extra 序列化失败]';
    }
  }
  line += '\n';
  if (logStream) {
    try { logStream.write(line); } catch { /* 忽略 */ }
  }
  // 同时输出到主进程控制台（便于开发调试）
  if (process.env.DSH_DESKTOP_DEBUG) {
    process.stdout.write(line);
  }
}

/** 关闭日志流（应用退出时调用） */
function close() {
  try {
    if (logStream) logStream.end();
  } catch { /* 忽略 */ }
}

module.exports = { init, log, close, getLogDir: () => logDir };
