"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  createOneBotRequest,
  imageResource,
  parseOneBotResponse,
  recordToForwardNode,
  resolveOneBotUrl,
  sendOneBotForward,
  sendOneBotForwardWithImageFallback,
  sendOneBotMessage,
} = require("../lib/onebot.js");

const privateConfig = {
  url: "http://127.0.0.1:3000/api/",
  messageType: "private",
  targetId: "654321",
  accessToken: "secret",
  headers: {},
  timeoutMs: 2000,
};

test("builds explicit OneBot HTTP endpoints and authentication", () => {
  assert.equal(
    resolveOneBotUrl("http://127.0.0.1:3000/api/", "send_private_msg").href,
    "http://127.0.0.1:3000/api/send_private_msg",
  );
  assert.throws(
    () => resolveOneBotUrl("https://example.com", "send_private_msg"),
    /只支持 http:\/\//,
  );

  const request = createOneBotRequest(privateConfig, "send_private_msg", {
    user_id: "654321",
    message: [{ type: "text", data: { text: "测试" } }],
  });
  assert.equal(request.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.body), {
    user_id: "654321",
    message: [{ type: "text", data: { text: "测试" } }],
  });
});

test("detects OneBot action failures returned with HTTP 200", () => {
  assert.deepEqual(
    parseOneBotResponse('{"status":"ok","retcode":0,"data":{"message_id":1}}').data,
    { message_id: 1 },
  );
  assert.throws(
    () => parseOneBotResponse('{"status":"failed","retcode":1400,"wording":"参数错误"}'),
    /retcode 1400.*参数错误/,
  );
});

test("converts text and cached images into one ordered forward node", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mention-image-"));
  const imagePath = path.join(directory, "image.jpg");
  fs.writeFileSync(imagePath, "image");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const node = recordToForwardNode({
    sender: { uin: "654321", nickname: "发送者", memberName: "群名片" },
    message: {
      text: "前[图片]后",
      elements: [
        { textElement: { content: "前\n" } },
        { picElement: { sourcePath: imagePath, summary: "[图片]" } },
        { textElement: { content: "\n后" } },
      ],
    },
  });

  assert.equal(node.type, "node");
  assert.equal(node.data.user_id, "654321");
  assert.equal(node.data.nickname, "群名片");
  assert.deepEqual(node.data.content.map((segment) => segment.type), ["text", "image", "text"]);
  assert.equal(node.data.content[0].data.text, "前\n");
  assert.equal(
    node.data.content[1].data.file,
    `base64://${Buffer.from("image").toString("base64")}`,
  );
  assert.equal(node.data.content[2].data.text, "\n后");
});

test("converts card data into readable forward text", () => {
  const node = recordToForwardNode({
    sender: { uin: "654321", nickname: "发送者" },
    message: {
      elements: [{
        arkElement: {
          bytesData: JSON.stringify({
            prompt: "[音乐] 示例歌曲",
            meta: { music: { title: "示例歌曲", singer: "示例歌手" } },
          }),
        },
      }],
    },
  });

  assert.deepEqual(node.data.content, [{
    type: "text",
    data: { text: "[音乐] 示例歌曲\n示例歌手" },
  }]);
});

test("prefers local image bytes before remote and MD5 resources", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mention-image-"));
  const imagePath = path.join(directory, "image.jpg");
  fs.writeFileSync(imagePath, "image");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const encodedImage = `base64://${Buffer.from("image").toString("base64")}`;
  const ntv2Url = "https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=old";

  assert.equal(
    imageResource({
      sourcePath: imagePath,
      originImageUrl: "https://example.com/image.jpg",
    }),
    encodedImage,
  );
  assert.equal(
    imageResource({ originImageUrl: "https://example.com/image.jpg" }),
    "https://example.com/image.jpg",
  );
  assert.equal(
    imageResource({ originImageUrl: "/relative/image.jpg" }),
    "https://gchat.qpic.cn/relative/image.jpg",
  );
  assert.equal(
    imageResource({
      originImageUrl: ntv2Url,
      url: "https://example.com/usable-image.jpg",
    }),
    "https://example.com/usable-image.jpg",
  );
  assert.equal(
    imageResource({
      originImageUrl: "https://gchat.qpic.cn/path?appid=1407&fileid=old",
      md5HexStr: "aabbccddaabbccddaabbccddaabbccdd",
    }),
    "https://gchat.qpic.cn/gchatpic_new/0/0-0-AABBCCDDAABBCCDDAABBCCDDAABBCCDD/0",
  );
  assert.equal(
    imageResource({ md5HexStr: "aabbccdd", sourcePath: imagePath }),
    encodedImage,
  );
  assert.equal(
    imageResource({
      md5HexStr: "not-an-md5",
      originImageMd5: "0123456789abcdef0123456789abcdef",
    }),
    "https://gchat.qpic.cn/gchatpic_new/0/0-0-0123456789ABCDEF0123456789ABCDEF/0",
  );
  assert.equal(imageResource({ originImageUrl: ntv2Url, sourcePath: imagePath }), encodedImage);
  assert.equal(imageResource({ originImageUrl: ntv2Url }), ntv2Url);
  assert.equal(imageResource({ sourcePath: "C:\\QQNT\\cache\\unavailable.jpg" }), "");
  assert.equal(imageResource({ url: "file:///C:/QQNT/cache/image.jpg" }), "");

  const fallbackNode = recordToForwardNode({
    sender: { uin: "654321", nickname: "发送者" },
    message: {
      elements: [{ picElement: { url: "file:///C:/missing.jpg", summary: "[远程图片]" } }],
    },
  });
  assert.deepEqual(fallbackNode.data.content, [{
    type: "text",
    data: { text: "[远程图片]" },
  }]);
});

