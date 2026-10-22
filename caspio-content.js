/**
 * Caspio 页面内容脚本
 *
 * 负责三个核心功能：
 * 1. 扫描表格中所有外部链接，构建任务队列
 * 2. 拦截用户点击外部链接，启动批量审批流程
 * 3. 从操作队列中依次执行审批提交（在后台自动完成）
 *
 * ====== v1.2.0 性能改造说明 ======
 * 旧版每处理一条审批都要"模拟点击 Edit → 展开下拉 → 点选项 → 点 Update →
 * 整页刷新 → 脚本重新注入"，且夹带大量固定 delay，导致 Caspio 侧处理速度
 * 远远跟不上用户在外部页面的判断速度，队列不断积压。
 *
 * 抓包分析发现：本类 Caspio DataPage 的提交本质是一个 AJAX 请求
 * （AjaxAction=UpdateRow），根本不需要整页刷新。因此本版引入两档处理引擎：
 *
 *   档位 2（首选，AjaxEngine）：
 *     直接用 fetch 复现 GetRowData + UpdateRow 请求，绕过 UI 与整页刷新，
 *     在一个页面上下文里连续地消化整个队列。
 *     （抓包实测 Caspio 服务器耗时：GetRowData ≈0.4s、UpdateRow ≈1.3s，单条串行约 1.7–1.9s，
 *      v1.2.0 注释中“每条约 0.2–0.5s”的说法有误，已更正。）
 *     仅在该 DataPage 的配置里显式声明了 ajax 元数据（可编辑字段集合）时启用，
 *     以避免误伤未验证的页面；任何令牌缺失或请求失败都会自动回退到档位 1。
 *
 *   档位 1（回退，UiEngine）：
 *     沿用模拟 UI 的方式，但改为"连续消化整个队列"且用事件驱动等待替代固定
 *     delay，比旧版显著更快，且不再依赖整页刷新续传。
 *
 * 两档共用同一个调度器 processQueue()，带重入保护。
 *
 * ====== v1.3.0 ======
 * 建队列时额外采集每行 “Duplicates: what happened before” 列（历史重复申请情况），
 * 随 items 传到目标页，由 target-content.js 在审批浮层下方醒目展示。
 *
 * ====== v1.4.0：跟上快速审批 ======
 * 1. 不再丢操作：待执行操作从共享数组 caspioOperations 改为“每条一个 storage 键”
 *    （caspioOp:<序号>），新增与删除各管各的键，消除与 background 之间读改写交错导致的
 *    静默丢失。旧版残留的 caspioOperations 会在页面加载时自动迁移。
 * 2. 并发提交：AJAX 档位最多同时提交 AJAX_CONCURRENCY 条（不同记录）。抓包显示 Caspio
 *    自身页面连续请求始终复用同一个 appSession，说明会话令牌无需逐条接力，可以并发。
 *    任一 AJAX 失败即自动降级为串行，并把该条交给 UI 引擎重试；同一记录的多条操作严格按先后顺序执行。
 * 3. 去掉后台降速：Caspio 标签页在后台时 Chrome 会把定时器限制为每秒一次，
 *    旧版循环中的 delay(0) 与 UI 引擎的定时轮询因此每次都可能多等约 1 秒。
 *    现在热路径不再依赖定时器：调度由 fetch / storage 回调驱动，DOM 等待改用 MutationObserver。
 * 4. 可见性：显示待提交数量；仍有未提交操作时关闭/刷新 Caspio 页面会弹出离开确认。
 *
 * ====== v1.5.0：确认每条都真正保存 + 审核日志 ======
 * 1. 提交后核对：UpdateRow 响应带回该行保存后的数据，只有其中的审批值与用户选择一致才算成功；
 *    旧版只看“响应能否解析为 JSON”，服务器没保存时也会被当成成功而静默丢失。
 *    失败的条目会先串行重试一次 AJAX，再交给 UI 模拟；仍失败则标记为 Failed，可一键重试。
 * 2. 单个 AJAX 请求 30 秒超时，避免卡住的请求永久占用并发名额、导致待提交数不再下降。
 * 3. 审核日志：每个决定（审批 / 跳过）及其提交结果写入 caspioLog:* 条目；一轮审阅结束且全部
 *    处理完后自动导出 CSV 到本地，也可随时在状态条点 Download log 或点击扩展图标导出。
 * 4. Caspio 页面顶部居中显示醒目的状态条（待提交 / 失败 / 全部保存），并把保存结果直接标在表格行上。
 *
 * Storage 数据结构：
 * - taskQueue: { items: [{targetUrl, recordId, duplicates?, company?}], currentIndex, caspioTabId,
 *                config, sessionId, sessionStartedAt }
 * - caspioOp:<序号>: {recordId, choice, createdAt, sessionId, logKey}  单条待执行审批操作，按键名排序即 FIFO
 * - caspioLog:<序号>: 审核日志条目（由 background 创建，本脚本写入提交结果）
 * - caspioSessionEnd:<sessionId>: {endedAt, exported}  会话结束标记，用于自动导出日志
 * - caspioLastSessionId: 最近一轮审阅会话 ID（状态条统计用）
 */

