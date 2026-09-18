(function (root) {
    "use strict";

    // 默认超时与后端 api.js 的 REQUEST_TIMEOUT_MS（5 分钟）对齐并留一点余量：
    // 后端最多 5 分钟就会回包，客户端再等下去只可能是连接已经死了。
    // 轮询类接口用 POLL_TIMEOUT_MS 快速失败，避免一个卡死的请求占住轮询循环。
    const DEFAULT_TIMEOUT_MS = 330 * 1000;
    const POLL_TIMEOUT_MS = 15 * 1000;

    function createApiClient() {
        function getApiBaseUrl() {
            const apiUrl = new URL("api.cgi", window.location.href);
            const marker = "/index.cgi";
            const position = apiUrl.pathname.indexOf(marker);
            if (position >= 0) {
                apiUrl.pathname = `${apiUrl.pathname.slice(0, position)}/api.cgi`;
            }
            apiUrl.search = "";
            apiUrl.hash = "";
            return apiUrl;
        }

        function apiUrl(api, params) {
            const url = getApiBaseUrl();
            url.searchParams.set("api", api);
            Object.entries(params || {}).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== "") {
                    url.searchParams.set(key, value);
                }
            });
            return url.toString();
        }

        async function requestJson(url, options) {
            const {
                timeoutMs = DEFAULT_TIMEOUT_MS,
                signal: externalSignal,
                ...fetchOptions
            } = options || {};

            // 有超时或外部 signal 时才建 controller，保持原有调用方式不变。
            const needsAbort = timeoutMs > 0 || Boolean(externalSignal);
            const controller = needsAbort ? new AbortController() : null;
            let timer = null;
            let timedOut = false;
            if (controller) {
                if (externalSignal) {
                    if (externalSignal.aborted) {
                        controller.abort();
                    } else {
                        externalSignal.addEventListener(
                            "abort",
                            () => controller.abort(),
                            { once: true },
                        );
                    }
                }
                if (timeoutMs > 0) {
                    timer = setTimeout(() => {
                        timedOut = true;
                        controller.abort();
                    }, timeoutMs);
                }
                fetchOptions.signal = controller.signal;
            }

            try {
                const response = await fetch(url, fetchOptions);
                const contentType = response.headers.get("content-type") || "";
                const data = contentType.includes("application/json")
                    ? await response.json()
                    : { success: false, msg: await response.text() };
                if (!response.ok || !data.success) {
                    const error = new Error(
                        data.error?.message
                        || data.msg
                        || `请求失败：HTTP ${response.status}`,
                    );
                    error.code = data.error?.code || `HTTP_${response.status}`;
                    error.requestId = data.requestId || "";
                    error.details = data.error || null;
                    throw error;
                }
                return data.data;
            } catch (error) {
                if (timedOut && error && error.name === "AbortError") {
                    const timeoutError = new Error("请求超时，请检查设备状态后重试");
                    timeoutError.code = "TIMEOUT";
                    throw timeoutError;
                }
                throw error;
            } finally {
                if (timer) {
                    clearTimeout(timer);
                }
            }
        }

        // options 是可选的：透传给 requestJson，用来传 signal（取消在途请求）
        // 或更短的 timeoutMs。不传时行为与原先完全一致。
        function postApi(api, body, options) {
            return requestJson(apiUrl(api), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    api,
                    ...body,
                }),
                ...options,
            });
        }

        return {
            apiUrl,
            getApiBaseUrl,
            postApi,
            requestJson,
            POLL_TIMEOUT_MS,
        };
    }

    root.CHzipApiClient = {
        createApiClient,
        DEFAULT_TIMEOUT_MS,
        POLL_TIMEOUT_MS,
    };
}(typeof window !== "undefined" ? window : globalThis));
