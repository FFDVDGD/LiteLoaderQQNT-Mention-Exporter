"use strict";

const fs = require("fs");
const http = require("node:http");

function hasHeader(headers, name) {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

function resolveOneBotUrl(value, action) {
  const url = new URL(value);
  if (url.protocol !== "http:") throw new Error("OneBot 地址只支持 http://");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${action}`.replace(/^\/?/, "/");
  url.search = "";
  url.hash = "";
  return url;
}

function createOneBotRequest(config, action, payload) {
  const url = resolveOneBotUrl(config.url, action);
  const body = JSON.stringify(payload);
  const headers = { ...(config.headers ?? {}) };

  if (config.accessToken && !hasHeader(headers, "authorization")) {
    headers.Authorization = `Bearer ${config.accessToken}`;
  }
  if (!hasHeader(headers, "content-type")) {
    headers["Content-Type"] = "application/json; charset=utf-8";
  }
  if (!hasHeader(headers, "content-length")) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  return { url, body, headers };
}

function parseOneBotResponse(body) {
  let response;
  try {
    response = JSON.parse(body);
  } catch {
    throw new Error("OneBot v11 返回的不是有效 JSON");
  }

  if (response?.status !== "ok" || Number(response?.retcode) !== 0) {
    const reason = response?.wording || response?.message || "未知错误";
    throw new Error(`OneBot v11 调用失败（retcode ${response?.retcode ?? "未知"}）：${reason}`);
  }
  return response;
}

function postOneBot(config, action, payload) {
  return new Promise((resolve, reject) => {
    let requestData;
    try {
      requestData = createOneBotRequest(config, action, payload);
    } catch (error) {
      reject(new Error(error instanceof TypeError ? "OneBot HTTP 地址无效" : error.message));
      return;
    }

    const { url, body, headers } = requestData;
    const request = http.request(url, { method: "POST", headers }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        if (size >= 4096) return;
        chunks.push(chunk);
        size += chunk.length;
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        const responseBody = Buffer.concat(chunks).toString("utf8").slice(0, 4096);
        if (status < 200 || status >= 300) {
          reject(new Error(`OneBot 返回 HTTP ${status}${responseBody ? `: ${responseBody}` : ""}`));
          return;
        }
        try {
          const oneBotResponse = parseOneBotResponse(responseBody);
          resolve({ status, body: responseBody, data: oneBotResponse.data });
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(Math.max(1000, Number(config.timeoutMs) || 60000), () => {
      request.destroy(new Error("OneBot 请求超时"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function target(config) {
  return config.messageType === "group"
    ? { type: "group", field: "group_id", id: String(config.targetId) }
    : { type: "private", field: "user_id", id: String(config.targetId) };
}

function sendOneBotMessage(config, message) {
  const destination = target(config);
  return postOneBot(config, `send_${destination.type}_msg`, {
    [destination.field]: destination.id,
    message: Array.isArray(message) ? message : [{ type: "text", data: { text: String(message) } }],
  });
}

function sendOneBotForward(config, messages) {
  const destination = target(config);
  return postOneBot(config, `send_${destination.type}_forward_msg`, {
    [destination.field]: destination.id,
    messages,
  });
}

async function sendOneBotForwardWithImageFallback(config, messages) {
  const prepared = await prepareForwardImages(config, messages);
  try {
    return {
      ...await sendOneBotForward(config, prepared.messages),
      usedImageFallback: prepared.usedImageFallback,
    };
  } catch (error) {
    if (!/(?:下载文件失败|文件处理失败)/.test(String(error?.message || error))) throw error;

    let replaced = false;
    const fallbackMessages = prepared.messages.map((node) => {
      if (!Array.isArray(node?.data?.content)) return node;
      const content = node.data.content.map((segment) => {
        if (segment?.type !== "image") return segment;
        replaced = true;
        return textSegment(segment.data?.summary || "[图片]");
      });
      return { ...node, data: { ...node.data, content } };
    });
    if (!replaced) throw error;

    return {
      ...await sendOneBotForward(config, fallbackMessages),
      usedImageFallback: true,
    };
  }
}

function existingPath(value) {
  return typeof value === "string" && value && fs.existsSync(value) ? value : "";
}

function thumbnailPaths(pic) {
  const value = pic?.thumbPath;
  if (!(value instanceof Map) && (!value || typeof value !== "object")) return [];

  const type = pic?.picElementType;
  const preferredKeys = type === null || type === undefined
    ? [0, "0"]
    : [type, String(type), 0, "0"];
  const preferred = value instanceof Map
    ? preferredKeys.filter((key) => value.has(key)).map((key) => value.get(key))
    : preferredKeys.filter((key) => Object.hasOwn(value, key)).map((key) => value[key]);
  const all = value instanceof Map ? [...value.values()] : Object.values(value);
  return [...new Set([...preferred, ...all])];
}

function parseHttpUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value, "https://gchat.qpic.cn");
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function isNtV2Url(url) {
  return ["1406", "1407"].includes(url.searchParams.get("appid"))
    && url.searchParams.has("fileid");
}

async function downloadImage(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1000, Number(timeoutMs) || 60000),
  );
  try {
    const response = await fetch(url, {
      headers: { Accept: "image/*,*/*;q=0.8" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const maximumBytes = 20 * 1024 * 1024;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
      throw new Error("image exceeds 20 MiB");
    }

    const chunks = [];
    let size = 0;
    if (!response.body) throw new Error("empty image response");
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("image exceeds 20 MiB");
      }
      chunks.push(chunk);
    }
    if (!size) throw new Error("empty image response");
    return `base64://${Buffer.concat(chunks).toString("base64")}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function prepareForwardImages(config, messages) {
  let usedImageFallback = false;
  const preparedMessages = await Promise.all(messages.map(async (node) => {
    if (!Array.isArray(node?.data?.content)) return node;
    const content = await Promise.all(node.data.content.map(async (segment) => {
      if (segment?.type !== "image") return segment;
      const file = String(segment.data?.file || "");
      if (file.startsWith("base64://")) return segment;

      const url = parseHttpUrl(file);
      if (url) {
        try {
          return {
            ...segment,
            data: { ...segment.data, file: await downloadImage(url, config.timeoutMs) },
          };
        } catch {
          // A missing remote image must not abort the complete forward message.
        }
      }
      usedImageFallback = true;
      return textSegment(segment.data?.summary || "[图片]");
    }));
    return { ...node, data: { ...node.data, content } };
  }));
  return { messages: preparedMessages, usedImageFallback };
}

function imageResource(pic) {
  const urls = [
    pic?.originImageUrl,
    pic?.originalImageUrl,
    pic?.url,
    pic?.picUrl,
    pic?.originUrl,
    ...(Array.isArray(pic?.urls) ? pic.urls : []),
  ].map(parseHttpUrl).filter(Boolean);

  for (const candidate of [pic?.sourcePath, pic?.filePath, ...thumbnailPaths(pic)]) {
    const localPath = existingPath(candidate);
    if (!localPath) continue;
    try {
      return `base64://${fs.readFileSync(localPath).toString("base64")}`;
    } catch {
      // The QQNT cache may disappear between the existence check and read.
    }
  }

  const remoteUrl = urls.find((url) => !isNtV2Url(url));
  if (remoteUrl) return remoteUrl.href;

  const md5 = [pic?.md5HexStr, pic?.originImageMd5, pic?.fileName]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => /^[a-f\d]{32}$/i.test(value)) || "";
  if (md5) return `https://gchat.qpic.cn/gchatpic_new/0/0-0-${md5.toUpperCase()}/0`;

  return urls[0]?.href || "";
}

