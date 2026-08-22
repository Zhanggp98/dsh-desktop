# DeepSeek Harness 桌面应用

Electron 套壳封装 `dsh web`，提供 Codex 式的独立桌面窗口体验：左侧导航栏（Harness / 插件 / MCP / Skills 管理）、托盘常驻、单实例、进程生命周期管理，一键打包 Windows NSIS 安装程序。

> ⚠️ **平台支持**：目前仅支持 **Windows**（macOS / Linux 支持后续规划中）。

## ✨ 功能特性

- **三步启动动画**：Node.js 检查 → DeepSeek Harness 检查 → 服务启动，每步状态实时打勾/打叉
- **内置 Node.js**：安装包自带 Node（约 25MB），系统没装 Node 也能直接运行；winget 仅作兜底
- **环境自动修复**：缺 dsh 自动通过 npx 安装，零命令行
- **左侧导航栏**：Harness / 插件 / MCP / Skills 四个页面，悬停提示跟随鼠标位置
- **插件管理**：卡片化展示第三方插件，支持安装（npm registry）/ 卸载，成功靠卡片动画反馈
- **MCP 管理**：卡片化管理 MCP 服务器（stdio / streamable-http），支持添加 / 编辑 / 删除，保存后自动重启服务生效
- **Skills 管理**：扫描 DSH 标准技能位置（`~/.agents/skills` 等），支持文件夹导入安装 / 卸载，带过渡动画与高亮反馈
- **主题跟随**：启动画面、标题栏、窗口按钮、管理页全部跟随 DSH 主题（浅色 / 深色 / 跟随系统）
- **自定义标题栏**：鲸鱼图标 + 标题 + 可拖动窗口 + 毛玻璃 + 按钮随主题变色
- **关闭选择框**：点关闭时弹出勾选式选择（关闭窗口 / 关闭服务 多选组合），支持最小化到托盘 / 仅退出 / 退出并停止服务
- **托盘常驻**：托盘菜单区分「停止服务并退出」/「退出」
- **端口复用**：检测到 dsh web 已在运行则直接复用，否则自动拉起，避免多实例

## 📸 界面预览

> 截图待补充（见下方清单）。

**启动画面**（三步环境检查动画，主题跟随）：

| 加载中 · 深色 | 加载中 · 浅色 |
|---|---|
| ![启动加载中-深色](screenshots/splash_loading_dark.png) | ![启动加载中-浅色](screenshots/splash_loading_light.png) |

| 完成 · 深色 | 完成 · 浅色 |
|---|---|
| ![启动完成-深色](screenshots/splash_complete_dark.png) | ![启动完成-浅色](screenshots/splash_complete_light.png) |

**主界面**（独立窗口 + 自定义标题栏 + 左侧导航栏）：

| 深色主题 | 浅色主题 |
|---|---|
| ![主界面-深色](screenshots/main_dark.png) | ![主界面-浅色](screenshots/main_light.png) |

**插件管理页**（卡片化 + 安装/卸载）：

| 深色主题 | 浅色主题 |
|---|---|
| 📷 待截图：`screenshots/plugins_dark.png` | 📷 待截图：`screenshots/plugins_light.png` |

**MCP 管理页**（卡片化 + 添加/编辑/删除）：

| 深色主题 | 浅色主题 |
|---|---|
| 📷 待截图：`screenshots/mcp_dark.png` | 📷 待截图：`screenshots/mcp_light.png` |

**Skills 管理页**（技能卡片 + 导入入口）：

| 深色主题 | 浅色主题 |
|---|---|
| 📷 待截图：`screenshots/skills_dark.png` | 📷 待截图：`screenshots/skills_light.png` |

**关闭选择框**（勾选式，跟随主题）：

| 深色主题 | 浅色主题 |
|---|---|
| 📷 待截图：`screenshots/close_dialog_dark.png` | 📷 待截图：`screenshots/close_dialog_light.png` |

## 📷 截图任务清单

