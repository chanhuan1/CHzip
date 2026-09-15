"use strict";

const TIMEOUTS = Object.freeze({
  REQUEST_READ_MS: 30 * 1000,
  API_REQUEST_MS: 5 * 60 * 1000,
  SEVENZIP_SYNC_MS: 10 * 60 * 1000,
  CANCELLATION_WAIT_MS: 100,
  CANCELLATION_MAX_ATTEMPTS: 30,
  CANCELLATION_KILL_MS: 3000,
  LOCK_RETRY_MS: 5,
  LOCK_MAX_ATTEMPTS: 200,
  STALE_LOCK_MS: 30 * 1000,
  // 过期任务清理的最小间隔：清理要全量扫 jobs 目录，不能挂在 1s 一次的
  // status 轮询上。用 runtimeRoot 下的 cleanup.stamp mtime 做跨请求节流。
  CLEANUP_MIN_INTERVAL_MS: 60 * 1000,
});

const LIMITS = Object.freeze({
  MAX_CONCURRENT_EXTRACTS: 3,
  MAX_REQUEST_BODY_BYTES: 16 * 1024 * 1024,
  MAX_PREVIEW_OUTPUT_BYTES: 64 * 1024 * 1024,
  // 单文件免解压预览的上限。7z -so 会把整个目标文件吐进内存，必须封顶，
  // 否则弱内存的 NAS 上峰值 RSS 会失控。比前端 10 MiB 的门槛留一点余量。
  MAX_PREVIEW_FILE_BYTES: 12 * 1024 * 1024,
  MAX_NESTED_PREVIEW_BYTES: 8 * 1024 * 1024 * 1024,
  MAX_NESTED_DISK_USAGE_RATIO: 0.8,
  MAX_PREVIEW_ENTRIES: 100000,
  MAX_LOG_BYTES: 2 * 1024 * 1024,
  MAX_LOG_BACKUPS: 3,
  MAX_LOG_TAIL_BYTES: 64 * 1024,
  // 注意：前端密码库的条目上限是浏览器侧的独立实现
  // （app/www/js/password-store.js 的 MAX_ENTRIES = 50），服务端不引用它，
  // 因此这里刻意不放 MAX_PASSWORD_ENTRIES —— 留一个零引用的常量只会制造
  // 「两边已经统一」的错觉。
  MAX_DIRECTORY_NAME_LENGTH: 128,
  MAX_OUTPUT_DIR_ATTEMPTS: 10000,
  MAX_CLEANUP_BATCH_SIZE: 100,
  MAX_TAIL_REQUEST_MATCHES: 1000,
});

const JOB = Object.freeze({
  EXPIRY_MS: 24 * 60 * 60 * 1000,
  TERMINAL_STATUSES: ["cancelled", "success", "failed"],
});

const CRYPTO = Object.freeze({
  PASSWORD_OVERWRITE_PASSES: 3,
  REQUEST_ID_BYTES: 8,
  JOB_ID_BYTES: 16,
  // 注意：前端密码库的加密参数（salt 16 / iv 12 / PBKDF2 100000 / 256 位）
  // 是浏览器侧的独立实现，见 app/www/js/password-store.js —— 服务端无法
  // require 它，这里也不放对应常量，免得制造「两边已统一」的错觉。
});

const PERMISSIONS = Object.freeze({
  MODE_DIR: 0o700,
  MODE_DIR_OUTPUT: 0o750,
  MODE_FILE_SECRET: 0o600,
  MODE_FILE_DEFAULT: 0o644,
  // 打包产物的可执行位（0o755）由 scripts/build-fpk.js 自己管 —— 那是打包
  // 关注点，与运行时的权限模式不是一回事，故不在这里放 MODE_EXECUTABLE。
});

module.exports = {
  CRYPTO,
  JOB,
  LIMITS,
  PERMISSIONS,
  TIMEOUTS,
};
