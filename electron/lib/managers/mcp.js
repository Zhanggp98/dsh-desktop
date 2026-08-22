'use strict';

// ---------------------------------------------------------------------------
// MCP 管理（数据层 + IPC）：读写 profiles/web/cordis.patch.yml。
// 每个 MCP 服务器是一个 @deepseek-ai/dsh-mcp-client 插件实例。
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');
const { dshHomeDir, unquote } = require('../utils');
const { MCP_CLIENT_BUNDLE } = require('../config');

function mcpPatchPath() {
  return path.join(dshHomeDir(), 'profiles', 'web', 'cordis.patch.yml');
}

/** 解析 cordis.patch.yml（YAML 顶层数组），返回条目列表 [{ raw, id, name }] */
function parsePatchFile(text) {
  const entries = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let cur = null;
  const flush = () => {
    if (cur && cur.raw.length > 0) {
      const nameMatch = cur.raw.find((l) => /^\s{2}name:\s*/.test(l));
      cur.name = nameMatch ? unquote(nameMatch.replace(/^\s{2}name:\s*/, '')) : '';
      const idMatch = cur.raw.find((l) => /^-\s+id:\s*/.test(l));
      cur.id = idMatch ? unquote(idMatch.replace(/^-\s+id:\s*/, '')) : '';
      entries.push(cur);
    }
    cur = null;
  };
  for (const line of lines) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      if (cur) cur.raw.push(line);
      continue;
    }
    if (/^-\s/.test(line) || /^-\s*$/.test(line)) {
      flush();
      cur = { raw: [line] };
    } else if (cur) {
      cur.raw.push(line);
    }
  }
  flush();
  return entries;
}

