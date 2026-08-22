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

test("prefers a non-NTV2 image URL over a local cache", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mention-image-"));
  const imagePath = path.join(directory, "image.jpg");
  fs.writeFileSync(imagePath, "image");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(
    imageResource({
      sourcePath: imagePath,
      originImageUrl: "https://example.com/image.jpg",
    }),
    "https://example.com/image.jpg",
  );
  assert.equal(
    imageResource({ originImageUrl: "/relative/image.jpg" }),
    "https://gchat.qpic.cn/relative/image.jpg",
  );
  assert.equal(
    imageResource({
      originImageUrl: "https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=old",
      url: "https://example.com/usable-image.jpg",
    }),
    "https://example.com/usable-image.jpg",
  );
  assert.equal(
    imageResource({
      originImageUrl: "https://gchat.qpic.cn/path?appid=1407&fileid=old",
      md5HexStr: "aabbccdd",
    }),
    "https://gchat.qpic.cn/gchatpic_new/0/0-0-AABBCCDD/0",
  );
  assert.equal(imageResource({ sourcePath: "C:\\QQNT\\cache\\unavailable.jpg" }), "");
  assert.equal(imageResource({ url: "file:///C:/QQNT/cache/image.jpg" }), "");
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