test("prefers the matching Map or object thumbnail type", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mention-image-"));
  const fallbackPath = path.join(directory, "fallback.jpg");
  const preferredPath = path.join(directory, "preferred.jpg");
  fs.writeFileSync(fallbackPath, "fallback");
  fs.writeFileSync(preferredPath, "preferred");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const expected = `base64://${Buffer.from("preferred").toString("base64")}`;

  assert.equal(imageResource({
    picElementType: 720,
    thumbPath: new Map([[0, fallbackPath], ["720", preferredPath]]),
  }), expected);
  assert.equal(imageResource({
    picElementType: 720,
    thumbPath: { 0: fallbackPath, 720: preferredPath },
  }), expected);
});

test("sends the summary and forward to explicit private endpoints", async (t) => {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { message_id: received.length },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const config = { ...privateConfig, url: `http://127.0.0.1:${address.port}` };
  await sendOneBotMessage(config, "来源摘要");
  await sendOneBotForward(config, [{
    type: "node",
    data: {
      user_id: "654321",
      nickname: "发送者",
      content: [{ type: "text", data: { text: "消息" } }],
    },
  }]);
  const groupConfig = { ...config, messageType: "group", targetId: "778899" };
  await sendOneBotMessage(groupConfig, "群来源摘要");
  await sendOneBotForward(groupConfig, [{
    type: "node",
    data: {
      user_id: "654321",
      nickname: "发送者",
      content: [{ type: "text", data: { text: "群消息" } }],
    },
  }]);

  assert.deepEqual(received.map((request) => request.url), [
    "/send_private_msg",
    "/send_private_forward_msg",
    "/send_group_msg",
    "/send_group_forward_msg",
  ]);
  assert.equal(received[0].authorization, "Bearer secret");
  assert.equal(received[0].body.user_id, "654321");
  assert.equal(received[1].body.messages[0].type, "node");
  assert.equal(received[2].body.group_id, "778899");
  assert.equal(received[3].body.messages[0].type, "node");
});

test("inlines downloadable images and omits missing ones before calling OneBot", async (t) => {
  const imageRequests = [];
  const oneBotRequests = [];
  const server = http.createServer((request, response) => {
    if (request.method === "GET") {
      imageRequests.push(request.url);
      if (request.url === "/image.jpg") {
        response.writeHead(200, { "Content-Type": "image/jpeg" });
        response.end("remote-image");
      } else {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("not found");
      }
      return;
    }

    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      oneBotRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config = { ...privateConfig, url: baseUrl };
  const result = await sendOneBotForwardWithImageFallback(config, [{
    type: "node",
    data: {
      nickname: "发送者",
      content: [
        { type: "image", data: { file: `${baseUrl}/image.jpg`, summary: "[图片1]" } },
        { type: "image", data: { file: `${baseUrl}/missing.jpg`, summary: "[图片2]" } },
      ],
    },
  }]);

  assert.equal(result.usedImageFallback, true);
  assert.deepEqual(imageRequests.sort(), ["/image.jpg", "/missing.jpg"]);
  assert.equal(oneBotRequests.length, 1, "NapCat must not receive a URL that already returned 404");
  assert.equal(
    oneBotRequests[0].messages[0].data.content[0].data.file,
    `base64://${Buffer.from("remote-image").toString("base64")}`,
  );
  assert.deepEqual(oneBotRequests[0].messages[0].data.content[1], {
    type: "text",
    data: { text: "[图片2]" },
  });
});

test("retries NapCat image processing failures with text placeholders only", async (t) => {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "Content-Type": "application/json" });
      if (received.length === 1) {
        response.end(JSON.stringify({
          status: "failed",
          retcode: 1200,
          wording: "发送伪造合并转发消息失败: Error: 下载文件失败: Not Found",
        }));
      } else if (received.length === 2) {
        response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 2 } }));
      } else {
        response.end(JSON.stringify({ status: "failed", retcode: 1403, wording: "权限不足" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const config = { ...privateConfig, url: `http://127.0.0.1:${address.port}` };
  const messages = [{
    type: "node",
    data: {
      nickname: "发送者",
      content: [{
        type: "image",
        data: { file: `base64://${Buffer.from("image").toString("base64")}`, summary: "[图片]" },
      }],
    },
  }];

  const result = await sendOneBotForwardWithImageFallback(config, messages);
  assert.equal(result.usedImageFallback, true);
  assert.equal(received.length, 2);
  assert.equal(received[0].messages[0].data.content[0].type, "image");
  assert.deepEqual(received[1].messages[0].data.content[0], {
    type: "text",
    data: { text: "[图片]" },
  });

  await assert.rejects(
    sendOneBotForwardWithImageFallback(config, messages),
    /retcode 1403.*权限不足/,
  );
  assert.equal(received.length, 3, "unrelated failures must not be retried");
});
