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
 * 1. 在页面顶部显示审批浮层，包含进度信息（如 "3 / 15"）
 * 2. 预加载下一个目标页面的资源（减少导航延迟）
 * 3. 用户选择后发送消息给 background.js，由 background 导航到下一个链接
 */

(function () {
  "use strict";

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
     * 清除任务队列，移除浮层。已提交的操作会继续在 Caspio 后台处理完成。
     */
    const stopBtn = document.createElement("button");
    stopBtn.className = "cao-btn cao-btn-cancel";
    stopBtn.textContent = "Stop";
    stopBtn.addEventListener("click", () => {
      if (isExtensionContextValid()) {
        try { chrome.storage.local.remove("taskQueue"); } catch (e) { /* 忽略 */ }
      }
      overlay.remove();
      document.body.classList.remove("caspio-approval-active");
    });

    overlay.appendChild(progress);
    overlay.appendChild(buttonsContainer);
    overlay.appendChild(skipBtn);
    overlay.appendChild(stopBtn);

    document.body.prepend(overlay);
    document.body.classList.add("caspio-approval-active");
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