按顺序截好后放入 `screenshots/` 目录，README 里的引用即自动生效：

| # | 文件 | 内容 |
|---|---|---|
| 1 | `main_dark.png` | 主界面，深色主题（含左侧导航栏） |
| 2 | `main_light.png` | 主界面，浅色主题（含左侧导航栏） |
| 3 | `plugins_dark.png` | 插件管理页，深色 |
| 4 | `plugins_light.png` | 插件管理页，浅色 |
| 5 | `mcp_dark.png` | MCP 管理页，深色 |
| 6 | `mcp_light.png` | MCP 管理页，浅色 |
| 7 | `skills_dark.png` | Skills 管理页，深色 |
| 8 | `skills_light.png` | Skills 管理页，浅色 |
| 9 | `close_dialog_dark.png` | 关闭选择框，深色 |
| 10 | `close_dialog_light.png` | 关闭选择框，浅色 |

> 启动画面 4 张已有，无需重截。

## 🚀 开发运行

```bash
npm install            # 安装依赖（含 Electron 运行时）
npm start              # 启动桌面应用（自动拉起/复用 dsh web 并开窗口）
```

## 📦 打包安装程序

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

## ⚙️ 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_URL` | 覆盖 GUI 地址（默认 `http://localhost:3080`） |
| `DSH_DESKTOP_DSH_CMD` | 指定 dsh 可执行文件路径（默认自动定位：PATH → npx 缓存） |
| `DSH_DESKTOP_HOLD_SPLASH` | 预览模式：启动画面完成后停留不进入主页面（调试用） |

## 🧠 设计说明

- **Node 优先级**：系统已装 Node → 优先使用；系统没装 → 使用应用内置 Node（`resources/node`）。
- **端口复用**：启动时先探测 3080 并确认是 DSH 服务；已有实例则直接复用，否则后台拉起一个，避免多实例。
- **关闭行为**：点关闭弹出勾选式选择框——都不勾 = 最小化到托盘；仅勾窗口 = 退出客户端（服务保留）；仅勾服务 = 只停服务；都勾 = 退出并停止服务。
- **托盘常驻**：托盘菜单提供「停止服务并退出」（无条件结束 3080 服务）/「退出」（保留服务）。
- **MCP 配置**：读写 `~/.dsh/profiles/web/cordis.patch.yml`（DSH 标准 MCP 配置位置），每个服务器是 `@deepseek-ai/dsh-mcp-client` 插件实例。
- **Skills 来源**：按 DSH 标准位置扫描（`~/.agents/skills`、`~/.dsh/skills`、工作区 `.dsh/skills` / `.agents/skills`），安装即复制到 `~/.agents/skills`。
- **单实例**：重复打开应用会把已有窗口拉回前台。

## 📁 目录结构

```
dsh-desktop/
├── electron/
│   ├── main.js        # 主进程（窗口/托盘/生命周期/服务管理/IPC）
│   ├── preload.js     # 窗口控制桥接（标题栏按钮 + 管理页 IPC + 关闭选择）
│   ├── splash.html    # 启动动画（三步状态机，双主题）
│   ├── nav.html       # 左侧导航栏 + 内容 iframe 容器 + 关闭选择框
│   └── manage.html    # 插件/MCP/Skills 管理页（卡片化 UI）
├── build/
│   ├── icon.png       # 应用图标 256x256（黑鲸）
│   ├── icon-blue.png  # exe 内嵌图标（蓝鲸，桌面快捷方式）
│   ├── tray.png       # 托盘图标 32x32
│   ├── favicon-official.svg  # 官方鲸鱼矢量图
│   └── favicon-blue.svg      # 蓝色鲸鱼矢量图
├── vendor/node/       # 内置 Node 便携版（git 忽略，打包前置条件）
├── screenshots/       # 界面截图（README 引用）
├── convert-icon.js    # 图标生成脚本
├── package.json       # 依赖与 electron-builder 配置
└── dist/              # 打包产物
```
