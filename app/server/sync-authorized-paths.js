#!/usr/bin/env node
/*
 * CHzip - fnOS 智能分卷解压套件
 * Copyright (C) 2026 chanhuan
 *
 * 本程序是自由软件：你可以依据自由软件基金会发布的
 * GNU 通用公共许可证第 3 版（或更高版本，由你选择）的条款，
 * 再分发和/或修改本程序。
 *
 * 发布本程序是希望它能有用，但不附带任何担保；
 * 甚至不附带适销性或特定用途适用性的默示担保。
 * 详见 GNU 通用公共许可证（仓库根目录 LICENSE 文件）。
 */

"use strict";

const path = require("node:path");
const {
  writeAuthorizationSnapshot,
} = require("./lib/authorization-paths");

/**
 * 同步入口：把当前环境变量里的授权目录写入 $TRIM_PKGVAR 下的快照。
 * 未配置 TRIM_PKGVAR（例如在本机调试）时不落盘，返回 null。
 */
function main(environment = process.env) {
  if (!environment.TRIM_PKGVAR) {
    return null;
  }
  return writeAuthorizationSnapshot(
    path.join(environment.TRIM_PKGVAR, "authorized-paths.json"),
    environment,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`授权路径同步失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
};
