/**
 * Background Service Worker
 *
 * 负责协调整个批量审批流程的跨标签页通信和队列管理。
 *
 * 新工作流程（用户无需回到 Caspio 页面）：
 * 1. 用户在 Caspio 点击外部链接 → caspio-content.js 请求本脚本建立审阅会话（startSession）
 * 2. 用户在目标页面做出审批选择 → 本脚本接收选择
 * 3. 将选择加入 Caspio 操作队列并写入审核日志 → 通知 Caspio 后台执行
 * 4. 将目标标签页导航到下一个外部链接（用户无需手动操作）
 * 5. 重复 2-4 直到所有任务完成；会话结束且全部提交处理完后自动导出审核日志 CSV
 *
 * Storage 数据结构说明：
 * - taskQueue: { items, currentIndex, caspioTabId, targetTabId, config, sessionId, sessionStartedAt }
 *   跟踪所有待审阅的外部链接、用户当前位置、以及指定的审批标签页 ID
 * - caspioOp:<序号>: {recordId, choice, createdAt, sessionId, logKey}
 *   Caspio 页面待执行的单条审批操作，每条操作独占一个 storage 键，按键名排序即 FIFO 顺序。
 * - caspioLog:<序号>: 审核日志条目（每个决定一条，含提交结果），导出 CSV 用
 * - caspioSessionEnd:<sessionId>: {endedAt, exported}  会话结束标记
 * - caspioLastSessionId: 最近一轮审阅会话 ID
 *
 * ====== v1.4.0：审批操作改为“每条一个键” ======
 * 旧版把全部待执行操作存成一个数组 caspioOperations，本脚本往队尾追加、Caspio 页面
 * 从队首删除，两边都是“读出整个数组 → 修改 → 整体写回”。两次读写一旦交错
 * （Caspio 读到 [A,B] → 本脚本写入 [A,B,C] → Caspio 写回 [B]），C 就被静默覆盖丢失，
 * 用户点得越快越容易发生。改为每条操作单独一个键后，新增只 set 自己的键、
 * 完成只 remove 自己的键，两边不再互相覆盖。
 *
 * ====== v1.5.0：审核日志 ======
 * 每个决定（审批 / 跳过）都会生成一条日志，Caspio 页面在提交并核对后把结果写回该条目。
 * 导出为带 UTF-8 BOM 的 CSV（Excel 直接打开中文公司名不乱码），通过 chrome.downloads
 * 直接保存到本地默认下载目录，文件名带 {YYYY-MM-DD_HHMMSS} 时间后缀。
 */

/** storage 键名前缀（caspio-content.js / target-content.js 使用同一组前缀） */
const OP_PREFIX = "caspioOp:";
const LOG_PREFIX = "caspioLog:";
const SESSION_END_PREFIX = "caspioSessionEnd:";

/** 审核日志保留天数：超过的条目在导出时清理，避免 storage 无限增长 */
const LOG_RETENTION_DAYS = 14;

/**
 * 进程内递增计数器，与时间戳一起组成键名，保证同一毫秒内的多条操作也有唯一且有序的键名。
 * Service Worker 重启后计数器归零，但时间戳已不同，不影响唯一性与顺序。
 */
let keyCounter = 0;

/**
 * 生成新的序号：<14 位补零时间戳>-<4 位补零计数>。
 * 补零保证按字符串排序即按时间先后排序（Caspio 页面依此按 FIFO 处理）。
 * 操作键与其日志键共用同一个序号，便于对照排查。
 *
 * @returns {string}
 */
function newSequence() {
  keyCounter = (keyCounter + 1) % 10000;
  return String(Date.now()).padStart(14, "0") + "-" + String(keyCounter).padStart(4, "0");
}

/**
 * taskQueue（及会话、日志导出状态）的串行化锁。
 *
 * Service Worker 中多个消息处理函数（建会话、审批、跳过、注册 Caspio 标签页、目标页校验、导出）
 * 都会做“读 → 改 → 写”。它们之间有 await，可能交错执行导致后写覆盖先写
 * （例如 currentIndex 回退、targetTabId 丢失、同一份日志被导出两次）。所有这类读改写都经此锁排队执行。
 *
 * @param {Function} fn - 需在锁内执行的异步函数
 * @returns {Promise<*>} fn 的返回值；fn 抛错时向调用方抛出，但不会阻塞后续排队任务
 */
let queueLock = Promise.resolve();
function withQueueLock(fn) {
  const run = queueLock.then(fn, fn);
  queueLock = run.catch(() => {});
  return run;
}

