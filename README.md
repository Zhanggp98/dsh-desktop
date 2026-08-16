# DeepSeek Harness 桌面应用

Electron 套壳封装 `dsh web`，提供 Codex 式的独立桌面窗口体验（托盘常驻、单实例、进程生命周期管理）。

> ⚠️ **平台支持**：目前仅支持 **Windows**（macOS / Linux 支持后续规划中）。

## 界面预览

**启动画面**（三步环境检查动画：Node 检查 → dsh 检查 → 服务启动，主题跟随 DSH 设置）：

| 加载中 · 深色 | 加载中 · 浅色 |
|---|---|
| ![启动加载中-深色](screenshots/splash_loading_dark.png) | ![启动加载中-浅色](screenshots/splash_loading_light.png) |

| 完成 · 深色 | 完成 · 浅色 |
|---|---|
| ![启动完成-深色](screenshots/splash_complete_dark.png) | ![启动完成-浅色](screenshots/splash_complete_light.png) |

**主界面**（独立窗口 + 自定义标题栏）：

| 深色主题 | 浅色主题 |
|---|---|
| ![主界面-深色](screenshots/main_dark.png) | ![主界面-浅色](screenshots/main_light.png) |

## 功能特性

- **三步启动动画**：Node.js 检查 → DeepSeek Harness 检查 → 服务启动，每步状态实时打勾/打叉
- **内置 Node.js**：安装包自带 Node（约 25MB），系统没装 Node 也能直接运行，无需下载安装；winget 仅作兜底
- **环境自动修复**：缺 dsh 自动通过 npx 安装，零命令行
- **主题跟随**：启动画面、标题栏、窗口按钮颜色全部跟随 DSH 主题（浅色/深色/跟随系统）
- **自定义标题栏**：鲸鱼图标 + 标题 + 可拖动窗口 + 按钮随主题变色
- **托盘常驻**：关闭窗口最小化到托盘；托盘菜单区分「停止服务并退出」/「退出」
- **端口复用**：检测到 dsh web 已在运行则直接复用，否则自动拉起

## 开发运行

```bash
npm install            # 安装依赖（含 Electron 运行时）
npm start              # 启动桌面应用（自动拉起/复用 dsh web 并开窗口）
```

## 打包安装程序

> ⚠️ **打包前先准备内置 Node**：项目用 `vendor/node` 里的便携版 Node（打包时打进 `resources/node`）。
> 它不在 git 仓库里（体积大），需要先下载解压：

```bash
# 下载 Node 便携版（以 v26.7.0 为例，npmmirror 镜像）
curl -L -o node.zip https://npmmirror.com/mirrors/node/v26.7.0/node-v26.7.0-win-x64.zip
# 解压并重命名到 vendor/node（去掉版本号目录）
Expand-Archive node.zip -DestinationPath vendor-tmp
Move-Item vendor-tmp/node-v26.7.0-win-x64 vendor/node
```

然后打包：

```bash
npm run pack           # 生成免安装目录（dist/win-unpacked/）
npm run dist           # 生成 NSIS 安装程序（dist/DeepSeek Harness Setup *.exe）
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_URL` | 覆盖 GUI 地址（默认 `http://localhost:3080`） |
| `DSH_DESKTOP_DSH_CMD` | 指定 dsh 可执行文件路径（默认自动定位：PATH → npx 缓存） |
| `DSH_DESKTOP_HOLD_SPLASH` | 预览模式：启动画面完成后停留不进入主页面（调试用） |

## 设计说明

- **Node 优先级**：系统已装 Node → 优先使用；系统没装 → 使用应用内置 Node（`resources/node`）。
- **端口复用**：启动时先探测 3080 并确认是 DSH 服务；已有实例则直接复用，否则后台拉起一个，避免多实例。
- **托盘常驻**：点关闭 = 最小化到托盘，任务后台继续；「停止服务并退出」会无条件结束 3080 服务，「退出」保留服务。
- **单实例**：重复打开应用会把已有窗口拉回前台。

## 目录结构

```
dsh-desktop/
├── electron/
│   ├── main.js        # 主进程（窗口/托盘/生命周期）
│   ├── preload.js     # 窗口控制桥接（自绘标题栏按钮）
│   └── splash.html    # 启动动画（三步状态机，双主题）
├── build/
│   ├── icon.png       # 应用图标 256x256（黑鲸）
│   ├── icon-blue.png  # exe 内嵌图标（蓝鲸，桌面快捷方式）
│   ├── tray.png       # 托盘图标 32x32
│   ├── favicon-official.svg  # 官方鲸鱼矢量图
│   └── favicon-blue.svg      # 蓝色鲸鱼矢量图
├── vendor/node/       # 内置 Node 便携版（git 忽略，打包前置条件）
├── screenshots/       # 界面截图
├── convert-icon.js    # 图标生成脚本
├── package.json       # 依赖与 electron-builder 配置
└── dist/              # 打包产物
```
