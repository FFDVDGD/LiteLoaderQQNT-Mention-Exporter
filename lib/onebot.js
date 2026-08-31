"use strict";

const fs = require("fs");
const http = require("node:http");
const { cardText } = require("./mentions.js");

const IMAGE_DEBUG_CONTEXT = Symbol("mentionExporterImageDebugContext");
const IMAGE_FALLBACK = Symbol("mentionExporterImageFallback");
const IMAGE_RESOURCE_CANDIDATES = Symbol("mentionExporterImageResourceCandidates");

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

function normalizeRkey(value) {
  return String(value || "").replace(/^&?rkey=/, "");
}

async function fetchImageRkeys(config) {
  const result = await postOneBot(config, "get_rkey", {});
  if (!Array.isArray(result.data)) {
    throw new Error("NapCat get_rkey returned no key list");
  }
  return Object.fromEntries(result.data.map((entry) => [
    String(entry?.type || ""),
    normalizeRkey(entry?.rkey),
  ]));
}

function refreshedNtv2Urls(source, rkeys) {
  const appid = source.searchParams.get("appid");
  const fileId = source.searchParams.get("fileid");
  const scope = appid === "1406" ? "private" : "group";
  const rkey = rkeys[scope];
  if (!appid || !fileId || !rkey) {
    throw new Error(`NapCat get_rkey returned no ${scope} image key`);
  }

  const query = `appid=${appid}&fileid=${fileId}&rkey=${rkey}`;
  return [
    new URL(`https://multimedia.nt.qq.com.cn/download?${query}`),
    new URL(`https://gchat.qpic.cn/download?${query}&spec=0`),
  ];
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

function attachImageResourceCandidates(segment, candidates) {
  Object.defineProperty(segment, IMAGE_RESOURCE_CANDIDATES, { value: candidates });
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
  let imageRkeysPromise;
  const getImageRkeys = () => {
    if (!imageRkeysPromise) imageRkeysPromise = fetchImageRkeys(config);
    return imageRkeysPromise;
  };
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

      const candidateValues = Array.isArray(segment[IMAGE_RESOURCE_CANDIDATES])
        ? segment[IMAGE_RESOURCE_CANDIDATES]
        : [file];
      const urls = [...new Map(candidateValues
        .map(parseHttpUrl)
        .filter(Boolean)
        .map((url) => [url.href, url])).values()];
      let lastError;
      const attemptedUrls = [];
      const ntv2Source = urls.find(isNtV2Url);
      async function tryImageUrl(url, candidateCount, refreshedRkey = false) {
        attemptedUrls.push(url);
        const attempt = attemptedUrls.length;
        emitDebug(onDebug, "image.download_started", {
          ...imageContext,
          attempt,
          candidateCount,
          refreshedRkey,
          resource: imageUrlDetails(url),
        });
        try {
          const downloaded = await downloadImage(url, config.timeoutMs);
          emitDebug(onDebug, "image.download_succeeded", {
            ...imageContext,
            attempt,
            candidateCount,
            refreshedRkey,
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
          lastError = error;
          emitDebug(onDebug, "image.download_failed", {
            ...imageContext,
            attempt,
            candidateCount,
            refreshedRkey,
            willRetry: attempt < candidateCount || (!refreshedRkey && Boolean(ntv2Source)),
            resource: imageUrlDetails(url),
            reason: errorMessage(error),
          });
          return null;
        }
      }

      for (const url of urls) {
        const downloaded = await tryImageUrl(url, urls.length);
        if (downloaded) return downloaded;
      }

      if (ntv2Source) {
        emitDebug(onDebug, "image.rkey_refresh_started", {
          ...imageContext,
          appid: ntv2Source.searchParams.get("appid") || "",
        });
        try {
          const refreshedUrls = refreshedNtv2Urls(ntv2Source, await getImageRkeys())
            .filter((url) => !attemptedUrls.some((attempted) => attempted.href === url.href));
          emitDebug(onDebug, "image.rkey_refresh_succeeded", {
            ...imageContext,
            appid: ntv2Source.searchParams.get("appid") || "",
            refreshedCandidateCount: refreshedUrls.length,
          });
          const candidateCount = attemptedUrls.length + refreshedUrls.length;
          for (const url of refreshedUrls) {
            const downloaded = await tryImageUrl(url, candidateCount, true);
            if (downloaded) return downloaded;
          }
        } catch (error) {
          lastError = error;
          emitDebug(onDebug, "image.rkey_refresh_failed", {
            ...imageContext,
            appid: ntv2Source.searchParams.get("appid") || "",
            reason: errorMessage(error),
          });
        }
      }

      if (attemptedUrls.length) {
        emitDebug(onDebug, "image.downgraded", {
          ...imageContext,
          stage: "source_download",
          attempts: attemptedUrls.length,
          attemptedResources: attemptedUrls.map(imageUrlDetails),
          reason: errorMessage(lastError),
          summary: String(segment.data?.summary || "[图片]"),
        }, "warn");
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

function selectImageResource(pic, onDebug, context = {}) {
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
      return { file: `base64://${data.toString("base64")}`, candidates: [] };
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

  const md5 = [pic?.md5HexStr, pic?.originImageMd5, pic?.fileName]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => /^[a-f\d]{32}$/i.test(value)) || "";
  const remoteCandidates = [];
  const seenUrls = new Set();
  function addRemoteCandidate(url, strategy) {
    if (!url || seenUrls.has(url.href)) return;
    seenUrls.add(url.href);
    remoteCandidates.push({ url, strategy });
  }

  urls.filter((url) => !isNtV2Url(url))
    .forEach((url) => addRemoteCandidate(url, "direct"));
  if (md5) {
    addRemoteCandidate(
      parseHttpUrl(`https://gchat.qpic.cn/gchatpic_new/0/0-0-${md5.toUpperCase()}/0`),
      "legacy_md5",
    );
  }
  urls.filter(isNtV2Url).forEach((url) => addRemoteCandidate(url, "ntv2"));

  if (remoteCandidates.length) {
    const [selected, ...alternates] = remoteCandidates;
    emitDebug(onDebug, "image.resource_selected", {
      ...context,
      ...imageDetails(pic),
      source: "remote_url",
      strategy: selected.strategy,
      resource: imageUrlDetails(selected.url),
      alternateResources: alternates.map((candidate) => ({
        strategy: candidate.strategy,
        ...imageUrlDetails(candidate.url),
      })),
    });
    return {
      file: selected.url.href,
      candidates: remoteCandidates.map((candidate) => candidate.url.href),
    };
  }

  emitDebug(onDebug, "image.downgraded", {
    ...context,
    ...imageDetails(pic),
    stage: "resource_selection",
    reason: "no readable local cache or usable HTTP/MD5 resource",
    localCandidateCount: localCandidates.length,
  }, "warn");
  return { file: "", candidates: [] };
}

function imageResource(pic, onDebug, context = {}) {
  return selectImageResource(pic, onDebug, context).file;
}

function textSegment(text) {
  return { type: "text", data: { text: String(text) } };
}

function elementToOneBot(element, context, onDebug) {
  if (element?.textElement) return [textSegment(element.textElement.content ?? "")];
  if (element?.picElement) {
    const resource = selectImageResource(element.picElement, onDebug, context);
    return resource.file
      ? [attachImageResourceCandidates(attachImageDebugContext({
        type: "image",
        data: {
          file: resource.file,
          summary: String(element.picElement.summary || "[图片]"),
        },
      }, context), resource.candidates)]
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
