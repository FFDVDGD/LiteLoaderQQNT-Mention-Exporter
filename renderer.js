const SETTINGS_HTML = /* html */ `
  <style>
    .mention-exporter-settings {
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding-bottom: 24px;
      color: var(--text_primary);
    }
    .mention-exporter-settings setting-item > div:first-child {
      min-width: 180px;
      padding-right: 20px;
    }
    .mention-exporter-settings setting-text[data-type="secondary"],
    .mention-exporter-help {
      display: block;
      margin-top: 4px;
      color: var(--text_secondary);
      font-size: min(var(--font_size_2), 14px);
      line-height: 1.5;
    }
    .mention-exporter-control {
      box-sizing: border-box;
      width: min(430px, 48vw);
      min-height: 30px;
      padding: 5px 8px;
      border: 1px solid var(--border_dark, rgba(127, 127, 127, .35));
      border-radius: 4px;
      outline: none;
      background: var(--fill_light_primary, rgba(127, 127, 127, .08));
      color: var(--text_primary);
      font: inherit;
    }
    .mention-exporter-control:focus {
      border-color: var(--brand_standard);
    }
    textarea.mention-exporter-control {
      min-height: 92px;
      resize: vertical;
      font-family: Consolas, "Courier New", monospace;
      font-size: 12px;
    }
    select.mention-exporter-control {
      width: 160px;
    }
    input[type="number"].mention-exporter-control {
      width: 160px;
    }
    .mention-exporter-rules {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      margin-top: 12px;
    }
    .mention-exporter-rule {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(180px, 220px) auto;
      gap: 8px;
      align-items: center;
    }
    .mention-exporter-rule .mention-exporter-control {
      width: 100%;
    }
    .mention-exporter-remove {
      min-height: 30px;
      padding: 4px 10px;
      border: 1px solid var(--border_dark, rgba(127, 127, 127, .35));
      border-radius: 4px;
      background: transparent;
      color: var(--text_primary);
      cursor: pointer;
    }
    .mention-exporter-remove:hover {
      background: var(--overlay_hover, rgba(127, 127, 127, .12));
    }
    .mention-exporter-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 16px;
    }
    .mention-exporter-status {
      min-height: 20px;
      color: var(--text_secondary);
      font-size: 13px;
    }
    .mention-exporter-status[data-state="success"] { color: #2ba471; }
    .mention-exporter-status[data-state="error"] { color: #e34d59; }
    .mention-exporter-hidden { display: none !important; }
    @media (max-width: 720px) {
      .mention-exporter-control { width: 44vw; }
      .mention-exporter-rule { grid-template-columns: 1fr minmax(140px, 180px) auto; }
    }
  </style>
  <div class="mention-exporter-settings">
    <setting-section data-title="监控与文件输出">
      <setting-panel>
        <setting-list data-direction="column">
          <setting-item data-direction="row">
            <div>
              <setting-text>启用消息监控</setting-text>
              <setting-text data-type="secondary">监控群聊中的 @全体成员 和当前账号被 @ 消息。</setting-text>
            </div>
            <setting-switch id="mentionExporterEnabled"></setting-switch>
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>写入 JSONL 文件</setting-text>
              <setting-text data-type="secondary">关闭后仍可单独使用 OneBot 输出。</setting-text>
            </div>
            <setting-switch id="mentionExporterFileEnabled"></setting-switch>
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>写入滚动调试日志</setting-text>
              <setting-text data-type="secondary">记录图片资源选择与降级原因；debug.log 达到 5 MiB 后滚动，保留 3 个备份。</setting-text>
            </div>
            <setting-switch id="mentionExporterDebugLogEnabled"></setting-switch>
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>输出文件</setting-text>
              <setting-text data-type="secondary">相对路径位于插件数据目录，也支持绝对路径。</setting-text>
            </div>
            <input id="mentionExporterOutputFile" class="mention-exporter-control" type="text" spellcheck="false">
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>保留原始消息元素</setting-text>
              <setting-text data-type="secondary">关闭可减小 JSONL 文件体积。</setting-text>
            </div>
            <setting-switch id="mentionExporterIncludeElements"></setting-switch>
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>启动宽限时间</setting-text>
              <setting-text data-type="secondary">避免启动时把旧消息识别为实时消息，单位为秒。</setting-text>
            </div>
            <input id="mentionExporterStartupGrace" class="mention-exporter-control" type="number" min="0" step="1">
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>消息去重上限</setting-text>
              <setting-text data-type="secondary">主进程内保留的最近消息 ID 数量，最低 100。</setting-text>
            </div>
            <input id="mentionExporterRemembered" class="mention-exporter-control" type="number" min="100" step="1">
          </setting-item>
        </setting-list>
      </setting-panel>
    </setting-section>

    <setting-section data-title="OneBot v11 HTTP API">
      <setting-panel>
        <setting-list data-direction="column">
          <setting-item data-direction="row">
            <div>
              <setting-text>启用 OneBot 输出</setting-text>
              <setting-text data-type="secondary">触发后等待同一发起者的下一条消息，最多 120 秒；先发送来源摘要，再发送合并转发。</setting-text>
            </div>
            <setting-switch id="mentionExporterOneBotEnabled"></setting-switch>
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>HTTP 地址</setting-text>
              <setting-text data-type="secondary">只填写以 http:// 开头的 OneBot 基地址；插件自动选择普通消息和合并转发接口。</setting-text>
            </div>
            <input id="mentionExporterOneBotUrl" class="mention-exporter-control" type="url" spellcheck="false" placeholder="http://127.0.0.1:3000">
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>OneBot 接收类型</setting-text>
              <setting-text data-type="secondary">私聊使用 send_private_msg；群聊使用 send_group_msg，并使用对应的合并转发接口。</setting-text>
            </div>
            <select id="mentionExporterMessageType" class="mention-exporter-control">
              <option value="private">私聊</option>
              <option value="group">群聊</option>
            </select>
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>OneBot 接收目标</setting-text>
              <setting-text data-type="secondary">私聊填写目标 QQ 号；群聊填写目标群号。</setting-text>
            </div>
            <input id="mentionExporterTargetId" class="mention-exporter-control" type="text" inputmode="numeric" spellcheck="false" placeholder="QQ 号或群号">
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>OneBot Access Token</setting-text>
              <setting-text data-type="secondary">可选；自动作为 Authorization: Bearer &lt;token&gt; 发送。</setting-text>
            </div>
            <input id="mentionExporterAccessToken" class="mention-exporter-control" type="password" spellcheck="false" autocomplete="off">
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>额外请求头</setting-text>
              <setting-text data-type="secondary">JSON 对象，可填写 Authorization 等鉴权信息。</setting-text>
            </div>
            <textarea id="mentionExporterOneBotHeaders" class="mention-exporter-control" spellcheck="false"></textarea>
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>请求超时</setting-text>
              <setting-text data-type="secondary">单位为毫秒，最低 1000。</setting-text>
            </div>
            <input id="mentionExporterOneBotTimeout" class="mention-exporter-control" type="number" min="1000" step="100">
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>消息时区</setting-text>
              <setting-text data-type="secondary">使用 IANA 时区名称，例如 Asia/Shanghai。</setting-text>
            </div>
            <input id="mentionExporterOneBotTimeZone" class="mention-exporter-control" type="text" spellcheck="false">
          </setting-item>
          <setting-item data-direction="row">
            <div>
              <setting-text>测试当前 OneBot 配置</setting-text>
              <setting-text data-type="secondary">主动发送一条来源摘要和一条三节点合并转发，不会自动保存配置。</setting-text>
            </div>
            <setting-button id="mentionExporterTest" data-type="secondary">发送两条测试消息</setting-button>
          </setting-item>
        </setting-list>
      </setting-panel>
    </setting-section>

    <setting-section data-title="消息正文黑名单">
      <setting-panel>
        <setting-list data-direction="column">
          <setting-item data-direction="row">
            <div>
              <setting-text>正文正则规则</setting-text>
              <setting-text data-type="secondary">只匹配出现 @ 的消息正文，不匹配群名、群 ID 或消息时间；命中后不写文件，也不发 OneBot。</setting-text>
            </div>
            <setting-button id="mentionExporterAddRule" data-type="secondary">添加规则</setting-button>
          </setting-item>
          <setting-item data-direction="row">
            <div id="mentionExporterRules" class="mention-exporter-rules"></div>
          </setting-item>
        </setting-list>
      </setting-panel>
    </setting-section>

    <setting-section data-title="群 ID 黑名单">
      <setting-panel>
        <setting-list data-direction="column">
          <setting-item data-direction="row">
            <div>
              <setting-text>忽略指定群</setting-text>
              <setting-text data-type="secondary">按群号精确匹配，每行填写一个群 ID；群名不参与判断。</setting-text>
            </div>
            <textarea id="mentionExporterGroupIdBlacklist" class="mention-exporter-control" spellcheck="false" placeholder="123456789\n987654321"></textarea>
          </setting-item>
        </setting-list>
      </setting-panel>
    </setting-section>

    <div class="mention-exporter-actions">
      <setting-button id="mentionExporterSave" data-type="primary">保存并立即生效</setting-button>
      <span id="mentionExporterStatus" class="mention-exporter-status" role="status"></span>
    </div>
  </div>
`;

