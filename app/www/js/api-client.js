(function (root) {
    "use strict";

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
            const response = await fetch(url, options);
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
        }

        function postApi(api, body) {
            return requestJson(apiUrl(api), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    api,
                    ...body,
                }),
            });
        }

        return {
            apiUrl,
            getApiBaseUrl,
            postApi,
            requestJson,
        };
    }

    root.CHzipApiClient = { createApiClient };
}(typeof window !== "undefined" ? window : globalThis));