/** 从条目 raw 文本解析 config 缩进块（顶层字段 2 空格，config 子字段 4 空格，args 子项 6 空格） */
function parseConfigBlock(raw) {
  const cfg = {};
  const lines = raw.split('\n');
  const startIdx = lines.findIndex((l) => /^\s{2}config:\s*$/.test(l));
  if (startIdx < 0) return cfg;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s{2}\S/.test(l)) break; // 回到 config 同级（其他顶层字段）
    const m = l.match(/^\s{4}([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (value.startsWith('[') || value === '') {
      // 数组或空 → 收集子行
      const arr = [];
      let j = i + 1;
      while (j < lines.length && /^\s{6}-\s/.test(lines[j])) {
        arr.push(unquote(lines[j].replace(/^\s{6}-\s*/, '')));
        j++;
      }
      cfg[m[1]] = value.startsWith('[')
        ? value.replace(/^\[|\]$/g, '').split(',').map((s) => unquote(s)).filter(Boolean)
        : arr;
      i = j - 1;
    } else {
      cfg[m[1]] = unquote(value);
    }
  }
  return cfg;
}

/** MCP 服务器列表 */
function listMcpServers() {
  const out = [];
  try {
    const p = mcpPatchPath();
    if (!fs.existsSync(p)) return out;
    const entries = parsePatchFile(fs.readFileSync(p, 'utf8'));
    for (const e of entries) {
      if (e.name !== MCP_CLIENT_BUNDLE) continue;
      const cfg = parseConfigBlock(e.raw.join('\n'));
      const serverName = cfg.serverName || e.id || '';
      const transport = cfg.transport || 'stdio';
      let detail = '';
      if (transport === 'stdio') {
        detail = [cfg.command, (cfg.args || []).join(' ')].filter(Boolean).join(' ');
      } else {
        detail = cfg.url || '';
      }
      out.push({
        id: e.id,
        name: serverName,
        detail,
        transport,
        command: cfg.command || '',
        args: cfg.args || [],
        url: cfg.url || '',
        headers: cfg.headers || '',
        enabled: true,
        tag: transport === 'stdio' ? 'stdio' : 'HTTP',
      });
    }
  } catch { /* 无配置 */ }
  return out;
}

/** 生成一条 MCP 条目文本（符合 DSH 标准缩进） */
function buildMcpEntry(entry, id) {
  const serverName = (entry.serverName || '').trim();
  const transport = entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  const lines = ['- id: ' + id, "  name: '" + MCP_CLIENT_BUNDLE + "'", '  config:'];
  lines.push('    serverName: ' + serverName);
  lines.push('    transport: ' + transport);
  if (transport === 'stdio') {
    const cmd = (entry.command || '').trim();
    const cmdQuote = /^[A-Za-z0-9_./\\:-]+$/.test(cmd) ? '' : "'";
    lines.push('    command: ' + cmdQuote + cmd + cmdQuote);
    const args = (Array.isArray(entry.args) ? entry.args : String(entry.args || '').split(/[,\s]+/))
      .map((s) => String(s).trim()).filter(Boolean);
    if (args.length > 0) {
      lines.push('    args:');
      for (const a of args) {
        const q = /^[A-Za-z0-9_./\\:-]+$/.test(a) ? '' : "'";
        lines.push('      - ' + q + a + q);
      }
    }
  } else {
    lines.push('    url: ' + (entry.url || '').trim());
    const hdr = (entry.headers || '').trim();
    if (hdr) lines.push('    headers: ' + hdr);
  }
  return lines.join('\n');
}

/** 保存（新增或编辑）MCP 服务器；返回 { ok, message, id? } */
function saveMcpServer(entry) {
  try {
    const p = mcpPatchPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '[]\n';
    const entries = parsePatchFile(text);
    const serverName = (entry.serverName || '').trim();
    if (!serverName) return { ok: false, message: 'serverName 不能为空' };
    const transport = entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
    if (transport === 'stdio' && !(entry.command || '').trim()) {
      return { ok: false, message: 'stdio 传输需要 command' };
    }
    if (transport === 'streamable-http' && !(entry.url || '').trim()) {
      return { ok: false, message: 'HTTP 传输需要 url' };
    }
    let id = (entry.id || '').trim();
    if (!id) id = 'mcp-' + serverName.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase();
    const newRaw = buildMcpEntry(entry, id);
    // 重建文件：非 MCP 条目原样保留；同 id 的 MCP 条目替换；新增追加
    const out = [];
    let replaced = false;
    for (const e of entries) {
      if (e.name === MCP_CLIENT_BUNDLE && e.id === id) {
        out.push(newRaw);
        replaced = true;
      } else {
        out.push(e.raw.join('\n'));
      }
    }
    if (!replaced) out.push(newRaw);
    const header = '# Your patch layer for this dsh profile, applied after every bundle layer:\n' +
      '# a top-level YAML array of loader patch entries (id-targeted config\n' +
      '# overrides, disables, and insert lists; `!!js` expressions allowed).\n';
    fs.writeFileSync(p, header + out.join('\n') + '\n', 'utf8');
    return { ok: true, id };
  } catch (e) {
    return { ok: false, message: e.message || '保存失败' };
  }
}

/** 删除 MCP 服务器；返回 { ok, message } */
function removeMcpServer(id) {
  try {
    const p = mcpPatchPath();
    if (!fs.existsSync(p)) return { ok: false, message: '配置文件不存在' };
    const entries = parsePatchFile(fs.readFileSync(p, 'utf8'));
    const out = [];
    let removed = false;
    for (const e of entries) {
      if (e.name === MCP_CLIENT_BUNDLE && e.id === id) {
        removed = true;
        continue;
      }
      out.push(e.raw.join('\n'));
    }
    if (!removed) return { ok: false, message: '未找到该 MCP 服务器' };
    fs.writeFileSync(p, out.join('\n') + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message || '删除失败' };
  }
}

function registerIpc() {
  ipcMain.handle('dsh:mcp-save', async (event, entry) => saveMcpServer(entry));
  ipcMain.handle('dsh:mcp-remove', async (event, id) => removeMcpServer(id));
}

module.exports = {
  install: () => registerIpc(),
  listMcpServers,
  saveMcpServer,
  removeMcpServer,
};
