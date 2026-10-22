/**
 * 目标页面内容脚本
 *
 * 注入到所有非 Caspio 域名的页面中。
 * 通过向 background.js 发送 isTargetTab 消息来验证当前标签页是否为审批目标标签页。
 * 只有以下两种情况会显示审批工具栏：
 * - 该标签页是从 Caspio 页面的链接直接打开的（openerTabId 匹配 Caspio 标签页）
 * - 该标签页是由扩展通过 chrome.tabs.update 导航到的（targetTabId 已注册匹配）
 *
 * 其他所有页面（用户正常浏览、手动打开的页面等）均不会显示工具栏。
 *
 * 功能：
 * 1. 在页面顶部显示审批浮层，包含进度信息（如 "3 / 15"），
 *    以及该记录的历史重复信息（Caspio “Duplicates: what happened before” 列，v1.3.0）
 * 2. 预加载下一个目标页面的资源（减少导航延迟）
 * 3. 用户选择后发送消息给 background.js，由 background 导航到下一个链接
 */

(function () {
  "use strict";

  /**
   * 单条审批操作在 storage 中的键名前缀（与 background.js / caspio-content.js 保持一致）。
   * 必须声明在文件顶部：下方的 isTargetTab 回调会构建浮层并用到它，常量须先完成初始化。
   */
  const OP_PREFIX = "caspioOp:";
  /** 审核日志条目前缀（用于统计本轮会话中保存失败的条数） */
  const LOG_PREFIX = "caspioLog:";

  /**
   * 检查扩展上下文是否仍然有效。
   * 扩展被重新加载后，旧页面上的内容脚本仍在运行但已失去连接，
   * 此时 chrome.runtime.id 为 undefined。
   *
   * @returns {boolean}
   */
  function isExtensionContextValid() {
    try {
      return !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  /**
   * 安全地发送消息给 background.js。
   * 如果扩展上下文已失效，静默忽略。
   *
   * @param {Object} message - 要发送的消息对象
   * @param {Function} [callback] - 可选的回调函数
   */
  function safeSendMessage(message, callback) {
    if (!isExtensionContextValid()) return;
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch (e) {
      /* 扩展上下文已失效，静默忽略 */
    }
  }

  /**
   * 初始化入口：向 background.js 请求验证当前标签页身份。
   *
   * 不再直接读取 chrome.storage.local，而是通过 background.js 的 isTargetTab 接口，
   * 由 background 对比 sender.tab.id 与 taskQueue.targetTabId（或首次打开时的 openerTabId）。
   * 这样确保只有真正的审批目标标签页才会显示工具栏。
   */
  safeSendMessage({ action: "isTargetTab" }, (response) => {
    if (response && response.isTarget) {
      injectOverlay(response.queue);
      prefetchNextPage(response.queue);
    }
  });

  /**
   * 在页面顶部注入审批选项浮层，包含进度指示器。
   *
   * 浮层结构：
   * - 进度信息："Review 3 / 15"
   * - 三个审批按钮：Approved without KAM | Approved with KAM | Declined
   * - Skip 按钮：跳过当前页面，进入下一个
   * - Stop 按钮：结束审阅会话
   *
   * @param {Object} queue - 任务队列对象
   * @param {Array} queue.items - 所有任务项
   * @param {number} queue.currentIndex - 当前审阅位置
   */
  function injectOverlay(queue) {
    if (document.getElementById("caspio-approval-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "caspio-approval-overlay";

    /**
     * 进度显示：当前是第几个 / 总共几个。
     * currentIndex 是 0-based，显示时 +1 更符合用户直觉。
     */
    const progress = document.createElement("span");
    progress.className = "cao-label";
    progress.textContent = `Review ${queue.currentIndex + 1} / ${queue.items.length}:`;

    /* 按钮组 */
    const buttonsContainer = document.createElement("div");
    buttonsContainer.className = "cao-buttons";

    /**
     * 审批按钮列表由发起审批的 Caspio DataPage 决定，随 taskQueue.config 传入。
     * 不同页面的可选审批值不同（例如页面一为三选项的 Catman 审批，
     * 页面二为 OK (approved) / Declined 二选一）。
     * 若队列中缺少 config（理论上不应发生，或来自旧版本数据），
     * 回退到原有的三选项 Catman 审批，保证向后兼容。
     */
    const options = (queue.config && Array.isArray(queue.config.options))
      ? queue.config.options
      : [
          { text: "Approved without KAM", value: "Approved without KAM", className: "cao-btn cao-btn-approve" },
          { text: "Approved with KAM",    value: "Approved with KAM",    className: "cao-btn cao-btn-approve-kam" },
          { text: "Declined",             value: "Declined",             className: "cao-btn cao-btn-decline" }
        ];

    options.forEach((option) => {
      const btn = document.createElement("button");
      btn.className = option.className;
      btn.textContent = option.text;
      btn.addEventListener("click", () => handleSelection(option.value, overlay));
      buttonsContainer.appendChild(btn);
    });

    /**
     * Skip 按钮：跳过当前页面，不做审批。
     * background.js 会将 currentIndex 推进但不添加 Caspio 操作。
     */
    const skipBtn = document.createElement("button");
    skipBtn.className = "cao-btn cao-btn-cancel";
    skipBtn.textContent = "Skip";
    skipBtn.addEventListener("click", () => {
      handleSkip(overlay);
    });

    /**
     * Stop 按钮：终止整个审阅会话。
     * 交由 background 写入会话结束标记（以便处理完后自动导出审核日志）并清除任务队列，然后移除浮层。
     * 已提交的操作会继续在 Caspio 后台处理完成。
     */
    const stopBtn = document.createElement("button");
    stopBtn.className = "cao-btn cao-btn-cancel";
    stopBtn.textContent = "Stop";
    stopBtn.addEventListener("click", () => {
      safeSendMessage({ action: "stopSession" });
      overlay.remove();
      document.body.classList.remove("caspio-approval-active");
    });

    overlay.appendChild(progress);
    overlay.appendChild(buttonsContainer);
    overlay.appendChild(skipBtn);
    overlay.appendChild(stopBtn);
    overlay.appendChild(buildPendingChip(queue.sessionId));

    /* 历史重复信息（“Duplicates: what happened before” 列），见 buildDuplicatesElement */
    const currentItem = queue.items[queue.currentIndex] || {};
    const dupEl = buildDuplicatesElement(currentItem.duplicates);
    if (dupEl) {
      /* 警示横幅放在最后（借助 flex-wrap 独占第二行）；“No duplicates” 小标记紧跟进度文字 */
      dupEl.classList.contains("cao-dup-banner") ? overlay.appendChild(dupEl) : progress.after(dupEl);
    }

    document.body.prepend(overlay);
    document.body.classList.add("caspio-approval-active");
    syncBodyOffset(overlay);
  }

  /**
   * 根据 Duplicates 列的值构建展示元素。
   *
   * 三种情况：
   * - undefined：发起审批的 DataPage 没有该列（或旧版本队列数据）→ 不展示任何内容；
   * - 空串：该列存在但为 NULL → 在工具栏行内显示低调的 “No duplicates” 标记，
   *   让审批人知道已检查过、无历史重复；
   * - 非空：在工具栏下方单独一行显示醒目的琥珀色警示横幅，其中重复类型
   *   （如 PHONE_DUP）、approved / declined 次数分别以徽标高亮，便于一眼判断历史结论。
   *
   * 全部用 textContent 构建，不使用 innerHTML，避免单元格内容被当作 HTML 注入目标页面。
   *
   * @param {string|undefined} duplicates - 队列项中的 duplicates 字段
   * @returns {HTMLElement|null} 待追加到浮层的元素；无需展示时返回 null
   */
  function buildDuplicatesElement(duplicates) {
    if (typeof duplicates !== "string") return null;

    if (!duplicates.trim()) {
      const none = document.createElement("span");
      none.className = "cao-dup-none";
      none.textContent = "No duplicates";
      none.title = "Duplicates: what happened before — empty";
      return none;
    }

    const banner = document.createElement("div");
    banner.className = "cao-dup-banner";
    banner.setAttribute("role", "alert");

    const title = document.createElement("span");
    title.className = "cao-dup-title";
    title.textContent = "⚠ Duplicates — what happened before:";
    banner.appendChild(title);

    /* 同一申请可能命中多种重复类型（PHONE_DUP / COMPANY_DUP / STORE_DUP / WECHAT_DUP / BL_DUP …），
     * Caspio 单元格中每种一行（建队列时以 \n 分隔保存），这里每行单独显示，避免挤成一长串。 */
    const text = document.createElement("span");
    text.className = "cao-dup-text";
    /* 按“重复类型 / N approved / N declined”切分，命中的片段包成徽标，其余保持纯文本。
     * split 搭配捕获组会把分隔符保留在结果数组中（奇数下标即命中片段）。 */
    const pattern = /(\b[A-Z][A-Z0-9]*_DUP\b|\b\d+\s+approved\b|\b\d+\s+declined\b)/i;
    duplicates.split("\n").filter((line) => line.trim()).forEach((line) => {
      const lineEl = document.createElement("span");
      lineEl.className = "cao-dup-line";
      line.split(pattern).forEach((part, i) => {
        if (!part) return;
        if (i % 2 === 0) {
          lineEl.appendChild(document.createTextNode(part));
          return;
        }
        const badge = document.createElement("span");
        badge.textContent = part;
        if (/approved/i.test(part)) badge.className = "cao-dup-badge cao-dup-approved";
        else if (/declined/i.test(part)) badge.className = "cao-dup-badge cao-dup-declined";
        else badge.className = "cao-dup-badge cao-dup-type";
        lineEl.appendChild(badge);
      });
      text.appendChild(lineEl);
    });
    banner.appendChild(text);

    return banner;
  }

  /**
   * 构建“Caspio 待提交数量”标记，并随 storage 变化实时刷新。
   *
   * 用户在外部页面审阅时看不到 Caspio 标签页，这个标记让用户知道后台提交是否跟得上：
   * - N > 0：显示 “Caspio: N pending”（琥珀色），积压持续增大说明判断速度超过了提交速度；
   * - N = 0：显示 “Caspio: all saved”（低调绿色）；
   * - 本轮会话有保存失败的条目时附加 “· M failed”（红色），提示审阅结束后到 Caspio 页面重试。
   *
   * 待提交数直接统计 storage 中的 caspioOp:* 键数（每条待执行操作一个键，提交完由 Caspio 页面删除）；
   * 失败数统计本会话审核日志（caspioLog:*）中状态为 Failed 的条目。
   *
   * @param {string|undefined} sessionId - 当前审阅会话 ID（旧版本队列没有该字段时不统计失败数）
   * @returns {HTMLElement}
   */
  function buildPendingChip(sessionId) {
    const chip = document.createElement("span");
    chip.className = "cao-pending";
    chip.title = "Approval decisions not yet saved to Caspio. Keep the Caspio tab open.";

    const render = (count, failed) => {
      chip.textContent = (count > 0 ? `Caspio: ${count} pending` : "Caspio: all saved") +
        (failed > 0 ? ` · ${failed} failed` : "");
      chip.classList.toggle("cao-pending-busy", count > 0);
      chip.classList.toggle("cao-pending-failed", failed > 0);
    };
    const refresh = () => {
      if (!isExtensionContextValid()) return;
      try {
        chrome.storage.local.get(null, (all) => {
          const keys = Object.keys(all || {});
          const pending = keys.filter((k) => k.startsWith(OP_PREFIX)).length;
          const failed = sessionId
            ? keys.filter((k) => k.startsWith(LOG_PREFIX) && all[k] && all[k].sessionId === sessionId && all[k].status === "Failed").length
            : 0;
          render(pending, failed);
        });
      } catch (e) {
        /* 扩展上下文已失效，忽略 */
      }
    };

    render(0, 0);
    refresh();
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && Object.keys(changes).some((k) => k.startsWith(OP_PREFIX) || k.startsWith(LOG_PREFIX))) refresh();
      });
    } catch (e) {
      /* 扩展上下文已失效，忽略 */
    }
    return chip;
  }

  /**
   * 让 body 的顶部留白与浮层实际高度保持一致。
   *
   * 浮层高度不再固定：出现 Duplicates 横幅、或窗口变窄导致按钮换行时都会变高，
   * 固定 56px 会让浮层遮住页面顶部内容。这里通过 CSS 变量把实际高度传给样式表，
   * 并用 ResizeObserver 跟随后续尺寸变化。Stop 移除 body 类名后留白自动失效。
   *
   * @param {HTMLElement} overlay - 浮层容器
   */
  function syncBodyOffset(overlay) {
    const apply = () => {
      document.body.style.setProperty("--cao-overlay-height", overlay.offsetHeight + "px");
    };
    apply();
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(apply).observe(overlay);
    }
  }

  /**
   * 预加载下一个目标页面的资源。
   *
   * 通过注入 <link rel="prefetch"> 标签，提示浏览器在空闲时预下载下一个页面。
   * 这样当用户做完当前审批、导航到下一个页面时，大部分资源已经在缓存中，
   * 页面加载会显著更快。
   *
   * prefetch 是非阻塞的，不会影响当前页面的加载和渲染性能。
   * 浏览器会在网络空闲时自动下载，且只是"建议"，不会强制下载。
   *
   * @param {Object} queue - 任务队列对象
   */
  function prefetchNextPage(queue) {
    const nextIndex = queue.currentIndex + 1;
    if (nextIndex >= queue.items.length) return;

    const nextUrl = queue.items[nextIndex].targetUrl;

    const prefetchLink = document.createElement("link");
    prefetchLink.rel = "prefetch";
    prefetchLink.href = nextUrl;
    prefetchLink.as = "document";
    document.head.appendChild(prefetchLink);

    console.log(`[Caspio Assistant] 预加载下一个页面: ${nextUrl}`);
  }

  /**
   * 处理用户的审批选择。
   * 发送消息给 background.js 后，显示"加载中"状态。
   * background.js 会将此标签页导航到下一个 URL（而非关闭它）。
   *
   * @param {string} choice - 用户的审批选择
   * @param {HTMLElement} overlay - 浮层容器
   */
  function handleSelection(choice, overlay) {
    /* 切换为加载状态，防止重复点击 */
    overlay.innerHTML = "";
    const loading = document.createElement("span");
    loading.className = "cao-processing";
    loading.textContent = "Loading next page...";
    overlay.appendChild(loading);

    safeSendMessage({
      action: "approvalSelected",
      choice: choice
    });
  }

  /**
   * 处理跳过操作。
   * 发送特殊消息给 background.js，跳过当前任务但不提交审批。
   *
   * @param {HTMLElement} overlay - 浮层容器
   */
  function handleSkip(overlay) {
    overlay.innerHTML = "";
    const loading = document.createElement("span");
    loading.className = "cao-processing";
    loading.textContent = "Skipping to next...";
    overlay.appendChild(loading);

    safeSendMessage({
      action: "approvalSkipped"
    });
  }

})();
