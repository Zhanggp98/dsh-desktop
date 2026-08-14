# DeepSeek Harness 桌面应用

Electron 套壳封装 `dsh web`，提供 Codex 式的独立桌面窗口体验（托盘常驻、单实例、进程生命周期管理）。

## 开发运行

```bash
npm install            # 安装依赖（含 Electron 运行时）
npm start              # 启动桌面应用（自动拉起/复用 dsh web 并开窗口）
```

## 打包安装程序

```bash
npm run pack           # 生成免安装目录（dist/win-unpacked/）
npm run dist           # 生成 NSIS 安装程序（dist/DeepSeek Harness Setup *.exe）
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_URL` | 覆盖 GUI 地址（默认 `http://localhost:3080`） |
| `DSH_DESKTOP_DSH_CMD` | 指定 dsh 可执行文件路径（默认自动定位：PATH → npx 缓存） |

## 设计说明

- **端口复用**：启动时先探测 3080；已有 dsh web 在跑（如浏览器 GUI 已打开）则直接复用，否则后台拉起一个。
- **托盘常驻**：点关闭 = 最小化到托盘，任务后台继续；托盘菜单"退出"才结束进程并清理子进程。
- **单实例**：重复打开应用会把已有窗口拉回前台。

## 目录结构

```
dsh-desktop/
├── electron/
│   └── main.js        # 主进程（窗口/托盘/生命周期）
├── build/
│   ├── icon.png       # 应用图标 256x256
│   └── tray.png       # 托盘图标 32x32
├── package.json       # 依赖与 electron-builder 配置
└── dist/              # 打包产物
```
