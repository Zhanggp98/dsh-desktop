'use strict';

/**
 * 图标转换：
 *  - build/icon.png / build/tray.png     ← 黑色鲸鱼（应用运行时：窗口/标题栏/托盘/splash）
 *  - build/icon-blue.png                 ← 蓝色鲸鱼（仅用于 exe 内嵌图标 → 桌面快捷方式）
 */

const sharp = require('E:/Workspace/dsh-desktop/.icon-tools/node_modules/sharp');
const path = require('path');
const fs = require('fs');

const BLACK_SRC = path.join(__dirname, 'build', 'favicon-official.svg');
const BLUE_SRC = path.join(__dirname, 'build', 'favicon-blue.svg');
const ICON_OUT = path.join(__dirname, 'build', 'icon.png');          // 黑 256
const TRAY_OUT = path.join(__dirname, 'build', 'tray.png');          // 黑 32
const BLUE_OUT = path.join(__dirname, 'build', 'icon-blue.png');     // 蓝 256

async function main() {
  const black = sharp(BLACK_SRC, { density: 300 });
  const blue = sharp(BLUE_SRC, { density: 300 });

  const iconBuf = await black.clone().resize(256, 256).png().toBuffer();
  fs.writeFileSync(ICON_OUT, iconBuf);
  console.log('saved 黑鲸 icon.png', iconBuf.length, 'bytes');

  const trayBuf = await black.clone().resize(32, 32).png().toBuffer();
  fs.writeFileSync(TRAY_OUT, trayBuf);
  console.log('saved 黑鲸 tray.png', trayBuf.length, 'bytes');

  const blueBuf = await blue.clone().resize(256, 256).png().toBuffer();
  fs.writeFileSync(BLUE_OUT, blueBuf);
  console.log('saved 蓝鲸 icon-blue.png', blueBuf.length, 'bytes');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
