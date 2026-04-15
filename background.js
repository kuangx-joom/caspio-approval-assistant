/**
 * Background Service Worker
 *
 * 负责协调整个批量审批流程的跨标签页通信和队列管理。
 *
 * 新工作流程（用户无需回到 Caspio 页面）：
 * 1. 用户在 Caspio 点击外部链接 → caspio-content.js 构建任务队列
 * 2. 用户在目标页面做出审批选择 → 本脚本接收选择
 * 3. 将选择加入 Caspio 操作队列 → 通知 Caspio 后台执行
 * 4. 将目标标签页导航到下一个外部链接（用户无需手动操作）
 * 5. 重复 2-4 直到所有任务完成
 *
 * Storage 数据结构说明：
 * - taskQueue: { items, currentIndex, caspioTabId, targetTabId }
 *   跟踪所有待审阅的外部链接、用户当前位置、以及指定的审批标签页 ID
 * - caspioOperations: [{recordId, choice}]
 *   Caspio 页面待执行的审批操作 FIFO 队列
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  /**
   * 处理用户在目标页面做出的审批选择。
   * 收到后不再关闭标签页，而是将其导航到下一个目标链接。
   */
  if (message.action === "approvalSelected") {
    handleApprovalSelection(message.choice, sender.tab.id);
    sendResponse({ status: "received" });
  }

  /**
   * 注册 Caspio 标签页 ID。
   * Caspio 内容脚本每次加载（包括 Update 后的页面刷新）都会发送此消息。
   * 将标签页 ID 存入 taskQueue，以便后续发送操作指令。
   */
  if (message.action === "registerCaspioTab") {
    chrome.storage.local.get("taskQueue", (result) => {
      const queue = result.taskQueue;
      if (queue) {
        queue.caspioTabId = sender.tab.id;
        chrome.storage.local.set({ taskQueue: queue });
      }
    });
    sendResponse({ status: "registered" });
  }

  /**
   * 处理用户在目标页面点击 Skip（跳过当前任务，不提交审批）。
   * 只推进队列索引并导航到下一个链接，不向 Caspio 操作队列中添加任何操作。
   */
  if (message.action === "approvalSkipped") {
    handleSkip(sender.tab.id);
    sendResponse({ status: "skipped" });
  }

  /**
   * 验证发送消息的标签页是否为指定的审批目标标签页。
   *
   * 判断逻辑：
   * 1. 如果 taskQueue.targetTabId 已记录，直接对比标签页 ID
   * 2. 如果 targetTabId 尚未记录（首次打开），检查该标签页的 openerTabId
   *    是否为 Caspio 标签页（即该页面是从 Caspio 页面上的链接打开的）
   * 3. 以上都不满足则返回 isTarget: false，内容脚本不显示审批工具栏
   *
   * 这样确保只有从 Caspio 链接打开的标签页、或由扩展导航到的标签页
   * 才会显示审批工具栏，用户正常浏览其他网站不会受到任何影响。
   */
  if (message.action === "isTargetTab") {
    chrome.storage.local.get("taskQueue", (result) => {
      const queue = result.taskQueue;

      /* 没有活跃的任务队列，或队列已处理完毕 */
      if (!queue || !queue.items || queue.currentIndex >= queue.items.length) {
        sendResponse({ isTarget: false });
        return;
      }

      const senderTabId = sender.tab.id;

      /* 情况 1：该标签页已被注册为目标标签页 */
      if (queue.targetTabId === senderTabId) {
        sendResponse({ isTarget: true, queue });
        return;
      }

      /**
       * 情况 2：targetTabId 尚未注册（用户首次从 Caspio 点击外部链接打开新标签页）。
       * 通过 openerTabId 判断：如果该标签页是由 Caspio 标签页打开的，
       * 则将其注册为目标标签页。
       */
      if (!queue.targetTabId && sender.tab.openerTabId === queue.caspioTabId) {
        queue.targetTabId = senderTabId;
        chrome.storage.local.set({ taskQueue: queue });
        sendResponse({ isTarget: true, queue });
        return;
      }

      /* 情况 3：不是目标标签页 */
      sendResponse({ isTarget: false });
    });
    return true;
  }

  /**
   * 处理 Caspio 操作失败的通知。
   * 操作失败时记录日志，但不中断整个流程。
   * Caspio 内容脚本会自动继续处理队列中的下一个操作。
   */
  if (message.action === "caspioOperationFailed") {
    console.warn(`[Caspio Assistant] Caspio 操作失败: RecordID=${message.recordId}`);
  }

  return true;
});

/**
 * 处理审批选择的核心逻辑（新版：不关闭目标标签页，直接导航到下一个链接）。
 *
 * 流程：
 * 1. 从 storage 读取任务队列和当前位置
 * 2. 将用户的选择加入 Caspio 操作队列
 * 3. 通知 Caspio 标签页开始处理操作
 * 4. 推进队列索引到下一个任务
 * 5. 如果还有下一个任务：将目标标签页导航到下一个 URL
 * 6. 如果已全部完成：关闭目标标签页，通知用户
 *
 * @param {string} choice - 用户的审批选择
 * @param {number} targetTabId - 当前目标页面的标签页 ID
 */