function textSegment(text) {
  return { type: "text", data: { text: String(text) } };
}

function elementToOneBot(element) {
  if (element?.textElement) return [textSegment(element.textElement.content ?? "")];
  if (element?.picElement) {
    const file = imageResource(element.picElement);
    return file
      ? [{
        type: "image",
        data: {
          file,
          summary: String(element.picElement.summary || "[图片]"),
        },
      }]
      : [textSegment(element.picElement.summary || "[图片]")];
  }
  if (element?.pttElement) return [textSegment("[语音]")];
  if (element?.videoElement) return [textSegment("[视频]")];
  if (element?.fileElement) return [textSegment("[文件]")];
  if (element?.marketFaceElement || element?.faceElement) return [textSegment("[表情]")];
  if (element?.arkElement) return [textSegment("[卡片]")];
  if (element?.markdownElement) return [textSegment("[Markdown]")];
  if (element?.structLongMsgElement) return [textSegment("[长消息]")];
  if (element?.multiForwardMsgElement) return [textSegment("[合并转发]")];
  return [];
}

function recordToForwardNode(record) {
  const content = (record.message?.elements ?? []).flatMap(elementToOneBot);
  if (!content.length) content.push(textSegment(record.message?.text || "[无法提取消息内容]"));

  const userId = String(record.sender?.uin || "");
  const data = {
    nickname: String(
      record.sender?.memberName
      || record.sender?.remarkName
      || record.sender?.nickname
      || userId
      || "未知发送者",
    ),
    content,
  };
  if (/^\d+$/.test(userId)) data.user_id = userId;
  return { type: "node", data };
}

module.exports = {
  createOneBotRequest,
  imageResource,
  parseOneBotResponse,
  postOneBot,
  recordToForwardNode,
  resolveOneBotUrl,
  sendOneBotForward,
  sendOneBotForwardWithImageFallback,
  sendOneBotMessage,
};
