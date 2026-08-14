'use strict';

/**
 * 将官方 favicon.svg（黑鲸）转换为应用图标 PNG。
 * 用法: node convert-icon.js
 * 产物: build/icon.png (256x256)  build/tray.png (32x32)
 */

const sharp = require('E:/Workspace/node_modules/sharp');
const path = require('path');

const SRC = path.join(__dirname, 'build', 'favicon-official.svg');
const ICON_OUT = path.join(__dirname, 'build', 'icon.png');
const TRAY_OUT = path.join(__dirname, 'build', 'tray.png');

async function main() {
  const svg = sharp(SRC, { density: 300 }); // 高密度渲染，保证放大边缘平滑

  const iconBuf = await svg.clone().resize(256, 256).png().toBuffer();
  require('fs').writeFileSync(ICON_OUT, iconBuf);
  console.log('saved', ICON_OUT, iconBuf.length, 'bytes');

  const trayBuf = await svg.clone().resize(32, 32).png().toBuffer();
  require('fs').writeFileSync(TRAY_OUT, trayBuf);
  console.log('saved', TRAY_OUT, trayBuf.length, 'bytes');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