function setSwitch(element, active) {
  element.toggleAttribute("is-active", Boolean(active));
}

function getSwitch(element) {
  return element.hasAttribute("is-active");
}

function bindSwitch(element) {
  element.addEventListener("click", () => setSwitch(element, !getSwitch(element)));
}

function setDisabled(element, disabled) {
  element.toggleAttribute("is-disabled", disabled);
}

function readableError(error) {
  const message = String(error?.message ?? error ?? "未知错误");
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function addBlacklistRule(container, entry = {}) {
  const row = document.createElement("div");
  row.className = "mention-exporter-rule";

  const pattern = document.createElement("input");
  pattern.className = "mention-exporter-control";
  pattern.dataset.field = "pattern";
  pattern.type = "text";
  pattern.spellcheck = false;
  pattern.placeholder = "正则表达式，例如 广告|推广";
  pattern.value = typeof entry === "string" ? entry : entry.pattern ?? "";

  const flags = document.createElement("select");
  flags.className = "mention-exporter-control";
  flags.dataset.field = "flags";
  const flagOptions = [
    ["u", "区分大小写"],
    ["iu", "忽略大小写"],
    ["mu", "多行"],
    ["imu", "多行 + 忽略大小写"],
    ["su", ". 匹配换行"],
    ["isu", ". 匹配换行 + 忽略大小写"],
    ["msu", "多行 + . 匹配换行"],
    ["imsu", "多行 + . 匹配换行 + 忽略大小写"],
  ];
  const currentFlags = typeof entry === "string" ? "u" : entry.flags ?? "u";
  if (!flagOptions.some(([value]) => value === currentFlags)) {
    flagOptions.push([currentFlags, `原配置：${currentFlags}`]);
  }
  for (const [value, label] of flagOptions) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    flags.append(option);
  }
  flags.value = currentFlags;

  const remove = document.createElement("button");
  remove.className = "mention-exporter-remove";
  remove.type = "button";
  remove.textContent = "删除";
  remove.addEventListener("click", () => row.remove());

  row.append(pattern, flags, remove);
  container.append(row);
  pattern.focus();
}

