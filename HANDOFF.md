# CHzip v4.5 交接文档

- 版本：`4.5`
- 日期：2026-10-23
- 分支 / 标签：`main` / `v4.5`
- 项目：CHzip 飞牛智能分卷解压
- 仓库：https://github.com/chanhuan1/CHzip
- 介绍页：https://chanhuan.dpdns.org/

## 本次范围

1. 高级选项新增“自动拍平同名一层目录”开关，默认开启；关闭后保留原始目录结构。
2. 扩展强签名格式识别：XAR、CPIO、RPM、DEB、MSI、CHM、磁盘镜像与文件系统镜像。
3. 文件头识别采用“解释纠正”：只调整打开方式并提示差异，不重命名、不修改源文件。
4. 优化解压与密码验证速度：减少进度回写读盘、日志改有界尾部缓冲、选择性解压复用已验证列表、密码探测按 Packed Size 选择。
5. 修复 worker 启动/取消竞态：启动占位超时回收，取消立即收敛终态。
6. 清理已无行为价值的旧测试，更新 README、API、贡献指南与介绍页。

## 验证状态

- `npm test`：`498/498` 通过。
- `node --check` 覆盖后端、前端、脚本与测试文件，全部通过。
- `sh -n cmd/* app/ui/*.cgi` 通过。
- `npm run test:release` 对双架构 FPK 通过。
- `git diff --check` 通过。

## 构建产物

- `dist/CHzip_4.5_x86_64.fpk`
- `dist/CHzip_4.5_arm64.fpk`
- `dist/SHA256SUMS.txt`
- 同步文件位于 `docs/dist/`。

## 发布状态

- Git 提交：见仓库 `main` 最新提交。
- 标签：`v4.5`。
- GitHub Release 标题：`v4.5`。
- Release 资产：上述两个 FPK 与 `SHA256SUMS.txt`。
- 介绍页版本、下载链接、哈希与更新日志已同步。

## 注意事项

- CHzip 无独立监听端口，仍通过 `/cgi/ThirdParty/CHzip/index.cgi` 与 `api.cgi` 访问。
- 升级时直接安装新 FPK 覆盖旧版本；不要先卸载。
- 解压 worker 是 detached 进程，升级前建议先等待或停止现有任务。
- macOS 单元测试使用注入替身；内置 `7zzs` 是 Linux ELF，真实解压仍以 fnOS 真机为准。
- 新扩展格式应在真机上抽样验证 RPM、DEB、XAR、CPIO、ISO/DMG 等实际文件。