(function () {
  "use strict";

  /* ====== storage 键名前缀（与 background.js / target-content.js 保持一致） ====== */

  /** 单条待执行审批操作：caspioOp:<时间戳>-<序号> → {recordId, choice, createdAt, sessionId, logKey} */
  const OP_PREFIX = "caspioOp:";
  /** 审核日志条目：caspioLog:<时间戳>-<序号> → 一条决定（审批或跳过）及其提交结果，用于导出 CSV */
  const LOG_PREFIX = "caspioLog:";
  /** 审阅会话结束标记：caspioSessionEnd:<sessionId> → {endedAt, exported} */
  const SESSION_END_PREFIX = "caspioSessionEnd:";

  /* ====== 多 DataPage 配置 ====== */

  /**
   * 不同 Caspio DataPage 的审批配置表。
   *
   * 各字段含义：
   * - inlineEditField: 内联编辑表单中审批下拉框 <select> 的 name 属性（UI 引擎使用）。
   * - options: 目标页面浮层中展示的审批按钮列表（传给 target-content.js）。
   * - approvalLabel: 审批列在结果表中的列名关键字（不区分大小写的包含匹配，用来忽略列名里的 emoji）。
   *     提交成功后用它找到该行的审批单元格并写入服务器回读的值，让 Caspio 表格直接显示已保存的结果；
   *     若该列被设为分组列（行内没有对应单元格），则只给整行打上“已保存”标记。
   * - ajax（可选）: 该页面的 AJAX 直连元数据。仅当存在此字段时才启用档位 2。
   *     - approvalField: 审批字段在 Caspio 行数据中的字段名（不含 InlineEdit 前缀）。
   *     - editableFields: 该 DataPage 内联编辑表单中所有可编辑字段的字段名集合。
   *         提交 UpdateRow 时必须回传全部可编辑字段（只改审批字段），否则未回传的
   *         字段会被服务器清空，属破坏性风险，务必与页面实际可编辑列保持一致。
   *     - pageId: DataPage 的 PageID（一般为 "2"，仅作缺省，运行时会尝试从页面读取覆盖）。
   */
  const DATAPAGE_CONFIGS = {
    /* 页面一：Catman 审批页（三个审批选项）。
     * 暂无该页面的抓包，未声明 ajax 元数据 → 只走档位 1（优化后的 UI 模拟）。
     * 待补充该页面的 editableFields 后即可开启 AJAX 直连。 */
    "111d6000ed43124f32b24bd99611": {
      inlineEditField: "InlineEditCatmanApproval",
      approvalLabel: "Catman Approval",
      options: [
        { text: "Approved without KAM", value: "Approved without KAM", className: "cao-btn cao-btn-approve" },
        { text: "Approved with KAM",    value: "Approved with KAM",    className: "cao-btn cao-btn-approve-kam" },
        { text: "Declined",             value: "Declined",             className: "cao-btn cao-btn-decline" }
      ],
      /* 可编辑字段集合来自真实页面内联编辑表单的运行时探测（见控制台“已发现可编辑字段”日志）。
       * 硬编码于此后，页面一从第一条起即可走 AJAX 直连，无需先慢跑一条 UI 采集。 */
      ajax: {
        approvalField: "CatmanApproval",
        editableFields: ["CatmanApproval", "TargetMarket", "LeadSource", "Note", "BusinessLine"],
        pageId: "2"
      }
    },
    /* 页面二：Initial application sorting（Target Market 审批）。
     * 已通过抓包确认可编辑字段集合与 AJAX 协议，开启档位 2 直连。 */
    "111d6000f90d0b783d8f420784b1": {
      inlineEditField: "InlineEditTargetMarket",
      approvalLabel: "Target Market",
      options: [
        { text: "OK (approved)", value: "OK (approved)", className: "cao-btn cao-btn-approve" },
        { text: "Declined",      value: "Declined",      className: "cao-btn cao-btn-decline" }
      ],
      ajax: {
        approvalField: "TargetMarket",
        /* 抓包 UpdateRow 中出现的全部 InlineEdit* 字段（去掉前缀）：
         * InlineEditOrigin / KeyCategory / TargetMarket / DeclineReason / Note */
        editableFields: ["Origin", "KeyCategory", "TargetMarket", "DeclineReason", "Note"],
        pageId: "2"
      }
    }
  };

  const DEFAULT_CONFIG = DATAPAGE_CONFIGS["111d6000ed43124f32b24bd99611"];

  /**
   * 运行时发现的可编辑字段表，按 DataPage 部署 ID 缓存：{ [pageId]: string[] }。
   *
   * 关键设计：本表持久化到 chrome.storage.local。只要在某个 DataPage 上做过一次内联编辑
   * （首条走 UI 时会自动采集字段），之后无论逐条审批、跨会话、还是页面刷新，都能立刻
   * 启用 AJAX 直连，而不必每次都先慢跑一条 UI。这样才能覆盖“用户回到 Caspio 逐条点链接”
   * 的真实用法——否则每条都成了“新会话第一条”，永远走不到 AJAX。
   *
   * 注意：若某 DataPage 的可编辑列日后发生增删，缓存可能过时。任何一次 UI 回退都会重新
   * 采集并覆盖本表；AJAX 提交时也会与 GetRowData 字段取交集，已知字段缺失则跳过而非清空。
   */
  let discoveredFieldsMap = {};

  /** 从 URL 中解析 Caspio DataPage 的部署 ID（/dp/<id>）。失败返回 null。 */
  function getDataPageId() {
    const match = location.pathname.match(/\/dp\/([a-z0-9]+)/i);
    return match ? match[1] : null;
  }

  /** 获取当前 DataPage 的审批配置；未登记的页面回退到 DEFAULT_CONFIG。 */
  function getCurrentConfig() {
    const id = getDataPageId();
    return (id && DATAPAGE_CONFIGS[id]) || DEFAULT_CONFIG;
  }

  /* ====== 扩展上下文与 storage 安全封装 ====== */

  /** 扩展被重新加载后旧脚本会失联，此时 chrome.runtime.id 为 undefined。 */
  function isExtensionContextValid() {
    try {
      return !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  /** 安全地向 background 发消息；上下文失效则静默忽略。 */
  function safeSendMessage(message, callback) {
    if (!isExtensionContextValid()) return;
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch (e) {
      /* 上下文失效，忽略 */
    }
  }

  /** 安全地访问 chrome.storage.local。 */
  function safeStorage(method, arg, callback) {
    if (!isExtensionContextValid()) return;
    try {
      chrome.storage.local[method](arg, callback);
    } catch (e) {
      /* 上下文失效，忽略 */
    }
  }

  /** Promise 化的 storage.get（上下文失效时 resolve 空对象）。 */
  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!isExtensionContextValid()) { resolve({}); return; }
      try {
        chrome.storage.local.get(keys, (r) => resolve(r || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  /* ====== 页面加载后的初始化 ====== */

  safeSendMessage({ action: "registerCaspioTab" });

  /* 启动时从持久化存储加载已发现的可编辑字段表，使 AJAX 直连可在本次会话第一条即生效 */
  safeStorage("get", "discoveredFieldsMap", (r) => {
    if (r && r.discoveredFieldsMap) {
      discoveredFieldsMap = r.discoveredFieldsMap;
      console.log("[Caspio Assistant][AJAX] 已加载持久化可编辑字段表:", Object.keys(discoveredFieldsMap));
    }
  });

  /**
   * 页面加载后启动一次队列消化。
   * 这是"页面刷新后继续处理队列"的安全网：即便某些 DataPage 的 Update 仍会
   * 触发整页刷新，刷新后脚本重新执行也会在此重新开始消化剩余操作。
   * 延迟缩短到 400ms（旧版 1000ms），并等待表格就绪以尽快开始。
   * 启动前先迁移旧版遗留的 caspioOperations 数组，避免升级时丢掉未提交的审批。
   */
  setTimeout(() => {
    if (!isExtensionContextValid()) return;
    migrateLegacyOperations().then(() => {
      processQueue();
      refreshStatusBar();
      maybeExportFinishedSessions();
    });
  }, 400);

  /**
   * 监听 storage 变化：
   * - 有新的操作键写入时立即唤醒调度器（不依赖 background 的 processCaspioQueue 消息，
   *   消息可能因页面刷新而丢失；processQueue 自带重入保护，重复唤醒无害）；
   * - 操作键 / 日志条目 / 会话结束标记有变化时刷新顶部状态条，并检查是否该自动导出日志。
   */
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !isExtensionContextValid()) return;
      const keys = Object.keys(changes);
      const opKeys = keys.filter((k) => k.startsWith(OP_PREFIX));
      if (opKeys.some((k) => changes[k].newValue !== undefined)) processQueue();
      if (opKeys.length || keys.some((k) => k.startsWith(LOG_PREFIX) || k.startsWith(SESSION_END_PREFIX) || k === "caspioLastSessionId")) {
        refreshStatusBar();
      }
      if (keys.some((k) => k.startsWith(SESSION_END_PREFIX))) maybeExportFinishedSessions();
    });
  } catch (e) {
    /* 上下文失效，忽略 */
  }

  /**
   * 仍有未提交操作时，阻止用户无意中关闭或刷新 Caspio 页面。
   *
   * 待提交操作依赖本页面的 DOM（行序号、Edit 按钮）与会话令牌来提交；页面一旦关闭，
   * 剩余操作要等用户重新打开同一 DataPage 才会继续。浏览器会显示其标准的“离开此网站？”确认框。
   * UI 引擎在兼容“整页刷新”的 DataPage 上点击 Update 时会主动置位 expectingReload，避免误拦截。
   */
  window.addEventListener("beforeunload", (event) => {
    if (pendingCount > 0 && !expectingReload) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  /* ====== 点击外部链接 → 构建任务队列 ====== */

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link) return;

    const href = link.href;
    if (!href) return;

    /* 只处理指向外部网站的链接 */
    try {
      const url = new URL(href);
      if (url.hostname.endsWith("caspio.com")) return;
    } catch (e) {
      return;
    }

    const row = link.closest("tr");
    if (!row) return;

    const editLink = row.querySelector('a.cbResultSetActionsLinks[title^="Edit"]');
    if (!editLink) return;

    const allItems = scanAllRows();
    const clickedRecordId = extractRecordId(editLink.href);

    let startIndex = allItems.findIndex(item => item.recordId === clickedRecordId);
    if (startIndex === -1) startIndex = 0;

    /* 交由 background 在 taskQueue 锁内建立新会话（同时结束上一轮未完成的会话、
     * 生成审核日志所需的 sessionId，并直接记录本标签页为 Caspio 标签页）。
     *
     * 注意：这里刻意不清空尚未提交的操作键（旧版会清空 caspioOperations）。
     * 它们是用户在上一轮已经做出的有效审批，清空会造成静默丢失；
     * 调度器会在新一轮审阅的同时继续把它们提交完。 */
    safeSendMessage({
      action: "startSession",
      items: allItems,
      currentIndex: startIndex,
      config: getCurrentConfig()
    }, () => {
      console.log(`[Caspio Assistant] 任务队列已建立: ${allItems.length} 项, 起始索引: ${startIndex}`);
    });
  });

  /* ====== 来自 background 的消息 ====== */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "processCaspioQueue") {
      /* 用户每做一次审批，background 会发一次本消息（storage.onChanged 也会唤醒，二者互为冗余）。
       * processQueue 带重入保护，多次触发只会合并为一次调度。 */
      processQueue();
      sendResponse({ status: "processing" });
    }
    return true;
  });

  /* ====== 表格扫描 ====== */

  /**
   * 扫描所有表格行，提取含外部链接与 Edit 按钮的行。
   * @returns {Array<{targetUrl: string, recordId: string, duplicates?: string, company?: string}>}
   */
  function scanAllRows() {
    const items = [];
    const rows = document.querySelectorAll("tr");

    for (const row of rows) {
      const editLink = row.querySelector('a.cbResultSetActionsLinks[title^="Edit"]');
      if (!editLink) continue;

      let targetUrl = null;
      const links = row.querySelectorAll("a");
      for (const a of links) {
        try {
          const url = new URL(a.href);
          if (!url.hostname.endsWith("caspio.com")) {
            targetUrl = a.href;
            break;
          }
        } catch (e) {
          /* 非法 URL，跳过 */
        }
      }

      if (!targetUrl) continue;

      const recordId = extractRecordId(editLink.href);
      if (recordId) {
        const item = { targetUrl, recordId };
        /* 仅当该 DataPage 存在 Duplicates 列时才写入字段（空串表示该行无重复记录），
         * 列不存在时不写入，目标页据此区分“无重复”与“该页面无此列”两种情况。 */
        const duplicates = extractDuplicatesInfo(row);
        if (duplicates !== null) item.duplicates = duplicates;
        /* 公司名仅用于审核日志（CSV）中辨识记录；页面没有该列时留空，日志会改用 GetRowData 返回的值 */
        const company = readCellByLabel(row, (t) => /^\s*Company\s*:?\s*$/i.test(t));
        if (company) item.company = company;
        items.push(item);
      }
    }

    return items;
  }

  /**
   * 从数据行中读取 “Duplicates: what happened before” 列的文本。
   *
   * 业务背景：Caspio 会为每条申请计算历史重复情况，格式形如
   * “PHONE_DUP x2 -> 1 approved, 1 declined, last 14.10.2026”，无重复时单元格为空（NULL）。
   * 重复类型不止手机号（已见 PHONE_DUP / COMPANY_DUP / STORE_DUP / WECHAT_DUP / BL_DUP），
   * 同一申请命中多种类型时单元格内为多行（<br> 分隔），返回值以 
 分隔各行。
   * 审批人需要在外部页面审阅时一眼看到该信息，因此在建队列时随行一并采集。
   *
   * 定位方式：Caspio 结果表每个单元格内都带有
   *   <span data-tabular-html-cell-label class="cbResultSetLabel">列名:</span>值
   * 的标签结构（用于响应式布局），按标签文本匹配列名比按列序号定位更稳健——
   * 列顺序调整、增删列都不会影响识别。
   *
   * @param {HTMLTableRowElement} row - 数据行
   * @returns {string|null} 列不存在返回 null；列存在但为空（含字面量 NULL）返回 ""；否则返回去空白后的文本
   */
  function extractDuplicatesInfo(row) {
    /* 列名有中英两种：英文页面为 “Duplicates: what happened before”，
     * Freelancer 页面（/dp/111d6000f90d0b783d8f420784b1）为俄文 “Дубли: что было раньше”。
     * 注意：JS 正则的 \b 只认 ASCII 单词字符，紧跟在西里尔字母后永远不成立，故俄文分支不加 \b。 */
    const value = readCellByLabel(row, (t) => /^\s*(Duplicates\b|Дубли)/i.test(t));
    if (value === null) return null;
    return /^null$/i.test(value) ? "" : value;
  }

  /**
   * 按列名标签查找数据行中的单元格。
   *
   * Caspio 结果表每个单元格内都带有 <span data-tabular-html-cell-label>列名:</span>值 的结构，
   * 按标签文本匹配比按列序号定位更稳健（列顺序调整、增删列都不影响）。
   *
   * @param {HTMLTableRowElement} row - 数据行
   * @param {(labelText: string) => boolean} match - 标签文本匹配函数
   * @returns {{cell: HTMLTableCellElement, label: HTMLElement}|null} 未找到返回 null
   */
  function findCellByLabel(row, match) {
    const labels = row.querySelectorAll("span[data-tabular-html-cell-label]");
    for (const label of labels) {
      if (!match(label.textContent || "")) continue;
      const cell = label.closest("td");
      return cell ? { cell, label } : null;
    }
    return null;
  }

  /**
   * 读取单元格的值（去掉列名标签部分）。
   *
   * @param {HTMLTableRowElement} row - 数据行
   * @param {(labelText: string) => boolean} match - 标签文本匹配函数
   * @returns {string|null} 列不存在返回 null；否则返回去空白后的文本（&nbsp; 视为空白），
   *   单元格内的多行（<br> 分隔）以 
 连接
   */
  function readCellByLabel(row, match) {
    const found = findCellByLabel(row, match);
    if (!found) return null;

    /* 在副本上处理，避免改动 Caspio 页面本身：去掉列名标签，把 <br> 与块级元素边界转为换行。
     * 不能直接用 textContent——它会丢掉 <br>，导致 Duplicates 列的多条记录
     * （如 PHONE_DUP … / COMPANY_DUP … / BL_DUP …）首尾相连成一行。 */
    const clone = found.cell.cloneNode(true);
    const label = clone.querySelector("span[data-tabular-html-cell-label]");
    if (label) label.remove();
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    clone.querySelectorAll("div, p, li").forEach((el) => el.append("\n"));

    /* &nbsp; 视为空白；逐行 trim 并去掉空行，多行之间用 \n 连接 */
    return (clone.textContent || "")
      .replace(/ /g, " ")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }

  /** 从 Edit 链接 URL 中提取 Mod0RecordID。 */
  function extractRecordId(href) {
    try {
      const url = new URL(href);
      return url.searchParams.get("Mod0RecordID");
    } catch (e) {
      return null;
    }
  }

  /* ====== 队列消化调度器（两档共用） ====== */

  /**
   * AJAX 档位的最大并发提交数。
   *
   * 取 3 的理由：UpdateRow 在服务器端约 1.3s，3 路并发即可让有效吞吐降到每条约 0.6s，
   * 足以跟上绝大多数审批人的判断速度；再往上加，对 Caspio 服务器压力增大而边际收益有限。
   * 若 Caspio 服务器对同一会话的请求串行处理，并发只是不提速，不会出错。
   */
  const AJAX_CONCURRENCY = 3;

  /**
   * 运行时降级标志：任意一条 AJAX 提交失败（含“提交后回读值不一致”）后置为 true，
   * 本页面生命周期内改为串行（并发 1），以免在服务器异常、令牌失效或服务器不接受并发时
   * 把多条请求同时打到失败路径上。页面刷新后重置。
   */
  let ajaxDegraded = false;

  /**
   * AJAX 引擎的页面上下文缓存：undefined=尚未提取，null=不可用（只走 UI），object=可用。
   * 每轮队列清空后重置为 undefined，下次有新操作时重新提取，以防用户在 Caspio 页面翻页/检索后令牌变化。
   */
  let ajaxCtx = undefined;

  /** 正在提交中的操作：键 → recordId。用于控制并发数，并保证同一记录的操作不会同时提交。 */
  const inFlight = new Map();

  /**
   * 本页面生命周期内已经处理完（成功或判定失败）的操作键。
   * 用于防止“调度器读到旧快照时，某条操作刚完成并删除了键”造成同一操作被再次提交。
   */
  const completedKeys = new Set();

  /** 调度器重入保护：pumping 表示正在调度；pumpAgain 表示调度期间又被唤醒，需要再跑一轮。 */
  let pumping = false;
  let pumpAgain = false;

  /** 当前待提交（含提交中）的操作数，供顶部状态条与离开确认使用。 */
  let pendingCount = 0;

  /**
   * UI 引擎在可能触发整页刷新的 Update 点击前置为 true，避免 beforeunload 误拦截自身的刷新。
   */
  let expectingReload = false;

  /** Promise 化的 storage.set（上下文失效时直接 resolve）。 */
  function storageSet(obj) {
    return new Promise((resolve) => {
      if (!isExtensionContextValid()) { resolve(); return; }
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  /**
   * 从全部 storage 内容中取出待执行操作，按键名排序（即按创建先后，FIFO）。
   *
   * @param {Object} all - chrome.storage.local.get(null) 的结果
   * @returns {Array<{key:string, recordId:string, choice:string, sessionId?:string, logKey?:string}>}
   */
  function pendingOperationsFrom(all) {
    return Object.keys(all)
      .filter((k) => k.startsWith(OP_PREFIX) && all[k] && all[k].recordId)
      .sort()
      .map((k) => ({
        key: k,
        recordId: String(all[k].recordId),
        choice: all[k].choice,
        sessionId: all[k].sessionId,
        logKey: all[k].logKey
      }));
  }

  /** 读取全部待执行操作。 */
  async function listPendingOperations() {
    return pendingOperationsFrom(await storageGet(null));
  }

  /**
   * 删除一条已处理的操作键。只删自己的键，不会影响 background 同时写入的新操作。
   * 对不存在的键调用也安全（幂等）。
   *
   * @param {string} key - 操作键
   * @returns {Promise<void>}
   */
  function removeOperation(key) {
    return new Promise((resolve) => {
      if (!isExtensionContextValid()) { resolve(); return; }
      try {
        chrome.storage.local.remove(key, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  /**
   * 更新一条审核日志条目（合并字段）。
   *
   * 日志条目由 background 在用户做出决定时创建；此后只有处理该条操作的 worker 会写它
   * （同一条目同一时刻至多一个操作在处理），因此这里的读改写不存在并发覆盖。
   * 条目不存在（例如旧版遗留的操作没有日志）时不新建，直接忽略。
   *
   * @param {string|undefined} logKey - 日志键
   * @param {Object} patch - 要合并的字段；其中 addAttempts 表示在原尝试次数上累加
   *   （“Retry failed” 重试时同一条目的尝试次数需要累计，而不是被本轮次数覆盖）
   * @returns {Promise<void>}
   */
  async function updateLog(logKey, patch) {
    if (!logKey) return;
    const current = (await storageGet(logKey))[logKey];
    if (!current) return;
    const { addAttempts, ...rest } = patch;
    const next = { ...current, ...rest };
    if (addAttempts) next.attempts = (current.attempts || 0) + addAttempts;
    /* 公司名只在原条目为空时补写（来自 GetRowData），不覆盖建队列时从表格读到的值 */
    if (current.company) next.company = current.company;
    await storageSet({ [logKey]: next });
  }

  /**
   * 把旧版（≤ v1.3.0）遗留的 caspioOperations 数组迁移为逐条操作键，然后删除旧数组。
   *
   * 迁移键使用全零时间戳前缀，保证排在所有新操作之前，维持原有的先后顺序。
   * 升级扩展时若仍有未提交的旧操作，这一步保证它们不会被遗弃。
   *
   * @returns {Promise<void>}
   */
  async function migrateLegacyOperations() {
    const { caspioOperations } = await storageGet("caspioOperations");
    if (!Array.isArray(caspioOperations)) return;
    const entries = {};
    caspioOperations.forEach((op, i) => {
      if (op && op.recordId) {
        entries[OP_PREFIX + "00000000000000-legacy-" + String(i).padStart(4, "0")] =
          { recordId: op.recordId, choice: op.choice, createdAt: 0 };
      }
    });
    await storageSet(entries);
    await new Promise((resolve) => safeStorage("remove", "caspioOperations", resolve));
    if (Object.keys(entries).length) {
      console.log(`[Caspio Assistant] 已迁移旧版待提交操作 ${Object.keys(entries).length} 条`);
    }
  }

  /**
   * 计算当前 DataPage 生效的 AJAX 元数据。
   * 优先用硬编码配置，其次用（持久化的）运行时发现字段。都没有时返回 null（本条只能走 UI）。
   *
   * @param {Object} cfg - DataPage 配置
   * @returns {{approvalField:string, editableFields:string[]}|null}
   */
  function getAjaxConfig(cfg) {
    if (cfg.ajax && Array.isArray(cfg.ajax.editableFields) && cfg.ajax.editableFields.length) {
      return { approvalField: cfg.ajax.approvalField, editableFields: cfg.ajax.editableFields };
    }
    const id = getDataPageId();
    const fields = id && discoveredFieldsMap[id];
    if (fields && fields.length) {
      /* 审批字段名由内联编辑下拉框 name 去掉 InlineEdit 前缀推导，如 InlineEditCatmanApproval → CatmanApproval */
      const approvalField = (cfg.inlineEditField || "").replace(/^InlineEdit/, "");
      return { approvalField, editableFields: fields };
    }
    return null;
  }

  /**
   * 调度器：读取待执行操作，在并发上限内为尚未开始的操作启动提交任务。
   *
   * 不是一个长循环，而是“按需补位”：每当有新操作写入（storage.onChanged / 消息）
   * 或某条提交完成时都会被调用一次，把空出来的并发名额补上。整个过程由 fetch 与
   * storage 回调驱动，不依赖 setTimeout，因此不受后台标签页的定时器降速影响。
   *
   * 选取规则：
   * - 按键名顺序（FIFO）遍历；
   * - 跳过已在提交中或本页已处理完的操作；
   * - 同一 recordId 若已有更早的操作在提交中或排在前面，则本轮不启动，保证同一记录
   *   的多次审批按先后顺序落库（最后一次选择生效）。
   */
  async function processQueue() {
    if (!isExtensionContextValid()) return;
    if (pumping) { pumpAgain = true; return; }
    pumping = true;

    try {
      do {
        pumpAgain = false;
        if (!isExtensionContextValid()) break;

        const pending = (await listPendingOperations()).filter((op) => !completedKeys.has(op.key));
        pendingCount = pending.length;

        if (!pending.length && !inFlight.size) {
          /* 队列清空：下一轮重新提取页面上下文，避免令牌随页面状态变化而过期；
           * 并检查是否有已结束且已全部处理完的审阅会话需要自动导出日志 */
          if (ajaxCtx !== undefined) console.log("[Caspio Assistant] 队列已清空");
          ajaxCtx = undefined;
          maybeExportFinishedSessions();
          break;
        }

        const cfg = getCurrentConfig();
        const ajaxCfg = getAjaxConfig(cfg);
        if (ajaxCfg && ajaxCtx === undefined) {
          ajaxCtx = extractPageContext(cfg); /* 提取失败返回 null，本轮清空前不再重试 */
        }
        const useAjax = !!(ajaxCfg && ajaxCtx);
        /* UI 模拟需要独占页面 DOM，只能串行；AJAX 未降级时允许并发 */
        const limit = useAjax && !ajaxDegraded ? AJAX_CONCURRENCY : 1;

        const blockedRecords = new Set(inFlight.values());
        for (const op of pending) {
          if (inFlight.size >= limit) break;
          if (inFlight.has(op.key)) continue;
          if (blockedRecords.has(op.recordId)) continue;
          blockedRecords.add(op.recordId);

          inFlight.set(op.key, op.recordId);
          runOperation(op, cfg, useAjax ? ajaxCfg : null).finally(() => {
            inFlight.delete(op.key);
            processQueue(); /* 名额空出，补位 */
          });
        }
      } while (pumpAgain);
    } catch (error) {
      console.error("[Caspio Assistant] 调度异常:", error);
    } finally {
      pumping = false;
      refreshStatusBar();
    }
  }

  /**
   * 提交单条操作，并把最终结果写入审核日志、标记到 Caspio 表格行上。
   *
   * 尝试顺序（审批写入是幂等的，重复写同一值无害，因此每一步失败都可以安全重试）：
   * 1. AJAX 直连（提交后用服务器返回的行数据核对审批值，核对不上视为失败）；
   * 2. 若第 1 步失败：降级为串行（并发本身可能就是失败原因）后再试一次 AJAX——超时、偶发网络错误
   *    等瞬时问题重试即可恢复，比直接转 UI 模拟更快更稳；
   * 3. UI 模拟（点击 Edit → 选择 → Update）。
   * 全部失败才判定为 Failed，日志中记录最后一次的失败原因，用户可在顶部状态条点 “Retry failed” 重试。
   *
   * 无论成功与否，结束时都会删除操作键并记入 completedKeys，防止被重复调度。
   *
   * @param {{key:string, recordId:string, choice:string, logKey?:string}} op - 操作
   * @param {Object} cfg - DataPage 配置
   * @param {Object|null} ajaxCfg - 生效的 AJAX 元数据；null 表示直接走 UI
   * @returns {Promise<void>} 永不 reject
   */
  async function runOperation(op, cfg, ajaxCfg) {
    console.log(`[Caspio Assistant] 处理操作: recordId=${op.recordId}, choice=${op.choice}`);
    let attempts = 0;
    /* 每次尝试的失败原因都保留（“AJAX #1: … | AJAX #2: … | UI: …”）。
     * 旧做法只记最后一次，真实日志里 UI 回退的报错把 AJAX 的根因覆盖掉了，无法排查。 */
    const errors = [];
    let result = null;
    let method = "";

    try {
      /* ---- 档位 2：AJAX 直连（必要时串行重试一次） ---- */
      if (ajaxCfg && ajaxCtx) {
        for (let i = 0; i < 2 && !(result && result.ok); i++) {
          attempts++;
          method = "AJAX";
          result = await AjaxEngine.submit(ajaxCtx, ajaxCfg, op);
          if (result.ok) break;
          errors.push(`AJAX #${i + 1}: ${result.reason}`);
          console.warn(`[Caspio Assistant][AJAX] recordId=${op.recordId} 第 ${attempts} 次提交失败: ${result.reason}`);
          if (!ajaxDegraded) {
            ajaxDegraded = true;
            console.warn("[Caspio Assistant][AJAX] 出现失败，本页面后续改为串行提交");
          }
        }
      }

      /* ---- 档位 1：UI 模拟；用互斥锁保证同一时刻只有一条在操作 DOM ---- */
      if (!(result && result.ok)) {
        attempts++;
        method = "UI";
        result = await withUiLock(() => UiEngine.submit(cfg, op));
        if (!result.ok) errors.push(`UI: ${result.reason}`);
      }
    } catch (error) {
      console.error("[Caspio Assistant] 提交操作异常:", error);
      result = { ok: false, reason: "Unexpected error: " + (error && error.message ? error.message : error) };
      errors.push(result.reason);
    }

    const errorText = errors.join(" | ") || "Unknown error";
    try {
      if (result && result.ok) {
        await updateLog(op.logKey, {
          status: "Saved",
          method,
          addAttempts: attempts,
          savedAt: Date.now(),
          savedValue: result.savedValue != null ? result.savedValue : "",
          company: result.company || "",
          /* 成功前若有失败尝试，保留其原因（Status 仍为 Saved），便于分析重试规律 */
          error: errors.length ? "Recovered after: " + errorText : ""
        });
        markRow(op.recordId, cfg, "saved", result.savedValue != null && result.savedValue !== "" ? result.savedValue : op.choice);
      } else {
        await updateLog(op.logKey, { status: "Failed", method, addAttempts: attempts, savedAt: null, error: errorText });
        markRow(op.recordId, cfg, "failed", op.choice);
        safeSendMessage({ action: "caspioOperationFailed", recordId: op.recordId, reason: errorText });
      }
    } finally {
      await removeOperation(op.key);
      completedKeys.add(op.key);
    }
  }

  /**
   * UI 引擎互斥锁：UI 模拟要点击 Edit、操作下拉框、点击 Update，会改动页面 DOM，
   * 两条同时进行会互相干扰。AJAX 并发时若有多条同时回退到 UI，在此排队串行执行。
   */
  let uiLock = Promise.resolve();
  function withUiLock(fn) {
    const run = uiLock.then(fn, fn);
    uiLock = run.catch(() => {});
    return run;
  }

  /* ====== Caspio 表格行标记 ====== */

  /**
   * 在 Caspio 结果表中标记某条记录的提交结果。
   *
   * 原因：AJAX 直连不经过页面 UI，Caspio 表格不会自动刷新，用户看表格会以为“没保存”。
   * 这里把服务器回读的审批值写进该行的审批单元格（若该列在行内可见），并给整行着色、
   * 在操作列追加一个结果徽标，让用户在 Caspio 页面上也能直接核对每条的保存结果。
   * 仅改动显示，不影响 Caspio 的数据与后续内联编辑（内联编辑会通过 GetRowData 重新取数）。
   *
   * @param {string} recordId - 记录 ID
   * @param {Object} cfg - DataPage 配置（需要 approvalLabel）
   * @param {"saved"|"failed"} state - 结果
   * @param {string} value - 已保存的值（saved）或用户的选择（failed）
   */
  function markRow(recordId, cfg, state, value) {
    const editLink = findEditLinkByRecordId(recordId);
    const row = editLink && editLink.closest("tr");
    if (!row) return;

    if (state === "saved" && cfg.approvalLabel) {
      const label = cfg.approvalLabel.toLowerCase();
      const found = findCellByLabel(row, (t) => t.toLowerCase().includes(label));
      if (found) {
        /* 保留列名标签 span，替换其后的值 */
        while (found.label.nextSibling) found.label.nextSibling.remove();
        found.cell.appendChild(document.createTextNode(value));
      }
    }

    row.style.backgroundColor = state === "saved" ? "#e6f4ea" : "#fdecea";

    const actionCell = editLink.closest("td") || row.lastElementChild;
    let badge = row.querySelector(".caspio-assistant-row-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "caspio-assistant-row-badge";
      actionCell.appendChild(badge);
    }
    badge.textContent = state === "saved" ? `✓ Saved: ${value}` : `✗ Not saved: ${value}`;
    badge.title = state === "saved"
      ? "Saved to Caspio by Caspio Approval Assistant"
      : "Caspio Approval Assistant could not save this decision. See the review log for details.";
    Object.assign(badge.style, {
      display: "inline-block",
      marginLeft: "6px",
      padding: "2px 6px",
      borderRadius: "4px",
      fontSize: "11px",
      fontWeight: "700",
      whiteSpace: "nowrap",
      color: "#ffffff",
      backgroundColor: state === "saved" ? "#28a745" : "#dc3545"
    });
  }

  /* ====== 顶部状态条（Caspio 页面） ====== */

  /** 状态条刷新的合并标志：刷新进行中再次触发时只补跑一轮，避免频繁 storage 读取堆积。 */
  let statusRefreshing = false;
  let statusRefreshAgain = false;

  /**
   * 重新统计并渲染顶部状态条。
   *
   * 统计来源：
   * - 待提交数：storage 中的 caspioOp:* 键（排除本页已处理完的）；
   * - 最近一轮审阅会话（caspioLastSessionId）的日志条目：已保存 / 失败 / 跳过数量。
   */
  async function refreshStatusBar() {
    if (statusRefreshing) { statusRefreshAgain = true; return; }
    statusRefreshing = true;
    try {
      do {
        statusRefreshAgain = false;
        const all = await storageGet(null);
        const pending = pendingOperationsFrom(all).filter((op) => !completedKeys.has(op.key));
        pendingCount = pending.length;

        const sessionId = all.caspioLastSessionId || null;
        const stats = { saved: 0, failed: 0, skipped: 0, total: 0 };
        if (sessionId) {
          for (const k of Object.keys(all)) {
            if (!k.startsWith(LOG_PREFIX) || !all[k] || all[k].sessionId !== sessionId) continue;
            const status = all[k].status;
            if (status === "Skipped") { stats.skipped++; continue; }
            stats.total++;
            if (status === "Saved") stats.saved++;
            else if (status === "Failed") stats.failed++;
          }
        }
        const ended = sessionId ? all[SESSION_END_PREFIX + sessionId] : null;
        renderStatusBar({ pending: pendingCount, sessionId, stats, ended });
      } while (statusRefreshAgain);
    } catch (e) {
      /* 状态条仅为提示，读取失败不影响提交流程 */
    } finally {
      statusRefreshing = false;
    }
  }

  /** 用户关闭过状态条的会话 ID（每个浏览器本地记忆，避免再次打开 Caspio 页面时反复提示）。 */
  function getDismissedSession() {
    try { return localStorage.getItem("caspioAssistantDismissedSession"); } catch (e) { return null; }
  }
  function setDismissedSession(id) {
    try { localStorage.setItem("caspioAssistantDismissedSession", id); } catch (e) { /* 忽略 */ }
  }

  /**
   * 渲染顶部居中的状态条。
   *
   * 三种状态：
   * - 有积压：琥珀色 “Saving to Caspio: N pending”（如有失败附加 “· M failed”），提醒不要关闭页面；
   * - 无积压但最近一轮有失败：红色 “M decisions could not be saved to Caspio”，提供 Retry failed；
   * - 无积压且全部成功：绿色 “All N decisions saved to Caspio”，仅在会话进行中或结束后 30 分钟内显示。
   * 后两种状态可点 × 关闭；三种状态都提供 Download log。
   *
   * @param {{pending:number, sessionId:string|null, stats:Object, ended:Object|null}} s - 统计数据
   */
  function renderStatusBar(s) {
    const recentlyEnded = !s.ended || (Date.now() - (s.ended.endedAt || 0) < 30 * 60 * 1000);
    let mode = null;
    if (s.pending > 0) mode = "busy";
    else if (s.sessionId && getDismissedSession() !== s.sessionId) {
      if (s.stats.failed > 0) mode = "failed";
      else if (s.stats.saved > 0 && recentlyEnded) mode = "done";
    }

    let bar = document.getElementById("caspio-assistant-status");
    if (!mode) {
      if (bar) bar.remove();
      return;
    }
    ensureStatusBarStyle();
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "caspio-assistant-status";
      bar.setAttribute("role", "status");
      document.body.appendChild(bar);
    }
    bar.className = "cas-" + mode;
    bar.textContent = "";

    const text = document.createElement("span");
    text.className = "cas-text";
    if (mode === "busy") {
      text.textContent = `⏳ Saving to Caspio: ${s.pending} pending` + (s.stats.failed ? ` · ${s.stats.failed} failed` : "");
      bar.title = "Approval decisions waiting to be saved to Caspio. Keep this tab open until all are saved.";
    } else if (mode === "failed") {
      text.textContent = `⚠ ${s.stats.failed} of ${s.stats.total} decision${s.stats.total === 1 ? "" : "s"} could not be saved to Caspio`;
      bar.title = "Open the review log to see why, or retry them now.";
    } else {
      text.textContent = `✓ All ${s.stats.saved} decision${s.stats.saved === 1 ? "" : "s"} saved to Caspio`;
      bar.title = "";
    }
    bar.appendChild(text);

    if (mode === "failed") {
      bar.appendChild(makeBarButton("Retry failed", "Submit the failed decisions again", () => retryFailed(s.sessionId)));
    }
    if (s.sessionId) {
      bar.appendChild(makeBarButton("Download log", "Download the review log of this session as a CSV file", () => {
        safeSendMessage({ action: "exportReviewLog", sessionId: s.sessionId });
      }));
    }
    if (mode !== "busy") {
      const close = makeBarButton("×", "Dismiss", () => {
        setDismissedSession(s.sessionId);
        bar.remove();
      });
      close.classList.add("cas-close");
      bar.appendChild(close);
    }
  }

  /** 创建状态条按钮。 */
  function makeBarButton(label, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  /**
   * 注入状态条样式（Caspio 页面没有注入 overlay.css，故以 <style> 方式一次性注入）。
   * 固定在页面顶部正中、超高 z-index；字号 18px 加粗，确保在 Caspio 页面上足够醒目。
   */
  function ensureStatusBarStyle() {
    if (document.getElementById("caspio-assistant-status-style")) return;
    const style = document.createElement("style");
    style.id = "caspio-assistant-status-style";
    style.textContent = `
      #caspio-assistant-status {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; display: flex; align-items: center; gap: 12px;
        max-width: calc(100vw - 32px); box-sizing: border-box;
        padding: 12px 22px; border-radius: 10px;
        font: 700 18px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      }
      #caspio-assistant-status.cas-busy { background: #ffc107; color: #1a1a1a; box-shadow: 0 6px 24px rgba(0,0,0,.35), inset 0 0 0 2px #e0a800; }
      #caspio-assistant-status.cas-failed { background: #dc3545; color: #ffffff; }
      #caspio-assistant-status.cas-done { background: #28a745; color: #ffffff; }
      #caspio-assistant-status .cas-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #caspio-assistant-status button {
        font: 600 13px/1 inherit; font-family: inherit; cursor: pointer; white-space: nowrap;
        padding: 7px 12px; border-radius: 6px; border: 1px solid rgba(0, 0, 0, 0.25);
        background: rgba(255, 255, 255, 0.9); color: #1a1a1a;
      }
      #caspio-assistant-status button:hover { background: #ffffff; }
      #caspio-assistant-status button.cas-close {
        background: transparent; border: none; color: inherit; font-size: 20px; padding: 0 4px;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * 把最近一轮会话中失败的审批重新放回待执行队列。
   *
   * 为每条失败日志生成新的操作键（时间戳格式与 background 一致，保证排在已有操作之后），
   * 并把日志状态改回 Pending；操作带上原日志键，处理完后原日志条目原地更新（尝试次数累加）。
   *
   * @param {string} sessionId - 会话 ID
   */
  async function retryFailed(sessionId) {
    const all = await storageGet(null);
    const writes = {};
    let n = 0;
    for (const k of Object.keys(all)) {
      const entry = all[k];
      if (!k.startsWith(LOG_PREFIX) || !entry || entry.sessionId !== sessionId || entry.status !== "Failed") continue;
      n++;
      const opKey = OP_PREFIX + String(Date.now()).padStart(14, "0") + "-r" + String(n).padStart(3, "0");
      writes[opKey] = { recordId: entry.recordId, choice: entry.decision, createdAt: Date.now(), sessionId, logKey: k };
      writes[k] = { ...entry, status: "Pending", error: "" };
    }
    if (n) {
      console.log(`[Caspio Assistant] 重新提交失败的审批 ${n} 条`);
      await storageSet(writes);
    }
  }

  /* ====== 审核日志自动导出 ====== */

  /**
   * 检查已结束的审阅会话：若某会话的全部操作都已处理完（没有属于它的待执行操作键）
   * 且尚未导出，则请求 background 生成 CSV 并直接下载到本地。
   *
   * 由 Caspio 页面触发的原因：只有这里知道提交何时真正完成；background 收到请求后会在锁内
   * 再次检查“是否已导出”，因此多处同时触发也只会下载一次。Caspio 页面若已关闭，
   * 用户可点击浏览器工具栏上的扩展图标手动导出。
   */
  async function maybeExportFinishedSessions() {
    const all = await storageGet(null);
    const pendingSessions = new Set(pendingOperationsFrom(all).map((op) => op.sessionId).filter(Boolean));
    for (const k of Object.keys(all)) {
      if (!k.startsWith(SESSION_END_PREFIX)) continue;
      const info = all[k];
      const sessionId = k.slice(SESSION_END_PREFIX.length);
      if (!info || info.exported || pendingSessions.has(sessionId)) continue;
      safeSendMessage({ action: "exportReviewLog", sessionId, auto: true });
    }
  }

  /* ====== 档位 2：AJAX 直连引擎 ====== */

  /**
   * 从当前页面 DOM/脚本中提取 AJAX 请求所需的会话级令牌与页面参数。
   *
   * 由于这些令牌只存在于运行时页面中（初始文档未被本仓库的抓包捕获），
   * 本函数会尽力从多个来源提取，并把结果打印到控制台（探测日志），
   * 便于在真实页面上验证与后续加固。任一关键令牌缺失则返回 null → 触发回退。
   *
   * @param {Object} cfg - 当前 DataPage 配置
   * @returns {Object|null} 提取到的上下文，或 null（不可用）
   */
  function extractPageContext(cfg) {
    try {
      const appKey = getDataPageId();

      /* cbUniqueFormId：取自结果表格 id 的后缀，如 cbTable_7ff826731d4785 → _7ff826731d4785 */
      let cbUniqueFormId = null;
      const table = document.querySelector('table[id^="cbTable"]');
      if (table) cbUniqueFormId = table.id.replace(/^cbTable/, "");

      /* 汇总所有 <script> 文本，便于正则提取 dataPageReady 初始化参数 */
      const scriptBlob = Array.from(document.scripts).map((s) => s.textContent || "").join("\n");
      const readInit = (name) => {
        const m = scriptBlob.match(new RegExp('"' + name + '"\\s*:\\s*"([^"]*)"'));
        return m ? m[1] : null;
      };

      /* appSession 优先从 Edit 链接 href 读取（最贴近当前页状态），回退到初始化脚本 */
      let appSession = null;
      const anyEdit = document.querySelector('a.cbResultSetActionsLinks[href*="appSession="]');
      if (anyEdit) {
        const m = anyEdit.href.match(/[?&]appSession=([^&]+)/);
        if (m) appSession = decodeURIComponent(m[1]);
      }
      if (!appSession) appSession = readInit("appSession");

      const dpFolderKey = readInit("dpFolderKey");
      /* UpdateRow 的 RequestToken 即初始化脚本中的 antiForgeryToken */
      const requestToken = readInit("antiForgeryToken");
      const stylePublicId = readInit("stylePublicId");
      const proxyUrl = readInit("proxyUrl") || location.href.split("?")[0];

      /* PageID / cbCurrentPageSize：优先从 Edit 链接 href 读取，回退到配置/缺省 */
      let pageId = (cfg.ajax && cfg.ajax.pageId) || "2";
      let pageSize = "500";
      if (anyEdit) {
        const mp = anyEdit.href.match(/[?&]PageID=(\d+)/);
        if (mp) pageId = mp[1];
        const ms = anyEdit.href.match(/[?&]cbCurrentPageSize=(\d+)/);
        if (ms) pageSize = ms[1];
      }

      /* 搜索条件：从页面表单里序列化 Caspio 的检索参数（NumCriteria / FieldNameN / ValueN_M 等）。
       * UpdateRow 抓包中包含这些参数；缺失时也尝试提交（更新以 recordId 为准）。 */
      const searchParams = collectSearchCriteria();

      const ctx = {
        appKey,
        cbUniqueFormId,
        appSession,
        dpFolderKey,
        requestToken,
        stylePublicId,
        proxyUrl,
        pageId,
        pageSize,
        searchParams,
        endpoint: proxyUrl /* AJAX 目标 URL（不含 rnd） */
      };

      /* ---- 探测日志（每次页面加载只打一次） ---- */
      if (!ctxLogged) {
        console.log("[Caspio Assistant][AJAX] 页面上下文提取结果:", {
          appKey,
          cbUniqueFormId,
          appSession: appSession ? appSession.slice(0, 12) + "…(" + appSession.length + ")" : null,
          dpFolderKey: dpFolderKey ? dpFolderKey.slice(0, 12) + "…" : null,
          requestToken,
          stylePublicId,
          pageId,
          pageSize,
          searchParamCount: Object.keys(searchParams).length
        });
      }

      /* 关键令牌校验：任一缺失则判定 AJAX 不可用，回退到 UI 引擎 */
      const missing = [];
      if (!appKey) missing.push("appKey");
      if (!cbUniqueFormId) missing.push("cbUniqueFormId");
      if (!appSession) missing.push("appSession");
      if (!dpFolderKey) missing.push("dpFolderKey");
      if (!requestToken) missing.push("requestToken(antiForgeryToken)");
      if (missing.length) {
        console.warn("[Caspio Assistant][AJAX] 缺少关键令牌，禁用 AJAX 直连，回退到 UI 模拟:", missing);
        return null;
      }

      if (!ctxLogged) {
        console.log("[Caspio Assistant][AJAX] ✅ 上下文完整，启用 AJAX 直连");
        ctxLogged = true;
      }
      return ctx;
    } catch (e) {
      console.warn("[Caspio Assistant][AJAX] 提取页面上下文异常，回退到 UI 模拟:", e);
      return null;
    }
  }

  /**
   * 从页面表单中序列化 Caspio 检索条件参数。
   * 匹配形如 NumCriteria / GlobalOperator / FieldNameN / OperatorN /
   * NumCriteriaDetailsN / ComparisonTypeN_M / ValueN_M / MatchNullN_M 的隐藏字段。
   *
   * @returns {Object<string,string>}
   */
  function collectSearchCriteria() {
    const params = {};
    const re = /^(NumCriteria|GlobalOperator|FieldName\d+|Operator\d+|NumCriteriaDetails\d+|ComparisonType\d+_\d+|Value\d+_\d+|MatchNull\d+_\d+)$/;
    document.querySelectorAll("input[name], select[name]").forEach((el) => {
      if (re.test(el.name) && !(el.name in params)) {
        params[el.name] = el.value;
      }
    });
    return params;
  }

  /**
   * AJAX 直连引擎：用 fetch 复现 GetRowData + UpdateRow。
   */
  /* 诊断日志节流标志：上下文与行字段结构在同一页面生命周期内不变，各只打印一次即可，
   * 避免逐条审批时刷屏。告警类日志不受此限制，始终打印。 */
  let ctxLogged = false;
  let rowFieldsLogged = false;

  /** 单个 Caspio AJAX 请求的超时（毫秒）。实测 UpdateRow 约 1.3s，30s 足够宽松且能及时释放卡住的名额。 */
  const AJAX_TIMEOUT_MS = 30000;

  /**
   * 从 GetRowData / UpdateRow 响应中取出指定记录的行数据。
   * @param {Object|null} json - 响应 JSON
   * @param {string} recordId - 记录 ID
   * @returns {Object|null} rows["pk_id<recordId>"]，不存在返回 null
   */
  function pickRow(json, recordId) {
    const rows = (json && json.rows) || {};
    return rows["pk_id" + String(recordId)] || null;
  }

  /**
   * 概括一个 Caspio 响应“实际返回了什么”，用于失败原因（写入审核日志的 Error 列）。
   *
   * 排查价值：若响应里是另一条记录（如按行序号定位错位），这里会列出其记录 ID；
   * 若 Caspio 返回了提示信息（responseText，如校验错误），截取前 160 个字符（去掉 HTML 标签）。
   *
   * @param {Object|null} json - 响应 JSON
   * @returns {string} 英文描述，如 “Caspio returned record(s) 39150; message: …”
   */
  function describeResponse(json) {
    if (!json) return "empty response";
    const ids = Object.keys(json.rows || {}).map((k) => k.replace(/^pk_id/, ""));
    const parts = [ids.length ? `Caspio returned record(s) ${ids.slice(0, 5).join(", ")}` : "Caspio returned no records"];
    const msg = String(json.responseText || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (msg) parts.push(`message: ${msg.slice(0, 160)}`);
    return parts.join("; ");
  }

  /**
   * 读取 Caspio 行数据中某个字段的原始值。字段形如 {inp, out, inline}，取 inp（提交用的原值）。
   * @param {*} cell - 字段数据
   * @returns {string} 不存在时返回空串
   */
  function cellValue(cell) {
    if (cell == null) return "";
    if (typeof cell === "object") return cell.inp != null ? String(cell.inp) : "";
    return String(cell);
  }

  const AjaxEngine = {
    /**
     * 提交单条审批，并核对服务器上的保存结果。
     *
     * 流程：定位行序号 → GetRowData 取回该行现有可编辑字段值 →
     * 只替换审批字段 → UpdateRow 提交 → 核对响应中该行的审批字段值。
     *
     * v1.5.0 起增加“提交后核对”：抓包显示 UpdateRow 的响应会带回该行保存后的完整数据
     * （rows["pk_id<记录ID>"]，如 TargetMarket.inp = "OK (approved)"）。旧版只要响应能解析为
     * JSON 就视为成功，服务器实际没有保存（如并发冲突、行定位错误、令牌失效返回了别的页面数据）
     * 时会被误判为成功、静默丢失。现在只有回读值与用户选择一致才算成功；响应里没有该行时
     * 再用一次 GetRowData 回读核对。
     *
     * v1.4.0 起不再把响应里返回的新 appSession 写回 ctx：抓包显示 Caspio 自身页面在连续请求中
     * 始终复用页面初始的 appSession（UpdateRow 甚至不带该参数），说明它无需逐条接力。
     * ctx 因此在并发提交之间只读共享，不存在多条请求互相覆盖令牌的问题。
     *
     * 由于审批写入幂等（重复写同一值无害），任何失败都可由调用方安全重试或交给 UI 引擎。
     *
     * @param {Object} ctx - extractPageContext 得到的上下文（只读，可在并发提交间共享）
     * @param {{approvalField:string, editableFields:string[]}} ajaxCfg - 生效的 AJAX 元数据
     * @param {{recordId:string, choice:string}} op - 操作
     * @returns {Promise<{ok:true, savedValue:string, company:string}|{ok:false, reason:string}>}
     *   成功时带回服务器上的审批值与公司名（供审核日志使用）；失败时带英文原因（写入日志 CSV）
     */
    async submit(ctx, ajaxCfg, op) {
      const recordIndex = computeRecordIndex(op.recordId);
      if (recordIndex == null) {
        return { ok: false, reason: "Record not found on the current Caspio page (it may have been filtered out or the page was reloaded)" };
      }

      /* 1) GetRowData：取回该行当前可编辑字段值 */
      let rowData, readJson;
      try {
        ({ row: rowData, json: readJson } = await this.getRowData(ctx, op.recordId, recordIndex));
      } catch (e) {
        return { ok: false, reason: `Reading the record failed (row position ${recordIndex}): ${e.message}` };
      }
      if (!rowData) {
        return { ok: false, reason: `Caspio did not return this record when reading it (row position ${recordIndex}; ${describeResponse(readJson)})` };
      }

      /* 2) UpdateRow：只改审批字段，其余可编辑字段原样回传 */
      let json;
      try {
        json = await this.updateRow(ctx, ajaxCfg, op, recordIndex, rowData);
      } catch (e) {
        return { ok: false, reason: "Saving failed: " + e.message };
      }

      /* 3) 核对：优先用 UpdateRow 响应里的行数据；没有时用 GetRowData 回读 */
      let saved = pickRow(json, op.recordId);
      if (!saved) {
        try {
          saved = (await this.getRowData(ctx, op.recordId, recordIndex)).row;
        } catch (e) {
          return { ok: false, reason: `Could not read the record back after saving (row position ${recordIndex}): ${e.message}` };
        }
      }
      if (!saved) {
        return { ok: false, reason: `Could not read the record back after saving (row position ${recordIndex}; save response: ${describeResponse(json)})` };
      }
      const savedValue = cellValue(saved[ajaxCfg.approvalField]);
      if (savedValue.trim() !== String(op.choice).trim()) {
        return { ok: false, reason: `Value was not saved: Caspio shows "${savedValue}" instead of "${op.choice}"` };
      }

      console.log(`[Caspio Assistant][AJAX] ✅ 已提交并核对 recordId=${op.recordId} → "${savedValue}" (index=${recordIndex})`);
      return { ok: true, savedValue, company: cellValue(saved.Company) || cellValue(rowData.Company) };
    },

    /**
     * 发送 GetRowData 请求，解析该行字段对象（rows["pk_id"+id]）。
     * 请求失败时抛出 Error（message 为英文原因）。
     * @returns {Promise<{row: Object|null, json: Object}>} row 为该行数据（响应中没有该行时为 null），
     *   json 为完整响应（用于在失败原因中说明服务器实际返回了什么）
     */
    async getRowData(ctx, recordId, recordIndex) {
      const fd = new FormData();
      fd.append("cbUniqueFormId", ctx.cbUniqueFormId);
      fd.append("CurrentRecordIndex", String(recordIndex));
      fd.append("AjaxAction", "GetRowData");
      fd.append("GridMode", "False");
      fd.append("dpFolderKey", ctx.dpFolderKey);
      fd.append("js", "true");
      fd.append("ClientQueryString", "");
      fd.append("appSession", ctx.appSession);
      fd.append("PageID", ctx.pageId);
      fd.append("PrevPageID", ctx.pageId);
      fd.append("cpipage", "1");
      fd.append("Mod0InlineEdit", "True");
      fd.append("Mod0RecordID", recordId);
      fd.append("cbCurrentPageSize", ctx.pageSize);
      fd.append("AjaxActionHostName", location.origin);
      fd.append("cbAjaxReferrer", ctx.endpoint);
      fd.append("cbParamList", "");

      const json = await this.postAjax(ctx, fd);
      const row = pickRow(json, recordId);
      if (row && !rowFieldsLogged) {
        console.log(`[Caspio Assistant][AJAX] GetRowData ok, 行字段结构:`, Object.keys(row));
        rowFieldsLogged = true;
      }
      return { row: row || null, json };
    },

    /**
     * 发送 UpdateRow 请求，返回解析后的响应 JSON（由调用方核对保存结果）。
     * 请求失败（HTTP 错误、超时、响应非 JSON）时抛出 Error。
     */
    async updateRow(ctx, ajaxCfg, op, recordIndex, rowData) {
      const fd = new FormData();
      fd.append("cbUniqueFormId", ctx.cbUniqueFormId);
      fd.append("AppKey", ctx.appKey);
      fd.append("PrevPageID", ctx.pageId);
      fd.append("cbPageType", "Results");
      fd.append("ClientQueryString", "");
      fd.append("pathname", ctx.endpoint);
      fd.append("RequestToken", ctx.requestToken);

      /* 检索条件（若页面存在则回传，保持与 Caspio 原生提交一致） */
      for (const [k, v] of Object.entries(ctx.searchParams)) {
        fd.append(k, v == null ? "" : v);
      }

      fd.append("CPIpage", "1");
      fd.append("cbCurrentPageSize", ctx.pageSize);

      /* 回传可编辑字段：只改审批字段，其余用 GetRowData 返回的 .inp 原值。
       *
       * 防清空关键逻辑：非审批字段仅在 GetRowData 确实返回了该字段时才回传其原值；
       * 若某个（可能来自运行时发现的）字段在 rowData 中不存在，则跳过而非回传空串，
       * 从而杜绝把真实数据清空的风险（运行时误采到的非数据列会因此被自动过滤）。 */
      const approvalField = ajaxCfg.approvalField;
      /* 审批字段始终提交为用户选择的值 */
      fd.append("InlineEdit" + approvalField, op.choice);
      for (const field of ajaxCfg.editableFields) {
        if (field === approvalField) continue;
        const cell = rowData[field];
        if (cell === undefined) continue; /* 未知字段：跳过，避免清空 */
        const value = cell && typeof cell === "object" ? (cell.inp != null ? cell.inp : "") : (cell != null ? cell : "");
        fd.append("InlineEdit" + field, value);
      }

      fd.append("InlineEditDoAction", "1");
      fd.append("Mod0InlineEditPageID", ctx.pageId);
      fd.append("JumpToSelectBottom" + ctx.cbUniqueFormId, "1");
      fd.append("PageID", ctx.pageId);
      fd.append("cbPageName", "Results");
      fd.append("Mod0InlineEdit", "1");
      /* 注意大小写：UpdateRow 用小写 record（Mod0recordID），与 GetRowData 的 Mod0RecordID 不同 */
      fd.append("Mod0recordID", op.recordId);
      fd.append("CurrentRecordIndex", String(recordIndex));
      fd.append("AjaxAction", "UpdateRow");
      fd.append("GridMode", "False");
      fd.append("dpFolderKey", ctx.dpFolderKey);
      fd.append("js", "true");
      fd.append("AjaxActionHostName", location.origin);
      fd.append("cbAjaxReferrer", ctx.endpoint);
      fd.append("cbParamList", "");

      return await this.postAjax(ctx, fd);
    },

    /**
     * 发送一个 Caspio AJAX POST（multipart/form-data，带 cookie），解析 JSON 响应。
     * 响应体为 JSON 文本（application/javascript），少数场景可能是 base64，做兼容处理。
     *
     * 超时：请求超过 AJAX_TIMEOUT_MS 未完成即中止。没有超时的话，一个卡住的请求会永久占用
     * 一个并发名额，多个卡住时整个队列停滞、待提交数不再下降。
     *
     * @returns {Promise<Object>} 解析后的 JSON
     * @throws {Error} HTTP 非 200、超时、网络错误或响应无法解析为 JSON 时抛出，message 为英文原因
     */
    async postAjax(ctx, formData) {
      const url = ctx.endpoint + "?rnd=" + Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AJAX_TIMEOUT_MS);
      let text;
      try {
        const resp = await fetch(url, {
          method: "POST",
          body: formData,
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest" },
          signal: controller.signal
        });
        if (!resp.ok) {
          console.warn("[Caspio Assistant][AJAX] HTTP 非 200:", resp.status);
          throw new Error("HTTP " + resp.status);
        }
        text = (await resp.text()).trim();
      } catch (e) {
        if (e && e.name === "AbortError") throw new Error(`no response from Caspio within ${AJAX_TIMEOUT_MS / 1000} s`);
        throw new Error(e && e.message ? e.message : String(e));
      } finally {
        clearTimeout(timer);
      }

      /* 兼容 base64 包裹（SearchForm 类响应会 base64，UpdateRow/GetRowData 一般为裸 JSON） */
      if (text && text[0] !== "{") {
        try {
          const decoded = atob(text);
          if (decoded && decoded.trim()[0] === "{") text = decoded;
        } catch (e) {
          /* 非 base64，保持原样 */
        }
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        console.warn("[Caspio Assistant][AJAX] 响应无法解析为 JSON，前 120 字符:", text.slice(0, 120));
        throw new Error("unexpected response from Caspio (not JSON)");
      }
    }
  };

  /**
   * 计算某 recordId 在当前页数据行中的 1-based 序号（Caspio 的 CurrentRecordIndex）。
   *
   * Caspio 的每条记录在结果表中会出现两个 Edit 链接（普通行 + 编辑态隐藏行），
   * 因此需按出现顺序去重后再取序号。经抓包验证：31922→1、31910→13。
   *
   * @param {string} recordId
   * @returns {number|null}
   */
  function computeRecordIndex(recordId) {
    const links = document.querySelectorAll('a.cbResultSetActionsLinks[href*="Mod0RecordID="]');
    const seen = [];
    for (const a of links) {
      const id = extractRecordId(a.href);
      if (id && !seen.includes(id)) seen.push(id);
    }
    const idx = seen.indexOf(String(recordId));
    return idx === -1 ? null : idx + 1;
  }

  /**
   * 从当前打开的内联编辑表单中采集全部可编辑字段名（去掉 InlineEdit 前缀），
   * 缓存到 discoveredFields，供后续记录改走 AJAX 直连。
   *
   * 只在该 DataPage 尚未采集过时执行一次。采集范围为编辑态内 name 以 InlineEdit 开头的
   * select/input/textarea；动作标志类字段（如 InlineEditDoAction）会在 updateRow 与
   * GetRowData 字段取交集时被自动过滤，故此处采得宽一些无妨。
   */
  function harvestEditableFields() {
    const id = getDataPageId();
    if (!id) return;

    const set = new Set();
    document.querySelectorAll('select[name^="InlineEdit"], input[name^="InlineEdit"], textarea[name^="InlineEdit"]').forEach((el) => {
      const field = el.name.replace(/^InlineEdit/, "");
      /* 排除已知的动作/控制类字段名 */
      if (/^(DoAction|PageID)$/i.test(field)) return;
      if (field) set.add(field);
    });

    if (!set.size) return;
    const fields = Array.from(set);
    const prev = discoveredFieldsMap[id];
    /* 与上次一致则不重复写存储 */
    const changed = !prev || prev.length !== fields.length || fields.some((f) => !prev.includes(f));
    discoveredFieldsMap[id] = fields;
    if (changed) {
      safeStorage("set", { discoveredFieldsMap });
      console.log("[Caspio Assistant][AJAX] 已发现并持久化可编辑字段(后续记录启用 AJAX 直连):", fields);
    }
  }

  /* ====== 档位 1：优化后的 UI 模拟引擎（回退） ====== */

  const UiEngine = {
    /**
     * 用模拟 UI 的方式提交单条审批。相比旧版：
     * - 用事件驱动等待替代固定 delay(300/500)；
     * - 在点击 Update 前删除操作键（兼容"仍会整页刷新"的 DataPage，避免刷新后重复处理）；
     * - 点击 Update 后等待编辑态关闭（下拉框消失）作为完成信号，随后由调度器续处理下一条，
     *   不再依赖整页刷新续传；
     * - v1.5.0：编辑态未关闭视为失败（旧版超时也算成功）；若审批列在行内可见，再核对单元格中的值。
     *
     * @param {Object} cfg - DataPage 配置
     * @param {{key:string, recordId:string, choice:string, logKey?:string}} op
     * @returns {Promise<{ok:true, savedValue:string}|{ok:false, reason:string}>} 失败原因为英文，写入审核日志
     */
    async submit(cfg, op) {
      try {
        const editLink = findEditLinkByRecordId(op.recordId);
        if (!editLink) {
          console.error(`[Caspio Assistant][UI] 未找到 RecordID=${op.recordId} 的 Edit 按钮`);
          return { ok: false, reason: "Record not found on the current Caspio page (it may have been filtered out or the page was reloaded)" };
        }

        editLink.click();

        const field = cfg.inlineEditField;
        const selectElement = await waitForElement(`select[name="${field}"]`, 10000);
        if (!selectElement) {
          console.error("[Caspio Assistant][UI] 审批下拉框未出现");
          return { ok: false, reason: "Caspio inline edit form did not open" };
        }

        /* 首条记录顺便发现该 DataPage 的可编辑字段（供后续记录改走 AJAX 直连）。
         * 编辑态下所有可编辑列都渲染为 name="InlineEdit<Field>" 的控件；这里只做“广采”，
         * 真正的过滤在 AJAX updateRow 里与 GetRowData 字段取交集完成，故不必精确。 */
        harvestEditableFields();

        const selected = await selectCaspioDropdownValue(selectElement, op.choice);
        if (!selected) {
          console.error("[Caspio Assistant][UI] 无法选择审批值");
          return { ok: false, reason: `Option "${op.choice}" could not be selected in the Caspio dropdown` };
        }

        /* 等待选择生效：自定义下拉容器关闭即视为已应用（替代固定 delay(500)） */
        await waitForGone("#dropbox-body", 1500);

        const updateButton = document.querySelector('input[name="Mod0InlineEdit"][value="Update"]');
        if (!updateButton) {
          console.error("[Caspio Assistant][UI] 未找到 Update 按钮");
          return { ok: false, reason: "Caspio Update button not found" };
        }

        /* 在点击 Update 前删除该操作键：兼容仍会整页刷新的页面，避免刷新后重复处理同一条。
         * 同时先把日志写成“已通过 UI 提交、未核对”，若页面随即整页刷新导致脚本中断，
         * 日志也不会永远停在 Pending；正常情况下随后会被最终结果覆盖。 */
        await updateLog(op.logKey, { status: "Saved", method: "UI", error: "Submitted via Caspio UI; result not verified" });
        await removeOperation(op.key);

        console.log(`[Caspio Assistant][UI] 提交审批: ${op.choice} (RecordID: ${op.recordId})`);
        /* 若该 DataPage 的 Update 触发整页刷新，属预期行为，不应被 beforeunload 离开确认拦截 */
        expectingReload = true;
        try {
          updateButton.click();
          /* 等待编辑态关闭（AJAX 提交完成、行退出编辑），作为完成信号 */
          const closed = await waitForGone(`select[name="${field}"]`, 8000);
          if (!closed) {
            return { ok: false, reason: "Caspio did not confirm the update (edit form still open after 8 s)" };
          }
        } finally {
          expectingReload = false;
        }

        /* 核对：审批列在行内可见时读取单元格值；不可见（如设为分组列）则无法核对，按已提交处理 */
        const row = findEditLinkByRecordId(op.recordId);
        const tr = row && row.closest("tr");
        if (tr && cfg.approvalLabel) {
          const label = cfg.approvalLabel.toLowerCase();
          const shown = readCellByLabel(tr, (t) => t.toLowerCase().includes(label));
          if (shown !== null && shown.trim() !== String(op.choice).trim()) {
            return { ok: false, reason: `Value was not saved: Caspio shows "${shown}" instead of "${op.choice}"` };
          }
        }
        return { ok: true, savedValue: op.choice };
      } catch (error) {
        console.error("[Caspio Assistant][UI] 执行失败:", error);
        return { ok: false, reason: "UI automation error: " + (error && error.message ? error.message : error) };
      }
    }
  };

  /** 通过 RecordID 查找 Edit 链接。 */
  function findEditLinkByRecordId(recordId) {
    const allEditLinks = document.querySelectorAll('a.cbResultSetActionsLinks[title^="Edit"]');
    for (const link of allEditLinks) {
      if (extractRecordId(link.href) === recordId) return link;
    }
    /* 兼容 title 在内层 img 上的页面：改用 data-cb-name="InlineEdit" 再匹配一次 */
    const alt = document.querySelectorAll('a.cbResultSetActionsLinks[data-cb-name="InlineEdit"]');
    for (const link of alt) {
      if (extractRecordId(link.href) === recordId) return link;
    }
    return null;
  }

  /**
   * 通过模拟点击 Caspio 自定义下拉组件选择值。
   */
  async function selectCaspioDropdownValue(selectElement, value) {
    simulateMouseClick(selectElement);

    let dropboxBody = await waitForElement("#dropbox-body", 5000);
    if (!dropboxBody) {
      selectElement.focus();
      await delay(100);
      simulateMouseClick(selectElement);
      dropboxBody = await waitForElement("#dropbox-body", 5000);
      if (!dropboxBody) return false;
    }
    return await selectOptionFromDropbox(dropboxBody, value);
  }

  /**
   * 在 dropbox-body 中查找并点击目标选项。
   * 用事件驱动等待选项渲染完成（替代固定 delay(300)）。
   */
  async function selectOptionFromDropbox(dropboxBody, value) {
    await waitForCondition(() => dropboxBody.querySelectorAll(".Option").length > 0, 1500);

    const options = dropboxBody.querySelectorAll(".Option");
    let targetOption = null;
    for (const option of options) {
      if (option.title === value || option.textContent.trim() === value) {
        targetOption = option;
        break;
      }
    }
    if (!targetOption) {
      console.error(`[Caspio Assistant][UI] 未找到匹配选项: "${value}"`);
      return false;
    }
    simulateMouseClick(targetOption);
    return true;
  }

  /** 模拟完整鼠标点击序列：mousedown → mouseup → click。 */
  function simulateMouseClick(element) {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  /* ====== DOM 工具函数 ====== */

  /** 等待元素出现（MutationObserver）。 */
  function waitForElement(selector, timeout) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) { resolve(existing); return; }

      let resolved = false;
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el && !resolved) {
          resolved = true;
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          observer.disconnect();
          resolve(null);
        }
      }, timeout);
    });
  }

  /** 等待元素消失。超时也 resolve（不抛错）。 */
  function waitForGone(selector, timeout) {
    return waitForCondition(() => !document.querySelector(selector), timeout);
  }

  /**
   * 等待条件成立（DOM 变化驱动）。
   *
   * v1.4.0 起由 setTimeout 轮询改为 MutationObserver：Caspio 标签页通常在后台，
   * Chrome 会把后台页的定时器限制为每秒最多一次（隐藏超过 5 分钟后，连续嵌套的定时器
   * 甚至可能被压到每分钟一次），轮询因此会严重拖慢每条 UI 提交。MutationObserver 回调
   * 属于微任务，不受此限制，DOM 一变化就能立即重新判断。
   * 超时仍用 setTimeout 兜底；它只在条件始终不成立时才会触发，受降速影响也无碍正常路径。
   *
   * @param {Function} predicate - 返回 boolean；抛错视为 false
   * @param {number} timeout - 超时毫秒
   * @returns {Promise<boolean>} 条件是否在超时前成立
   */
  function waitForCondition(predicate, timeout) {
    return new Promise((resolve) => {
      const check = () => {
        try { return !!predicate(); } catch (e) { return false; }
      };
      if (check()) { resolve(true); return; }

      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(result);
      };
      const observer = new MutationObserver(() => { if (check()) finish(true); });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const timer = setTimeout(() => finish(check()), timeout);
    });
  }

  /** @param {number} ms @returns {Promise<void>} */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

})();