/**
 * 禁止 Chrome 自动丢弃（discard）Caspio 标签页。
 *
 * 审阅期间 Caspio 标签页长时间处于后台，开启“内存节省”时 Chrome 可能把它卸载，
 * 页面上的提交流程随之中断，待提交数停住不动，直到用户切回该标签页触发重新加载。
 *
 * @param {number} tabId - Caspio 标签页 ID
 */
function keepTabAlive(tabId) {
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => { /* 标签页可能已关闭，忽略 */ });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  /**
   * 建立新的审阅会话（用户在 Caspio 页面点击外部链接时发送）。
   * 若上一轮会话未正常结束（用户中途直接开始新一轮），先为其写入结束标记，使其日志能被导出。
   */
  if (message.action === "startSession") {
    withQueueLock(async () => {
      const { taskQueue: old } = await chrome.storage.local.get("taskQueue");
      const writes = {};
      if (old && old.sessionId) {
        writes[SESSION_END_PREFIX + old.sessionId] = { endedAt: Date.now(), exported: false };
      }
      const sessionId = "S" + newSequence();
      writes.taskQueue = {
        items: message.items || [],
        currentIndex: message.currentIndex || 0,
        config: message.config,
        caspioTabId: sender.tab.id,
        sessionId,
        sessionStartedAt: Date.now()
      };
      writes.caspioLastSessionId = sessionId;
      await chrome.storage.local.set(writes);
      keepTabAlive(sender.tab.id);
      return { status: "started", sessionId };
    }).then(sendResponse, (e) => sendResponse({ status: "error", error: String(e) }));
    return true;
  }

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
   * Caspio 内容脚本每次加载（包括页面刷新）都会发送此消息。
   * 将标签页 ID 存入 taskQueue，以便后续发送操作指令。
   */
  if (message.action === "registerCaspioTab") {
    withQueueLock(async () => {
      const { taskQueue: queue } = await chrome.storage.local.get("taskQueue");
      if (queue) {
        queue.caspioTabId = sender.tab.id;
        await chrome.storage.local.set({ taskQueue: queue });
        keepTabAlive(sender.tab.id);
      }
    });
    sendResponse({ status: "registered" });
  }

  /**
   * 处理用户在目标页面点击 Skip（跳过当前任务，不提交审批）。
   * 只推进队列索引、记录一条 Skipped 日志并导航到下一个链接，不添加任何 Caspio 操作。
   */
  if (message.action === "approvalSkipped") {
    handleSkip(sender.tab.id);
    sendResponse({ status: "skipped" });
  }

  /**
   * 处理用户在目标页面点击 Stop：结束会话（写入结束标记以便导出日志），清除任务队列。
   * 已提交的操作会继续在 Caspio 后台处理完成。
   */
  if (message.action === "stopSession") {
    withQueueLock(async () => {
      const { taskQueue: queue } = await chrome.storage.local.get("taskQueue");
      if (queue && queue.sessionId) {
        await chrome.storage.local.set({ [SESSION_END_PREFIX + queue.sessionId]: { endedAt: Date.now(), exported: false } });
      }
      await chrome.storage.local.remove("taskQueue");
    }).then(() => sendResponse({ status: "stopped" }), () => sendResponse({ status: "error" }));
    return true;
  }

  /**
   * 导出审核日志 CSV。
   * - sessionId：导出该会话的日志；auto=true 表示由 Caspio 页面在会话处理完后自动触发，
   *   若该会话已导出过则跳过（防止重复下载）。
   */
  if (message.action === "exportReviewLog") {
    exportReviewLog({ sessionId: message.sessionId, auto: !!message.auto })
      .then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
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
    withQueueLock(async () => {
      const { taskQueue: queue } = await chrome.storage.local.get("taskQueue");

      /* 没有活跃的任务队列，或队列已处理完毕 */
      if (!queue || !queue.items || queue.currentIndex >= queue.items.length) {
        return { isTarget: false };
      }

      const senderTabId = sender.tab.id;

      /* 情况 1：该标签页已被注册为目标标签页 */
      if (queue.targetTabId === senderTabId) {
        return { isTarget: true, queue };
      }

      /**
       * 情况 2：targetTabId 尚未注册（用户首次从 Caspio 点击外部链接打开新标签页）。
       * 通过 openerTabId 判断：如果该标签页是由 Caspio 标签页打开的，
       * 则将其注册为目标标签页。
       */
      if (!queue.targetTabId && sender.tab.openerTabId === queue.caspioTabId) {
        queue.targetTabId = senderTabId;
        await chrome.storage.local.set({ taskQueue: queue });
        return { isTarget: true, queue };
      }

      /* 情况 3：不是目标标签页 */
      return { isTarget: false };
    }).then(sendResponse, () => sendResponse({ isTarget: false }));
    return true;
  }

  /**
   * 处理 Caspio 操作失败的通知（结果已写入审核日志，这里仅记录到 Service Worker 控制台）。
   */
  if (message.action === "caspioOperationFailed") {
    console.warn(`[Caspio Assistant] Caspio 操作失败: RecordID=${message.recordId}, 原因: ${message.reason || "-"}`);
  }

  return true;
});

