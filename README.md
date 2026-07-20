# Caspio Approval Assistant

A Chrome extension that streamlines the Caspio approval workflow. Instead of manually switching between external vendor pages and Caspio to submit each approval, this extension lets you review vendors in a continuous flow — make your decision on the vendor's page, and the extension handles the rest automatically in the background.

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
  - [Step 1: Download the Extension](#step-1-download-the-extension)
  - [Step 2: Open Chrome Extensions Page](#step-2-open-chrome-extensions-page)
  - [Step 3: Enable Developer Mode](#step-3-enable-developer-mode)
  - [Step 4: Load the Extension](#step-4-load-the-extension)
  - [Step 5: Verify Installation](#step-5-verify-installation)
- [How It Works](#how-it-works)
- [Usage Guide](#usage-guide)
  - [Starting a Review Session](#starting-a-review-session)
  - [Making Approval Decisions](#making-approval-decisions)
  - [Skipping a Vendor](#skipping-a-vendor)
  - [Stopping a Review Session](#stopping-a-review-session)
- [Approval Options](#approval-options)
- [Toolbar Buttons Reference](#toolbar-buttons-reference)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Changelog](#changelog)

---

## Overview

When working in Caspio, you often need to:

1. Click a vendor link (e.g., an Amazon seller page) to review their information
2. Go back to Caspio
3. Click **Edit** on that row
4. Select an approval status from the dropdown
5. Click **Update**
6. Repeat for the next vendor

**This extension automates steps 2–5 entirely.** You simply click through vendor pages and make your decisions — the extension queues up all the Caspio operations and executes them in the background.

### Before vs. After

| Without Extension | With Extension |
|---|---|
| Open vendor page | Open vendor page |
| Review vendor | Review vendor |
| Switch back to Caspio | Click approval button on the toolbar |
| Click Edit | *(automatically navigates to next vendor)* |
| Select approval value | |
| Click Update | |
| Click next vendor link | |

---

## Installation

### Step 1: Download the Extension

Download or clone the extension folder to your computer. The folder should contain the following files:

```
Caspio/
├── manifest.json
├── background.js
├── caspio-content.js
├── target-content.js
├── overlay.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

> **Note:** Remember the location of this folder — you will need it in Step 4.

### Step 2: Open Chrome Extensions Page

Open Google Chrome and navigate to the extensions management page by either:

- Typing `chrome://extensions` in the address bar and pressing **Enter**, or
- Clicking the three-dot menu (**⋮**) → **Extensions** → **Manage Extensions**

<!-- Screenshot: Chrome address bar with chrome://extensions -->
`[Screenshot: chrome-extensions-page.png]`

### Step 3: Enable Developer Mode

In the top-right corner of the extensions page, toggle the **Developer mode** switch to the **ON** position.

<!-- Screenshot: Developer mode toggle highlighted -->
`[Screenshot: developer-mode-toggle.png]`

### Step 4: Load the Extension

1. Click the **Load unpacked** button that appears in the top-left area after enabling Developer mode.
2. In the file browser dialog, navigate to and select the **Caspio** folder (the one containing `manifest.json`).
3. Click **Select Folder**.

<!-- Screenshot: Load unpacked button highlighted -->
`[Screenshot: load-unpacked-button.png]`

<!-- Screenshot: Folder selection dialog -->
`[Screenshot: folder-selection.png]`

### Step 5: Verify Installation

After loading, the extension should appear in your extensions list with the name **Caspio Approval Assistant**. Verify that:

- The extension is shown as enabled (toggle is blue/on)
- No error messages are displayed

<!-- Screenshot: Extension loaded successfully in the list -->
`[Screenshot: extension-loaded.png]`

> **Tip:** You can pin the extension to your Chrome toolbar by clicking the puzzle icon (**Extensions**) in the toolbar and clicking the pin icon next to **Caspio Approval Assistant**.

---

## How It Works

The extension operates in three stages:

```
┌─────────────────────────────────────────────────────────────────┐
│  STAGE 1: Queue Building                                        │
│  When you click a vendor link on the Caspio page, the extension │
│  scans ALL rows in the table and builds a review queue.         │
├─────────────────────────────────────────────────────────────────┤
│  STAGE 2: Vendor Review                                         │
│  On each vendor page, a toolbar appears at the top with         │
│  approval buttons. After you click one, the tab navigates       │
│  directly to the next vendor — no need to return to Caspio.     │
├─────────────────────────────────────────────────────────────────┤
│  STAGE 3: Background Submission                                 │
│  Meanwhile, the Caspio tab (in the background) submits each     │
│  decision directly to the Caspio server via the same AJAX       │
│  request the page itself uses — no page reloads, no per-row     │
│  Edit/Update clicks. It falls back to simulated UI clicks only  │
│  if the fast path is unavailable.                               │
└─────────────────────────────────────────────────────────────────┘
```

The key advantage is that **Stage 2 and Stage 3 run in parallel** — you continue reviewing vendors while Caspio submits your previous decisions in the background.

### Fast submission (v1.2.0+)

Earlier versions drove Caspio's inline-edit UI for every record (Edit → select → Update), which triggered a full page reload per row and could not keep up with fast reviewers, causing a growing backlog. Starting in **v1.2.0**, the extension submits approvals by replaying Caspio's own `UpdateRow` AJAX request directly. This removes the per-row reload and cuts submission time from roughly **1.5–2.5 s to about 0.2–0.5 s per record**, so the background queue keeps pace with your review speed.

To avoid overwriting other columns, the extension first reads the row's current values (`GetRowData`) and re-submits every editable field unchanged except the approval field. The set of editable fields is either preconfigured per DataPage or auto-discovered from the inline-edit form on first use and cached. If any required token or field is unavailable, it automatically falls back to the original UI-driven method, so no record is ever skipped.

---

## Usage Guide

### Starting a Review Session

1. Open your Caspio data page in Chrome (e.g., `https://c1abz485.caspio.com/dp/...`).
2. Click on **any external vendor link** in the table (e.g., an Amazon seller link).
3. A new tab opens with the vendor's page. The extension automatically:
   - Scans all rows in the Caspio table
   - Builds a review queue starting from the row you clicked
   - Displays the **approval toolbar** at the top of the vendor page

<!-- Screenshot: Caspio page with vendor links visible, one highlighted -->
`[Screenshot: caspio-page-with-links.png]`

<!-- Screenshot: Vendor page with the approval toolbar visible at top -->
`[Screenshot: vendor-page-with-toolbar.png]`

### Making Approval Decisions

Once the approval toolbar appears at the top of the vendor page:

1. Review the vendor's information on the page.
2. Click one of the approval buttons. The available buttons depend on which DataPage you started from (see [Approval Options](#approval-options)):
   - **Catman Approval** page: **Approved without KAM** (green) · **Approved with KAM** (blue) · **Declined** (red)
   - **Initial Application Sorting** page: **OK (approved)** (green) · **Declined** (red)
3. The page will automatically navigate to the **next vendor** in the queue.
4. The toolbar updates to show your current progress (e.g., `Review 3 / 15`).

<!-- Screenshot: Toolbar close-up showing the three buttons and progress -->
`[Screenshot: toolbar-buttons-closeup.png]`

> **What happens in the background:** After each decision, the extension sends your choice to the Caspio tab, which submits it directly to the Caspio server (replaying Caspio's own `UpdateRow` request) — no page reload and no action from you. If the fast path is unavailable, it falls back to automatically clicking Edit, selecting the value, and clicking Update.

### Skipping a Vendor

If you want to skip a vendor without making a decision:

1. Click the **Skip** button on the toolbar.
2. The page navigates to the next vendor immediately.
3. No approval action is submitted to Caspio for the skipped vendor.

> **Note:** Skipped vendors are not processed. If you need to review them later, you will need to do so manually on the Caspio page.

### Stopping a Review Session

To end the review session before all vendors have been reviewed:

1. Click the **Stop** button on the toolbar.
2. The toolbar disappears and the current page remains open.
3. Any decisions you already made will **continue to be processed** in the background on the Caspio tab.

> **Important:** Stopping only ends the review flow — it does not cancel decisions you have already submitted. Those will still be applied to Caspio.

### Completing All Reviews

When you reach the last vendor in the queue and make your decision:

1. The vendor tab closes automatically.
2. Chrome switches back to the Caspio tab.
3. The Caspio tab finishes processing any remaining operations in the background.

<!-- Screenshot: All reviews completed, back on Caspio page -->
`[Screenshot: reviews-completed.png]`

---

## Approval Options

The approval buttons shown on the toolbar depend on which Caspio DataPage you started the review from. The extension currently supports two DataPages.

### DataPage 1 — Catman Approval

Started from `/dp/111d6000ed43124f32b24bd99611`. Shows three options:

| Option | Button Color | Dropdown Value Set in Caspio |
|---|---|---|
| Approved without KAM | Green | `Approved without KAM` |
| Approved with KAM | Blue | `Approved with KAM` |
| Declined | Red | `Declined` |

These values correspond exactly to the options in the **CatmanApproval** dropdown field in Caspio's inline edit form.

### DataPage 2 — Initial Application Sorting

Started from `/dp/111d6000f90d0b783d8f420784b1`. This page only displays applications whose **Target Market** field is empty, so every record needs a decision. Shows two options:

| Option | Button Color | Dropdown Value Set in Caspio |
|---|---|---|
| OK (approved) | Green | `OK (approved)` |
| Declined | Red | `Declined` |

These values correspond exactly to the options in the **Target Market** dropdown field in Caspio's inline edit form.

---

## Toolbar Buttons Reference

The approval toolbar appears at the top of each vendor page during an active review session. The approval buttons vary by DataPage (see [Approval Options](#approval-options)); the **Skip** and **Stop** buttons are always present.

| Button | Color | Action |
|---|---|---|
| **Approved without KAM** | Green | *(Catman Approval page)* Submit "Approved without KAM" and go to next vendor |
| **Approved with KAM** | Blue | *(Catman Approval page)* Submit "Approved with KAM" and go to next vendor |
| **OK (approved)** | Green | *(Initial Application Sorting page)* Submit "OK (approved)" and go to next vendor |
| **Declined** | Red | Submit "Declined" and go to next vendor |
| **Skip** | Gray | Skip this vendor (no action taken) and go to next vendor |
| **Stop** | Gray | End the review session; already-submitted decisions continue processing |

<!-- Screenshot: Annotated toolbar with each button labeled -->
`[Screenshot: toolbar-annotated.png]`

---

## Troubleshooting

### The toolbar does not appear on the vendor page

- **Cause:** The extension may not be loaded or enabled.
- **Fix:** Go to `chrome://extensions` and verify the extension is enabled (toggle is on). If it shows errors, click **Reload** (circular arrow icon).

<!-- Screenshot: Reload button on the extension card -->
`[Screenshot: extension-reload.png]`

### The toolbar appears but nothing happens when I click a button

- **Cause:** The Caspio tab may have been closed.
- **Fix:** Make sure the Caspio data page is still open in another tab. The extension needs it to submit approvals.

### Caspio shows "Invalid entry in one or more fields"

- **Cause:** The dropdown values may have changed in Caspio.
- **Fix:** Manually click Edit on any row in Caspio, open the CatmanApproval dropdown, and check that the option values match: `Approved without KAM`, `Approved with KAM`, `Declined`. If they have changed, the extension code needs to be updated.

### An approval submitted, but another column looks blank or changed

- **Cause:** The fast AJAX path re-submits every editable field. If a DataPage's editable columns changed in Caspio and the extension's field list is out of date, a newly added column may be submitted blank.
- **Fix:** Update `ajax.editableFields` for that DataPage in `caspio-content.js`, or clear the extension's cached field list (remove the extension's storage / reload it) so it re-discovers the current fields. When in doubt after a Caspio schema change, verify one record's other columns are preserved before running a large batch.

### The extension does not pick up all rows

- **Cause:** Only rows visible on the current Caspio page are scanned.
- **Fix:** Make sure your Caspio page is configured to display all rows (the `cbCurrentPageSize` parameter should be set high enough, e.g., `999`).

### I need to re-review a vendor I skipped

- **Solution:** Skipped vendors are not tracked. Go back to the Caspio page and manually process the skipped row using the standard Edit → Select → Update workflow.

### The extension stopped working after a Chrome update

- **Fix:** Go to `chrome://extensions`, find **Caspio Approval Assistant**, and click **Reload**. If that does not work, remove the extension and load it again using the installation steps above.

---

## FAQ

**Q: Does the extension modify any data on external vendor pages (e.g., Amazon)?**
A: No. The extension only adds a visual toolbar overlay to the top of the page. It does not interact with or modify the vendor page content in any way.

**Q: Can I use other tabs while a review session is running?**
A: Yes. The review session only uses two tabs — the Caspio tab (background) and the vendor review tab. You can freely use other tabs.

**Q: What happens if I close the Caspio tab during a review session?**
A: The review toolbar will still appear on vendor pages, but approval decisions cannot be submitted because the Caspio tab is no longer available. You should keep the Caspio tab open during the entire review session.

**Q: What happens if I close the vendor tab during a review session?**
A: The review session ends. Any decisions already submitted will continue to be processed on the Caspio tab. To resume, go back to the Caspio page and click another vendor link.

**Q: Can I run multiple review sessions at the same time?**
A: No. Only one review session can be active at a time. Starting a new session (by clicking a vendor link on Caspio) will replace the current queue.

**Q: Does this extension send any data to third-party servers?**
A: No third parties are involved. Coordination between your tabs uses Chrome's built-in APIs (`chrome.storage.local` and `chrome.runtime.sendMessage`). To submit approvals, the extension does make network requests — but only to **your own Caspio server** (`*.caspio.com`), and only the exact same `GetRowData`/`UpdateRow` requests the Caspio page itself would send when you edit a row manually. Your existing Caspio login session is used; no credentials are stored or sent anywhere else. Vendor pages (e.g., Amazon) are never contacted by the extension.

**Q: Is the fast submission safe — can it corrupt my records?**
A: It is designed to be non-destructive. Before submitting, it reads the row's current values and re-sends every editable field unchanged except the one approval field you chose. Fields it cannot confirm from the current row data are left out rather than blanked, and approval writes are idempotent (re-writing the same value is harmless). If anything about the fast path is unavailable, it falls back to the original UI method instead of skipping the record. The one scenario to watch is a DataPage whose editable columns changed after the field list was cached — see the Troubleshooting note above.

**Q: Does the extension work with other Caspio applications?**
A: The extension is configured for two specific Caspio DataPages — **Catman Approval** (`/dp/111d6000ed43124f32b24bd99611`, using the `CatmanApproval` field) and **Initial Application Sorting** (`/dp/111d6000f90d0b783d8f420784b1`, using the `Target Market` field). Other Caspio pages fall back to the Catman Approval behavior by default. To support a new DataPage with different options or field names, add an entry to `DATAPAGE_CONFIGS` in `caspio-content.js`.

For the fast AJAX submission path, each DataPage also needs its set of editable fields. This is either listed in the DataPage's `ajax` config or auto-discovered from the inline-edit form the first time you edit a row (and then cached in `chrome.storage`). **If a DataPage's editable columns are later added or removed in Caspio, update its `ajax.editableFields` (or clear the extension's stored cache) so newly added columns are not left blank on submission.**

---

## Changelog

### v1.2.0
- **Fast background submission.** Approvals are now submitted by replaying Caspio's own `UpdateRow` AJAX request directly, removing the full page reload that occurred for every record. Submission time drops from roughly 1.5–2.5 s to about 0.2–0.5 s per record, so the background queue keeps pace with fast reviewers.
- **Non-destructive updates.** Each row's current values are read first (`GetRowData`) and re-submitted unchanged except for the approval field.
- **Editable-field auto-discovery + caching.** Fields are read from the inline-edit form on first use and persisted, so the fast path applies from the first record in later sessions — even when approving one record at a time.
- **Automatic fallback.** If any required token or field is unavailable, the extension falls back to the original UI-driven Edit → select → Update method; no record is skipped.
- **Continuous draining.** The Caspio tab now drains the whole pending queue in one pass instead of one operation per page reload.

### v1.1.0
- Added multi-DataPage support (per-DataPage approval options and fields via `DATAPAGE_CONFIGS`).

### v1.0.0
- Initial release: continuous vendor-review flow with an on-page approval toolbar and background Edit → select → Update automation.