function numberValue(view, selector, label, minimum) {
  const value = Number(view.querySelector(selector).value);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${label}不能小于 ${minimum}`);
  }
  return value;
}

function collectConfig(view) {
  let headers;
  try {
    headers = JSON.parse(view.querySelector("#mentionExporterOneBotHeaders").value || "{}");
  } catch (error) {
    throw new Error(`额外请求头不是有效 JSON：${error.message}`);
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("额外请求头必须是 JSON 对象");
  }

  const blacklist = [];
  for (const [index, row] of [...view.querySelectorAll(".mention-exporter-rule")].entries()) {
    const pattern = row.querySelector('[data-field="pattern"]').value;
    const flags = row.querySelector('[data-field="flags"]').value || "u";
    if (!pattern) continue;
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`第 ${index + 1} 条黑名单无效：${error.message}`);
    }
    blacklist.push({ pattern, flags });
  }

  const groupIdBlacklist = [...new Set(
    view.querySelector("#mentionExporterGroupIdBlacklist").value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
  const invalidGroupId = groupIdBlacklist.find((entry) => !/^\d+$/.test(entry));
  if (invalidGroupId) {
    throw new Error(`群 ID 黑名单中“${invalidGroupId}”不是有效群号`);
  }

  return {
    enabled: getSwitch(view.querySelector("#mentionExporterEnabled")),
    fileEnabled: getSwitch(view.querySelector("#mentionExporterFileEnabled")),
    debugLogEnabled: getSwitch(view.querySelector("#mentionExporterDebugLogEnabled")),
    outputFile: view.querySelector("#mentionExporterOutputFile").value.trim(),
    includeElements: getSwitch(view.querySelector("#mentionExporterIncludeElements")),
    startupGraceSeconds: numberValue(view, "#mentionExporterStartupGrace", "启动宽限时间", 0),
    maxRememberedMessages: numberValue(view, "#mentionExporterRemembered", "消息去重上限", 100),
    blacklist,
    groupIdBlacklist,
    onebot: {
      enabled: getSwitch(view.querySelector("#mentionExporterOneBotEnabled")),
      url: view.querySelector("#mentionExporterOneBotUrl").value.trim(),
      headers,
      timeoutMs: numberValue(view, "#mentionExporterOneBotTimeout", "OneBot 超时", 1000),
      timeZone: view.querySelector("#mentionExporterOneBotTimeZone").value.trim(),
      messageType: view.querySelector("#mentionExporterMessageType").value,
      targetId: view.querySelector("#mentionExporterTargetId").value.trim(),
      accessToken: view.querySelector("#mentionExporterAccessToken").value.trim(),
    },
  };
}

function fillConfig(view, config) {
  setSwitch(view.querySelector("#mentionExporterEnabled"), config.enabled);
  setSwitch(view.querySelector("#mentionExporterFileEnabled"), config.fileEnabled);
  setSwitch(view.querySelector("#mentionExporterDebugLogEnabled"), config.debugLogEnabled);
  view.querySelector("#mentionExporterOutputFile").value = config.outputFile;
  setSwitch(view.querySelector("#mentionExporterIncludeElements"), config.includeElements);
  view.querySelector("#mentionExporterStartupGrace").value = config.startupGraceSeconds;
  view.querySelector("#mentionExporterRemembered").value = config.maxRememberedMessages;
  setSwitch(view.querySelector("#mentionExporterOneBotEnabled"), config.onebot.enabled);
  view.querySelector("#mentionExporterOneBotUrl").value = config.onebot.url;
  view.querySelector("#mentionExporterOneBotHeaders").value = JSON.stringify(config.onebot.headers, null, 2);
  view.querySelector("#mentionExporterOneBotTimeout").value = config.onebot.timeoutMs;
  view.querySelector("#mentionExporterOneBotTimeZone").value = config.onebot.timeZone;
  view.querySelector("#mentionExporterMessageType").value = config.onebot.messageType;
  view.querySelector("#mentionExporterTargetId").value = config.onebot.targetId;
  view.querySelector("#mentionExporterAccessToken").value = config.onebot.accessToken;

  const rules = view.querySelector("#mentionExporterRules");
  rules.replaceChildren();
  config.blacklist.forEach((entry) => addBlacklistRule(rules, entry));
  view.querySelector("#mentionExporterGroupIdBlacklist").value = config.groupIdBlacklist.join("\n");
}

export async function onSettingWindowCreated(view) {
  view.innerHTML = SETTINGS_HTML;
  const status = view.querySelector("#mentionExporterStatus");
  const save = view.querySelector("#mentionExporterSave");
  const test = view.querySelector("#mentionExporterTest");
  const switches = view.querySelectorAll("setting-switch");
  switches.forEach(bindSwitch);

  const showStatus = (message, state = "") => {
    status.textContent = message;
    status.dataset.state = state;
  };

  view.querySelector("#mentionExporterAddRule").addEventListener("click", () => {
    addBlacklistRule(view.querySelector("#mentionExporterRules"));
  });
  try {
    if (!window.mentionExporter) throw new Error("预加载脚本未注入，请完全重启 QQ");
    fillConfig(view, await window.mentionExporter.getConfig());
  } catch (error) {
    showStatus(`读取配置失败：${readableError(error)}`, "error");
    return;
  }

  save.addEventListener("click", async () => {
    if (save.hasAttribute("is-disabled")) return;
    setDisabled(save, true);
    showStatus("正在保存…");
    try {
      const saved = await window.mentionExporter.saveConfig(collectConfig(view));
      fillConfig(view, saved);
      showStatus("已保存，配置已立即生效。", "success");
    } catch (error) {
      showStatus(`保存失败：${readableError(error)}`, "error");
    } finally {
      setDisabled(save, false);
    }
  });

  test.addEventListener("click", async () => {
    if (test.hasAttribute("is-disabled")) return;
    setDisabled(test, true);
    showStatus("正在发送 OneBot 测试消息…");
    try {
      const config = collectConfig(view);
      const result = await window.mentionExporter.testOneBot(config.onebot);
      showStatus(`测试成功，两条消息均已发送（HTTP ${result.status}）。`, "success");
    } catch (error) {
      showStatus(`测试失败：${readableError(error)}`, "error");
    } finally {
      setDisabled(test, false);
    }
  });
}
