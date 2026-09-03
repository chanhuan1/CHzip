# CHzip · 飞牛智能分卷解压

![Version](https://img.shields.io/badge/版本-v2.4-2786dc) ![Platform](https://img.shields.io/badge/平台-fnOS%20(x86_64%20%2F%20arm64)-2786dc) ![License](https://img.shields.io/badge/许可证-GPL--3.0-green) ![Language](https://img.shields.io/badge/语言-Chinese-orange)

> 面向 **fnOS（飞牛私有云）文件管理器右键场景**的专业压缩包处理工具：解压、分卷、选择性解压、文件预览、注释编辑、密码管理一站式完成。基于 7-Zip 引擎，Node.js 后端零运行时依赖、原生 JS 前端、深色模式加持。

在文件管理器里选中压缩包 → **右键 → 使用 CHzip 打开** → 点「开始解压」。就这么简单。

## 截图

| 界面截图 ① | 界面截图 ② |
| :-: | :-: |
| ![CHzip 界面截图 1](docs/images/1.png) | ![CHzip 界面截图 2](docs/images/2.png) |

## ✨ 功能特性

- **格式全**：7Z、ZIP、RAR、TAR、GZ、BZ2、XZ、ZST、CAB、ISO、ARJ、LZH 等主流压缩格式；`tar.gz`/`tar.bz2`/`tar.xz`/`tar.zst` 等单文件压缩自动识别。
- **分卷原生支持**：`.7z.001`、`.zip.001`、通用 `.001`、zip 传统分卷（`.z01`）、RAR 新式（`.part1.rar`）与旧式（`.r00`）分卷**自动合并**，缺卷即时报错提示。
- **智能文件树**：目录树预览、搜索过滤、勾选部分文件做**选择性解压**。
- **多代码页**：UTF-8 / GBK / Big5 / Shift-JIS / 韩文，国产软件常见乱码不再是问题。
- **免解压预览**：文本与代码（语法高亮 + 行号）、图片直接查看；支持加密包内文件（自动携带密码）。
- **深色模式**：自动跟随系统，可手动切换。
- **解压进度**：实时百分比 + 当前文件 + **预计剩余时间**，随时**取消**；失败自动清理半成品目录。
- **压缩包注释**：查看与编辑 ZIP / 7Z 注释。
- **密码管理器**：本地保存常用解压密码，按需快速填入（仅存当前浏览器）。
- **内置诊断**：一键生成脱敏诊断报告，配合权限问题排查。

## 🚀 快速开始

1. 在飞牛应用中心**手动安装** `CHzip_2.4_search-fixed_<架构>.fpk`（x86_64 / arm64）。
2. 文件管理器右键压缩包（分卷选中首卷即可）→「使用 CHzip 打开」。
3. 预览目录 → 选择目标路径 → 点「开始解压」。

> **权限提示**：请在 fnOS「应用设置」中给 CHzip 授予源文件与目标共享目录的**读写**权限。
> 首次使用若提示无法读取：在文件管理器对压缩包所在文件夹右键 → 详细信息 → 权限 → 新增 → 应用 → 添加 CHzip（源目录授读取、目标目录授读取+写入），保存后重试。

## 🛡️ 安全设计

- **路径越权防护**：严格校验条目路径（目录遍历 / 绝对路径 / 危险字符拦截）。
- **授权白名单**：解压输出目标必须落在 fnOS 授予的共享目录内（`realpath` 校验）。
- **临时密码文件即焚**：密码不落命令行，写临时文件用后**多次随机覆写再删除**。
- **源文件防篡改**：任务前后对压缩包做 dev/ino/size/mtime 指纹校验。
- **日志脱敏**：诊断日志自动打码敏感值，按请求 ID 追踪。

## 🧩 技术架构

- **后端**：Node.js ≥ 22，CGI-per-request 模型，零运行时依赖。
- **前端**：原生 JavaScript（IIFE），无框架、无构建步骤。
- **解压引擎**：内置 7-Zip（7zzs），按架构分发 `linux-x64` / `linux-arm64`。
- **任务模型**：后台 detached worker + 文件态任务（队列 → 运行 → 成功/失败），支持取消与跨页面续看。
- **打包**：fnOS FPK（`scripts/build-fpk.js`，需 `fnpack`）。

```
CHzip/
├── app/
│   ├── server/              # Node.js CGI 后端（api.js + lib/）
│   ├── ui/                  # CGI 桥接（index.cgi / api.cgi）
│   ├── www/                 # 前端静态资源（js / css / fonts）
│   └── vendor/7zip/         # 内置 7zzs 二进制（构建时按架构剥发）
├── cmd/                     # fnOS 生命周期脚本
├── config/                  # 应用配置（privilege / resource）
├── scripts/                 # 构建与发布脚本
├── tests/                   # node --test 单元测试
├── docs/images/             # 文档截图
├── manifest                 # fnOS 应用清单
└── API.md                   # CGI API 文档
```

## 🕒 更新日志

### v2.4（2026-09-03）
- **深色模式修复**：下拉框/输入框/按钮/弹窗等控件改用主题色，暗色下清晰不刺眼（新增 `color-scheme` 适配原生控件）。
- **进度条重做**：圆角高光轨道 + 成功/失败着色 + 启动期呼吸动画 + **预计剩余时间**；任务状态按阶段显示（解压/检查文件列表/准备嵌套归档）。
- 更新应用介绍与文档表述（去掉不实能力声明）。

### v2.3
- 修复 `preview-file`：图片按二进制直读（原会损坏），加密包内/多字节文件名预览可用。
- 跨进程解压限流（最多 3 个并发任务），请求体加 16 MiB 上限与规范错误码。
- 清理：统一 `CHzipTree` 命名、移除死按钮、打包剔除 `.DS_Store`、修复若干前端竞态。

### v2.1 / v2.2
- 修复解压 504 与「正在校验」卡死：预览/请求路径不再同步跑整包完整性测试，改为后台任务实时进度；密码在解压时校验。
- 修复前端 6 处密码流程崩溃（ReferenceError）；授权脚本与审计对齐 2.x 命名与版本。

### v2.0
- 全面重构并改名为 **CHzip**：前端模块化（单一 `main.js` → `app.js` + `ui-*`）、后端新增任务存储/指纹/目录授权/嵌套 tar 支持、补齐测试。

## 🛠️ 开发 / 构建 / 测试

```bash
npm test                 # node --test，84 个用例
node --check app/server/api.js   # 语法检查
node scripts/build-fpk.js        # 构建 dist/*.fpk（双架构，需 fnpack）
node scripts/audit-fpk.js        # 发布审计（校验和/版本/架构/搜索特性）
```

> 说明：单元测试通过依赖注入运行，内置 7zzs 为 Linux ELF，需在目标 fnOS 环境做真机回归。

## 📄 文档

- [API 文档](API.md)：CGI 端点、错误码与数据结构。
- [CONTRIBUTING](CONTRIBUTING.md)：参与贡献指南。

## ⚖️ 许可与致谢

本项目基于 [GNU GPL-3.0](LICENSE) 开源，源自 [ff-xin/xinZip](https://github.com/ff-xin/xinZip) 与[飞牛论坛原帖](https://club.fnnas.com/forum.php?mod=viewthread&tid=64284&highlight=)继续开发。内置 7-Zip（LGPL）与 Inter 字体（SIL OFL）遵循各自许可证，见对应上游。
