function parseArgs(input) {
  const result = {};
  if (!input) return result;

  input.split("&").forEach((pair) => {
    const index = pair.indexOf("=");
    if (index === -1) return;
    const key = decodeURIComponent(pair.slice(0, index));
    const value = decodeURIComponent(pair.slice(index + 1));
    result[key] = value;
  });

  return result;
}

function addParam(url, key, value) {
  if (!value) return url;
  const joiner = url.indexOf("?") === -1 ? "?" : "&";
  return url + joiner + encodeURIComponent(key) + "=" + encodeURIComponent(value);
}

function doneWithResponse(status, title, body) {
  const text = body || title;
  $notification.post("TG Signer", title, text);

  if (typeof $request !== "undefined") {
    $done({
      response: {
        status: status,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: text,
      },
    });
  } else {
    $done();
  }
}

const args = parseArgs(typeof $argument === "string" ? $argument : "");
let endpoint = args.endpoint || "";
const key = args.key || "";

if (!endpoint || !key) {
  doneWithResponse(400, "配置错误", "缺少云端接口 endpoint 或触发密钥 key");
} else {
  endpoint = addParam(endpoint, "key", key);
  endpoint = addParam(endpoint, "mode", args.mode);
  endpoint = addParam(endpoint, "target_chat", args.target_chat);
  endpoint = addParam(endpoint, "checkin_text", args.checkin_text);
  endpoint = addParam(endpoint, "task_name", args.task_name);

  $httpClient.get(endpoint, function (error, response, data) {
    if (error) {
      doneWithResponse(500, "触发失败", String(error));
      return;
    }

    const status = response && response.status ? response.status : 200;
    let message = data || "云端任务已提交";

    try {
      const parsed = JSON.parse(data || "{}");
      if (parsed.message) message = parsed.message;
      if (parsed.error) message = parsed.error;
    } catch (_) {
      // Keep raw data.
    }

    doneWithResponse(status, status >= 200 && status < 300 ? "触发完成" : "触发异常", message);
  });
}
