# CHzip 项目交接

状态快照：2026-10-22。版本保持 `4.3`，本轮为同版本覆盖重建与重新发布。

## 当前交付物

| 架构 | 文件 | 字节数 | SHA256 |
| --- | --- | ---: | --- |
| x86_64 | `dist/CHzip_4.3_x86_64.fpk` | 2,415,555 | `e0570b9f5cb285bd2b2b683eab7f37622d40337538e86dd0dea63d8cfbf29fdd` |
| arm64 | `dist/CHzip_4.3_arm64.fpk` | 2,250,357 | `5cfcd4454be4478bb4f7aefd779414dfac40a8eb454299de29820b00b206ea63` |

- 校验清单：`dist/SHA256SUMS.txt`
- 站内下载副本：`docs/dist/`
- 介绍页：`docs/index.html`
- 页面版本数据：`docs/version.json`

应用运行期没有独立监听端口，也没有常驻 Web 服务。页面通过飞牛 WebStation 的
`/cgi/ThirdParty/CHzip/index.cgi` 访问，API 使用 `/cgi/ThirdParty/CHzip/api.cgi`。

## 本轮更新重点

- 移除同盘串行限制，并发只受全局任务槽位控制。
- 新增来源文件和输出目录任务锁，拦截并发覆盖、注释冲突和同目录重复解压。
- 加密包通过实际测试加密成员确认密码，验证超时返回明确错误。
- 修正同名冲突策略：重命名创建新目录，覆盖、跳过、保留较新复用同名目录。
- 文件树增加修改时间、类型、大小、搜索计数与清除按钮。
- 补齐弹窗焦点管理、主题语义、进度条语义及文件树滚动/键盘体验。
- 修复超长文件名部分救援误报、缩略图缓存泄漏、共享目录识别与 ZIP 主卷缺失提示。
- 发布审计增加对焦点管理、来源锁、输出锁和加密成员验证代码的包内检查。

## 验证结果

- `npm test`：485 项全部通过。
- `node --check`：后端、CGI 相关 JS、前端脚本和打包脚本通过。
- `git diff --check`：通过。
- `node scripts/build-fpk.js`：x86_64 与 arm64 均成功。
- `node scripts/audit-fpk.js`：两个架构均通过版本、架构、校验和与包内代码检查。
- Release 下载资产与本地包 SHA256、字节内容完全一致。
- GitHub Actions：提交 `f7181ab` 的 CI 成功。
- 线上介绍页已显示本轮新 SHA256、`2026-10-22` 更新日志和 485 项测试。

内置 `7zzs` 是 Linux ELF，macOS 只能完成结构审计与单元测试，不能替代 fnOS
真机安装、分卷解压和权限回归。

## Git 与 Release

- Release：https://github.com/chanhuan1/CHzip/releases/tag/v4.3
- Release 标题必须保持为裸标签 `v4.3`，功能摘要写入 Release 正文。
- Release 资产：两个架构 FPK 和 `SHA256SUMS.txt`。
- 主分支和 `v4.3` 标签在交接文档最终提交后保持一致。
- 公开介绍页：https://chanhuan.dpdns.org
- `https://chzip.pages.dev` 不是本项目页面。

## 重建约定

```bash
npm test
node scripts/build-fpk.js
cd dist
shasum -a 256 CHzip_4.3_arm64.fpk CHzip_4.3_x86_64.fpk > SHA256SUMS.txt
cd ..
node scripts/audit-fpk.js
cp dist/CHzip_4.3_x86_64.fpk dist/CHzip_4.3_arm64.fpk dist/SHA256SUMS.txt docs/dist/
```

- `manifest` 是版本号源文件，同版本发布不要擅自改成 `4.3.1`。
- `docs/index.html` 每个架构的 SHA256 有两处：`title` 与 `data-copy`。
- `docs/dist/` 受根目录 `dist/` 忽略规则影响，提交时使用 `git add -f docs/dist/...`。
- 页面更新日志同时存在于 `docs/version.json` 与 `docs/index.html` 的内置离线数据中。
- 替换 Release 资产后必须重新下载并做 SHA256 与 `cmp` 校验。
- 升级前应等待或取消正在运行的任务；升级脚本不会主动终止 detached 解压 Worker。