/**
 * 点击浏览器工具栏上的扩展图标：导出最近 LOG_RETENTION_DAYS 天内的全部审核日志。
 * 这是在 Caspio 页面已关闭、或想要汇总多轮会话时的手动导出入口。
 */
chrome.action.onClicked.addListener(() => {
  exportReviewLog({ all: true }).catch((e) => console.error("[Caspio Assistant] 导出日志失败:", e));
});

/**
 * 为当前任务项创建一条审核日志条目（尚未写入 storage，由调用方与其他写入合并为一次 set）。
 *
 * @param {Object} queue - 任务队列
 * @param {Object} item - 当前任务项 {targetUrl, recordId, duplicates?, company?}
 * @param {string} decision - 审批值；跳过时为空串
 * @param {string} status - "Pending"（待提交）或 "Skipped"
 * @returns {Object} 日志条目
 */
function buildLogEntry(queue, item, decision, status) {
  return {
    sessionId: queue.sessionId || "",
    sessionStartedAt: queue.sessionStartedAt || null,
    position: queue.currentIndex + 1,
    total: queue.items.length,
    decidedAt: Date.now(),
    recordId: item.recordId,
    company: item.company || "",
    targetUrl: item.targetUrl || "",
    duplicates: item.duplicates || "",
    decision,
    status,
    method: "",
    attempts: 0,
    savedAt: null,
    savedValue: "",
    error: ""
  };
}

/**
 * 处理审批选择的核心逻辑（新版：不关闭目标标签页，直接导航到下一个链接）。
 *
 * 流程：
 * 1. （锁内）读取任务队列，把本次选择写成一条独立的操作键 + 一条日志条目，推进索引并保存队列
 * 2. 通知 Caspio 标签页开始处理操作
 * 3. 如果还有下一个任务：将目标标签页导航到下一个 URL
 * 4. 如果已全部完成：关闭目标标签页，切回 Caspio，结束会话
 *
 * @param {string} choice - 用户的审批选择
 * @param {number} targetTabId - 当前目标页面的标签页 ID
 */
async function handleApprovalSelection(choice, targetTabId) {
  try {
    /* 步骤 1：锁内完成全部 storage 读改写，返回后续导航所需的队列快照 */
    const queue = await withQueueLock(async () => {
      const { taskQueue: q } = await chrome.storage.local.get("taskQueue");

      if (!q || !q.items || q.items.length === 0) {
        console.error("[Caspio Assistant] 任务队列为空或不存在");
        return null;
      }

      const currentItem = q.items[q.currentIndex];
      if (!currentItem) {
        console.error("[Caspio Assistant] 当前索引超出队列范围");
        return null;
      }

      /**
       * 将审批操作写成独立的键（而非追加到共享数组），见文件头 v1.4.0 说明；
       * 同时写入对应的日志条目（与操作在同一次 set 中写入，保证两者同时存在）。
       */
      const seq = newSequence();
      const logKey = LOG_PREFIX + seq;
      const writes = {
        [OP_PREFIX + seq]: {
          recordId: currentItem.recordId,
          choice,
          createdAt: Date.now(),
          sessionId: q.sessionId || "",
          logKey
        },
        [logKey]: buildLogEntry(q, currentItem, choice, "Pending")
      };
      q.currentIndex++;
      writes.taskQueue = q;
      await chrome.storage.local.set(writes);
      return q;
    });
    if (!queue) return;

    /**
     * 步骤 2：通知 Caspio 标签页开始处理操作队列。
     * Caspio 页面也会通过 storage.onChanged 自行感知新操作，这里的消息只是加速唤醒；
     * Caspio 页面若正在刷新导致消息发送失败也无妨，刷新后会自动处理剩余操作。
     */
    try {
      if (queue.caspioTabId) {
        await chrome.tabs.sendMessage(queue.caspioTabId, { action: "processCaspioQueue" });
      }
    } catch (e) {
      console.log("[Caspio Assistant] Caspio 页面暂时无法接收消息（可能正在刷新），操作已入队等待处理");
    }

    /**
     * 步骤 3：处理目标标签页的导航。
     * - 如果队列中还有下一个任务：将目标标签页导航到下一个 URL
     * - 如果所有任务已完成：关闭目标标签页
     */
    if (queue.currentIndex < queue.items.length) {
      const nextItem = queue.items[queue.currentIndex];
      console.log(`[Caspio Assistant] 导航到下一个链接 (${queue.currentIndex}/${queue.items.length}): ${nextItem.targetUrl}`);

      /* 直接更新标签页 URL，实现无缝导航 */
      await chrome.tabs.update(targetTabId, { url: nextItem.targetUrl });
    } else {
      await finishSession(queue, targetTabId);
    }

  } catch (error) {
    console.error("[Caspio Assistant] 处理审批选择时发生错误:", error);
  }
}

