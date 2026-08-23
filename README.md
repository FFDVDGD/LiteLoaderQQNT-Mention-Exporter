# LiteLoaderQQNT Mention Exporter

用于验证以下目标的 LiteLoaderQQNT 插件：

- 实时观察所有群聊消息，而不是读取当前聊天窗口 DOM；
- 捕获 `@全体成员`；
- 捕获当前账号被 `@` 的消息；
- 验证免打扰群是否仍通过 QQNT 消息 IPC 投递；
- 写入 JSONL 文本文件，并可通过 OneBot v11 HTTP API 发送来源摘要和上下文合并转发；
- 使用正则表达式过滤消息正文，并可按群 ID 单独过滤来源群。

## 实现方式

插件只在主进程中被动包装 `webContents.send`，观察 QQNT 已经发送的：

```text
nodeIKernelMsgListener/onRecvMsg
nodeIKernelMsgListener/onRecvActiveMsg
```

不创建额外 QQNT 内核 session，不调用 QQNT 历史拉取、群成员查询或 SSO 接口。

OneBot 使用异步串行队列发送，不会等待网络响应后再转发 QQ 自己的消息 IPC。

## 安装测试

1. 执行测试：

   ```powershell
   npm test
   ```

2. 将整个项目目录复制到 LiteLoader 插件目录，并确保最终路径类似：

   ```text
   llqqnt-plugins\plugins\mention_exporter\manifest.json
   ```

   也可以在 LiteLoader 设置页选择本项目的 `manifest.json` 安装。

3. 完全退出并重新启动 QQ。插件必须在 QQ 初始化阶段加载，不能靠刷新页面热加载。

4. 分别测试：

   - 普通群的 `@全体成员`；
   - 普通群直接 `@当前账号`；
   - 免打扰群的 `@全体成员`；
   - 免打扰群直接 `@当前账号`。

## 输出

默认输出文件：

```text
llqqnt-plugins\data\mention_exporter\mentions.jsonl
```

每行是一个独立 JSON 对象，包含：

- 捕获时间和 QQNT 事件名；
- `atAll` / `atMe` 分类；
- 群号、群名；
- 发送者 UID、QQ 号和昵称；
- 消息 ID、时间、文本摘要；
- 原始 `elements`，便于后续转换图片、文件、卡片等消息。

JSONL 便于实时追加；即使程序异常退出，已有行通常仍然可读。

启用 OneBot 后，每次触发最终输出两条消息。第一条是来源摘要：

```text
群：群名（群ID）
发送者：群名片或昵称（QQ号）
发送日期：2026-08-12 15:34:47
```

第二条是合并转发，节点范围固定为同一群、同一发起者的：

1. 出现 @ 的消息之前，该发起者最近的一条消息；
2. 出现 @ 的消息；
3. 该发起者之后的第一条消息。

其他成员的消息不进入范围，也不会打断等待。插件最多等待下一条 120 秒；超时后发送已有节点。插件刚启动、没有上一条时，则从 @ 消息开始。文字、显式换行、图片和元素顺序会尽量保留。

## 配置

首次运行会生成：

```text
llqqnt-plugins\data\mention_exporter\config.json
```

在 LiteLoader 设置中打开“群聊 @ 消息导出测试”，即可使用图形界面修改下列配置。点击“保存并立即生效”后无需重启 QQ；设置页还可主动测试来源摘要和合并转发。

也可以继续手动编辑配置文件，但手动编辑后需要重启 QQ 才会重新读取。

默认配置：

```json
{
  "enabled": true,
  "fileEnabled": true,
  "outputFile": "mentions.jsonl",
  "includeElements": true,
  "startupGraceSeconds": 10,
  "maxRememberedMessages": 10000,
  "blacklist": [],
  "groupIdBlacklist": [],
  "onebot": {
    "enabled": false,
    "url": "",
    "headers": {},
    "timeoutMs": 60000,
    "timeZone": "Asia/Shanghai",
    "messageType": "private",
    "targetId": "",
    "accessToken": ""
  }
}
```

- `enabled: false`：停止监控；
- `fileEnabled: false`：不再写 JSONL，但仍可发送 OneBot 消息；
- `outputFile` 可以是插件数据目录下的相对路径，也可以是绝对路径；
- `includeElements: false` 可减小文件体积；
- `startupGraceSeconds` 用于避免启动时把历史消息误判为实时消息；
- `maxRememberedMessages` 控制内存中的消息 ID 去重数量。

### OneBot v11 / NapCat

只支持 OneBot v11 HTTP API。填写以 `http://` 开头的服务基地址、接收类型和接收 QQ/群号；不要在地址末尾填写具体 action。

```json
{
  "enabled": true,
  "url": "http://127.0.0.1:3000",
  "headers": {},
  "timeoutMs": 60000,
  "timeZone": "Asia/Shanghai",
  "messageType": "private",
  "targetId": "123456",
  "accessToken": "replace-me"
}
```

- 私聊摘要：`/send_private_msg`；
- 私聊合并转发：`/send_private_forward_msg`；
- 群聊摘要：`/send_group_msg`；
- 群聊合并转发：`/send_group_forward_msg`；
- `headers`：额外 HTTP 请求头；
- `accessToken`：自动生成 `Authorization: Bearer <token>`；
- `timeoutMs`：单次请求超时；
- `timeZone`：来源摘要的 IANA 时区。

OneBot 返回 HTTP 200 但 `status` 为 `failed` 或 `retcode` 非 0 时，插件仍会将其记为发送失败。

合并转发使用自定义 OneBot 节点。图片优先将本机 QQNT 缓存编码为 `base64://` 后发送，避免远端 NapCat 无法读取本机路径；没有本地缓存时才使用 HTTP(S) 或 MD5 图片地址。如果远端图片已经失效，插件会仅重试合并转发并把图片降级为 `[图片]`，避免整条上下文丢失或重复发送来源摘要。

### 黑名单

`blacklist` 中的正则只匹配出现 @ 的消息正文，不匹配群名、群 ID 或消息时间。命中后既不写 JSONL，也不发送 OneBot 消息。

字符串默认使用 JavaScript 正则和 `u` 标志：

```json
"blacklist": [
  "广告|推广"
]
```

GUI 中第二列是正则标志下拉框，可选择区分大小写、忽略大小写、多行和点号匹配换行等组合。手动配置时使用对象：

```json
"blacklist": [
  {
    "pattern": "广告|推广",
    "flags": "iu"
  }
]
```

无效正则会被忽略并输出错误日志，不会阻止插件加载。

`groupIdBlacklist` 按群号精确匹配，与正文正则相互独立。群名不参与黑名单判断：

```json
"groupIdBlacklist": [
  "123456789",
  "987654321"
]
```

## 已知边界

- 这仍然依赖 QQNT 私有 IPC 名称和消息字段，QQ 更新后可能失效；
- 是否覆盖免打扰群必须真机测试，不能只凭源码保证；
- 插件只记录运行期间收到的新消息，不补拉历史记录；
- JSONL 仍在 QQ 主进程同步追加，目标消息数量通常很少；若后续导出量变大，应改为异步文件队列或数据库；
- OneBot 只在合并转发的远端图片下载失败时降级图片并重试一次，其他失败只记录错误日志；
- 使用 QwQNT/LiteLoaderQQNT 本身存在设备下线或账号风控风险，本插件不能消除该基础风险。
