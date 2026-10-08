#!/bin/bash
#
# CHzip - fnOS 智能分卷解压套件
#
# 本文件基于 fnOS 应用 CGI 引导模板编写，由 CHzip 项目修改与维护。
# 模板骨架的著作权归其原作者所有；本文件的修改部分按 CHzip 项目的
# 许可证条款分发。
#
# 本程序是自由软件：你可以依据自由软件基金会发布的
# GNU 通用公共许可证第 3 版（或更高版本，由你选择）的条款，
# 再分发和/或修改本程序。
#
# 发布本程序是希望它能有用，但不附带任何担保；
# 甚至不附带适销性或特定用途适用性的默示担保。
# 详见 GNU 通用公共许可证（仓库根目录 LICENSE 文件）。
#
# ---------------------------------------------------------------------------
# CGI 引导入口：app/ui/api.cgi
#
# fnOS WebStation 对每次 API 请求都拉起一个新的 CGI 进程。本脚本只做
# 引导：定位后端 server/api.js 与 node 运行时，环境自检通过后 exec 交给
# Node.js 处理；自检失败时按 CGI 规范直接回一段 JSON 错误，绝不回 HTML
# 错误页（前端按 JSON 解析，HTML 会让前端解析崩溃）。
# ---------------------------------------------------------------------------

# 优先使用 fnOS 官方 nodejs_v22 套件的 node，找不到再回退到 PATH。
export PATH="/var/apps/nodejs_v22/target/bin:${PATH}"

# 应用名（用于定位安装目录下的兜底路径）。
APP_NAME="CHzip"

# 脚本自身所在目录（解析符号链接后的物理路径）。
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

# 开发布局：api.cgi 位于 app/ui/，后端在同级 app/server/。
# 安装布局（/var/apps/CHzip/target/）：两者同样相邻，${SCRIPT_DIR%/ui} 去掉
# 末尾的 /ui 即得到应用根，再拼 server/api.js。
API_SCRIPT="${SCRIPT_DIR%/ui}/server/api.js"

# 若相邻布局没找到（例如被单独调用），回退到 fnOS 标准安装路径。
if [ ! -f "${API_SCRIPT}" ]; then
    API_SCRIPT="/var/apps/${APP_NAME}/target/server/api.js"
fi

# 以 CGI 规范输出一段 JSON 错误并结束（HTTP body 必须是合法 JSON）。
# $1 = 错误消息（不含需要转义的特殊字符）。
respond_with_error() {
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-store"
    echo ""
    printf '{"success":false,"code":500,"msg":"%s"}\n' "$1"
}

# 自检一：后端入口必须存在，否则无法处理任何请求。
if [ ! -f "${API_SCRIPT}" ]; then
    respond_with_error "API 脚本不存在"
    exit 0
fi

# 自检二：node 运行时必须在 PATH 中可用。
if ! command -v node >/dev/null 2>&1; then
    respond_with_error "未找到 node 运行环境"
    exit 0
fi

# 自检通过：用 exec 把 CGI 进程的 stdin/stdout 直接交给 Node.js，
# 不额外起子进程，请求体与响应都零拷贝透传。
exec node "${API_SCRIPT}"
