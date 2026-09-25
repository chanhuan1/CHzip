<div align="center">

<img src="ICON_256.PNG" width="128" alt="CHzip logo"/>

# CHzip · 飞牛智能分卷解压

面向 **fnOS（飞牛私有云）文件管理器右键场景**的专业压缩包处理工具 —— 解压 · 分卷 · 选择性解压 · 文件预览 · 密码管理，一键完成。

[![版本](https://img.shields.io/badge/版本-v3.9-2786dc?style=flat-square)](https://github.com/chanhuan1/CHzip/releases)
[![平台](https://img.shields.io/badge/平台-fnOS%20(x86_64%20·%20arm64)-2786dc?style=flat-square)]()
[![Stars](https://img.shields.io/github/stars/chanhuan1/CHzip?style=flat-square&label=Stars&color=2786dc)](https://github.com/chanhuan1/CHzip/stargazers)
[![Forks](https://img.shields.io/github/forks/chanhuan1/CHzip?style=flat-square&label=Forks&color=2786dc)](https://github.com/chanhuan1/CHzip/forks)
[![Issues](https://img.shields.io/github/issues/chanhuan1/CHzip?style=flat-square&label=Issues&color=2786dc)](https://github.com/chanhuan1/CHzip/issues)
[![License](https://img.shields.io/github/license/chanhuan1/CHzip?style=flat-square&color=brightgreen)](LICENSE)

**⭐ 觉得好用就点个 Star，是对作者最大的支持！**

在文件管理器里选中压缩包 → **右键 → 使用 CHzip 打开** → 点「开始解压」。

</div>

---

## 📸 界面截图

| 界面截图 ① | 界面截图 ② |
| :-: | :-: |
| ![CHzip 界面截图 1](docs/images/1.png) | ![CHzip 界面截图 2](docs/images/2.png) |

## ✨ 功能特性

**格式与分卷**
- 主流格式全覆盖：`7Z` `ZIP` `RAR` `TAR` `GZ` `BZ2` `XZ` `ZST` `CAB` `ISO` `ARJ` `LZH` `CBZ` `CBR` `EPUB` `WIM` `DMG` 等；`tar.gz`/`tar.bz2`/`tar.xz`/`tar.zst` 等单文件压缩自动识别。
- **分卷原生支持**：`.7z.001`、`.zip.001`、通用 `.001`、zip 传统分卷 `.z01`、RAR 新式 `.part1.rar` 与旧式 `.r00` **自动合并**，缺卷即时提示。

**易用体验**
- 智能文件树预览：搜索过滤、勾选部分文件做**选择性解压**。
- **多代码页**：UTF-8 / GBK / Big5 / Shift-JIS / 韩文，国产软件常见乱码不再是问题。
- **免解压预览**：文本与代码（语法高亮 + 行号）、图片直读，加密包内文件也支持。
- **深色模式**：自动跟随系统，可手动切换。
- **解压进度**：实时百分比 + 当前文件 + **预计剩余时间**，随时**取消**，失败自动清理半成品目录。
- **压缩包注释**：查看与编辑 ZIP / 7Z 注释。
- **密码管理器**：本地保存常用解压密码，按需快速填入。
- **内置诊断**：一键生成脱敏诊断报告，权限问题不求人。

**🔒 安全设计**
- 路径越权防护（目录遍历 / 绝对路径 / 危险字符拦截）+ 授权目录白名单。
- 临时密码文件用后即焚（多次随机覆写再删除）；任务前后源文件指纹校验。
- 诊断日志自动脱敏，按请求 ID 追踪。

---

## 🚀 快速开始

1. 在飞牛应用中心手动安装 `CHzip_3.9_<架构>.fpk`（x86_64 / arm64）。
2. 文件管理器右键压缩包（分卷选中首卷即可）→「使用 CHzip 打开」。
3. 预览目录 → 选择目标路径 → 点「开始解压」。

> **权限提示**：请在 fnOS「应用设置」给 CHzip 授予源文件与目标共享目录的**读写**权限。

## ⭐ Star 统计

喜欢这个项目的话，欢迎点右上角 **Star** 并分享给身边用飞牛的伙伴～
## Star History

<a href="https://www.star-history.com/">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=chanhuan1/CHzip&type=date&theme=dark&legend=top-left&sealed_token=RVnoCTXiI1u6i9Hfsw0kRYN2Mjp-oK6_60JTg4kCzxNxryDDHin-UVO7rIzJGNH_QV1e6ygGGdRD4PP941Ughveuc4xokAQm7zTfzOVsJb3wk4_j5Fp4TQ" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=chanhuan1/CHzip&type=date&legend=top-left&sealed_token=RVnoCTXiI1u6i9Hfsw0kRYN2Mjp-oK6_60JTg4kCzxNxryDDHin-UVO7rIzJGNH_QV1e6ygGGdRD4PP941Ughveuc4xokAQm7zTfzOVsJb3wk4_j5Fp4TQ" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=chanhuan1/CHzip&type=date&legend=top-left&sealed_token=RVnoCTXiI1u6i9Hfsw0kRYN2Mjp-oK6_60JTg4kCzxNxryDDHin-UVO7rIzJGNH_QV1e6ygGGdRD4PP941Ughveuc4xokAQm7zTfzOVsJb3wk4_j5Fp4TQ" />
 </picture>
</a>

## 🧩 技术架构

- **后端**：Node.js ≥ 22 · CGI-per-request · 零运行时依赖。
- **前端**：原生 JavaScript（IIFE），无框架、无构建步骤。
- **解压引擎**：内置 7-Zip（`7zzs`），按架构分发 `linux-x64` / `linux-arm64`。
- **任务模型**：后台 detached worker + 文件态任务（排队 → 运行 → 成功/失败），支持取消与跨页面续看。
- **打包**：fnOS FPK（`scripts/build-fpk.js`，需 `fnpack`）。

```
CHzip/
├── app/
│   ├── server/              # Node.js CGI 后端（api.js + lib/）
│   ├── ui/                  # CGI 桥接（index.cgi / api.cgi）
│   ├── www/                 # 前端静态资源（js / css / fonts）
│   └── vendor/7zip/         # 内置 7zzs（构建时按架构剥发）
├── cmd/                     # fnOS 生命周期脚本
├── config/                  # 应用配置（privilege / resource）
├── scripts/                 # 构建与发布脚本
├── tests/                   # node --test 单元测试
├── docs/images/             # 文档截图
├── manifest                 # fnOS 应用清单
└── API.md                   # CGI API 文档
```

## 🕒 更新日志

### v3.9（2026-09-25）
- **修复：文件树实时高亮在真机上完全不亮**。三个真机根因逐一排查定位（靠新增的
  `?debugHighlight=1` 调试开关在飞牛上抓日志）：
  1. 解压 `.gz` 等单文件流时，7-Zip `-bsp1` 输出的「当前文件」是 `1`、`2`… 这样的
     **已处理文件计数**而非文件名，`engine.js` 原样传给前端，文件树拿 `"1"/"2"` 匹配
     路径（永远 NONE）。已过滤纯数字序号。
  2. 真机 7-Zip 用 `\b`（退格符）+ 空格做原地刷新，文件名前带一串 `\b` 与 `- ` 动作
     标记（如 `\b\b\b- dir/x.mp4`），前端未剥导致匹配失败。后端 `extractProgressName`
     与前端 `normalizeHighlightPath` 现都剥除控制字符与动作前缀。
  3. 文件树是分批异步渲染、且展开/折叠/搜索会 `replaceChildren()` 重建，高亮一旦随
     DOM 消失便不再恢复。`renderTree` 末尾现按记住的当前文件补挂高亮。
- **体验：顶栏版本号与真实版本实时同步**。原硬编码 `v3.7` 漂移（`?v=3.8` 资源在跑、
  顶栏仍显示 v3.7）。现从 CSS 资源 `?v=` 缓存键（打包门禁保证其随 manifest 更新）
  实时推导，今后发版只改 `?v=` 一处，顶栏自动跟随。
- **变更：移除解压「续跑」功能**（前端续跑按钮 + 后端 `resume()` 服务，后端路由本未
  注册）。用户取消解压后**保留已解压文件**，前端提示「已解压的文件已保留」；想继续
  可重新解压并选「跳过已存在文件」冲突策略达到同等效果。
- **变更：高亮样式沿用整行发光**（背景呼吸 + 左侧蓝竖条 + 文件名加粗），曾短暂改为
  文件名后小蓝点，按反馈回退。
- 测试：413。版本号升至 3.9。

### v3.8（2026-09-24）
- **修复：解压冲突策略四选一**（重命名/覆盖/跳过/保留较新，F1）。
- **新增：解压完成智能拍平同名一层目录**（F2）。
- **新增：完整性体检（7z t）异步任务 + 坏文件归因**（F6）。
- **新增：失败保留部分成果 + 续跑重试**（F8，续跑后于 v3.9 移除）。
- **新增：并发上限从硬拒绝 429 改排队等待**（F7）。
- **新增：文件树展示压缩率 + 加密锁标**（F13）。
- **新增：乱码检测一键换代码页 + 分卷缺失引导卡**（F12）。
- **新增：包内图片缩略图墙 + PDF 免解压预览**（F11）。

### v3.7（2026-09-23）
- **修复：若干解压稳定性与界面一致性问题**（详见提交历史）。
- **工程：版本号五处同步门禁**（manifest / package.json / index.html `?v=` /
  README 徽章与安装命令），漏改任意一处 `npm test` 即红。

### v3.6（2026-09-19）
- **修复：密码库写失败被吞**（`password-store` 的 `save()` 对 Promise 判非未 `await`），
  UI 显示已保存但刷新后丢失。
- **修复：诊断日志密码脱敏不全**。`-p` 正则只匹配 ASCII，含**中文或空格**的密码
  会部分或完整泄漏进诊断日志。已覆盖任意非空白密码并补回归测试，含 `-p` 的路径仍不误伤。
- **修复：请求超时定时器未 `unref`**，个别场景下 CGI 进程会被定时器拖住不退。
- **体验：状态轮询失败不再静默**。连续失败时进度条标红并提示「连接中断，重试中」，
  恢复后自动消除（此前进度条永远停在最后一次成功值，无法区分「解压中」与「轮询已失效」）。
- **体验：重新打开页面自动恢复进度**。打开一个有进行中任务的压缩包时，主面板进度
  与顶部任务流保持一致（此前主面板显示「准备就绪 0%」，易重复点解压）。
- **体验：弹窗可用 Esc 关闭**；目录选择弹窗打开时焦点落到主按钮。
- **体验：任务行「停止」点击后禁用并显示「停止中…」**，防止弱网下重复取消。
- **文档/构建**：API.md 错误码表补齐 11 个真实错误码、补 `solid` 字段；
  audit-fpk 新增后端代码内容断言（防止升版本后忘重新打包）。
- 测试：297 → 301。版本号升至 3.6。

### v3.5（2026-09-18）
- **修复：两个会在运行时崩溃的引用错误**（全盘死代码扫描发现）。
  嵌套 tar 解压的清理失败路径调用了未导入的函数，会抛 `ReferenceError` 并吞掉正常结果；
  压缩包打开失败、目录授权弹窗两条错误路径调用了未导出的诊断函数，会抛 `TypeError`。
- **工程：死代码清理**。逐项验证零引用后删除后端与前端一批死函数、死导出、死字段与
  失效 CSS（含 v2.4 起就接不进 CGI 的 `isAllowedOrigin`、废弃的 taskMini 样式等），
  并新增「前端调用与导出对象对账」测试防下一次漏导出。
- 测试：292 → 297。版本号升至 3.5。

### v3.4（2026-09-18）
- **修复：切回窗口后任务栏永久停更**。`pagehide` 会停掉所有轮询器，但 `pagehide` ≠ 卸载 ——
  fnOS 内嵌窗口被 bfcache 保留时，切回后进度条不再更新。新增 `pageshow` 恢复逻辑
  （仅 bfcache 还原时），按当前任务/弹窗状态重启轮询。
- **修复：RAR 压缩包注释读/写失败**。注释接口无条件强制 `-tRar`，违反本仓红线 ——
  RAR5 多分卷在强制 `-tRar` 下 Open ERROR。与解压/列表统一走同一判断，交给引擎自动识别。
- **修复：诊断报告版本号恒为 "1.0.0"**。安装布局下 manifest 路径少解析两级，
  改为候选数组（安装布局优先、开发树回退）。
- **修复：连续预览图片泄漏 blob URL**；轮询请求补上 15s 超时（卡死的请求不再占住轮询循环）。
- **性能**：高频轮询（每秒一次的任务状态）的成功路径不再写诊断日志；解压请求内分卷的
  重复指纹扫描合并；CGI 响应合并为单次写。
- **工程**：删除 v3.0 遗留的死代码（`testing` phase 进度封顶及对应展示分支）。
- 测试：269 → 292。版本号升至 3.4。

### v3.3（2026-09-16）
- **修复：预览固实压缩包里的文件会把 CPU 跑满**。固实（solid）压缩把包内所有文件当成
  一条连续的流来压，取出其中任意一个文件都必须从流的开头解压到目标位置 —— 代价由
  **压缩包体积**决定，与目标文件大小无关：1GB+ 的固实 RAR 分卷，预览一个几 KB 的 txt
  也会让一个核 100% 跑满到解压完为止。而 `preview-file` 是唯一一处绕过统一封装、直接
  调用 7-Zip 的代码，**把超时一起漏掉了**，于是这个代价完全没有上界。
  现在补上 45 秒超时（超时会真的杀掉 7z 子进程，而不是丢下它继续跑）、改走统一封装以
  继承超时与错误分类，并在预览固实包时提前说明原因。
- **新增**：`preview` 返回 `solid` 标记（从已有的 `7z l -slt` 属性段零成本读出），
  前端在预览固实包前提示「需先解压整个包，可能耗时较久」，不再让用户面对一次
  没有解释的长时间等待。
- **工程**：`runSevenZipSync` 新增 `encoding` 选项（默认 utf8，既有调用点行为不变），
  二进制预览（图片）不再需要绕过统一封装；前端预览改为可取消，连点不会同时跑起多个 7z。
- 测试：258 → 269。版本号升至 3.3。

### v3.2（2026-09-15）
- **修复：进度条下方堆着一串百分比**。7-Zip 在管道（非 TTY）下会把文件名行与进度行挤在
  同一行且没有 `\r` 分隔，而百分比正则只在**行首**匹配 —— 于是解析器退化到「取行内第一个
  `%`」，把第一个 `0%` 之后的内容全当成了文件名（界面上就是进度条下方那排 `1% 3% 5% …`）。
  现在按「前后都是空白」识别进度百分比，并从扣掉百分比后的残余文本里取文件名；
  前端另加一道兜底，文件名位置不会再渲染百分比堆叠。
- **修复：任务永久卡在「排队中」**。worker 启动阶段（读取任务、打开源文件）抛错时进程以 0 退出，
  父进程无法感知失败，任务状态永远停在 `queued`，前端每秒轮询却永远等不到结果。
  现在会落终态并以非 0 退出。
- **修复：分卷识别可被普通文件名打挂**。`backup.20260915` 这类合法备份名会被当成 2000 万号分卷，
  `info` / `preview` 需要分配近 2000 万元素的数组（实测峰值内存约 900 MiB；10 位数字直接 OOM）。
  分卷号与缺失枚举现在都有上界，被截断时提示改为「至少 N 个（前 M 个：…）」。
- **修复：诊断报告的授权目录被误脱敏**。`authorizedRoots` 因敏感词子串匹配（`authorized` 含 `auth`）
  恒被替换成 `[REDACTED]`，导致诊断报告无法用于排查目录授权问题。顺带修掉含 `-p` 的路径被误伤。
- **修复：清理步骤相互干扰**。解压收尾时若临时目录删除失败（权限异常），密码文件覆写与选择文件
  删除会被整体跳过；过期清理与 worker 并发删除时也可能让 `extract` / `jobs` 请求报内部错误。
- **工程**：补齐 `source` / `selection` / `diagnostics` 三个安全模块的单测（此前零直连测试）；
  新增版本号一致性门禁（漏改任一处 `npm test` 会失败）；新增 GitHub Actions CI；
  清理死代码并让 `constants.js` 成为常量的唯一来源。
- 测试：172 → 258。版本号升至 3.2。



### v3.1（2026-09-14）
- **解压吞吐优化**：进度回写由「每个 7z chunk 都落盘」改为「≥200ms 或百分比跳变 ≥1 才落盘」，热路径 payload 从 ~64KB 降到 <1KB，减少同步 IO 对事件循环的阻塞。
- **增量进度解析**：新增 `createProgressTracker`（StringDecoder + 增量解析），chunk 边界切断多字节 UTF-8 字符不再产生乱码，解析复杂度从 O(日志总长) 降到 O(新字节数)。
- **列表校验进程内化**：删除 `listing-validator.js` 独立子进程，worker 直接 spawn 7z 流式校验，每个任务少一次 node 启动 + 64KB JSON 往返。
- **陈旧锁回收**：`jobs.withLock` 改用 `acquireFileLock`（staleMs=30s），worker 被 SIGKILL 后任务不再永久卡死。
- **过期清理节流**：用 `cleanup.stamp` mtime 跨请求节流（≥60s），只在用户主动动作接口触发，不再挂在 1s 轮询上。
- **前端统一轮询器**：`createPoller` 递归 setTimeout + in-flight 守卫，消除请求堆积/乱序覆盖；页面隐藏降频 30s，空闲退避 5s→15s→30s。
- **文件树渲染**：选中计数改为一次后序预聚合 O(节点数)；分批渲染（每批 200 节点）；容器级事件委托；勾选只做定向复选框刷新，不再整树重建。
- **大文本预览截断**：渲染上限 20000 行、高亮 3000 行（超出提示，复制仍复制全文）；`escapeHtml` 改为纯字符串替换。
- **死代码清理**：删除 `watcher.js`、`listing-validator.js`、`watcher.test.js` 及多个死函数，lib/ 模块 20→18。
- **测试**：98→172（+74），新增 perf-batch1 / worker-progress / ui-preview / ui-tree。
- 版本号升至 3.1。

### v3.0（2026-09-13）
- **修复进度条下方显示整串百分比**：7-Zip 在非 TTY 管道下会把多次进度更新挤在
  同一行，解析时只取第一个百分比，导致进度停在 0%、且剩余百分比串被当作文件名
  显示在进度条下方。现改为取行首连续百分比串的最后一段。
- 版本号升至 3.0，与此前流出的 v2.9 测试包区分。

### v2.9（2026-09-13）
- **矢量图标化**：将剩余 5 处 UI emoji（文件夹/文件树图标、预览眼睛、主题月亮）替换为 SVG，解决部分系统字体缺失导致的方框问题。
- **主题切换修复**：深色/浅色模式切换后图标正确跟随变化。
- **历史记录增强**：显示解压日期时间；新增手动「清空历史」按钮。
- **圆角统一**：引入设计 token 统一控件圆角。
- **构建优化**：去除重复 staging 调用，减少 I/O 浪费。

### v2.8（2026-09-03）
- **超长文件名自动截断**：解压时遇到文件名超过文件系统限制（errno 36），自动截断为安全长度并保留扩展名，避免整包解压失败。
- **部分提取保留**：识别超长文件名错误，保留已提取的部分文件。

### v2.7（2026-09-03）
- **解压历史记录**：记录最近 20 次解压任务，支持自动覆盖。
- **任务中心改版**：顶部实时任务流，去掉独立任务按钮；每个后台任务在右上角独立显示迷你进度。
- **跨页面任务续看**：所有打开窗口自动检测后台任务。
- **进度解析修复**：正确解析 7-Zip 的 `\r` 回车进度，百分比实时更新。

### v2.6（2026-09-03）
- **任务中心**：后台 detached worker + 文件态任务，支持取消与页面刷新后续看进度。

### v2.5（2026-09-03）
- **RAR5 多卷修复**：不再强制指定 `-tRar`，直接打开多卷 RAR5。
- **README 美化**：添加徽章和 Star History。

### v2.4（2026-09-03）
- **深色模式修复**：下拉框/输入框/按钮/弹窗等控件改用主题色，暗色下清晰不刺眼（含原生控件 `color-scheme` 适配）。
- **进度条重做**：圆角高光轨道 + 成功/失败着色 + 启动期呼吸动画 + **预计剩余时间**；任务状态按阶段显示。
- 更新应用介绍，移除不实能力声明。

### v2.3
- 修复 `preview-file`：图片按二进制直读（原会损坏），加密包内 / 多字节文件名预览可用。
- 跨进程解压限流（最多 3 个并发）、请求体 16 MiB 上限与规范错误码。
- 清理：统一 `CHzipTree` 命名、移除死按钮、打包剔除 `.DS_Store`、修复若干前端竞态。

### v2.1 / v2.2
- 修复解压 504 与「正在校验」卡死：预览 / 请求路径不再同步跑整包完整性测试，改为后台任务实时进度。
- 修复前端密码流程 6 处崩溃（ReferenceError）；授权脚本与审计对齐命名与版本。

### v2.0
- 全面重构并改名为 **CHzip**：前端模块化（`app.js` + `ui-*`）、后端新增任务存储 / 源文件指纹 / 目录授权 / 嵌套 tar 支持、补齐测试。

---

## 🛠️ 开发 / 构建 / 测试

```bash
npm test                 # node --test，301 个用例
node --check app/server/api.js   # 语法检查
node scripts/build-fpk.js        # 构建 dist/*.fpk（双架构，需 fnpack）
node scripts/audit-fpk.js        # 发布审计（校验和/版本/架构/搜索特性）
```

> 推送与 PR 会自动跑 `node --check` + `npm test`（见 `.github/workflows/ci.yml`）。
> `audit-fpk` 依赖 `dist/*.fpk` 产物，因此不在 CI 里跑。

> 说明：单元测试通过依赖注入运行；内置 `7zzs` 为 Linux ELF，请在目标 fnOS 环境做真机回归。

## 📄 文档

- [API 文档](API.md)：CGI 端点、错误码与数据结构。
- [CONTRIBUTING](CONTRIBUTING.md)：参与贡献指南。

## ⚖️ 许可与致谢

本项目基于 [GNU GPL-3.0](LICENSE) 开源，源自 [xinZip](https://github.com/ff-xin/xinZip) 及[飞牛论坛原帖](https://club.fnnas.com/forum.php?mod=viewthread&tid=64284&highlight=)继续开发。内置 7-Zip（LGPL）与 Inter 字体（SIL OFL）遵循各自上游许可证。
