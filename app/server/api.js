#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const querystring = require("node:querystring");
const { LIMITS } = require("./lib/constants");
const { createServices } = require("./lib/services");
const { runWorker } = require("./lib/worker");
const {
  safeDiagnosticWrite,
} = require("./lib/diagnostics");

const JSON_TYPE = "application/json; charset=utf-8";

const ALLOWED_ORIGINS = new Set([
  "http://localhost",
  "https://localhost",
]);

function isAllowedOrigin(request) {
  const origin = request.headers?.origin;
  if (!origin) {
    return true;
  }
  if (ALLOWED_ORIGINS.has(origin)) {
    return true;
  }
  const referer = request.headers?.referer;
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      return ALLOWED_ORIGINS.has(`${refererUrl.protocol}//${refererUrl.host}`);
    } catch {
      return false;
    }
  }
  return false;
}

function sendJson(body, statusCode = 200) {
  if (statusCode !== 200) {
    console.log(`Status: ${statusCode}`);
  }
  console.log(`Content-Type: ${JSON_TYPE}`);
  console.log("Cache-Control: no-cache, no-store, must-revalidate");
  console.log("Pragma: no-cache");
  console.log("Expires: 0");
  console.log("");
  console.log(JSON.stringify(body));
}

function readRequestBody(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    const maxBytes = LIMITS.MAX_REQUEST_BODY_BYTES;
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    stream.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        const error = new Error("请求体超过 16 MiB 限制");
        error.code = "BODY_TOO_LARGE";
        stream.destroy();
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stream.on("error", fail);
  });
}

function parseJsonBody(rawBody) {
  if (!rawBody) {
    return {};
  }
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    const invalid = new Error("请求 JSON 格式无效");
    invalid.code = "INVALID_JSON";
    throw invalid;
  }
}

function normalizeApiName(query, body) {
  return String(query.api || query._api || body.api || "").trim();
}

async function routeRequest(api, request, services) {
  const requestId = request.requestId || "";
  let data;
  if (api === "info") {
    data = await services.info({
      path: request.query.path,
      requestId,
    });
  } else if (api === "preview") {
    data = await services.preview({
      path: request.body.path,
      password: request.body.password || "",
      codePage: request.body.codePage || "auto",
      requestId,
    });
  } else if (api === "directories") {
    data = await services.directories({
      archivePath: request.query.archivePath,
      path: request.query.path || "",
      requestId,
    });
  } else if (api === "create-directory") {
    data = await services.createDirectory({
      archivePath: request.body.archivePath,
      parentPath: request.body.parentPath,
      name: request.body.name,
      requestId,
    });
  } else if (api === "extract") {
    data = await services.extract({
      path: request.body.path,
      password: request.body.password || "",
      codePage: request.body.codePage || "auto",
      destinationRoot: request.body.destinationRoot || "",
      selectedPaths: request.body.selectedPaths,
      requestId,
    });
  } else if (api === "status") {
    data = await services.status({
      jobId: request.query.jobId,
      requestId,
    });
  } else if (api === "cancel") {
    data = await services.cancel({
      jobId: request.body.jobId,
      requestId,
    });
  } else if (api === "diagnostics") {
    data = await services.diagnostics({
      path: request.query.path,
      requestId: request.query.requestId || requestId,
    });
  } else if (api === "comment") {
    if (request.body && request.body.comment !== undefined) {
      data = await services.comment({
        path: request.body.path,
        comment: request.body.comment,
        requestId,
      });
    } else {
      data = await services.comment({
        path: request.query.path,
        requestId,
      });
    }
  } else if (api === "preview-file") {
    data = await services.previewFile({
      path: request.body.path,
      targetPath: request.body.targetPath,
      password: request.body.password || "",
      codePage: request.body.codePage || "auto",
      requestId,
    });
  } else {
    const error = new Error("不存在的接口");
    error.code = "NOT_FOUND";
    throw error;
  }

  return {
    success: true,
    code: 200,
    data,
    requestId,
  };
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_EXTRACTS = 3;

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(timeoutMessage);
      error.code = "TIMEOUT";
      reject(error);
    }, timeoutMs);
    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function main() {
  const services = createServices();
  const requestId = crypto.randomBytes(8).toString("hex");
  const startedAt = Date.now();
  let api = "";
  try {
    const query = querystring.parse(process.env.QUERY_STRING || "");
    const rawBody = await withTimeout(
      readRequestBody(),
      30 * 1000,
      "请求读取超时",
    );
    const body = parseJsonBody(rawBody);
    api = normalizeApiName(query, body);
    services.store.cleanupExpired();

    if (
      api === "extract"
      && services.store.countActive() >= MAX_CONCURRENT_EXTRACTS
    ) {
      const error = new Error("当前解压任务过多，请稍后再试");
      error.code = "TOO_MANY_REQUESTS";
      throw error;
    }

    const result = await withTimeout(
      routeRequest(api, {
        query,
        body,
        requestId,
      }, services),
      REQUEST_TIMEOUT_MS,
      "请求处理超时",
    );

    safeDiagnosticWrite(services.logger, {
      event: "api_request",
      requestId,
      api,
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    sendJson(result);
  } catch (error) {
    safeDiagnosticWrite(services.logger, {
      event: "api_request",
      requestId,
      api,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: {
        code: error.code || "INTERNAL",
        message: error.message,
        errno: error.errno ?? null,
        syscall: error.syscall || "",
        path: error.path || "",
        exitCode: error.exitCode ?? null,
        signal: error.signal || "",
        logTail: String(error.log || "").slice(-8192),
      },
    });
    error.requestId = requestId;
    throw error;
  }
}

async function runCli() {
  try {
    if (process.argv[2] === "--worker") {
      const jobId = process.argv[3];
      await runWorker(jobId, {
        runtimeRoot: process.env.CHZIP_RUNTIME_ROOT,
      });
      return;
    }
    await main();
  } catch (error) {
    const statusCode = {
      NOT_FOUND: 404,
      INVALID_JSON: 400,
      BODY_TOO_LARGE: 413,
      TOO_MANY_REQUESTS: 429,
    }[error.code] || 200;
    sendJson({
      success: false,
      code: error.code === "NOT_FOUND" ? 404 : 500,
      error: {
        code: error.code || "INTERNAL",
        message: error.message || "调用错误",
      },
      msg: error.message || "调用错误",
      requestId: error.requestId || "",
    }, statusCode);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  main,
  normalizeApiName,
  parseJsonBody,
  readRequestBody,
  routeRequest,
  runCli,
  sendJson,
};
