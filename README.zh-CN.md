# Disk Space Analyze

[English](README.md) | [简体中文](README.zh-CN.md)

![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust)
![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)

Disk Space Analyze 是一个使用 Rust 和 Tauri 2 构建的轻量级桌面磁盘空间分析工具。它可以扫描本机磁盘、移动盘或映射的网络驱动器，例如 `Z:\`，并以类似 SpaceSniffer 的矩形树图展示目录和文件占用，帮助你快速定位大文件和大目录。

应用在本机运行，不会上传文件名、路径或扫描结果。

## 截图

以下截图使用演示数据。

![总览](docs/images/overview.png)

![目录下钻](docs/images/drilldown.png)

## 功能特性

- 扫描本机磁盘、移动盘、映射网络驱动器，或手动输入的任意目录路径。
- 使用可点击矩形树图展示磁盘占用。
- 点击目录下钻查看子目录，通过面包屑返回上层。
- 显示文件数量、目录数量、总大小、扫描进度和访问错误样本。
- 支持取消正在进行的扫描。
- 支持在 Windows 资源管理器中打开选中的文件或目录。
- 跳过符号链接和目录联接点，避免递归循环和重复统计。
- 对超大目录保留最大的子项，并将较小项目合并为聚合节点，保持界面流畅。

## 环境要求

- Windows 10/11
- Rust stable 工具链
- Tauri 2 系统依赖：
  - Microsoft C++ Build Tools
  - Microsoft Edge WebView2 Runtime

如果已经安装 `cargo`，但终端中无法直接访问，可以使用完整路径，例如：

```powershell
C:\Users\<you>\.cargo\bin\cargo.exe --version
```

## 快速开始

克隆仓库后运行应用：

```powershell
cargo run --manifest-path .\src-tauri\Cargo.toml
```

也可以使用 Tauri CLI：

```powershell
cargo install tauri-cli --version "^2"
cargo tauri dev
```

## 构建

生成 release 版本：

```powershell
cargo build --release --manifest-path .\src-tauri\Cargo.toml
```

应用本体会生成在：

```text
target\release\disk-space-analyze.exe
```

## 打包

生成 Windows 单文件 NSIS 安装包：

```powershell
cargo tauri build --bundles nsis
```

安装包会生成在：

```text
target\release\bundle\nsis\Disk Space Analyze_0.1.0_x64-setup.exe
```

## 使用方式

1. 启动应用。
2. 从左侧选择驱动器，或输入路径，例如 `C:\`、`D:\Projects`、`Z:\`。
3. 点击 **扫描**。
4. 点击目录矩形进入下一级。
5. 使用面包屑或 **上层** 返回。
6. 选中文件或目录后，点击 **打开位置** 在 Windows 资源管理器中定位。

## 项目结构

```text
.
|-- docs/
|   `-- images/              # README 截图
|-- src-tauri/
|   |-- capabilities/        # Tauri 命令权限
|   |-- icons/               # Windows 应用图标
|   |-- permissions/         # 自定义 Tauri 权限清单
|   |-- src/main.rs          # Rust 扫描后端和 Tauri 命令
|   |-- Cargo.toml
|   `-- tauri.conf.json
|-- ui/
|   |-- app.js               # 矩形树图 UI 和 Tauri IPC 逻辑
|   |-- index.html
|   `-- styles.css
|-- Cargo.toml               # Workspace 清单
|-- README.md
`-- README.zh-CN.md
```

## 架构说明

应用由原生扫描后端和静态前端组成：

- `src-tauri/src/main.rs`
  - 枚举可用根目录和映射驱动器
  - 在后台线程扫描目录
  - 向界面发送扫描进度和完成事件
  - 提供取消扫描和在资源管理器中打开路径的命令
- `ui/app.js`
  - 调用 Tauri 命令
  - 监听扫描事件
  - 渲染矩形树图、面包屑、指标和详情面板

## 注意事项

- 扫描完整系统盘或较慢的网络驱动器可能需要较长时间。
- 部分受保护目录可能出现访问拒绝错误，这些错误会被统计并显示在访问问题面板中。
- 当前统计的是文件字节大小，不是磁盘上的物理占用大小。
- 目前主要面向 Windows。其他平台可能需要针对驱动器枚举和文件管理器打开逻辑做少量适配。

## Roadmap

- 导出扫描报告为 JSON 或 HTML。
- 在扫描结果中增加搜索和过滤。
- 增加文件扩展名统计。
- 增加可选的物理占用大小统计模式。
- 增加扫描历史记录。

## 参与贡献

欢迎提交 Issue 和 Pull Request。较大的改动建议先开 Issue 讨论实现方向。

提交改动前建议运行：

```powershell
cargo fmt --manifest-path .\src-tauri\Cargo.toml
cargo check --manifest-path .\src-tauri\Cargo.toml
```

## 许可证

本项目使用 GNU General Public License v3.0 only 开源协议。详情请查看 [LICENSE](LICENSE)。