/**
 * 处理 Skip（跳过）操作。
 *
 * 与 handleApprovalSelection 类似，但不写入任何审批操作，只记录一条 Skipped 日志。
 * 只推进 currentIndex 并导航到下一个目标链接。
 *
 * @param {number} targetTabId - 当前目标页面的标签页 ID
 */
async function handleSkip(targetTabId) {
  try {
    const queue = await withQueueLock(async () => {
      const { taskQueue: q } = await chrome.storage.local.get("taskQueue");
      if (!q || !q.items) return null;

      const currentItem = q.items[q.currentIndex];
      const writes = {};
      if (currentItem) {
        writes[LOG_PREFIX + newSequence()] = buildLogEntry(q, currentItem, "", "Skipped");
      }

      /* 推进索引，跳过当前任务 */
      q.currentIndex++;
      writes.taskQueue = q;
      await chrome.storage.local.set(writes);
      return q;
    });
    if (!queue) return;

    /* 导航到下一个或结束 */
    if (queue.currentIndex < queue.items.length) {
      const nextItem = queue.items[queue.currentIndex];
      console.log(`[Caspio Assistant] 跳过，导航到下一个 (${queue.currentIndex}/${queue.items.length})`);
      await chrome.tabs.update(targetTabId, { url: nextItem.targetUrl });
    } else {
      console.log("[Caspio Assistant] 所有任务已审阅完毕（含跳过）");
      await finishSession(queue, targetTabId);
    }

  } catch (error) {
    console.error("[Caspio Assistant] 处理跳过操作时发生错误:", error);
  }
}

/**
 * 全部任务审阅完毕后的收尾：关闭目标标签页，切回 Caspio 标签页，写入会话结束标记并清理任务队列。
 *
 * 待执行的审批操作键（caspioOp:*）不在此清理，由 Caspio 内容脚本逐条处理完后自行删除；
 * Caspio 页面在该会话的操作全部处理完后，会根据结束标记自动请求导出审核日志。
 *
 * @param {Object} queue - 任务队列快照（需要其中的 caspioTabId、sessionId）
 * @param {number} targetTabId - 目标标签页 ID
 */
async function finishSession(queue, targetTabId) {
  console.log("[Caspio Assistant] 所有任务已审阅完毕，关闭目标页面");

  await chrome.tabs.remove(targetTabId);

  if (queue.caspioTabId) {
    try {
      await chrome.tabs.update(queue.caspioTabId, { active: true });
    } catch (e) {
      /* Caspio 标签页可能已关闭，忽略 */
    }
  }

  await withQueueLock(async () => {
    if (queue.sessionId) {
      await chrome.storage.local.set({ [SESSION_END_PREFIX + queue.sessionId]: { endedAt: Date.now(), exported: false } });
    }
    await chrome.storage.local.remove("taskQueue");
  });
}

/* ====== 审核日志导出 ====== */

/** CSV 列定义：表头（英文，面向最终用户）与取值函数 */
const CSV_COLUMNS = [
  ["Session Started", (e) => formatDateTime(e.sessionStartedAt)],
  ["Session ID", (e) => e.sessionId],
  ["Position", (e) => (e.position ? `${e.position} / ${e.total}` : "")],
  ["Decided At", (e) => formatDateTime(e.decidedAt)],
  ["Record ID", (e) => e.recordId],
  ["Company", (e) => e.company],
  ["Target URL", (e) => e.targetUrl],
  ["Duplicates", (e) => e.duplicates],
  ["Decision", (e) => e.decision],
  ["Status", (e) => e.status],
  ["Method", (e) => e.method],
  ["Attempts", (e) => (e.attempts ? String(e.attempts) : "")],
  ["Saved At", (e) => formatDateTime(e.savedAt)],
  ["Value in Caspio", (e) => e.savedValue],
  ["Error", (e) => e.error]
];

