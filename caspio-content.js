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
 *     在一个页面上下文里连续、快速地消化整个队列。每条约 0.2–0.5s。
 *     仅在该 DataPage 的配置里显式声明了 ajax 元数据（可编辑字段集合）时启用，
 *     以避免误伤未验证的页面；任何令牌缺失或请求失败都会自动回退到档位 1。
 *
 *   档位 1（回退，UiEngine）：
 *     沿用模拟 UI 的方式，但改为"连续消化整个队列"且用事件驱动等待替代固定
 *     delay，比旧版显著更快，且不再依赖整页刷新续传。
 *
 * 两档共用同一个"连续消化"调度器 processQueue()，带重入保护，
 * 用户点得再快也只会有一个消化循环在跑，新入队的操作会被同一循环续处理。
 *
 * Storage 数据结构：
 * - taskQueue: { items: [{targetUrl, recordId}], currentIndex, caspioTabId, config }
 * - caspioOperations: [{recordId, choice}]  待执行审批操作，FIFO
 */

(function () {
  "use strict";

  /* ====== 多 DataPage 配置 ====== */

  /**
   * 不同 Caspio DataPage 的审批配置表。
   *
   * 各字段含义：
   * - inlineEditField: 内联编辑表单中审批下拉框 <select> 的 name 属性（UI 引擎使用）。
   * - options: 目标页面浮层中展示的审批按钮列表（传给 target-content.js）。
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
   */
  setTimeout(() => {
    if (isExtensionContextValid()) processQueue();
  }, 400);

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

    safeStorage("set", {
      taskQueue: {
        items: allItems,
        currentIndex: startIndex,
        config: getCurrentConfig()
      },
      caspioOperations: []
    }, () => {
      safeSendMessage({ action: "registerCaspioTab" });
      console.log(`[Caspio Assistant] 任务队列已建立: ${allItems.length} 项, 起始索引: ${startIndex}`);
    });
  });

  /* ====== 来自 background 的消息 ====== */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "processCaspioQueue") {
      /* 用户每做一次审批，background 会发一次本消息。
       * 由于 processQueue 带重入保护，多次触发只会有一个消化循环，
       * 循环内每轮都重新读取 storage，因此新入队的操作会被同一循环续处理。 */
      processQueue();
      sendResponse({ status: "processing" });
    }
    return true;
  });

  /* ====== 表格扫描 ====== */

  /**
   * 扫描所有表格行，提取含外部链接与 Edit 按钮的行。
   * @returns {Array<{targetUrl: string, recordId: string}>}
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
        items.push({ targetUrl, recordId });
      }
    }

    return items;
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
   * 消化循环的重入保护标志。
   * 保证同一时刻只有一个消化循环在跑，避免同一操作被并发处理导致重复提交。
   */
  let isDraining = false;

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
   * 连续消化 caspioOperations 队列，直到清空。
   *
   * 每轮：读取队列 → 取队首操作 → 优先走 AJAX 直连，失败则回退到 UI 模拟 →
   * 根据结果移除队首并继续。整个过程在同一页面上下文中完成，不依赖整页刷新。
   */
  async function processQueue() {
    if (isDraining) return;
    if (!isExtensionContextValid()) return;
    isDraining = true;

    try {
      /* AJAX 引擎的页面上下文只提取一次，后续复用（appSession 在响应间链式更新） */
      let ajaxCtx = undefined; /* undefined=未尝试, null=不可用, object=可用 */

      while (true) {
        if (!isExtensionContextValid()) break;

        const { caspioOperations = [] } = await storageGet("caspioOperations");
        if (!caspioOperations.length) break;

        const op = caspioOperations[0];
        const cfg = getCurrentConfig();
        console.log(`[Caspio Assistant] 处理操作: recordId=${op.recordId}, choice=${op.choice}`);

        let handled = false;

        /* ---- 档位 2：AJAX 直连 ----
         * 生效条件：该 DataPage 有硬编码 ajax 元数据，或已通过 UI 首条运行时发现字段。
         * 审批写入是幂等的（重复写同一值无害），故任何 AJAX 失败都安全回退到 UI，不会跳过记录。 */
        const ajaxCfg = getAjaxConfig(cfg);
        if (ajaxCfg && ajaxCtx !== null) {
          if (ajaxCtx === undefined) {
            ajaxCtx = extractPageContext(cfg); /* 提取失败返回 null，下轮不再重试 */
          }
          if (ajaxCtx) {
            const result = await AjaxEngine.submit(ajaxCtx, ajaxCfg, op);
            if (result === "done") {
              await removeFirstOperation();
              handled = true;
            }
            /* result === "fallback"：未提交任何内容，继续走档位 1（UI） */
          }
        }

        /* ---- 档位 1：优化后的 UI 模拟（回退，并在首条发现可编辑字段） ---- */
        if (!handled) {
          const ok = await UiEngine.submit(cfg, op);
          if (!ok) {
            /* UI 路径未成功提交（元素缺失等），移除并记录，避免死循环 */
            await removeFirstOperation();
            safeSendMessage({ action: "caspioOperationFailed", recordId: op.recordId });
          }
          /* UI 路径成功时已在其内部于 Update 前移除队首（整页刷新安全），此处不再移除 */
        }

        /* 让出事件循环，避免长时间独占主线程 */
        await delay(0);
      }
      console.log("[Caspio Assistant] 队列已清空");
    } catch (error) {
      console.error("[Caspio Assistant] 队列消化异常:", error);
    } finally {
      isDraining = false;
    }
  }

  /**
   * 移除 caspioOperations 队首操作。
   * @returns {Promise<void>}
   */
  function removeFirstOperation() {
    return new Promise((resolve) => {
      if (!isExtensionContextValid()) { resolve(); return; }
      try {
        chrome.storage.local.get("caspioOperations", (result) => {
          const operations = result.caspioOperations || [];
          operations.shift();
          chrome.storage.local.set({ caspioOperations: operations }, resolve);
        });
      } catch (e) {
        resolve();
      }
    });
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

  const AjaxEngine = {
    /**
     * 提交单条审批。
     *
     * 流程：定位行序号 → GetRowData 取回该行现有可编辑字段值 →
     * 只替换审批字段 → UpdateRow 提交。响应中的 appSession 会链式更新到 ctx。
     *
     * 由于审批写入幂等（重复写同一值无害），任何失败都返回 "fallback" 交给 UI 重试，
     * 既不会跳过记录，也不会造成有害的重复写入。
     *
     * @param {Object} ctx - extractPageContext 得到的上下文（会被就地更新 appSession）
     * @param {{approvalField:string, editableFields:string[]}} ajaxCfg - 生效的 AJAX 元数据
     * @param {{recordId:string, choice:string}} op - 操作
     * @returns {Promise<"done"|"fallback">}
     */
    async submit(ctx, ajaxCfg, op) {
      const recordIndex = computeRecordIndex(op.recordId);
      if (recordIndex == null) {
        console.warn(`[Caspio Assistant][AJAX] 未能定位行序号，回退: recordId=${op.recordId}`);
        return "fallback";
      }

      /* 1) GetRowData：取回该行当前可编辑字段值 */
      let rowData;
      try {
        rowData = await this.getRowData(ctx, op.recordId, recordIndex);
      } catch (e) {
        console.warn("[Caspio Assistant][AJAX] GetRowData 异常，回退:", e);
        return "fallback";
      }
      if (!rowData) {
        console.warn(`[Caspio Assistant][AJAX] GetRowData 未返回该行数据，回退: recordId=${op.recordId}`);
        return "fallback";
      }

      /* 2) UpdateRow：只改审批字段，其余可编辑字段原样回传 */
      try {
        const ok = await this.updateRow(ctx, ajaxCfg, op, recordIndex, rowData);
        if (ok) {
          console.log(`[Caspio Assistant][AJAX] ✅ 已提交 recordId=${op.recordId} → "${op.choice}" (index=${recordIndex})`);
          return "done";
        }
        return "fallback";
      } catch (e) {
        console.warn("[Caspio Assistant][AJAX] UpdateRow 异常，回退:", e);
        return "fallback";
      }
    },

    /**
     * 发送 GetRowData 请求，解析并返回该行字段对象（rows["pk_id"+id]）。
     * 同时用响应中的 appSession 更新 ctx。
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
      if (!json) return null;
      if (json.appSession) ctx.appSession = json.appSession;

      const rows = json.rows || {};
      const row = rows["pk_id" + recordId] || rows["pk_id" + String(recordId)];
      if (row && !rowFieldsLogged) {
        console.log(`[Caspio Assistant][AJAX] GetRowData ok, 行字段结构:`, Object.keys(row));
        rowFieldsLogged = true;
      }
      return row || null;
    },

    /**
     * 发送 UpdateRow 请求。返回是否成功（HTTP 200 且响应可解析为 JSON）。
     * 同时用响应中的 appSession 更新 ctx。
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

      const json = await this.postAjax(ctx, fd);
      if (!json) return false;
      if (json.appSession) ctx.appSession = json.appSession;
      return true;
    },

    /**
     * 发送一个 Caspio AJAX POST（multipart/form-data，带 cookie），解析 JSON 响应。
     * 响应体为 JSON 文本（application/javascript），少数场景可能是 base64，做兼容处理。
     *
     * @returns {Promise<Object|null>} 解析后的 JSON，或 null（失败）
     */
    async postAjax(ctx, formData) {
      const url = ctx.endpoint + "?rnd=" + Date.now();
      const resp = await fetch(url, {
        method: "POST",
        body: formData,
        credentials: "include",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      });
      if (!resp.ok) {
        console.warn("[Caspio Assistant][AJAX] HTTP 非 200:", resp.status);
        return null;
      }
      let text = await resp.text();
      text = text.trim();
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
        return null;
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
     * - 在点击 Update 前移除队首（兼容"仍会整页刷新"的 DataPage，避免刷新后重复处理）；
     * - 点击 Update 后等待编辑态关闭（下拉框消失）作为完成信号，随后由外层循环续处理下一条，
     *   不再依赖整页刷新续传。
     *
     * @param {Object} cfg - DataPage 配置
     * @param {{recordId:string, choice:string}} op
     * @returns {Promise<boolean>} 是否成功提交
     */
    async submit(cfg, op) {
      try {
        const editLink = findEditLinkByRecordId(op.recordId);
        if (!editLink) {
          console.error(`[Caspio Assistant][UI] 未找到 RecordID=${op.recordId} 的 Edit 按钮`);
          return false;
        }

        editLink.click();

        const field = cfg.inlineEditField;
        const selectElement = await waitForElement(`select[name="${field}"]`, 10000);
        if (!selectElement) {
          console.error("[Caspio Assistant][UI] 审批下拉框未出现");
          return false;
        }

        /* 首条记录顺便发现该 DataPage 的可编辑字段（供后续记录改走 AJAX 直连）。
         * 编辑态下所有可编辑列都渲染为 name="InlineEdit<Field>" 的控件；这里只做“广采”，
         * 真正的过滤在 AJAX updateRow 里与 GetRowData 字段取交集完成，故不必精确。 */
        harvestEditableFields();

        const selected = await selectCaspioDropdownValue(selectElement, op.choice);
        if (!selected) {
          console.error("[Caspio Assistant][UI] 无法选择审批值");
          return false;
        }

        /* 等待选择生效：自定义下拉容器关闭即视为已应用（替代固定 delay(500)） */
        await waitForGone("#dropbox-body", 1500);

        /* 在点击 Update 前移除队首：兼容仍会整页刷新的页面，避免刷新后重复处理同一条 */
        await removeFirstOperation();

        const updateButton = document.querySelector('input[name="Mod0InlineEdit"][value="Update"]');
        if (!updateButton) {
          console.error("[Caspio Assistant][UI] 未找到 Update 按钮");
          return false;
        }

        console.log(`[Caspio Assistant][UI] 提交审批: ${op.choice} (RecordID: ${op.recordId})`);
        updateButton.click();

        /* 等待编辑态关闭（AJAX 提交完成、行退出编辑），作为完成信号。
         * 若页面改为整页刷新，此等待会超时，但刷新后脚本会重新消化剩余队列。 */
        await waitForGone(`select[name="${field}"]`, 8000);
        return true;
      } catch (error) {
        console.error("[Caspio Assistant][UI] 执行失败:", error);
        return false;
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
    await waitForCondition(() => dropboxBody.querySelectorAll(".Option").length > 0, 1500, 30);

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

  /** 等待元素消失（轮询）。超时也 resolve（不抛错）。 */
  function waitForGone(selector, timeout) {
    return waitForCondition(() => !document.querySelector(selector), timeout, 40);
  }

  /**
   * 轮询等待条件成立。
   * @param {Function} predicate - 返回 boolean
   * @param {number} timeout - 超时毫秒
   * @param {number} interval - 轮询间隔毫秒
   * @returns {Promise<boolean>} 条件是否在超时前成立
   */
  function waitForCondition(predicate, timeout, interval) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        try {
          if (predicate()) { resolve(true); return; }
        } catch (e) { /* 忽略断言异常 */ }
        if (Date.now() - start >= timeout) { resolve(false); return; }
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  /** @param {number} ms @returns {Promise<void>} */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

})();
