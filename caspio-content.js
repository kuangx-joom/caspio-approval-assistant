/**
 * Caspio 页面内容脚本
 *
 * 负责三个核心功能：
 * 1. 扫描表格中所有外部链接，构建任务队列
 * 2. 拦截用户点击外部链接，启动批量审批流程
 * 3. 从操作队列中依次执行 Edit → 选择下拉值 → Update（在后台自动完成）
 *
 * 工作原理：
 * - 页面加载时扫描所有表格行，提取外部链接和对应的 Edit 按钮信息
 * - 用户点击某个外部链接时，以该行为起点构建完整任务队列
 * - 用户在目标页面做出审批选择后，background.js 会将操作加入队列
 * - 本脚本从队列中取出操作，执行 Edit → 选择 → Update
 * - 点击 Update 后页面会刷新，脚本重新执行，继续处理队列中剩余的操作
 *
 * Storage 数据结构：
 * - taskQueue: { items: [{targetUrl, recordId}], currentIndex, caspioTabId }
 *   所有待审阅的行信息及当前用户正在审阅的位置
 * - caspioOperations: [{recordId, choice}]
 *   Caspio 页面待执行的审批操作队列，按 FIFO 顺序处理
 */

(function () {
  "use strict";

  /**
   * 检查扩展上下文是否仍然有效。
   *
   * 当用户在 chrome://extensions 页面重新加载扩展后，
   * 已打开页面上的旧内容脚本仍在运行，但其与扩展的连接已断开。
   * 此时调用 chrome.runtime.sendMessage 等 API 会抛出
   * "Extension context invalidated" 错误。
   *
   * 通过检查 chrome.runtime.id 是否存在来判断上下文是否有效：
   * - 有效时 chrome.runtime.id 返回扩展 ID 字符串
   * - 失效时 chrome.runtime.id 为 undefined
   *
   * @returns {boolean} 扩展上下文是否仍然有效
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
   * 如果扩展上下文已失效，静默忽略，不抛出错误。
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
   * 安全地访问 chrome.storage.local。
   * 如果扩展上下文已失效，静默忽略。
   *
   * @param {"get"|"set"|"remove"} method - storage 操作类型
   * @param {*} arg - 操作参数
   * @param {Function} [callback] - 可选的回调函数
   */
  function safeStorage(method, arg, callback) {
    if (!isExtensionContextValid()) return;
    try {
      chrome.storage.local[method](arg, callback);
    } catch (e) {
      /* 扩展上下文已失效，静默忽略 */
    }
  }

  /**
   * 页面加载后向 background.js 注册当前标签页 ID，
   * 并检查是否有待执行的 Caspio 操作（用于页面刷新后的断点续传）。
   */
  safeSendMessage({ action: "registerCaspioTab" });

  /**
   * 页面加载后立即检查是否有待执行的操作。
   * 这是实现"页面刷新后继续处理队列"的关键机制：
   * 每次 Update 提交会导致页面刷新 → 脚本重新执行 → 自动处理下一个操作。
   */
  setTimeout(() => {
    if (isExtensionContextValid()) checkAndProcessOperations();
  }, 1000);

  /**
   * 使用事件委托监听整个文档的点击事件。
   *
   * 当用户点击外部链接时：
   * 1. 扫描所有表格行，构建完整的任务队列
   * 2. 以被点击的行为起点，设置队列的起始索引
   * 3. 将队列存入 chrome.storage.local
   * 4. 允许链接正常打开新标签页
   */
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

    /**
     * 扫描整个表格，构建所有可审阅行的任务列表。
     * 每个任务项包含：
     * - targetUrl: 外部链接的 URL（用户将在该页面做审批决定）
     * - recordId: 对应行的 Caspio 记录 ID（用于定位 Edit 按钮）
     */
    const allItems = scanAllRows();
    const clickedRecordId = extractRecordId(editLink.href);

    /**
     * 找到用户点击的行在队列中的位置，从该位置开始审阅。
     * 如果找不到（理论上不应发生），从第一行开始。
     */
    let startIndex = allItems.findIndex(item => item.recordId === clickedRecordId);
    if (startIndex === -1) startIndex = 0;

    /* 存储任务队列，currentIndex 表示用户当前正在审阅的位置 */
    safeStorage("set", {
      taskQueue: {
        items: allItems,
        currentIndex: startIndex
      },
      /* 清空操作队列，确保不会残留上一次会话的数据 */
      caspioOperations: []
    }, () => {
      safeSendMessage({ action: "registerCaspioTab" });
      console.log(`[Caspio Assistant] 任务队列已建立: ${allItems.length} 项, 起始索引: ${startIndex}`);
    });
  });

  /**
   * 监听来自 background.js 的消息。
   *
   * 支持的消息类型：
   * - processCaspioQueue: 开始处理操作队列中的下一个审批操作
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "processCaspioQueue") {
      checkAndProcessOperations();
      sendResponse({ status: "processing" });
    }
    return true;
  });

  /* ====== 表格扫描相关函数 ====== */

  /**
   * 扫描当前页面的所有表格行，提取包含外部链接和 Edit 按钮的行信息。
   *
   * 遍历所有 <tr> 行：
   * - 查找每行中的 Edit 按钮（用于后续自动化操作）
   * - 查找每行中第一个外部链接（用户需要在该页面做审批）
   * - 提取 Edit 链接中的 RecordID 作为行的唯一标识
   *
   * @returns {Array<{targetUrl: string, recordId: string}>} 所有可审阅行的信息
   */
  function scanAllRows() {
    const items = [];
    const rows = document.querySelectorAll("tr");

    for (const row of rows) {
      const editLink = row.querySelector('a.cbResultSetActionsLinks[title^="Edit"]');
      if (!editLink) continue;

      /* 在该行中找到第一个外部链接 */
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

  /**
   * 从 Edit 链接 URL 中提取 Mod0RecordID 参数。
   *
   * RecordID 是 Caspio 中每条记录的唯一标识，不会随 session 或页面刷新而变化。
   * 用于在页面刷新后重新定位到正确的 Edit 按钮。
   *
   * @param {string} href - Edit 链接的完整 URL
   * @returns {string|null} RecordID 值，或 null
   */
  function extractRecordId(href) {
    try {
      const url = new URL(href);
      return url.searchParams.get("Mod0RecordID");
    } catch (e) {
      return null;
    }
  }

  /* ====== Caspio 操作执行相关函数 ====== */

  /**
   * 检查并处理 caspioOperations 队列中的下一个操作。
   *
   * 这是操作队列的核心调度函数。它会：
   * 1. 从 storage 读取 caspioOperations 队列
   * 2. 如果队列非空，取出第一个操作执行
   * 3. 执行完成后，从队列中移除该操作
   * 4. 点击 Update 按钮（会导致页面刷新，脚本重新执行后自动处理下一个）
   *
   * 页面刷新后的断点续传机制：
   * Update → 页面刷新 → 脚本重新执行 → setTimeout 调用本函数 → 处理下一个操作
   */
  async function checkAndProcessOperations() {
    if (!isExtensionContextValid()) return;

    let result;
    try {
      result = await chrome.storage.local.get("caspioOperations");
    } catch (e) {
      /* 扩展上下文已失效，静默退出 */
      return;
    }
    const operations = result.caspioOperations;

    if (!operations || operations.length === 0) {
      console.log("[Caspio Assistant] 没有待处理的 Caspio 操作");
      return;
    }

    const op = operations[0];
    console.log(`[Caspio Assistant] 开始处理操作: recordId=${op.recordId}, choice=${op.choice}`);

    await executeApproval(op.choice, op.recordId);
  }

  /**
   * 执行单条审批操作的完整流程。
   *
   * 步骤：
   * 1. 通过 RecordID 找到对应行的 Edit 链接并点击
   * 2. 等待 Caspio 动态加载编辑表单（InlineEditCatmanApproval 下拉框）
   * 3. 通过模拟点击 Caspio 自定义下拉组件选择审批值
   * 4. 从 caspioOperations 队列中移除当前操作
   * 5. 点击 Update 按钮提交（提交后页面会刷新）
   *
   * 注意：步骤 4 必须在步骤 5 之前执行，因为 Update 会导致页面刷新，
   * 刷新后 JS 执行上下文丢失，无法再操作 storage。
   *
   * @param {string} choice - 用户的审批选择
   * @param {string} recordId - 目标记录的 Caspio RecordID
   */
  async function executeApproval(choice, recordId) {
    try {
      /* 步骤 1：通过 RecordID 找到 Edit 链接并点击 */
      const editLink = findEditLinkByRecordId(recordId);
      if (!editLink) {
        console.error(`[Caspio Assistant] 未找到 RecordID=${recordId} 的 Edit 按钮`);
        await removeFirstOperation();
        safeSendMessage({ action: "caspioOperationFailed", recordId });
        return;
      }

      editLink.click();

      /* 步骤 2：等待审批下拉框出现 */
      const selectElement = await waitForElement('select[name="InlineEditCatmanApproval"]', 10000);
      if (!selectElement) {
        console.error("[Caspio Assistant] 审批下拉框未出现");
        await removeFirstOperation();
        safeSendMessage({ action: "caspioOperationFailed", recordId });
        return;
      }

      /* 步骤 3：通过自定义下拉组件选择值 */
      const selected = await selectCaspioDropdownValue(selectElement, choice);
      if (!selected) {
        console.error("[Caspio Assistant] 无法选择审批值");
        await removeFirstOperation();
        safeSendMessage({ action: "caspioOperationFailed", recordId });
        return;
      }

      await delay(500);

      /* 步骤 4：从队列中移除当前操作（必须在 Update 之前） */
      await removeFirstOperation();

      /* 步骤 5：点击 Update 提交（页面将刷新） */
      const updateButton = document.querySelector('input[name="Mod0InlineEdit"][value="Update"]');
      if (!updateButton) {
        console.error("[Caspio Assistant] 未找到 Update 按钮");
        safeSendMessage({ action: "caspioOperationFailed", recordId });
        return;
      }

      console.log(`[Caspio Assistant] 提交审批: ${choice} (RecordID: ${recordId})`);
      updateButton.click();
      /* 页面将刷新，脚本重新执行后自动处理队列中的下一个操作 */

    } catch (error) {
      console.error("[Caspio Assistant] 自动审批执行失败:", error);
      await removeFirstOperation();
      chrome.runtime.sendMessage({ action: "caspioOperationFailed", recordId });
    }
  }

  /**
   * 从 caspioOperations 队列中移除第一个操作。
   *
   * 必须在点击 Update 之前调用，因为 Update 会导致页面刷新。
   * 如果在 Update 之后尝试移除，JS 上下文已丢失，队列不会更新，
   * 导致页面刷新后重复处理同一个操作。
   *
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

  /**
   * 通过 RecordID 在当前页面中查找对应的 Edit 链接。
   *
   * 遍历所有 Edit 链接，从每个链接的 URL 中提取 Mod0RecordID 参数进行匹配。
   * RecordID 是稳定的唯一标识，不会因页面刷新或 session 变化而改变。
   *
   * @param {string} recordId - 目标记录的 RecordID
   * @returns {HTMLAnchorElement|null} 找到的 Edit 链接，或 null
   */
  function findEditLinkByRecordId(recordId) {
    const allEditLinks = document.querySelectorAll('a.cbResultSetActionsLinks[title^="Edit"]');
    for (const link of allEditLinks) {
      const linkRecordId = extractRecordId(link.href);
      if (linkRecordId === recordId) {
        return link;
      }
    }
    return null;
  }

  /* ====== DOM 工具函数 ====== */

  /**
   * 等待指定的 DOM 元素出现在页面中。
   * 使用 MutationObserver 监听 DOM 变化，元素出现时立即响应。
   *
   * @param {string} selector - CSS 选择器
   * @param {number} timeout - 超时时间（毫秒）
   * @returns {Promise<Element|null>}
   */
  function waitForElement(selector, timeout) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      let resolved = false;

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element && !resolved) {
          resolved = true;
          observer.disconnect();
          resolve(element);
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

  /**
   * 通过模拟用户操作来选择 Caspio 自定义下拉组件的值。
   *
   * Caspio 使用自定义下拉组件而非原生 <select>：
   * - 点击 <select> 后弹出 div#dropbox-body 容器
   * - 容器内包含 div.Option 元素作为可选项
   * - 必须模拟完整的鼠标点击流程来触发选择
   *
   * @param {HTMLSelectElement} selectElement - <select> 元素
   * @param {string} value - 要选择的值
   * @returns {Promise<boolean>} 是否成功
   */
  async function selectCaspioDropdownValue(selectElement, value) {
    /* 模拟点击 <select> 触发自定义下拉框展开 */
    simulateMouseClick(selectElement);

    const dropboxBody = await waitForElement("#dropbox-body", 5000);
    if (!dropboxBody) {
      /* 备用策略：先 focus 再重试 */
      selectElement.focus();
      await delay(100);
      simulateMouseClick(selectElement);

      const dropboxRetry = await waitForElement("#dropbox-body", 5000);
      if (!dropboxRetry) return false;
      return await selectOptionFromDropbox(dropboxRetry, value);
    }

    return await selectOptionFromDropbox(dropboxBody, value);
  }

  /**
   * 在 dropbox-body 容器中查找并点击目标选项。
   *
   * @param {HTMLElement} dropboxBody - 下拉选项容器
   * @param {string} value - 要选择的值
   * @returns {Promise<boolean>}
   */
  async function selectOptionFromDropbox(dropboxBody, value) {
    await delay(300);

    const options = dropboxBody.querySelectorAll(".Option");
    let targetOption = null;

    for (const option of options) {
      if (option.title === value || option.textContent.trim() === value) {
        targetOption = option;
        break;
      }
    }

    if (!targetOption) {
      console.error(`[Caspio Assistant] 未找到匹配选项: "${value}"`);
      return false;
    }

    simulateMouseClick(targetOption);
    return true;
  }

  /**
   * 模拟完整的鼠标点击事件序列：mousedown → mouseup → click。
   * Caspio 的自定义 UI 组件需要完整的事件链才能正确响应。
   *
   * @param {HTMLElement} element - 要点击的元素
   */
  function simulateMouseClick(element) {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  /**
   * @param {number} ms - 毫秒
   * @returns {Promise<void>}
   */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

})();