async function handleApprovalSelection(choice, targetTabId) {
  try {
    const result = await chrome.storage.local.get(["taskQueue", "caspioOperations"]);
    const queue = result.taskQueue;
    const operations = result.caspioOperations || [];

    if (!queue || !queue.items || queue.items.length === 0) {
      console.error("[Caspio Assistant] 任务队列为空或不存在");
      return;
    }

    const currentItem = queue.items[queue.currentIndex];
    if (!currentItem) {
      console.error("[Caspio Assistant] 当前索引超出队列范围");
      return;
    }

    /**
     * 步骤 1：将审批操作加入 Caspio 操作队列。
     * 每个操作包含 recordId（定位 Edit 按钮）和 choice（审批值）。
     */
    operations.push({
      recordId: currentItem.recordId,
      choice: choice
    });

    /**
     * 步骤 2：推进队列索引，指向下一个待审阅的任务。
     */
    queue.currentIndex++;

    /* 保存更新后的队列和操作列表 */
    await chrome.storage.local.set({
      taskQueue: queue,
      caspioOperations: operations
    });

    /**
     * 步骤 3：通知 Caspio 标签页开始处理操作队列。
     * Caspio 页面在后台执行 Edit → 选择 → Update，
     * 用户此时可能已经在查看下一个目标页面。
     *
     * 使用 try-catch 包裹，因为 Caspio 页面可能正在刷新（上一次 Update 导致），
     * 此时发送消息会失败。但这不影响流程，因为 Caspio 页面刷新后
     * 会自动检查 caspioOperations 队列并继续处理。
     */
    try {
      if (queue.caspioTabId) {
        await chrome.tabs.sendMessage(queue.caspioTabId, { action: "processCaspioQueue" });
      }
    } catch (e) {
      console.log("[Caspio Assistant] Caspio 页面暂时无法接收消息（可能正在刷新），操作已入队等待处理");
    }

    /**
     * 步骤 4：处理目标标签页的导航。
     * - 如果队列中还有下一个任务：将目标标签页导航到下一个 URL
     * - 如果所有任务已完成：关闭目标标签页
     */
    if (queue.currentIndex < queue.items.length) {
      const nextItem = queue.items[queue.currentIndex];
      console.log(`[Caspio Assistant] 导航到下一个链接 (${queue.currentIndex}/${queue.items.length}): ${nextItem.targetUrl}`);

      /* 直接更新标签页 URL，实现无缝导航 */
      await chrome.tabs.update(targetTabId, { url: nextItem.targetUrl });
    } else {
      /**
       * 所有任务已审阅完毕。
       * 关闭目标标签页，切换回 Caspio 标签页。
       * 保留 taskQueue 和 caspioOperations 直到 Caspio 处理完所有操作后再清理。
       */
      console.log("[Caspio Assistant] 所有任务已审阅完毕，关闭目标页面");

      await chrome.tabs.remove(targetTabId);

      /* 切换回 Caspio 标签页 */
      if (queue.caspioTabId) {
        try {
          await chrome.tabs.update(queue.caspioTabId, { active: true });
        } catch (e) {
          /* Caspio 标签页可能已关闭，忽略 */
        }
      }

      /* 清理任务队列（操作队列由 Caspio 内容脚本处理完后自行清理） */
      await chrome.storage.local.remove("taskQueue");
    }

  } catch (error) {
    console.error("[Caspio Assistant] 处理审批选择时发生错误:", error);
  }
}

/**
 * 处理 Skip（跳过）操作。
 *
 * 与 handleApprovalSelection 类似，但不向 caspioOperations 队列添加操作。
 * 只推进 currentIndex 并导航到下一个目标链接。
 *
 * @param {number} targetTabId - 当前目标页面的标签页 ID
 */
async function handleSkip(targetTabId) {
  try {
    const result = await chrome.storage.local.get("taskQueue");
    const queue = result.taskQueue;

    if (!queue || !queue.items) return;

    /* 推进索引，跳过当前任务 */
    queue.currentIndex++;

    await chrome.storage.local.set({ taskQueue: queue });

    /* 导航到下一个或结束 */
    if (queue.currentIndex < queue.items.length) {
      const nextItem = queue.items[queue.currentIndex];
      console.log(`[Caspio Assistant] 跳过，导航到下一个 (${queue.currentIndex}/${queue.items.length})`);
      await chrome.tabs.update(targetTabId, { url: nextItem.targetUrl });
    } else {
      console.log("[Caspio Assistant] 所有任务已审阅完毕（含跳过）");
      await chrome.tabs.remove(targetTabId);

      if (queue.caspioTabId) {
        try {
          await chrome.tabs.update(queue.caspioTabId, { active: true });
        } catch (e) { /* 忽略 */ }
      }

      await chrome.storage.local.remove("taskQueue");
    }

  } catch (error) {
    console.error("[Caspio Assistant] 处理跳过操作时发生错误:", error);
  }
}