/**
 * 导出审核日志为 CSV 并直接下载到本地。
 *
 * @param {Object} opts
 * @param {string} [opts.sessionId] - 只导出该会话的日志
 * @param {boolean} [opts.auto] - 自动导出：该会话已导出过则跳过，导出后标记 exported
 * @param {boolean} [opts.all] - 导出保留期内的全部日志（忽略 sessionId）
 * @returns {Promise<{ok:boolean, count?:number, filename?:string, reason?:string}>}
 */
function exportReviewLog(opts) {
  return withQueueLock(async () => {
    const all = await chrome.storage.local.get(null);
    await pruneOldLogs(all);

    const endKey = opts.sessionId ? SESSION_END_PREFIX + opts.sessionId : null;
    if (opts.auto && endKey && all[endKey] && all[endKey].exported) {
      return { ok: false, reason: "already exported" };
    }

    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 3600 * 1000;
    const entries = Object.keys(all)
      .filter((k) => k.startsWith(LOG_PREFIX) && all[k])
      .map((k) => all[k])
      .filter((e) => (opts.all ? (e.decidedAt || 0) >= cutoff : e.sessionId === opts.sessionId))
      .sort((a, b) => (a.decidedAt || 0) - (b.decidedAt || 0));

    if (!entries.length) {
      if (opts.auto && endKey) await chrome.storage.local.set({ [endKey]: { ...(all[endKey] || {}), exported: true } });
      return { ok: false, reason: "no log entries" };
    }

    const csv = [CSV_COLUMNS.map((c) => csvCell(c[0])).join(",")]
      .concat(entries.map((e) => CSV_COLUMNS.map((c) => csvCell(c[1](e))).join(",")))
      .join("\r\n");
    const filename = `Caspio_review_log${opts.all ? "_all" : ""}_${fileTimestamp(new Date())}.csv`;

    /* UTF-8 BOM：让 Excel 以 UTF-8 打开，中文公司名不乱码。Service Worker 中无法使用
     * URL.createObjectURL，故用 data URL 交给 chrome.downloads；saveAs:false 直接保存到默认下载目录。 */
    await chrome.downloads.download({
      url: "data:text/csv;charset=utf-8," + encodeURIComponent("﻿" + csv),
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });

    if (endKey && all[endKey]) {
      await chrome.storage.local.set({ [endKey]: { ...all[endKey], exported: true } });
    }
    console.log(`[Caspio Assistant] 已导出审核日志 ${entries.length} 条: ${filename}`);
    return { ok: true, count: entries.length, filename };
  });
}

/**
 * 清理超过保留期的日志条目与会话结束标记（在导出锁内调用）。
 * 仍有对应待执行操作的日志不会被清理（保留期远长于正常提交耗时，这里只是兜底判断）。
 *
 * @param {Object} all - storage 全量快照
 */
async function pruneOldLogs(all) {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 3600 * 1000;
  const activeLogKeys = new Set(
    Object.keys(all).filter((k) => k.startsWith(OP_PREFIX) && all[k]).map((k) => all[k].logKey)
  );
  const stale = Object.keys(all).filter((k) => {
    const v = all[k];
    if (!v) return false;
    if (k.startsWith(LOG_PREFIX)) return (v.decidedAt || 0) < cutoff && !activeLogKeys.has(k);
    if (k.startsWith(SESSION_END_PREFIX)) return (v.endedAt || 0) < cutoff;
    return false;
  });
  if (stale.length) await chrome.storage.local.remove(stale);
}

/**
 * CSV 单元格转义：统一加双引号、内部双引号翻倍；
 * 以 = + - @ 开头的文本前加单引号，防止 Excel 把公司名等内容当作公式执行（CSV 注入）。
 *
 * @param {*} value
 * @returns {string}
 */
function csvCell(value) {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** 两位补零 */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 时间戳格式化为本地时间 “YYYY-MM-DD HH:mm:ss”；空值返回空串。
 * @param {number|null} ts
 * @returns {string}
 */
function formatDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 文件名时间后缀 “YYYY-MM-DD_HHMMSS”（本地时间）。
 * @param {Date} d
 * @returns {string}
 */
function fileTimestamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
