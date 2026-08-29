"use strict";

const fs = require("fs");
const http = require("node:http");
const { cardText } = require("./mentions.js");

const IMAGE_DEBUG_CONTEXT = Symbol("mentionExporterImageDebugContext");
const IMAGE_FALLBACK = Symbol("mentionExporterImageFallback");

function emitDebug(onDebug, event, details, level = "debug") {
  if (typeof onDebug !== "function") return;
  try {
    onDebug(event, details, level);
  } catch {
    // Diagnostics must never alter message delivery.
  }
}

function errorMessage(error) {
  return String(error?.message || error || "unknown error");
}

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

async function sendOneBotForwardWithImageFallback(config, messages, options = {}) {
  const onDebug = typeof options === "function" ? options : options?.debug;
  const batchContext = options && typeof options === "object" ? options.context ?? {} : {};
  const prepared = await prepareForwardImages(config, messages, onDebug, batchContext);
  try {
    return {
      ...await sendOneBotForward(config, prepared.messages),
      usedImageFallback: prepared.usedImageFallback,
    };
  } catch (error) {
    if (!/(?:下载文件失败|文件处理失败)/.test(errorMessage(error))) {
      emitDebug(onDebug, "onebot.forward_failed", {
        ...batchContext,
        reason: errorMessage(error),
        retryableImageFailure: false,
      }, "error");
      throw error;
    }

    let replaced = false;
    let replacedImages = 0;
    const fallbackMessages = prepared.messages.map((node) => {
      if (!Array.isArray(node?.data?.content)) return node;
      const content = node.data.content.map((segment) => {
        if (segment?.type !== "image") return segment;
        replaced = true;
        replacedImages += 1;
        emitDebug(onDebug, "image.downgraded", {
          ...batchContext,
          ...(segment[IMAGE_DEBUG_CONTEXT] ?? {}),
          stage: "napcat_retry",
          reason: errorMessage(error),
          summary: String(segment.data?.summary || "[图片]"),
        }, "warn");
        return textSegment(segment.data?.summary || "[图片]");
      });
      return { ...node, data: { ...node.data, content } };
    });
    if (!replaced) throw error;

    emitDebug(onDebug, "onebot.forward_retry", {
      ...batchContext,
      reason: errorMessage(error),
      replacedImages,
    }, "warn");

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

function imageUrlDetails(value) {
  const url = value instanceof URL ? value : parseHttpUrl(value);
  if (!url) return null;
  return {
    protocol: url.protocol,
    host: url.host,
    path: url.pathname,
    appid: url.searchParams.get("appid") || "",
    hasFileId: url.searchParams.has("fileid"),
    hasRkey: url.searchParams.has("rkey"),
    ntv2: isNtV2Url(url),
  };
}

function imageDetails(pic) {
  return {
    fileName: String(pic?.fileName || ""),
    fileSize: String(pic?.fileSize || ""),
    width: Number(pic?.picWidth) || 0,
    height: Number(pic?.picHeight) || 0,
    picType: pic?.picType ?? null,
    picSubType: pic?.picSubType ?? null,
    md5: String(pic?.md5HexStr || pic?.originImageMd5 || ""),
    summary: String(pic?.summary || "[图片]"),
  };
}

function attachImageDebugContext(segment, context) {
  if (!context || typeof context !== "object") return segment;
  Object.defineProperty(segment, IMAGE_DEBUG_CONTEXT, { value: context });
  return segment;
}

function markImageFallback(segment) {
  Object.defineProperty(segment, IMAGE_FALLBACK, { value: true });
  return segment;
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
    return {
      file: `base64://${Buffer.concat(chunks).toString("base64")}`,
      bytes: size,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      finalUrl: imageUrlDetails(response.url),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function prepareForwardImages(config, messages, onDebug, batchContext) {
  let usedImageFallback = false;
  const preparedMessages = await Promise.all(messages.map(async (node) => {
    if (!Array.isArray(node?.data?.content)) return node;
    const content = await Promise.all(node.data.content.map(async (segment) => {
      if (segment?.[IMAGE_FALLBACK]) usedImageFallback = true;
      if (segment?.type !== "image") return segment;
      const file = String(segment.data?.file || "");
      if (file.startsWith("base64://")) return segment;

      const imageContext = {
        ...batchContext,
        ...(segment[IMAGE_DEBUG_CONTEXT] ?? {}),
      };

      const url = parseHttpUrl(file);
      if (url) {
        emitDebug(onDebug, "image.download_started", {
          ...imageContext,
          resource: imageUrlDetails(url),
        });
        try {
          const downloaded = await downloadImage(url, config.timeoutMs);
          emitDebug(onDebug, "image.download_succeeded", {
            ...imageContext,
            resource: imageUrlDetails(url),
            finalResource: downloaded.finalUrl,
            status: downloaded.status,
            contentType: downloaded.contentType,
            bytes: downloaded.bytes,
          });
          return attachImageDebugContext({
            ...segment,
            data: { ...segment.data, file: downloaded.file },
          }, segment[IMAGE_DEBUG_CONTEXT]);
        } catch (error) {
          emitDebug(onDebug, "image.downgraded", {
            ...imageContext,
            stage: "source_download",
            resource: imageUrlDetails(url),
            reason: errorMessage(error),
            summary: String(segment.data?.summary || "[图片]"),
          }, "warn");
          // A missing remote image must not abort the complete forward message.
        }
      } else {
        emitDebug(onDebug, "image.downgraded", {
          ...imageContext,
          stage: "resource_validation",
          reason: "image resource is not an HTTP URL or base64 payload",
          summary: String(segment.data?.summary || "[图片]"),
        }, "warn");
      }
      usedImageFallback = true;
      return textSegment(segment.data?.summary || "[图片]");
    }));
    return { ...node, data: { ...node.data, content } };
  }));
  return { messages: preparedMessages, usedImageFallback };
}

function imageResource(pic, onDebug, context = {}) {
  const urls = [
    pic?.originImageUrl,
    pic?.originalImageUrl,
    pic?.url,
    pic?.picUrl,
    pic?.originUrl,
    ...(Array.isArray(pic?.urls) ? pic.urls : []),
  ].map(parseHttpUrl).filter(Boolean);

  const seenPaths = new Set();
  const localCandidates = [
    { field: "sourcePath", value: pic?.sourcePath },
    { field: "filePath", value: pic?.filePath },
    ...thumbnailPaths(pic).map((value) => ({ field: "thumbPath", value })),
  ].filter((candidate) => {
    if (typeof candidate.value !== "string" || !candidate.value || seenPaths.has(candidate.value)) {
      return false;
    }
    seenPaths.add(candidate.value);
    return true;
  });

  for (const candidate of localCandidates) {
    const localPath = existingPath(candidate.value);
    if (!localPath) {
      emitDebug(onDebug, "image.local_unavailable", {
        ...context,
        ...imageDetails(pic),
        field: candidate.field,
        path: candidate.value,
      });
      continue;
    }
    try {
      const data = fs.readFileSync(localPath);
      emitDebug(onDebug, "image.resource_selected", {
        ...context,
        ...imageDetails(pic),
        source: "local_cache",
        field: candidate.field,
        path: localPath,
        bytes: data.length,
      });
      return `base64://${data.toString("base64")}`;
    } catch (error) {
      emitDebug(onDebug, "image.local_read_failed", {
        ...context,
        ...imageDetails(pic),
        field: candidate.field,
        path: localPath,
        reason: errorMessage(error),
      }, "warn");
      // The QQNT cache may disappear between the existence check and read.
    }
  }

  const remoteUrl = urls.find((url) => !isNtV2Url(url));
  if (remoteUrl) {
    emitDebug(onDebug, "image.resource_selected", {
      ...context,
      ...imageDetails(pic),
      source: "remote_url",
      strategy: "direct",
      resource: imageUrlDetails(remoteUrl),
    });
    return remoteUrl.href;
  }

  const md5 = [pic?.md5HexStr, pic?.originImageMd5, pic?.fileName]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => /^[a-f\d]{32}$/i.test(value)) || "";
  if (md5) {
    const legacyUrl = `https://gchat.qpic.cn/gchatpic_new/0/0-0-${md5.toUpperCase()}/0`;
    emitDebug(onDebug, "image.resource_selected", {
      ...context,
      ...imageDetails(pic),
      source: "remote_url",
      strategy: "legacy_md5",
      resource: imageUrlDetails(legacyUrl),
      ignoredNtv2Resources: urls.filter(isNtV2Url).map(imageUrlDetails),
    });
    return legacyUrl;
  }

  if (urls[0]) {
    emitDebug(onDebug, "image.resource_selected", {
      ...context,
      ...imageDetails(pic),
      source: "remote_url",
      strategy: "ntv2_last_resort",
      resource: imageUrlDetails(urls[0]),
    });
    return urls[0].href;
  }

  emitDebug(onDebug, "image.downgraded", {
    ...context,
    ...imageDetails(pic),
    stage: "resource_selection",
    reason: "no readable local cache or usable HTTP/MD5 resource",
    localCandidateCount: localCandidates.length,
  }, "warn");
  return "";
}

function textSegment(text) {
  return { type: "text", data: { text: String(text) } };
}

function elementToOneBot(element, context, onDebug) {
  if (element?.textElement) return [textSegment(element.textElement.content ?? "")];
  if (element?.picElement) {
    const file = imageResource(element.picElement, onDebug, context);
    return file
      ? [attachImageDebugContext({
        type: "image",
        data: {
          file,
          summary: String(element.picElement.summary || "[图片]"),
        },
      }, context)]
      : [markImageFallback(textSegment(element.picElement.summary || "[图片]"))];
  }
  if (element?.pttElement) return [textSegment("[语音]")];
  if (element?.videoElement) return [textSegment("[视频]")];
  if (element?.fileElement) return [textSegment("[文件]")];
  if (element?.marketFaceElement || element?.faceElement) return [textSegment("[表情]")];
  if (element?.arkElement) return [textSegment(cardText(element.arkElement))];
  if (element?.markdownElement) return [textSegment("[Markdown]")];
  if (element?.structLongMsgElement) return [textSegment("[长消息]")];
  if (element?.multiForwardMsgElement) return [textSegment("[合并转发]")];
  return [];
}

function recordToForwardNode(record, onDebug) {
  const content = (record.message?.elements ?? []).flatMap((element, elementIndex) => {
    const context = {
      messageId: String(record.message?.id || ""),
      groupId: String(record.group?.uin || record.group?.uid || ""),
      senderId: String(record.sender?.uin || record.sender?.uid || ""),
      elementIndex,
    };
    return elementToOneBot(element, context, onDebug);
  });
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
