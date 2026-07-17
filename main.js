const { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } = require("obsidian");

const DEFAULT_EXCLUDED_PATTERNS = [
  ".obsidian/**",
  ".trash/**",
  ".DS_Store",
  "**/.DS_Store",
  "Thumbs.db",
  "**/Thumbs.db",
  "desktop.ini",
  "**/desktop.ini",
  "*.tmp",
  "**/*.tmp",
  "*.temp",
  "**/*.temp",
  "*.conflict-*",
  "**/*.conflict-*",
  "*.drivebridge-partial",
  "**/*.drivebridge-partial",
  "*.drivebridge-replace-*",
  "**/*.drivebridge-replace-*"
];
const DEFAULT_SETTINGS = {
  clientId: "",
  clientSecret: "",
  rootFolderName: "Obsidian Vault",
  rootFolderId: "",
  syncMode: "bidirectional",
  dryRunDefault: true,
  safeInitialSync: true,
  allowFirstRealSync: false,
  syncDeletes: false,
  conflictAction: "manualReview",
  protectModifyPercentage: 40,
  obsidianSyncMode: "off",
  autoSyncOnStartup: false,
  autoSyncIntervalMinutes: 0,
  maxFileSizeMb: 50,
  duplicateGuardMode: "auto",
  excludedFolders: "",
  excludedPatterns: DEFAULT_EXCLUDED_PATTERNS.join("\n"),
  accessToken: "",
  refreshToken: "",
  tokenExpiresAt: 0,
  deviceCode: "",
  userCode: "",
  verificationUrl: "",
  authStartedAt: 0,
  lastSyncSummary: "",
  lastPlanSummary: "",
  lastRecoverySummary: "",
  recoveryPreviewRunId: "",
  recoveryPreviewSafe: false,
  recoveryPlanPreviewRunId: "",
  recoveryPlanPreviewAt: 0,
  recoveryPlanPreviewSafe: false,
  lastSyncAt: 0,
  lastRemoteSnapshotAt: 0,
  remoteSnapshotProtocolVersion: 0,
  lastSyncHadErrors: false,
  duplicateGuardRootChanged: false,
  duplicateGuardAfterRebuild: false,
  duplicateGuardFolderPaths: "",
  lastSyncStatus: "idle",
  manualReviewMigrationDone: false,
  lastPreviewDigest: "",
  approvedFirstSyncDigest: "",
  allowLargeDeleteOnce: false,
  approvedDeletePlanDigest: "",
  deviceId: ""
};

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const OAUTH_DEVICE_CODE = "https://oauth2.googleapis.com/device/code";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SNAPSHOT_FILE = "snapshot.json";
const JOURNAL_FILE = "sync-journal.json";
const OPERATION_JOURNAL_FILE = "operation-journal.json";
const OPERATION_JOURNAL_BACKUP_FILE = "operation-journal.previous.json";
const REMOTE_SNAPSHOT_FILE = "remote_snapshot.json";
const REVIEW_QUEUE_FILE = "review-queue.json";
const SNAPSHOT_BACKUP_FILE = "snapshot.previous.json";
const REVIEW_QUEUE_BACKUP_FILE = "review-queue.previous.json";
const REPAIR_PLAN_FILE = "repair-plan.json";
const RUNTIME_EPOCH_KEY = "__drivebridgeRuntimeEpoch";
const REMOTE_DELETE_TOMBSTONE_RETENTION_MS = 20 * 24 * 60 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 4;
const DRIVE_ID_BATCH_SIZE = 1000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const LOCAL_HASH_MAX_BYTES = 10 * 1024 * 1024;
const LARGE_BINARY_CONFLICT_BYTES = 10 * 1024 * 1024;
const BULK_TIMESTAMP_SLOT_MS = 60 * 1000;
const BULK_TIMESTAMP_MIN_FILES = 30;
const ATOMIC_VERIFY_RETRY_DELAYS_MS = [0, 50, 200, 750, 2000];
const HASHED_LOCAL_EXTENSIONS = new Set([".md", ".txt", ".json", ".css", ".js", ".canvas"]);
const LARGE_BINARY_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".mp4", ".mov", ".zip"]);
const OBSIDIAN_SAFE_ALLOW_PATTERNS = [
  ".obsidian/appearance.json",
  ".obsidian/core-plugins.json",
  ".obsidian/community-plugins.json",
  ".obsidian/hotkeys.json",
  ".obsidian/snippets/**",
  ".obsidian/themes/**",
  ".obsidian/plugins/*/manifest.json",
  ".obsidian/plugins/*/main.js",
  ".obsidian/plugins/*/styles.css"
];
const OBSIDIAN_ALWAYS_EXCLUDE_PATTERNS = [
  ".DS_Store",
  "**/.DS_Store",
  "Thumbs.db",
  "**/Thumbs.db",
  "desktop.ini",
  "**/desktop.ini",
  "*.tmp",
  "**/*.tmp",
  "*.temp",
  "**/*.temp",
  "*.conflict-*",
  "**/*.conflict-*",
  "*.drivebridge-partial",
  "**/*.drivebridge-partial",
  "*.drivebridge-replace-*",
  "**/*.drivebridge-replace-*",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/plugins/*/data.json"
];

module.exports = class DriveBridgePlugin extends Plugin {
  async onload() {
    const runtimeHost = typeof globalThis !== "undefined" ? globalThis : window;
    runtimeHost[RUNTIME_EPOCH_KEY] = `${Date.now()}-${randomId(8)}`;
    this.runtimeEpoch = runtimeHost[RUNTIME_EPOCH_KEY];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.deviceId) {
      this.settings.deviceId = `device-${randomId(16)}`;
      await this.saveData(this.settings);
    }
    if (!this.settings.manualReviewMigrationDone) {
      this.settings.conflictAction = "manualReview";
      this.settings.manualReviewMigrationDone = true;
      await this.saveData(this.settings);
    }
    this.syncing = false;
    this.activeOperation = "";
    this.remoteIndexRepairPending = false;
    this.folderCache = new Map();
    this.progressModal = null;
    this.progressCloseTimer = null;
    this.currentSyncProgress = "";
    this.syncUiQuiet = false;
    this.skipChangedFilesDuringSync = false;
    this.operationJournalCache = null;
    this.operationJournalDirty = false;
    this.operationJournalDirtyCount = 0;
    this.operationJournalLastFlushAt = 0;
    this.remoteChildCache = new Map();
    this.reviewCount = 0;
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("drivebridge-sync-status");
    this.clearSyncStatus();
    this.addSettingTab(new DriveBridgeSettingTab(this.app, this));
    this.addCommand({
      id: "drivebridge-preview-sync",
      name: "Preview Google Drive sync",
      callback: () => this.previewSync()
    });
    this.addCommand({
      id: "drivebridge-sync-now",
      name: "Sync vault with Google Drive",
      callback: () => this.syncNow({ dryRun: false })
    });
    this.addCommand({
      id: "drivebridge-compact-sync",
      name: "Run compact sync",
      callback: () => this.syncNow({
        dryRun: this.settings.dryRunDefault,
        quiet: true
      })
    });
    this.addCommand({
      id: "drivebridge-rebuild-remote-snapshot",
      name: "Repair remote index (not a normal sync)",
      callback: () => this.rebuildRemoteSnapshotFromDrive()
    });
    this.addCommand({
      id: "drivebridge-review-conflicts",
      name: "Review sync conflicts",
      callback: () => runUiAction(() => this.openConflictReview())
    });
    this.addRibbonIcon("refresh-cw", "Preview Google Drive sync", () => this.previewSync());
    this.addRibbonIcon("list-checks", "Review DriveBridge conflicts", () => runUiAction(() => this.openConflictReview()));
    try {
      const reviewQueue = await this.loadReviewQueue();
      this.reviewCount = reviewQueue.items.length;
    } catch (err) {
      console.error("[drivebridge-obsidian-sync] failed to load review queue", err);
      new Notice(`DriveBridge review queue error: ${err.message}`, 10000);
    }
    this.clearSyncStatus();
    if (this.settings.autoSyncOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        if (this.isCurrentRuntime()) this.syncNow({ dryRun: this.settings.dryRunDefault, quiet: true });
      });
    }
    if (this.settings.autoSyncIntervalMinutes > 0) {
      this.registerInterval(window.setInterval(
        () => {
          if (this.isCurrentRuntime()) this.syncNow({ dryRun: this.settings.dryRunDefault, quiet: true });
        },
        this.settings.autoSyncIntervalMinutes * 60 * 1000
      ));
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async startDeviceAuth() {
    this.requireClientId();
    const body = new URLSearchParams({
      client_id: this.settings.clientId,
      scope: DRIVE_SCOPE
    });
    const data = await parseJsonResponse(await customFetch(OAUTH_DEVICE_CODE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    }));
    this.settings.deviceCode = data.device_code;
    this.settings.userCode = data.user_code;
    this.settings.verificationUrl = data.verification_url || data.verification_uri;
    this.settings.authStartedAt = Date.now();
    await this.saveSettings();
    new Notice(`Open ${this.settings.verificationUrl} and enter ${this.settings.userCode}`);
  }

  async finishDeviceAuth() {
    this.requireClientId();
    if (!this.settings.deviceCode) {
      throw new Error("Start authorization first.");
    }
    const body = new URLSearchParams({
      client_id: this.settings.clientId,
      device_code: this.settings.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    });
    if (this.settings.clientSecret) {
      body.set("client_secret", this.settings.clientSecret);
    }
    const data = await parseJsonResponse(await customFetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    }));
    this.settings.accessToken = data.access_token;
    this.settings.refreshToken = data.refresh_token || this.settings.refreshToken;
    this.settings.tokenExpiresAt = Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000;
    this.settings.deviceCode = "";
    this.settings.userCode = "";
    this.settings.verificationUrl = "";
    await this.saveSettings();
    new Notice("Google Drive authorization complete.");
  }

  async previewSync() {
    await this.syncNow({ dryRun: true });
  }

  async syncNow(options = {}) {
    const dryRun = options.dryRun !== undefined ? options.dryRun : this.settings.dryRunDefault;
    const quiet = Boolean(options.quiet);
    const recoveryResume = Boolean(options.recoveryResume);
    if (this.syncing) {
      if (!quiet) {
        new Notice("DriveBridge sync is already running.");
      }
      return;
    }
    this.syncing = true;
    this.activeOperation = "sync";
    this.syncUiQuiet = quiet;
    this.skipChangedFilesDuringSync = true;
    this.folderCache = new Map();
    this.remoteChildCache = new Map();
    this.syncMetrics = {
      driveRequests: 0,
      idReservationRequests: 0,
      recoveryLookups: 0,
      duplicateGuardPreflightParents: 0,
      duplicateGuardPostflightParents: 0,
      duplicateGuardSelfHealed: 0,
      remoteSnapshotWrites: 0,
      remoteSnapshotWriteSkipped: 0,
      remoteSnapshotConflictMerges: 0
    };
    const started = Date.now();
    try {
      const recovery = await this.checkInterruptedSync();
      if (recovery.interrupted && !dryRun && !recoveryResume) {
        const message = `Previous DriveBridge sync appears interrupted. Run Preview first or use recovery actions. In-progress: ${recovery.inProgress.length}, partial files: ${recovery.partials.length}.`;
        this.settings.lastRecoverySummary = message;
        this.settings.lastSyncSummary = message;
        await this.saveSettings();
        new Notice(message, 12000);
        return;
      }
      if (recoveryResume) {
        this.assertRecoveryResumeAllowed(recovery);
      }
      this.updateSyncProgress({
        phase: dryRun ? "Preview" : "Sync",
        message: "Scanning local vault and Google Drive..."
      });
      if (!quiet) {
        new Notice(dryRun ? "DriveBridge preview started." : "DriveBridge sync started. Avoid editing notes until it completes.");
      }
      const context = await this.buildSyncContext();
      if (recoveryResume) {
        await this.reconcileRecoveryContext(recovery, context);
      }
      const plan = await this.buildSyncPlan(context);
      context.planDigest = planDigest(plan, context);
      context.newUploadParentPathCounts = this.newUploadParentPathCounts(plan, context);
      const summary = this.formatPlanSummary(plan, dryRun, Date.now() - started);
      this.settings.lastPlanSummary = summary;
      if (dryRun && this.recoveryPreviewIsCurrent(recovery)) {
        const unsafeResumeActions = this.unsafeResumePlanEntries(plan);
        this.settings.recoveryPlanPreviewRunId = recovery.runId;
        this.settings.recoveryPlanPreviewAt = Date.now();
        this.settings.recoveryPlanPreviewSafe = unsafeResumeActions.length === 0;
        this.settings.lastRecoverySummary = [
          "Normal Preview completed after recovery preview.",
          unsafeResumeActions.length
            ? `Resume safe operations is blocked because Preview includes ${unsafeResumeActions.length} conflict/delete action(s).`
            : "Resume safe operations is now available."
        ].join("\n");
      }

      if (dryRun) {
        await this.reconcileReviewQueue(plan, this.reviewItemsForPlan(plan, context));
        this.settings.lastPreviewDigest = context.planDigest;
        this.settings.lastSyncSummary = summary;
        await this.saveSettings();
        if (!quiet) {
          new Notice("DriveBridge preview complete.");
        }
        this.updateSyncProgress({
          phase: "Preview",
          current: plan.entries.length,
          total: plan.entries.length,
          message: "Preview complete."
        });
        if (!quiet) {
          this.scheduleProgressModalClose(1800);
        }
        this.clearSyncStatus();
        return;
      }

      this.assertRealSyncAllowed(context, plan);
      if (recoveryResume) {
        this.assertResumePlanSafe(plan);
      }
      await this.writeJournal({ startedAt: new Date().toISOString(), dryRun, plan });
      const hasOperationWork = recoveryResume || plan.entries.some((entry) => this.shouldJournalOperation(entry));
      const runId = hasOperationWork
        ? (recoveryResume && recovery.runId
          ? recovery.runId
          : `${formatTimestamp(new Date(started))}-${randomId(6)}`)
        : "";
      if (hasOperationWork) {
        await this.prepareOperationJournal(runId, plan, context, recoveryResume ? recovery.journal : null);
      }
      const resumeDonePaths = recoveryResume ? this.recoveryDonePaths(recovery) : new Set();
      const executed = await this.executePlan(context, plan, runId, { skipDonePaths: resumeDonePaths });
      if (hasOperationWork) {
        await this.markOperationJournalCommitPending(runId, executed);
      }
      if (!dryRun) {
        const remoteSnapshotResult = await this.saveRemoteSnapshot(
          context.rootFolderId,
          context.remoteBase || context.remote,
          context.remoteDeleted,
          Object.assign({}, context.recoveredRemoteDeleted || {}, executed.remoteDeleted),
          Object.assign({}, context.recoveredRemoteMutations || {}, executed.remoteMutations, executed.remoteSnapshotUpdates),
          {
            runId,
            expectedSnapshotFileId: context.remoteSnapshotFileId || "",
            expectedSnapshotModifiedTime: context.remoteSnapshotModifiedTime || "",
            forceWrite: Boolean(context.remoteSnapshotMissing)
          }
        );
        if (hasOperationWork) {
          await this.updateOperationJournalSnapshotCommit(runId, remoteSnapshotResult);
        }
        await this.saveSnapshot(executed.nextSnapshot);
        await this.reconcileReviewQueue(plan, executed.reviewItems);
      }
      executed.performance = Object.assign({}, this.syncMetrics);
      await this.writeJournal({
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        dryRun,
        stats: executed.stats,
        errors: executed.errors,
        skippedChanged: executed.skippedChanged,
        skippedSafe: executed.skippedSafe,
        performance: executed.performance
      });
      if (hasOperationWork) {
        await this.markOperationJournalComplete(runId, executed);
      }
      this.settings.allowFirstRealSync = false;
      this.settings.approvedFirstSyncDigest = "";
      this.settings.allowLargeDeleteOnce = false;
      this.settings.approvedDeletePlanDigest = "";
      this.settings.lastSyncAt = Date.now();
      const incomplete = executed.errors.length > 0 ||
        executed.skippedChanged.length > 0 ||
        executed.skippedSafe.length > 0 ||
        executed.reviewItems.length > 0;
      this.settings.lastSyncHadErrors = incomplete;
      this.settings.lastSyncStatus = executed.errors.length
        ? "completed_with_errors"
        : incomplete ? "completed_incomplete" : "completed";
      if (!incomplete) {
        this.settings.duplicateGuardRootChanged = false;
        this.settings.duplicateGuardAfterRebuild = false;
      }
      this.settings.lastSyncSummary = this.formatExecutionSummary(executed, Date.now() - started);
      this.settings.lastRecoverySummary = "";
      await this.saveSettings();
      if (executed.errors.length) {
        new Notice("DriveBridge sync completed with errors. Check DriveBridge settings for details.", 10000);
        this.showProgressModal(this.formatErrorModalMessage("DriveBridge sync completed with errors.", executed.errors), {
          current: executed.processedBytes,
          total: executed.totalBytes,
          unit: "bytes"
        });
      } else {
        if (!quiet) {
          const reviewSuffix = this.reviewCount ? ` ${this.reviewCount} conflict(s) need review.` : "";
          new Notice(incomplete ? `DriveBridge sync incomplete.${reviewSuffix}` : "DriveBridge sync complete.", incomplete ? 10000 : 5000);
        }
        this.updateSyncProgress({
          phase: "Sync",
          current: executed.processedBytes,
          total: executed.totalBytes,
          unit: "bytes",
          message: "Sync complete."
        });
        if (!quiet) {
          this.scheduleProgressModalClose(1800);
        }
      }
    } catch (err) {
      const failure = this.errorRecord({ path: "(sync)", action: "sync" }, err);
      this.settings.lastSyncSummary = this.formatFatalErrorSummary(failure, Date.now() - started);
      this.settings.lastSyncHadErrors = true;
      this.settings.lastSyncStatus = "failed";
      await this.safeWriteJournal({
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        dryRun,
        fatalError: failure
      });
      await this.saveSettings();
      new Notice(`DriveBridge failed: ${failure.message}. Check DriveBridge settings for details.`, 10000);
      this.showProgressModal(this.formatErrorModalMessage("DriveBridge failed.", [failure]), this.lastProgressForModal());
      console.error("[drivebridge-obsidian-sync]", err);
    } finally {
      await this.safeFlushOperationJournal(true);
      this.remoteChildCache = new Map();
      this.folderCache = new Map();
      this.syncing = false;
      this.activeOperation = "";
      this.syncUiQuiet = false;
      this.skipChangedFilesDuringSync = false;
      this.clearSyncStatus();
      this.startPendingRemoteIndexRepair();
    }
  }

  async buildSyncContext() {
    await this.ensureAccessToken();
    const rootFolderId = await this.ensureRootFolder();
    const snapshot = await this.loadSnapshot();
    const local = await this.scanLocalVault();
    const remoteState = await this.scanRemoteVault(rootFolderId);
    return {
      rootFolderId,
      snapshot,
      local,
      remote: remoteState.files,
      remoteDeleted: remoteState.deleted,
      remoteSnapshotAt: remoteState.snapshotAt || 0,
      remoteSnapshotFileId: remoteState.snapshotFileId || "",
      remoteSnapshotModifiedTime: remoteState.snapshotModifiedTime || "",
      remoteSnapshotFromFullScan: Boolean(remoteState.fromFullScan),
      remoteSnapshotMissing: Boolean(remoteState.snapshotMissing)
    };
  }

  isCurrentRuntime() {
    const runtimeHost = typeof globalThis !== "undefined" ? globalThis : window;
    return !this.runtimeEpoch || runtimeHost[RUNTIME_EPOCH_KEY] === this.runtimeEpoch;
  }

  assertCurrentRuntime() {
    if (!this.isCurrentRuntime()) {
      const error = new Error("A newer DriveBridge runtime replaced this instance. The stale callback stopped before changing Google Drive.");
      error.code = "DRIVEBRIDGE_STALE_RUNTIME";
      throw error;
    }
  }

  async rebuildRemoteSnapshotFromDrive() {
    if (this.syncing) {
      if (this.activeOperation === "repair") {
        new Notice("DriveBridge remote index Repair is already running.");
        return;
      }
      this.remoteIndexRepairPending = true;
      this.showProgressModal([
        "REPAIR REMOTE INDEX — QUEUED",
        "A Normal/automatic sync is finishing first.",
        "Repair will start automatically as soon as that operation releases DriveBridge.",
        "Do not press Normal sync again. Keep Obsidian open."
      ].join("\n"));
      new Notice("DriveBridge Repair queued. It will start automatically after the current Normal sync finishes.", 12000);
      return;
    }
    const started = Date.now();
    this.syncing = true;
    this.activeOperation = "repair";
    this.remoteIndexRepairPending = false;
    try {
      this.updateSyncProgress({
        phase: "REPAIR REMOTE INDEX",
        current: 0,
        total: 0,
        message: "Repair mode is scanning Google Drive metadata. This is not a normal file sync or backup. No local note content is being uploaded or downloaded."
      });
      new Notice("DriveBridge REPAIR started. This rebuilds the remote index; it is not a normal sync or backup.", 10000);
      await this.ensureAccessToken();
      const rootFolderId = await this.ensureRootFolder();
      let previousDeleted = {};
      try {
        const previousRemoteState = await this.loadRemoteSnapshotFile(rootFolderId);
        previousDeleted = previousRemoteState ? previousRemoteState.deleted || {} : {};
      } catch (err) {
        console.warn("[drivebridge-obsidian-sync] Could not preserve existing tombstones during rebuild", err);
      }
      const files = {};
      await this.scanRemoteFolder(rootFolderId, "", files);
      const preservedDeleted = this.mergeRemoteDeleteTombstones(previousDeleted, {}, files);
      await this.writeRemoteSnapshotFile(rootFolderId, files, preservedDeleted);
      const count = Object.keys(files).length;
      this.settings.lastSyncSummary = this.formatRemoteIndexRepairSuccess(
        count,
        Object.keys(preservedDeleted).length,
        Date.now() - started
      );
      this.settings.duplicateGuardAfterRebuild = true;
      this.settings.lastSyncHadErrors = false;
      await this.saveSettings();
      new Notice(`DriveBridge REPAIR COMPLETE: indexed ${count} Drive file(s). Next, run Normal Preview and Normal sync.`, 12000);
      this.showProgressModal(this.settings.lastSyncSummary);
      this.scheduleProgressModalClose(6000);
    } catch (err) {
      const failure = this.errorRecord({ path: REMOTE_SNAPSHOT_FILE, action: "rebuildRemoteSnapshot" }, err);
      this.settings.lastSyncSummary = this.formatRemoteIndexRepairFailure(failure, Date.now() - started);
      this.settings.lastSyncHadErrors = true;
      await this.saveSettings();
      new Notice(`DriveBridge REPAIR STOPPED: ${failure.message}. Normal sync was not run.`, 15000);
      this.showProgressModal(this.settings.lastSyncSummary);
      console.error("[drivebridge-obsidian-sync]", err);
    } finally {
      this.syncing = false;
      this.activeOperation = "";
      this.clearSyncStatus();
    }
  }

  formatRemoteIndexRepairSuccess(count, preservedTombstones, elapsedMs) {
    return [
      "REPAIR REMOTE INDEX — COMPLETE",
      "Operation type: metadata index repair (not Normal sync / not a file backup)",
      `Completed at: ${formatLogDateTime(new Date())}`,
      `Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
      `DriveBridge version: ${this.manifest.version}`,
      `Remote files indexed: ${count}`,
      `Delete tombstones preserved: ${preservedTombstones}`,
      "Local notes uploaded/downloaded: 0",
      `Local ${SNAPSHOT_FILE} changed: no`,
      "Next: run Normal Preview, then Normal sync."
    ].join("\n");
  }

  formatRemoteIndexRepairFailure(failure, elapsedMs) {
    return [
      "REPAIR REMOTE INDEX — STOPPED WITH ERROR",
      "Operation type: metadata index repair (not Normal sync / not a file backup)",
      `Stopped at: ${formatLogDateTime(new Date())}`,
      `Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
      `Stopped while processing: ${failure.path || REMOTE_SNAPSHOT_FILE}`,
      `Reason: ${failure.message || "Unknown error"}`,
      "Result: the repaired remote index was not completed.",
      "Normal sync was not run. Drive files were not automatically deleted by this failed repair.",
      "Next: resolve the displayed cause, run Repair again, and wait for REPAIR COMPLETE before Normal Preview/Normal sync."
    ].join("\n");
  }

  async scanDuplicateRepairPlan() {
    if (this.syncing) throw new Error("DriveBridge is already running.");
    this.syncing = true;
    try {
      this.assertCurrentRuntime();
      await this.ensureAccessToken();
      const rootFolderId = await this.ensureRootFolder();
      const files = {};
      const duplicateGroups = [];
      await this.scanRemoteFolder(rootFolderId, "", files, { duplicateGroups, continueOnDuplicate: true });
      const groups = duplicateGroups.map((group) => {
        const candidates = group.candidates.slice().sort(compareRemoteCreationOrder);
        const filesOnly = candidates.every((item) => item.mimeType !== "application/vnd.google-apps.folder");
        const safe = filesOnly && candidates.length >= 2 && candidates.every((item) => sameDriveContentExact(candidates[0], item));
        return {
          key: md5Hex(new TextEncoder().encode(`${group.parentId}\n${group.path}\n${group.mimeType}`).buffer),
          path: group.path,
          parentId: group.parentId,
          mimeType: group.mimeType,
          candidates,
          canonicalId: safe ? candidates[0].id : "",
          extraIds: safe ? candidates.slice(1).map((item) => item.id) : [],
          safe,
          reason: safe ? "same size and non-empty MD5" : "different content, missing MD5, or folder duplicate"
        };
      });
      const plan = { version: 1, rootFolderId, createdAt: new Date().toISOString(), groups };
      plan.digest = md5Hex(new TextEncoder().encode(JSON.stringify(plan)).buffer);
      await this.writePluginDataFile(REPAIR_PLAN_FILE, JSON.stringify(plan, null, 2));
      await this.enqueueDuplicateRepairReviews(groups.filter((group) => !group.safe));
      this.settings.lastRecoverySummary = `Duplicate repair preview\nGroups: ${groups.length}\nSafe to isolate: ${groups.filter((g) => g.safe).length}\nManual review: ${groups.filter((g) => !g.safe).length}\nPlan digest: ${plan.digest}`;
      await this.saveSettings();
      new Notice(`DriveBridge found ${groups.length} duplicate group(s). Review the preview before Apply.`, 10000);
      return plan;
    } finally {
      this.syncing = false;
      this.activeOperation = "";
      this.clearSyncStatus();
    }
  }

  startPendingRemoteIndexRepair() {
    if (!this.remoteIndexRepairPending || this.syncing) return;
    window.setTimeout(() => {
      if (this.remoteIndexRepairPending && !this.syncing) {
        this.rebuildRemoteSnapshotFromDrive();
      }
    }, 0);
  }

  async applyDuplicateRepairPlan() {
    if (this.syncing) throw new Error("DriveBridge is already running.");
    this.syncing = true;
    try {
      this.assertCurrentRuntime();
      const plan = await this.readPluginDataJson(REPAIR_PLAN_FILE);
      if (!plan || plan.version !== 1 || !plan.digest) throw new Error("Run duplicate repair Preview before Apply.");
      const claimedDigest = plan.digest;
      const unsignedPlan = Object.assign({}, plan);
      delete unsignedPlan.digest;
      if (md5Hex(new TextEncoder().encode(JSON.stringify(unsignedPlan)).buffer) !== claimedDigest) {
        throw new Error("The duplicate repair plan changed after Preview. Preview again.");
      }
      await this.ensureAccessToken();
      const rootFolderId = await this.ensureRootFolder();
      if (rootFolderId !== plan.rootFolderId) throw new Error("The DriveBridge root changed after Preview. Preview again.");
      let isolated = 0;
      for (const group of plan.groups.filter((item) => item.safe)) {
        const current = await this.findRemoteItemsByExactName(group.parentId, basename(group.path), group.mimeType);
        const currentIds = current.map((item) => item.id).sort();
        const plannedIds = group.candidates.map((item) => item.id).sort();
        if (JSON.stringify(currentIds) !== JSON.stringify(plannedIds) || !current.every((item) => sameDriveContentExact(current[0], item))) {
          throw new Error(`Duplicate group changed after Preview: ${group.path}. Nothing further was isolated.`);
        }
        for (const id of group.extraIds) {
          this.assertCurrentRuntime();
          await this.trashRemote(id);
          isolated++;
        }
      }
      const files = {};
      const remaining = [];
      await this.scanRemoteFolder(rootFolderId, "", files, { duplicateGroups: remaining, continueOnDuplicate: true });
      if (!remaining.length) {
        const previousRemoteState = await this.loadRemoteSnapshotFile(rootFolderId);
        const preservedDeleted = this.mergeRemoteDeleteTombstones(previousRemoteState && previousRemoteState.deleted || {}, {}, files);
        await this.writeRemoteSnapshotFile(rootFolderId, files, preservedDeleted);
      }
      this.settings.lastRecoverySummary = `Duplicate repair Apply\nItems isolated to Drive trash: ${isolated}\nRemaining duplicate groups: ${remaining.length}${remaining.length ? "\nResolve Manual Review items, then Preview again." : "\nRemote snapshot rebuilt."}`;
      await this.saveSettings();
      return { isolated, remaining: remaining.length };
    } finally {
      this.syncing = false;
      this.clearSyncStatus();
    }
  }

  async buildSyncPlan(context) {
    const allPaths = Array.from(new Set([
      ...Object.keys(context.local),
      ...Object.keys(context.remote),
      ...Object.keys(context.snapshot),
      ...Object.keys(context.remoteDeleted || {})
    ])).sort();
    const entries = [];
    const stats = newEmptyStats();
    for (const path of allPaths) {
      let entry = this.planPath(path, context);
      if (entry.reason === "same-size files on both sides require content verification") {
        const localItem = context.local[path];
        if (Number(localItem && localItem.size || 0) > LOCAL_HASH_MAX_BYTES) {
          entry = { path, action: "conflict", reason: "large same-size files require manual review" };
        } else {
          const same = await this.hasSameContent(path, localItem, context.remote[path]);
          entry = same
            ? { path, action: "adopt", reason: "same content verified during first scan" }
            : { path, action: "conflict", reason: "different content verified during first scan" };
        }
      }
      entries.push(entry);
      stats[entry.action] = (stats[entry.action] || 0) + 1;
    }
    const moveAwareEntries = await this.detectMoveEntries(entries, context);
    const timestampAwareEntries = await this.bypassBulkTimestampUpdate(moveAwareEntries, context);
    return { entries: timestampAwareEntries, stats: statsFromEntries(timestampAwareEntries) };
  }

  async bypassBulkTimestampUpdate(entries, context) {
    const bySlot = new Map();
    for (const entry of entries) {
      if (entry.action !== "upload" && entry.action !== "conflict") {
        continue;
      }
      if (!this.isBulkTimestampCandidate(entry, context)) {
        continue;
      }
      const localItem = context.local[entry.path];
      const slot = Math.floor(localItem.mtime / BULK_TIMESTAMP_SLOT_MS);
      const slotEntries = bySlot.get(slot) || [];
      slotEntries.push(entry.path);
      bySlot.set(slot, slotEntries);
    }

    const replacementsByPath = new Map();
    for (const [slot, paths] of bySlot.entries()) {
      if (paths.length < BULK_TIMESTAMP_MIN_FILES) {
        continue;
      }
      const slotStart = new Date(slot * BULK_TIMESTAMP_SLOT_MS).toISOString();
      for (const path of paths) {
        const localItem = context.local[path];
        if (Number(localItem && localItem.size || 0) > LOCAL_HASH_MAX_BYTES) {
          replacementsByPath.set(path, {
            action: "conflict",
            reason: `large bulk timestamp candidate requires manual review (${paths.length} files around ${slotStart})`
          });
        } else if (await this.hasSameContent(path, localItem, context.remote[path])) {
          replacementsByPath.set(path, {
            action: "adopt",
            reason: `bulk timestamp-only update content verified (${paths.length} files around ${slotStart})`
          });
        }
      }
    }
    if (!replacementsByPath.size) {
      return entries;
    }
    return entries.map((entry) => {
      const replacement = replacementsByPath.get(entry.path);
      return replacement ? Object.assign({}, entry, replacement) : entry;
    });
  }

  isBulkTimestampCandidate(entry, context) {
    const localItem = context.local[entry.path];
    const remoteItem = context.remote[entry.path];
    const previous = context.snapshot[entry.path];
    if (!localItem || !remoteItem || !previous || !previous.local || !previous.remote) {
      return false;
    }
    if (localItem.size !== remoteItem.size ||
        localItem.size !== previous.local.size ||
        localItem.size !== previous.remote.size) {
      return false;
    }
    if (!sameRemoteContent(previous.remote, remoteItem)) {
      return false;
    }
    if (previous.local.sha256 && localItem.sha256 && previous.local.sha256 !== localItem.sha256) {
      return false;
    }
    return Math.abs(previous.local.mtime - localItem.mtime) >= 2000;
  }

  async detectMoveEntries(entries, context) {
    if (this.settings.syncMode === "pull" || !this.settings.syncDeletes) {
      return entries;
    }
    const uploadCandidates = entries.filter((entry) => {
      return entry.action === "upload" && context.local[entry.path] && !context.remote[entry.path];
    });
    const deleteCandidates = entries.filter((entry) => {
      const previous = context.snapshot[entry.path];
      return entry.action === "deleteRemote" &&
        context.remote[entry.path] &&
        previous &&
        previous.local &&
        previous.remote;
    });
    if (!uploadCandidates.length || !deleteCandidates.length) {
      return entries;
    }

    const oldBySignature = new Map();
    const ambiguousSignatures = new Set();
    for (const entry of deleteCandidates) {
      const previous = context.snapshot[entry.path];
      const signature = moveSignatureFromSnapshot(previous);
      if (!signature) {
        continue;
      }
      if (oldBySignature.has(signature)) {
        ambiguousSignatures.add(signature);
        oldBySignature.delete(signature);
        continue;
      }
      oldBySignature.set(signature, entry);
    }

    const usedOldPaths = new Set();
    const movesByNewPath = new Map();
    for (const entry of uploadCandidates) {
      const signature = await this.moveSignatureForLocal(entry.path, context.local[entry.path], oldBySignature);
      if (!signature || ambiguousSignatures.has(signature)) {
        continue;
      }
      const oldEntry = oldBySignature.get(signature);
      if (!oldEntry || usedOldPaths.has(oldEntry.path)) {
        continue;
      }
      usedOldPaths.add(oldEntry.path);
      movesByNewPath.set(entry.path, {
        path: entry.path,
        fromPath: oldEntry.path,
        action: "moveRemote",
        reason: `local move detected from ${oldEntry.path}`
      });
    }
    if (!movesByNewPath.size) {
      return entries;
    }
    return entries
      .filter((entry) => !usedOldPaths.has(entry.path))
      .map((entry) => movesByNewPath.get(entry.path) || entry);
  }

  async moveSignatureForLocal(path, localItem, oldBySignature) {
    if (!localItem) {
      return "";
    }
    if (localItem.sha256) {
      const signature = `sha256:${localItem.size}:${localItem.sha256}`;
      if (oldBySignature.has(signature)) {
        return signature;
      }
    }
    const hasMd5Candidate = Array.from(oldBySignature.keys()).some((signature) => {
      return signature.startsWith(`md5:${localItem.size}:`);
    });
    if (!hasMd5Candidate) {
      return "";
    }
    const md5 = await this.localMd5ByPath(path);
    const signature = `md5:${localItem.size}:${md5}`;
    return oldBySignature.has(signature) ? signature : "";
  }

  planPath(path, context) {
    if (this.isExcluded(path)) {
      return { path, action: "skip", reason: "excluded" };
    }
    const localItem = context.local[path];
    const remoteItem = context.remote[path];
    const previous = context.snapshot[path];
    const remoteDeleted = context.remoteDeleted && context.remoteDeleted[path];

    if (!localItem && !remoteItem) {
      return { path, action: "skip", reason: "missing on both sides" };
    }
    const localChanged = localItem ? !previous || !sameLocal(previous.local, localItem) : Boolean(previous && previous.local);
    const remoteChanged = remoteItem ? !previous || !sameRemote(previous.remote, remoteItem) : Boolean(previous && previous.remote);

    if (localItem && !remoteItem && this.settings.syncDeletes && this.settings.syncMode !== "push") {
      if (remoteDeleted && this.remoteDeleteTombstoneIsFresh(remoteDeleted)) {
        if (this.localChangedAfterRemoteDeletion(localItem, remoteDeleted)) {
          return { path, action: "skip", reason: "local changed after remote deletion tombstone; manual review required" };
        }
        return { path, action: "deleteLocal", reason: "remote deletion tombstone detected" };
      }
      if (this.settings.syncMode === "pull") {
        return { path, action: "skip", reason: "pull mode remote missing without a trusted deletion tombstone" };
      }
      if (previous && previous.remote && (this.settings.syncMode === "pull" || !localChanged)) {
        return { path, action: "skip", reason: "remote missing without deletion tombstone; kept local for manual review" };
      }
    }
    if (!localItem && remoteItem && previous && previous.local && this.settings.syncDeletes && this.settings.syncMode !== "pull") {
      if (this.remoteSnapshotNewerThanLocalSync(context)) {
        return { path, action: "download", reason: "remote snapshot is newer than this device; local deletion not trusted" };
      }
      if (this.settings.syncMode === "push" || !remoteChanged) {
        return { path, action: "deleteRemote", reason: "local deletion detected" };
      }
    }
    if (localItem && localItem.size > this.maxFileSizeBytes()) {
      return { path, action: "skip", reason: `local file exceeds ${this.settings.maxFileSizeMb} MB` };
    }
    if (remoteItem && remoteItem.size > this.maxFileSizeBytes()) {
      return { path, action: "skip", reason: `remote file exceeds ${this.settings.maxFileSizeMb} MB` };
    }

    if (this.settings.syncMode === "push") {
      return this.planPushOnly(path, localItem, remoteItem, previous, localChanged);
    }
    if (this.settings.syncMode === "pull") {
      return this.planPullOnly(path, localItem, remoteItem, previous, remoteChanged);
    }

    if (localItem && !remoteItem) {
      if (previous && previous.remote && this.settings.syncDeletes && !localChanged) {
        return { path, action: "skip", reason: "remote missing without deletion tombstone; kept local for manual review" };
      }
      return { path, action: "upload", reason: "local only" };
    }
    if (!localItem && remoteItem) {
      if (previous && previous.local && this.settings.syncDeletes && !remoteChanged) {
        if (this.remoteSnapshotNewerThanLocalSync(context)) {
          return { path, action: "download", reason: "remote snapshot is newer than this device; local deletion not trusted" };
        }
        return { path, action: "deleteRemote", reason: "local deletion detected" };
      }
      return { path, action: "download", reason: "remote only" };
    }
    if (!previous && localItem && remoteItem) {
      if (sameSize(localItem, remoteItem)) {
        return { path, action: "conflict", reason: "same-size files on both sides require content verification" };
      }
      return { path, action: "conflict", reason: "different files on first scan" };
    }
    if (!localChanged && !remoteChanged) {
      return { path, action: "skip", reason: "unchanged" };
    }
    if (localChanged && remoteChanged) {
      return { path, action: "conflict", reason: "changed on both sides" };
    }
    if (remoteChanged) {
      return { path, action: "download", reason: "remote changed" };
    }
    return { path, action: "upload", reason: "local changed" };
  }

  planPushOnly(path, localItem, remoteItem, previous, localChanged) {
    if (!localItem && remoteItem) {
      if (previous && previous.local && this.settings.syncDeletes) {
        return { path, action: "deleteRemote", reason: "push mode local deletion" };
      }
      return { path, action: "skip", reason: "push mode ignores remote-only file" };
    }
    if (localItem && !remoteItem) {
      return { path, action: "upload", reason: "push mode local only" };
    }
    if (!localChanged) {
      return { path, action: "adopt", reason: "push mode unchanged" };
    }
    return { path, action: "upload", reason: "push mode local changed" };
  }

  planPullOnly(path, localItem, remoteItem, previous, remoteChanged) {
    if (localItem && !remoteItem) {
      if (previous && previous.remote && this.settings.syncDeletes) {
        return { path, action: "skip", reason: "pull mode remote missing without a trusted deletion tombstone" };
      }
      return { path, action: "skip", reason: "pull mode ignores local-only file" };
    }
    if (!localItem && remoteItem) {
      return { path, action: "download", reason: "pull mode remote only" };
    }
    if (!remoteChanged) {
      return { path, action: "adopt", reason: "pull mode unchanged" };
    }
    return { path, action: "download", reason: "pull mode remote changed" };
  }

  assertRealSyncAllowed(context, plan) {
    const snapshotEmpty = Object.keys(context.snapshot).length === 0;
    const hasLocal = Object.keys(context.local).length > 0;
    const hasRemote = Object.keys(context.remote).length > 0;
    if (this.settings.safeInitialSync && snapshotEmpty && hasLocal && hasRemote) {
      if (!this.settings.allowFirstRealSync || this.settings.approvedFirstSyncDigest !== context.planDigest) {
        throw new Error("First real sync is protected. Run Preview, then approve that exact plan with 'Allow first real sync once'.");
      }
    }
    const dangerousDeletes = plan.entries.filter((entry) => entry.action === "deleteLocal" || entry.action === "deleteRemote");
    if (dangerousDeletes.length && !this.settings.syncDeletes) {
      throw new Error("Delete actions were planned while delete sync is disabled.");
    }
    if (dangerousDeletes.length) {
      const totalKnown = Math.max(1, Object.keys(context.snapshot).length, Object.keys(context.local).length, Object.keys(context.remote).length);
      const deleteRatio = dangerousDeletes.length / totalKnown;
      const unexpectedlyEmpty = Object.keys(context.snapshot).length > 0 &&
        (Object.keys(context.local).length === 0 || Object.keys(context.remote).length === 0);
      const largeDelete = dangerousDeletes.length >= 10 || deleteRatio >= 0.2 || unexpectedlyEmpty;
      if (largeDelete && (!this.settings.allowLargeDeleteOnce || this.settings.approvedDeletePlanDigest !== context.planDigest)) {
        throw new Error(`Large delete safeguard: ${dangerousDeletes.length} delete(s) require Preview and approval for this exact plan.`);
      }
    }
    if (!snapshotEmpty) {
      const changedFiles = plan.entries.filter((e) => e.action !== "skip" && e.action !== "adopt").length;
      const totalLocalFiles = Object.keys(context.local).length;
      const threshold = this.protectModifyRatio();
      if (threshold >= 0 && threshold < 1 && totalLocalFiles > 20 && changedFiles / totalLocalFiles > threshold) {
        throw new Error(`Safeguard triggered: too many files would change (${changedFiles}/${totalLocalFiles}, ${Math.round((changedFiles / totalLocalFiles) * 100)}%). Increase Protect modify percentage only after Preview looks correct.`);
      }
    }
  }

  protectModifyRatio() {
    const value = Number(this.settings.protectModifyPercentage);
    if (!Number.isFinite(value)) {
      return DEFAULT_SETTINGS.protectModifyPercentage / 100;
    }
    return Math.max(0, Math.min(100, value)) / 100;
  }

  newUploadParentPathCounts(plan, context) {
    const counts = {};
    for (const entry of plan.entries || []) {
      if (entry.action !== "upload" || context.remote[entry.path]) {
        continue;
      }
      const parent = parentPath(entry.path);
      counts[parent] = (counts[parent] || 0) + 1;
    }
    return counts;
  }

  shouldUseDuplicateGuard(context, entry, existingRemote) {
    if (existingRemote || !entry || entry.action !== "upload") {
      return false;
    }
    const mode = this.settings.duplicateGuardMode || DEFAULT_SETTINGS.duplicateGuardMode;
    if (mode === "off") {
      return false;
    }
    return true;
  }

  shouldRefreshDuplicateGuardPreflight() {
    return (this.settings.duplicateGuardMode || DEFAULT_SETTINGS.duplicateGuardMode) === "strict";
  }

  shouldUseExactNameDuplicateGuard(context, entry, existingRemote) {
    if (existingRemote || !entry || entry.action !== "upload") {
      return false;
    }
    const mode = this.settings.duplicateGuardMode || DEFAULT_SETTINGS.duplicateGuardMode;
    if (mode !== "auto") {
      return false;
    }
    const parent = parentPath(entry.path);
    const parentCounts = context.newUploadParentPathCounts || {};
    return Number(parentCounts[parent] || 1) <= 1;
  }

  duplicateGuardFolderPathSet() {
    return new Set(String(this.settings.duplicateGuardFolderPaths || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean));
  }

  rememberDuplicateGuardFolder(folderPath) {
    const normalized = folderPath || "/";
    const paths = this.duplicateGuardFolderPathSet();
    paths.add(normalized);
    this.settings.duplicateGuardFolderPaths = Array.from(paths).sort().join("\n");
  }

  async executePlan(context, plan, runId, options = {}) {
    const nextSnapshot = Object.assign({}, context.snapshot);
    const stats = newEmptyStats();
    const errors = [];
    const skippedChanged = [];
    const skippedSafe = [];
    const remoteSnapshotUpdates = {};
    const remoteMutations = {};
    const remoteDeleted = {};
    const reviewItems = [];
    const skipDonePaths = options.skipDonePaths || new Set();
    let processed = 0;
    let processedBytes = 0;
    const orderedEntries = this.orderPlanEntries(plan.entries);
    const totalBytes = orderedEntries.reduce((sum, entry) => {
      return sum + this.progressBytesForEntry(entry, context);
    }, 0);
    for (const entry of orderedEntries) {
      if (skipDonePaths.has(entry.path)) {
        const localItem = context.local[entry.path];
        const remoteItem = context.remote[entry.path];
        if (await this.hasSameContent(entry.path, localItem, remoteItem)) {
          nextSnapshot[entry.path] = this.snapshotFrom(localItem, remoteItem);
          stats.adopt++;
          await this.updateOperation(runId, entry, "skipped", context, new Error("Previous operation result was reverified and adopted."));
          continue;
        }
      }
      processed++;
      this.updateSyncProgress({
        phase: "Sync",
        current: processedBytes,
        total: totalBytes,
        unit: "bytes",
        action: entry.action,
        path: entry.path
      });
      const entryBytes = this.progressBytesForEntry(entry, context);
      try {
        await this.updateOperation(runId, entry, "in_progress", context);
        await this.executeEntry(entry, context, nextSnapshot, stats, remoteDeleted, remoteMutations, reviewItems, runId);
        await this.updateOperation(runId, entry, "done", context, null, {
          phase: "remote_verified",
          remoteResult: Object.prototype.hasOwnProperty.call(remoteMutations, entry.path)
            ? remoteMutations[entry.path]
            : undefined
        });
      } catch (err) {
        if (this.shouldSkipChangedDuringSync(err)) {
          skippedChanged.push(this.skipRecord(entry, err));
          this.recordRemoteSnapshotUpdate(remoteSnapshotUpdates, entry, err);
          stats.skip++;
          await this.updateOperation(runId, entry, "skipped", context, err);
          continue;
        }
        if (this.shouldSkipSafeConflict(err)) {
          skippedSafe.push(this.skipRecord(entry, err));
          stats.skip++;
          await this.updateOperation(runId, entry, "skipped", context, err);
          continue;
        }
        const error = this.errorRecord(entry, err);
        errors.push(error);
        stats.error++;
        await this.updateOperation(runId, entry, "failed", context, err);
        if (stats.error <= 3) {
          new Notice(`DriveBridge error: ${error.action} ${error.path}: ${error.message}`, 10000);
        } else if (stats.error === 4) {
          new Notice(`More DriveBridge errors occurred. See developer console for details.`, 10000);
        }
        this.showProgressModal(this.formatErrorModalMessage(`DriveBridge sync error ${stats.error}. Continuing...`, [error]), {
          current: processedBytes,
          total: totalBytes,
          unit: "bytes"
        });
        console.error("[drivebridge-obsidian-sync]", entry, err);
      } finally {
        processedBytes += entryBytes;
        this.updateSyncProgress({
          phase: "Sync",
          current: processedBytes,
          total: totalBytes,
          unit: "bytes",
          action: entry.action,
          path: entry.path
        });
      }
    }
    await this.verifyCreatedUploadDuplicates(context, orderedEntries, nextSnapshot, remoteMutations, runId);
    await this.flushOperationJournal(true);
    return { nextSnapshot, stats, errors, skippedChanged, skippedSafe, remoteDeleted, remoteSnapshotUpdates, remoteMutations, reviewItems, processed, total: orderedEntries.length, processedBytes, totalBytes };
  }

  recordRemoteSnapshotUpdate(remoteSnapshotUpdates, entry, err) {
    if (!entry || !err || !err.hasCurrentRemote) {
      return;
    }
    remoteSnapshotUpdates[entry.path] = err.currentRemote || null;
  }

  progressBytesForEntry(entry, context) {
    if (!entry || entry.action === "skip" || entry.action === "adopt") {
      return 0;
    }
    const localItem = context.local[entry.path];
    const remoteItem = context.remote[entry.path];
    if (entry.action === "upload") {
      return localItem && localItem.size ? localItem.size : 0;
    }
    if (entry.action === "download") {
      return remoteItem && remoteItem.size ? remoteItem.size : 0;
    }
    if (entry.action === "deleteRemote") {
      return remoteItem && remoteItem.size ? remoteItem.size : 0;
    }
    if (entry.action === "deleteLocal") {
      return localItem && localItem.size ? localItem.size : 0;
    }
    if (entry.action === "moveRemote") {
      return 0;
    }
    if (entry.action === "conflict") {
      return (localItem && localItem.size ? localItem.size : 0) +
        (remoteItem && remoteItem.size ? remoteItem.size : 0);
    }
    return Math.max(
      localItem && localItem.size ? localItem.size : 0,
      remoteItem && remoteItem.size ? remoteItem.size : 0
    );
  }

  orderPlanEntries(entries) {
    const weight = {
      skip: 0,
      adopt: 0,
      upload: 1,
      download: 1,
      moveRemote: 1,
      conflict: 1,
      deleteRemote: 2,
      deleteLocal: 2
    };
    return entries.slice().sort((a, b) => {
      const aw = weight[a.action] === undefined ? 1 : weight[a.action];
      const bw = weight[b.action] === undefined ? 1 : weight[b.action];
      if (aw !== bw) {
        return aw - bw;
      }
      if (a.action === "deleteLocal" || a.action === "deleteRemote") {
        return b.path.length - a.path.length;
      }
      return a.path.localeCompare(b.path);
    });
  }

  async executeEntry(entry, context, nextSnapshot, stats, remoteDeleted, remoteMutations, reviewItems, runId = "") {
    const path = entry.path;
    const localItem = context.local[path];
    const remoteItem = context.remote[path];
    if (entry.action === "skip") {
      if (entry.reason === "missing on both sides") {
        delete nextSnapshot[path];
      }
      stats.skip++;
      return;
    }
    if (entry.action === "adopt") {
      nextSnapshot[path] = this.snapshotFrom(localItem, remoteItem);
      stats.adopt++;
      return;
    }
    const canVerifyContentCheaply = Math.max(
      Number(localItem && localItem.size || 0),
      Number(remoteItem && remoteItem.size || 0)
    ) <= LOCAL_HASH_MAX_BYTES;
    if (canVerifyContentCheaply &&
        (entry.action === "upload" || entry.action === "download" || entry.action === "conflict") &&
        await this.hasSameContent(path, localItem, remoteItem)) {
      const currentLocal = await this.localInfoByPath(path);
      nextSnapshot[path] = this.snapshotFrom(currentLocal, remoteItem);
      stats.adopt++;
      return;
    }
    if (entry.action === "upload") {
      await this.assertLocalUnchangedSincePlan(path, localItem);
      if (remoteItem) {
        await this.assertRemoteContentUnchangedSincePlan(path, remoteItem);
      }
      const uploadStartLocal = await this.localInfoByPath(path);
      const uploaded = await this.uploadLocalFile(path, context.rootFolderId, remoteItem, {
        duplicateGuard: this.shouldUseDuplicateGuard(context, entry, remoteItem),
        duplicateGuardRefresh: this.shouldRefreshDuplicateGuardPreflight(),
        duplicateGuardExactName: this.shouldUseExactNameDuplicateGuard(context, entry, remoteItem),
        reservedRemoteId: this.reservedRemoteIdForOperation(runId, path),
        operationId: this.operationIdForPath(runId, path),
        runId,
        onPrepared: async (prepared) => {
          await this.updateOperation(runId, entry, "in_progress", context, null, Object.assign({
            phase: "request_sent"
          }, prepared));
        }
      });
      const localAfter = await this.localInfoByPath(path);
      if (!sameLocalStrict(uploadStartLocal, localAfter)) {
        throw this.changedDuringSyncError(
          `Local file changed while upload was running: ${path}`,
          "local",
          "remote upload completed, but local content must be replanned",
          uploaded
        );
      }
      nextSnapshot[path] = this.snapshotFrom(localAfter, uploaded);
      remoteMutations[path] = uploaded;
      stats.upload++;
      return;
    }
    if (entry.action === "download") {
      await this.assertLocalUnchangedSincePlan(path, localItem);
      const currentRemote = await this.assertRemoteContentUnchangedSincePlan(path, remoteItem);
      const remoteToDownload = currentRemote || remoteItem;
      await this.downloadRemoteFile(path, remoteToDownload, { plannedLocal: localItem });
      const refreshedLocal = await this.localInfoByPath(path);
      if (!(await this.hasSameContent(path, refreshedLocal, remoteToDownload))) {
        throw this.changedDuringSyncError(`Downloaded file changed before verification completed: ${path}`, "local");
      }
      nextSnapshot[path] = this.snapshotFrom(refreshedLocal, remoteToDownload);
      stats.download++;
      return;
    }
    if (entry.action === "conflict") {
      await this.assertLocalUnchangedSincePlan(path, localItem);
      await this.assertRemoteUnchangedSincePlan(path, remoteItem);
      if ((this.settings.conflictAction || DEFAULT_SETTINGS.conflictAction) === "manualReview") {
        reviewItems.push(this.reviewItemFrom(entry, localItem, remoteItem));
        stats.review++;
        return;
      }
      this.assertSafeConflictAutoResolve(path, localItem, remoteItem);
      const resolved = await this.resolveConflict(path, localItem, remoteItem, context.rootFolderId);
      nextSnapshot[path] = resolved;
      if (resolved.remote) {
        remoteMutations[path] = resolved.remote;
      }
      stats.conflict++;
      return;
    }
    if (entry.action === "moveRemote") {
      const oldPath = entry.fromPath;
      const oldRemoteItem = context.remote[oldPath];
      await this.assertLocalUnchangedSincePlan(path, localItem);
      const currentRemote = await this.assertRemoteContentUnchangedSincePlan(oldPath, oldRemoteItem);
      const movedRemote = await this.moveRemoteFile(oldPath, path, currentRemote || oldRemoteItem, context.rootFolderId);
      const currentLocal = await this.localInfoByPath(path);
      delete nextSnapshot[oldPath];
      nextSnapshot[path] = this.snapshotFrom(currentLocal, movedRemote);
      remoteMutations[oldPath] = null;
      remoteMutations[path] = movedRemote;
      stats.moveRemote++;
      return;
    }
    if (entry.action === "deleteLocal") {
      await this.assertLocalUnchangedSincePlan(path, localItem, true);
      await this.assertRemoteUnchangedSincePlan(path, remoteItem);
      await this.deleteLocal(path);
      delete nextSnapshot[path];
      stats.deleteLocal++;
      return;
    }
    if (entry.action === "deleteRemote") {
      await this.assertLocalUnchangedSincePlan(path, localItem);
      const deletedRemote = await this.assertRemoteContentUnchangedSincePlan(path, remoteItem);
      if (!deletedRemote) {
        throw this.changedDuringSyncError(`Google Drive file disappeared before delete: ${path}`, "remote", "delete was not applied", null);
      }
      await this.trashRemote(deletedRemote.id);
      delete nextSnapshot[path];
      remoteMutations[path] = null;
      remoteDeleted[path] = this.remoteDeleteTombstone(deletedRemote || remoteItem);
      stats.deleteRemote++;
      return;
    }
  }

  assertSafeConflictAutoResolve(path, localItem, remoteItem) {
    const size = Math.max(
      localItem && localItem.size ? localItem.size : 0,
      remoteItem && remoteItem.size ? remoteItem.size : 0
    );
    if (size >= LARGE_BINARY_CONFLICT_BYTES && isLargeBinaryPath(path)) {
      const error = new Error(`Large binary conflict skipped for manual review: ${path} (${formatBytes(size)})`);
      error.code = "DRIVEBRIDGE_SAFE_CONFLICT_SKIP";
      error.side = "conflict";
      throw error;
    }
  }

  async resolveConflict(path, localItem, remoteItem, rootFolderId) {
    const action = this.settings.conflictAction || DEFAULT_SETTINGS.conflictAction;
    if (action === "keepLocalWithBackup") {
      await this.writeConflictCopy(path, remoteItem);
      const uploaded = await this.uploadLocalFile(path, rootFolderId, remoteItem);
      return this.snapshotFrom(localItem, uploaded);
    }
    if (action === "keepRemoteWithBackup") {
      await this.renameLocalToConflict(path);
      await this.downloadRemoteFile(path, remoteItem);
      const refreshedLocal = await this.localInfoByPath(path);
      return this.snapshotFrom(refreshedLocal, remoteItem);
    }
    if (action === "keepBothLocalWins") {
      await this.writeConflictCopy(path, remoteItem);
      const uploaded = await this.uploadLocalFile(path, rootFolderId, remoteItem);
      return this.snapshotFrom(localItem, uploaded);
    }

    const localMtime = localItem && localItem.mtime ? localItem.mtime : 0;
    const remoteMtime = remoteItem && remoteItem.modifiedTime ? new Date(remoteItem.modifiedTime).getTime() : 0;
    if (localMtime >= remoteMtime) {
      await this.writeConflictCopy(path, remoteItem);
      const uploaded = await this.uploadLocalFile(path, rootFolderId, remoteItem);
      return this.snapshotFrom(localItem, uploaded);
    }
    await this.renameLocalToConflict(path);
    await this.downloadRemoteFile(path, remoteItem);
    const refreshedLocal = await this.localInfoByPath(path);
    return this.snapshotFrom(refreshedLocal, remoteItem);
  }

  async ensureAccessToken() {
    this.requireClientId();
    if (this.settings.accessToken && Date.now() < this.settings.tokenExpiresAt) {
      return this.settings.accessToken;
    }
    if (!this.settings.refreshToken) {
      throw new Error("Authorize Google Drive first.");
    }
    const body = new URLSearchParams({
      client_id: this.settings.clientId,
      refresh_token: this.settings.refreshToken,
      grant_type: "refresh_token"
    });
    if (this.settings.clientSecret) {
      body.set("client_secret", this.settings.clientSecret);
    }
    const data = await parseJsonResponse(await customFetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    }));
    this.settings.accessToken = data.access_token;
    this.settings.tokenExpiresAt = Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000;
    await this.saveSettings();
    return this.settings.accessToken;
  }

  requireClientId() {
    if (!this.settings.clientId.trim()) {
      throw new Error("Google OAuth Client ID is required.");
    }
  }

  async driveFetch(url, options = {}, attempt = 1) {
    await this.ensureAccessToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${this.settings.accessToken}`);
    const method = String(options.method || "GET").toUpperCase();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method) &&
        (url.startsWith(DRIVE_API) || url.startsWith(DRIVE_UPLOAD_API))) {
      this.assertCurrentRuntime();
    }
    const retrySafe = method !== "POST";
    let res;
    try {
      if (this.syncMetrics) {
        this.syncMetrics.driveRequests++;
      }
      res = await customFetch(url, Object.assign({}, options, { headers }));
    } catch (cause) {
      if (retrySafe && attempt < MAX_RETRY_ATTEMPTS) {
        await sleep(this.retryDelayMs(attempt));
        return this.driveFetch(url, options, attempt + 1);
      }
      const error = new Error(`Google Drive network request failed (${method}): ${cause && cause.message ? cause.message : String(cause)}`);
      error.code = "DRIVEBRIDGE_NETWORK_ERROR";
      error.method = method;
      error.cause = cause;
      throw error;
    }
    if (res.status === 401 && this.settings.refreshToken && attempt === 1) {
      this.settings.tokenExpiresAt = 0;
      await this.ensureAccessToken();
      return this.driveFetch(url, options, attempt + 1);
    }
    if (retrySafe && RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRY_ATTEMPTS) {
      await sleep(this.retryDelayMs(attempt));
      return this.driveFetch(url, options, attempt + 1);
    }
    return res;
  }

  retryDelayMs(attempt) {
    const base = 500 * Math.pow(2, Math.max(0, attempt - 1));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  async ensureRootFolder() {
    if (this.settings.rootFolderId) {
      return this.settings.rootFolderId;
    }
    const name = this.settings.rootFolderName.trim() || DEFAULT_SETTINGS.rootFolderName;
    const escaped = escapeDriveQuery(name);
    const params = new URLSearchParams({
      q: `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id,name)",
      spaces: "drive"
    });
    const list = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
    if (list.files && list.files.length) {
      if (list.files.length > 1) {
        throw new Error(`Multiple Google Drive folders named "${name}" are visible. Set Root folder ID manually or rename duplicates.`);
      }
      this.settings.rootFolderId = list.files[0].id;
      this.settings.duplicateGuardRootChanged = true;
      await this.saveSettings();
      return this.settings.rootFolderId;
    }
    let created;
    try {
      created = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?fields=id,name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: "application/vnd.google-apps.folder"
        })
      }));
    } catch (err) {
      if (!this.isAmbiguousCreateError(err)) {
        throw err;
      }
      const reconciled = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
      if (!reconciled.files || reconciled.files.length !== 1) {
        throw err;
      }
      created = reconciled.files[0];
    }
    this.settings.rootFolderId = created.id;
    this.settings.duplicateGuardRootChanged = true;
    await this.saveSettings();
    return created.id;
  }

  async scanLocalVault() {
    const result = {};
    for (const file of this.app.vault.getFiles()) {
      if (!this.isExcluded(file.path)) {
        result[file.path] = await this.localInfo(file);
      }
    }
    if (this.settings.obsidianSyncMode === "safe") {
      await this.scanAdapterFolder(this.app.vault.configDir || ".obsidian", result);
    }
    return result;
  }

  async scanAdapterFolder(folderPath, result) {
    if (!(await this.app.vault.adapter.exists(folderPath))) {
      return;
    }
    const listing = await this.app.vault.adapter.list(folderPath);
    for (const filePath of listing.files || []) {
      if (!this.isExcluded(filePath)) {
        result[filePath] = await this.localInfoByPath(filePath);
      }
    }
    for (const childFolder of listing.folders || []) {
      if (this.shouldScanLocalFolder(childFolder)) {
        await this.scanAdapterFolder(childFolder, result);
      }
    }
  }

  async scanRemoteVault(rootFolderId) {
    const snapshotState = await this.loadRemoteSnapshotFile(rootFolderId);
    if (snapshotState) {
      return snapshotState;
    }
    const result = {};
    await this.scanRemoteFolder(rootFolderId, "", result);
    return { files: result, deleted: {}, snapshotAt: 0, fromFullScan: true, snapshotMissing: true };
  }

  async loadRemoteSnapshotFile(rootFolderId) {
    try {
      const params = new URLSearchParams({
        q: `'${rootFolderId}' in parents and name='${REMOTE_SNAPSHOT_FILE}' and trashed=false`,
        fields: "files(id,modifiedTime)",
        orderBy: "modifiedTime desc",
        spaces: "drive"
      });
      const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
      if (data.files && data.files.length > 0) {
        const snapId = data.files[0].id;
        const res = await this.driveFetch(`${DRIVE_API}/files/${snapId}?alt=media`);
        if (res.ok) {
          const content = await res.text();
          const parsed = JSON.parse(content);
          const protocolVersion = Number(parsed && parsed.version || 1);
          if (protocolVersion > 2) {
            const error = new Error(`Unsupported ${REMOTE_SNAPSHOT_FILE} protocol version ${protocolVersion}. Update DriveBridge before syncing.`);
            error.code = "DRIVEBRIDGE_REMOTE_SNAPSHOT_VERSION";
            throw error;
          }
          if (Number(this.settings.remoteSnapshotProtocolVersion || 0) >= 2 && protocolVersion < 2) {
            const error = new Error(`${REMOTE_SNAPSHOT_FILE} was downgraded by an older DriveBridge device. Update all devices, then rebuild the remote snapshot.`);
            error.code = "DRIVEBRIDGE_REMOTE_SNAPSHOT_DOWNGRADE";
            throw error;
          }
          if (protocolVersion >= 2 && Number(this.settings.remoteSnapshotProtocolVersion || 0) < 2) {
            this.settings.remoteSnapshotProtocolVersion = 2;
            await this.saveSettings();
          }
          this.settings.lastRemoteSnapshotAt = Date.parse(data.files[0].modifiedTime || "") || Date.now();
          const normalized = normalizeRemoteState(parsed);
          normalized.snapshotAt = Date.parse(parsed && parsed.generatedAt || "") ||
            Date.parse(data.files[0].modifiedTime || "") ||
            0;
          normalized.snapshotFileId = snapId;
          normalized.snapshotModifiedTime = data.files[0].modifiedTime || "";
          normalized.snapshotCommitId = parsed && parsed.commitId || "";
          normalized.fromFullScan = false;
          normalized.snapshotMissing = false;
          return normalized;
        }
      }
    } catch (err) {
      if (err && (err.code === "DRIVEBRIDGE_REMOTE_SNAPSHOT_VERSION" ||
          err.code === "DRIVEBRIDGE_REMOTE_SNAPSHOT_DOWNGRADE")) {
        throw err;
      }
      console.warn(`[drivebridge-obsidian-sync] Failed to load ${REMOTE_SNAPSHOT_FILE}, falling back to full scan`, err);
    }
    return null;
  }

  remoteSnapshotNewerThanLocalSync(context) {
    const remoteSnapshotAt = Number(context && context.remoteSnapshotAt || 0);
    const lastSyncAt = Number(this.settings.lastSyncAt || 0);
    return remoteSnapshotAt > 0 && lastSyncAt > 0 && remoteSnapshotAt > lastSyncAt + 2000;
  }

  async scanRemoteFolder(folderId, prefix, result, options = {}) {
    let pageToken = "";
    const seenNames = new Map();
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,parents,appProperties)",
        pageSize: "1000",
        spaces: "drive"
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
      for (const file of data.files || []) {
        assertSafeRemoteName(file.name);
        if (file.name === REMOTE_SNAPSHOT_FILE && !prefix) {
          continue;
        }
        if (seenNames.has(file.name)) {
          const folderPath = prefix || "/";
          if (!options.continueOnDuplicate) {
            throw new Error(`Duplicate Google Drive item name "${file.name}" under "${folderPath}". Rename duplicates before syncing.`);
          }
          const previous = seenNames.get(file.name);
          let group = (options.duplicateGroups || []).find((item) => item.parentId === folderId && item.name === file.name);
          if (!group) {
            group = { parentId: folderId, name: file.name, path: prefix ? `${prefix}/${file.name}` : file.name, mimeType: file.mimeType, candidates: [previous] };
            options.duplicateGroups.push(group);
          }
          group.candidates.push(file);
          continue;
        }
        seenNames.set(file.name, file);
        const path = prefix ? `${prefix}/${file.name}` : file.name;
        if (file.mimeType === "application/vnd.google-apps.folder") {
          if (this.shouldScanRemoteFolder(path)) {
            await this.scanRemoteFolder(file.id, path, result, options);
          }
        } else if (!file.mimeType.startsWith("application/vnd.google-apps.")) {
          if (this.isExcluded(path)) {
            continue;
          }
          if (result[path]) {
            throw new Error(`Duplicate Google Drive path "${path}". Rename duplicates before syncing.`);
          }
          result[path] = remoteInfo(path, Object.assign({}, file, { parentId: folderId }));
        }
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
  }

  async uploadLocalFile(path, rootFolderId, existingRemote, options = {}) {
    if (!(await this.localPathExists(path))) {
      throw new Error(`Local file not found: ${path}`);
    }
    const localItem = await this.localInfoByPath(path);
    const data = await this.readLocalBinary(path);
    const parentId = await this.ensureRemoteParent(path, rootFolderId);
    const metadata = { name: basename(path) };
    if (!existingRemote) {
      if (options.duplicateGuard) {
        if (options.duplicateGuardExactName) {
          await this.ensureNoExactRemoteNameCollision(parentId, metadata.name, parentPath(path));
        } else {
          await this.ensureNoRemoteNameCollision(parentId, metadata.name, parentPath(path), {
            refresh: Boolean(options.duplicateGuardRefresh)
          });
        }
      }
      metadata.parents = [parentId];
      if (options.reservedRemoteId) {
        metadata.id = options.reservedRemoteId;
      }
      if (options.operationId) {
        metadata.appProperties = this.provenanceProperties(options.operationId || "", options.runId || "");
      }
    }
    if (options.onPrepared) {
      await options.onPrepared({
        reservedRemoteId: options.reservedRemoteId || "",
        expectedName: metadata.name,
        expectedParentId: parentId,
        expectedSize: Number(localItem.size || 0)
      });
    }
    const boundary = `drivebridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = makeMultipartBody(boundary, metadata, data, getMimeType(path));
    const url = existingRemote
      ? `${DRIVE_UPLOAD_API}/files/${existingRemote.id}?uploadType=multipart&fields=id,name,size,modifiedTime,md5Checksum`
      : `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,size,modifiedTime,md5Checksum`;
    const request = async () => parseJsonResponse(await this.driveFetch(url, {
      method: existingRemote ? "PATCH" : "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    }));
    let uploaded;
    try {
      uploaded = await request();
    } catch (err) {
      if (existingRemote || !options.reservedRemoteId || !this.isAmbiguousCreateError(err)) {
        throw err;
      }
      const expectedMd5 = md5Hex(data);
      uploaded = await this.reconcileReservedUpload(path, options.reservedRemoteId, {
        name: metadata.name,
        parentId,
        size: Number(localItem.size || 0),
        md5Checksum: expectedMd5
      });
      if (!uploaded && (err.code === "DRIVEBRIDGE_NETWORK_ERROR" || RETRYABLE_STATUS.has(err.status))) {
        try {
          uploaded = await request();
        } catch (retryError) {
          if (!this.isAmbiguousCreateError(retryError)) {
            throw retryError;
          }
          uploaded = await this.reconcileReservedUpload(path, options.reservedRemoteId, {
            name: metadata.name,
            parentId,
            size: Number(localItem.size || 0),
            md5Checksum: expectedMd5
          });
          if (!uploaded) {
            throw retryError;
          }
        }
      }
      if (!uploaded) {
        throw err;
      }
    }
    const result = {
      id: uploaded.id,
      name: uploaded.name || metadata.name,
      path,
      size: Number(uploaded.size || localItem.size),
      modifiedTime: uploaded.modifiedTime,
      md5Checksum: uploaded.md5Checksum || "",
      parentId: existingRemote && existingRemote.parentId ? existingRemote.parentId : parentId
    };
    if (!existingRemote) {
      this.rememberRemoteChild(parentId, result);
    }
    return result;
  }

  isAmbiguousCreateError(err) {
    return Boolean(err && (
      err.code === "DRIVEBRIDGE_NETWORK_ERROR" ||
      err.status === 409 ||
      RETRYABLE_STATUS.has(err.status)
    ));
  }

  async reconcileReservedUpload(path, reservedRemoteId, expected) {
    const remote = await this.remoteInfoById(path, reservedRemoteId);
    if (!remote) {
      return null;
    }
    const matches = remote.name === expected.name &&
      remote.parentId === expected.parentId &&
      Number(remote.size || 0) === Number(expected.size || 0) &&
      Boolean(remote.md5Checksum) &&
      remote.md5Checksum.toLowerCase() === expected.md5Checksum.toLowerCase();
    if (!matches) {
      const error = new Error(`Reserved Google Drive ID exists but does not match the planned upload: ${path}`);
      error.code = "DRIVEBRIDGE_RESERVED_ID_MISMATCH";
      throw error;
    }
    return remote;
  }

  async reserveDriveIds(count) {
    const ids = [];
    let remaining = Math.max(0, Number(count) || 0);
    while (remaining > 0) {
      const batchSize = Math.min(DRIVE_ID_BATCH_SIZE, remaining);
      const params = new URLSearchParams({
        count: String(batchSize),
        space: "drive",
        type: "files"
      });
      const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files/generateIds?${params}`));
      if (this.syncMetrics) {
        this.syncMetrics.idReservationRequests++;
      }
      if (!Array.isArray(data.ids) || data.ids.length !== batchSize) {
        throw new Error(`Google Drive returned ${Array.isArray(data.ids) ? data.ids.length : 0} reserved IDs; expected ${batchSize}.`);
      }
      ids.push(...data.ids);
      remaining -= batchSize;
    }
    return ids;
  }

  async ensureNoExactRemoteNameCollision(parentId, name, folderPath) {
    const files = await this.remoteFilesByExactName(parentId, name);
    if (this.syncMetrics) {
      this.syncMetrics.duplicateGuardPreflightParents++;
    }
    if (files.length) {
      this.rememberDuplicateGuardFolder(folderPath);
      const displayFolder = folderPath || "/";
      throw new Error(`Google Drive item "${name}" already exists under "${displayFolder}". Rename duplicates or rebuild after cleanup before uploading.`);
    }
  }

  async remoteFilesByExactName(parentId, name) {
    const files = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'${parentId}' in parents and name='${escapeDriveQuery(name)}' and trashed=false`,
        fields: "nextPageToken,files(id,name,size,createdTime,modifiedTime,md5Checksum,parents,mimeType)",
        pageSize: "1000",
        spaces: "drive"
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
      for (const file of data.files || []) {
        assertSafeRemoteName(file.name);
        files.push(Object.assign({}, file, {
          parentId: file.parents && file.parents[0] ? file.parents[0] : parentId
        }));
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return files;
  }

  async ensureNoRemoteNameCollision(parentId, name, folderPath, options = {}) {
    const names = await this.remoteChildNames(parentId, folderPath, options);
    if (names.has(name)) {
      this.rememberDuplicateGuardFolder(folderPath);
      const displayFolder = folderPath || "/";
      throw new Error(`Google Drive item "${name}" already exists under "${displayFolder}". Rename duplicates or rebuild after cleanup before uploading.`);
    }
  }

  async remoteChildNames(parentId, folderPath, options = {}) {
    const children = await this.remoteChildren(parentId, folderPath, Object.assign({}, options, {
      purpose: "preflight"
    }));
    const names = new Set();
    for (const file of children) {
      if (names.has(file.name)) {
        this.rememberDuplicateGuardFolder(folderPath);
        const displayFolder = folderPath || "/";
        throw new Error(`Duplicate Google Drive item name "${file.name}" under "${displayFolder}". Rename duplicates before syncing.`);
      }
      names.add(file.name);
    }
    return names;
  }

  async remoteChildren(parentId, folderPath, options = {}) {
    if (!this.remoteChildCache) {
      this.remoteChildCache = new Map();
    }
    if (!options.refresh && this.remoteChildCache.has(parentId)) {
      return this.remoteChildCache.get(parentId);
    }
    const children = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'${parentId}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,size,createdTime,modifiedTime,md5Checksum,parents,mimeType)",
        pageSize: "1000",
        spaces: "drive"
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
      for (const file of data.files || []) {
        assertSafeRemoteName(file.name);
        if (file.name === REMOTE_SNAPSHOT_FILE && !folderPath) {
          continue;
        }
        children.push(Object.assign({}, file, {
          parentId: file.parents && file.parents[0] ? file.parents[0] : parentId
        }));
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    this.remoteChildCache.set(parentId, children);
    if (options.purpose === "preflight" && this.syncMetrics) {
      this.syncMetrics.duplicateGuardPreflightParents++;
    }
    return children;
  }

  rememberRemoteChild(parentId, remoteItem) {
    if (!this.remoteChildCache || !this.remoteChildCache.has(parentId) || !remoteItem) {
      return;
    }
    const children = this.remoteChildCache.get(parentId).filter((file) => file.id !== remoteItem.id);
    children.push(Object.assign({}, remoteItem, {
      name: remoteItem.name || basename(remoteItem.path || ""),
      parentId
    }));
    this.remoteChildCache.set(parentId, children);
  }

  async verifyCreatedUploadDuplicates(context, entries, nextSnapshot, remoteMutations, runId = "") {
    const mode = this.settings.duplicateGuardMode || DEFAULT_SETTINGS.duplicateGuardMode;
    if (mode === "off") {
      return;
    }
    const groups = new Map();
    for (const entry of entries || []) {
      const uploaded = entry && entry.action === "upload" && !context.remote[entry.path]
        ? remoteMutations[entry.path]
        : null;
      if (!uploaded || !uploaded.id || !uploaded.parentId) {
        continue;
      }
      if (!groups.has(uploaded.parentId)) {
        groups.set(uploaded.parentId, []);
      }
      groups.get(uploaded.parentId).push({ entry, uploaded });
    }
    for (const [parentId, uploads] of groups.entries()) {
      const folderPath = parentPath(uploads[0].entry.path);
      if (this.syncMetrics) {
        this.syncMetrics.duplicateGuardPostflightParents++;
      }
      const exactNamePostflight = mode === "auto" && uploads.length === 1;
      let children = exactNamePostflight
        ? await this.remoteFilesByExactName(parentId, basename(uploads[0].entry.path))
        : await this.remoteChildren(parentId, folderPath, { refresh: true, purpose: "postflight" });
      for (const record of uploads) {
        let matches = this.remoteFilesWithName(children, basename(record.entry.path));
        if (!matches.length) {
          await sleep(250);
          children = exactNamePostflight
            ? await this.remoteFilesByExactName(parentId, basename(record.entry.path))
            : await this.remoteChildren(parentId, folderPath, { refresh: true, purpose: "postflight_visibility_retry" });
          matches = this.remoteFilesWithName(children, basename(record.entry.path));
          if (!matches.length) {
            const error = new Error(`The new Google Drive item "${basename(record.entry.path)}" was not visible during duplicate verification. The snapshot was not committed; use Recovery to reverify reserved ID ${record.uploaded.id}.`);
            error.code = "DRIVEBRIDGE_DUPLICATE_POSTFLIGHT_INCONCLUSIVE";
            throw error;
          }
        }
        if (matches.length === 1 && matches[0].id === record.uploaded.id) {
          continue;
        }
        matches = matches.map((file) => file.id === record.uploaded.id
          ? Object.assign({}, file, record.uploaded)
          : file);
        if (!matches.some((file) => file.id === record.uploaded.id)) {
          matches = matches.concat([record.uploaded]);
        }
        const reconciliation = await this.reconcileCreatedUploadDuplicate(
          record.entry.path,
          record.uploaded,
          matches,
          parentId,
          context,
          nextSnapshot,
          remoteMutations,
          runId
        );
        if (reconciliation === "wait") {
          await sleep(250);
          children = exactNamePostflight
            ? await this.remoteFilesByExactName(parentId, basename(record.entry.path))
            : await this.remoteChildren(parentId, folderPath, { refresh: true, purpose: "postflight_retry" });
          matches = this.remoteFilesWithName(children, basename(record.entry.path));
          if (matches.length === 1 && matches[0].id === record.uploaded.id) {
            continue;
          }
          matches = matches.map((file) => file.id === record.uploaded.id
            ? Object.assign({}, file, record.uploaded)
            : file);
          if (!matches.some((file) => file.id === record.uploaded.id)) {
            matches = matches.concat([record.uploaded]);
          }
          await this.reconcileCreatedUploadDuplicate(
            record.entry.path,
            record.uploaded,
            matches,
            parentId,
            context,
            nextSnapshot,
            remoteMutations,
            runId,
            { allowWait: false }
          );
        }
      }
    }
  }

  remoteFilesWithName(children, name) {
    return (children || []).filter((file) => file.name === name);
  }

  async reconcileCreatedUploadDuplicate(path, uploaded, matches, parentId, context, nextSnapshot, remoteMutations, runId, options = {}) {
    const uploadedFile = matches.find((file) => file.id === uploaded.id);
    const canonical = matches.slice().sort(compareRemoteCreationOrder)[0];
    const allSameContent = matches.every((file) => sameDriveContentExact(canonical, file));
    if (uploadedFile && matches.length === 2 && allSameContent && canonical.id !== uploaded.id) {
      await this.trashRemote(uploaded.id);
      this.forgetRemoteChild(parentId, uploaded.id);
      const canonicalRemote = remoteInfo(path, Object.assign({}, canonical, { parentId }));
      remoteMutations[path] = canonicalRemote;
      const localSnapshot = nextSnapshot[path] && nextSnapshot[path].local
        ? nextSnapshot[path].local
        : context.local[path];
      nextSnapshot[path] = this.snapshotFrom(localSnapshot, canonicalRemote);
      this.rememberDuplicateGuardFolder(parentPath(path));
      if (this.syncMetrics) {
        this.syncMetrics.duplicateGuardSelfHealed++;
      }
      await this.updateOperation(runId, { path, action: "upload" }, "done", context, null, {
        phase: "remote_verified",
        remoteResult: canonicalRemote,
        reservedRemoteId: "",
        duplicateSelfHealed: true,
        trashedRemoteId: uploaded.id
      });
      return "healed";
    }
    if (uploadedFile && allSameContent && canonical.id === uploaded.id && options.allowWait !== false) {
      return "wait";
    }
    const error = new Error(`Duplicate Google Drive item "${basename(path)}" under "${parentPath(path) || "/"}" has different content or could not be safely reconciled. No duplicate was deleted.`);
    error.code = "DRIVEBRIDGE_DUPLICATE_POSTFLIGHT";
    throw error;
  }

  forgetRemoteChild(parentId, remoteId) {
    if (!this.remoteChildCache || !this.remoteChildCache.has(parentId)) {
      return;
    }
    this.remoteChildCache.set(
      parentId,
      this.remoteChildCache.get(parentId).filter((file) => file.id !== remoteId)
    );
  }

  async moveRemoteFile(oldPath, newPath, remoteItem, rootFolderId) {
    if (!remoteItem || !remoteItem.id) {
      throw new Error(`Remote file not found for move: ${oldPath}`);
    }
    const newParentId = await this.ensureRemoteParent(newPath, rootFolderId);
    const oldParentId = remoteItem.parentId || "";
    const params = new URLSearchParams({
      fields: "id,name,size,modifiedTime,md5Checksum,parents"
    });
    if (newParentId && newParentId !== oldParentId) {
      params.set("addParents", newParentId);
      if (oldParentId) {
        params.set("removeParents", oldParentId);
      }
    }
    const moved = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files/${remoteItem.id}?${params}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: basename(newPath) })
    }));
    return remoteInfo(newPath, moved);
  }

  async ensureRemoteParent(path, rootFolderId) {
    const parts = path.split("/").slice(0, -1);
    let parentId = rootFolderId;
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const cacheKey = `${parentId}/${part}`;
      if (this.folderCache.has(cacheKey)) {
        parentId = this.folderCache.get(cacheKey);
        continue;
      }
      const folder = await this.findRemoteFolder(parentId, part);
      parentId = folder ? folder.id : await this.createRemoteFolder(parentId, part, {
        reservedId: this.reservedFolderIdForPrefix(prefix),
        runId: this.operationJournalCache && this.operationJournalCache.runId || "",
        operationId: `folder-${prefix}`
      });
      this.folderCache.set(cacheKey, parentId);
    }
    return parentId;
  }

  async findRemoteFolder(parentId, name) {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and name='${escapeDriveQuery(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id,name)",
      spaces: "drive"
    });
    const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
    if (data.files && data.files.length > 1) {
      throw new Error(`Multiple Google Drive folders named "${name}" are visible under the same parent. Rename duplicates before syncing.`);
    }
    return data.files && data.files.length ? data.files[0] : null;
  }

  reservedFolderIdForPrefix(prefix) {
    const journal = this.operationJournalCache;
    return journal && journal.folderReservations && journal.folderReservations[prefix] || "";
  }

  async findRemoteItemsByExactName(parentId, name, mimeType = "") {
    const mimeClause = mimeType ? ` and mimeType='${escapeDriveQuery(mimeType)}'` : "";
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and name='${escapeDriveQuery(name)}' and trashed=false${mimeClause}`,
      fields: "files(id,name,createdTime,size,modifiedTime,md5Checksum,parents,mimeType,appProperties)",
      spaces: "drive"
    });
    const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
    return data.files || [];
  }

  async findRemoteParentReadOnly(path, rootFolderId) {
    const parts = path.split("/").slice(0, -1);
    let parentId = rootFolderId;
    for (const part of parts) {
      const cacheKey = `${parentId}/${part}`;
      if (this.folderCache.has(cacheKey)) {
        parentId = this.folderCache.get(cacheKey);
        continue;
      }
      const folder = await this.findRemoteFolder(parentId, part);
      if (!folder) {
        return null;
      }
      parentId = folder.id;
      this.folderCache.set(cacheKey, parentId);
    }
    return parentId;
  }

  async findRemoteFileByExactName(path, rootFolderId) {
    const files = await this.findRemoteFileCandidates(path, rootFolderId);
    if (files.length > 1) {
      throw new Error(`Multiple Google Drive files named "${basename(path)}" exist under "${parentPath(path) || "/"}". Rename duplicates before recovery.`);
    }
    return files.length ? remoteInfo(path, files[0]) : null;
  }

  async findRemoteFileCandidates(path, rootFolderId) {
    const parentId = await this.findRemoteParentReadOnly(path, rootFolderId);
    if (!parentId) {
      return [];
    }
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and name='${escapeDriveQuery(basename(path))}' and trashed=false`,
      fields: "files(id,name,size,modifiedTime,md5Checksum,parents,mimeType,trashed)",
      spaces: "drive"
    });
    const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
    const files = (data.files || []).filter((file) =>
      !String(file.mimeType || "").startsWith("application/vnd.google-apps.")
    );
    return files;
  }

  async createRemoteFolder(parentId, name, options = {}) {
    this.assertCurrentRuntime();
    const reservedId = options.reservedId || "";
    try {
      const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?fields=id,name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(reservedId ? { id: reservedId } : {}),
          name,
          parents: [parentId],
          mimeType: "application/vnd.google-apps.folder",
          appProperties: this.provenanceProperties(options.operationId || "", options.runId || "")
        })
      }));
      const candidates = await this.findRemoteItemsByExactName(parentId, name, "application/vnd.google-apps.folder");
      if (candidates.length > 1) {
        throw new Error(`Folder create collision for "${name}". No folder was auto-merged; use duplicate repair.`);
      }
      return data.id;
    } catch (err) {
      if (this.isAmbiguousCreateError(err)) {
        const reconciled = await this.findRemoteFolder(parentId, name);
        if (reconciled) {
          return reconciled.id;
        }
      }
      throw err;
    }
  }

  provenanceProperties(operationId = "", runId = "") {
    return {
      drivebridgeOperationId: operationId || "",
      drivebridgeRunId: runId || "",
      drivebridgeDeviceId: this.settings.deviceId || "",
      drivebridgeProtocolVersion: "2"
    };
  }

  async downloadRemoteFile(path, remoteItem, options = {}) {
    const res = await this.driveFetch(`${DRIVE_API}/files/${remoteItem.id}?alt=media`);
    if (!res.ok) {
      await parseJsonResponse(res);
    }
    const buffer = await res.arrayBuffer();
    await this.ensureLocalParent(path);
    await this.writeVerifiedDownload(path, remoteItem, buffer, options);
  }

  async writeVerifiedDownload(path, remoteItem, buffer, options = {}) {
    const tempPath = this.partialDownloadPath(path);
    const replacePath = this.replaceBackupPath(path);
    if (await this.app.vault.adapter.exists(tempPath)) {
      await this.app.vault.adapter.remove(tempPath);
    }
    await this.ensureLocalParent(tempPath);
    await this.app.vault.adapter.writeBinary(tempPath, buffer);
    await this.assertDownloadedTempMatchesRemote(tempPath, remoteItem);

    if (Object.prototype.hasOwnProperty.call(options, "plannedLocal")) {
      await this.assertLocalUnchangedSincePlan(path, options.plannedLocal, true);
    }

    let movedExisting = false;
    if (await this.localPathExists(path)) {
      if (await this.app.vault.adapter.exists(replacePath)) {
        await this.app.vault.adapter.remove(replacePath);
      }
      await this.app.vault.adapter.rename(path, replacePath);
      movedExisting = true;
    }
    try {
      await this.app.vault.adapter.rename(tempPath, path);
      if (movedExisting && await this.app.vault.adapter.exists(replacePath)) {
        await this.app.vault.adapter.remove(replacePath);
      }
    } catch (err) {
      if (movedExisting && !(await this.localPathExists(path)) && await this.app.vault.adapter.exists(replacePath)) {
        await this.app.vault.adapter.rename(replacePath, path);
      }
      throw err;
    }
  }

  async assertDownloadedTempMatchesRemote(tempPath, remoteItem) {
    const stat = await this.app.vault.adapter.stat(tempPath);
    const expectedSize = Number(remoteItem.size || 0);
    if (expectedSize && (!stat || stat.size !== expectedSize)) {
      throw new Error(`Downloaded file size mismatch for ${tempPath}: ${stat ? stat.size : "missing"} != ${expectedSize}`);
    }
    if (remoteItem.md5Checksum) {
      const localMd5 = await this.localMd5ByPath(tempPath);
      if (localMd5 !== remoteItem.md5Checksum.toLowerCase()) {
        throw new Error(`Downloaded file checksum mismatch for ${tempPath}`);
      }
    }
  }

  partialDownloadPath(path) {
    return `${path}.drivebridge-partial`;
  }

  replaceBackupPath(path) {
    return `${path}.drivebridge-replace-${formatTimestamp(new Date())}-${randomId(6)}`;
  }

  async writeConflictCopy(path, remoteItem) {
    const dot = path.lastIndexOf(".");
    const stamp = `${formatTimestamp(new Date())}-${randomId(6)}`;
    const conflictPath = dot > 0
      ? `${path.slice(0, dot)}.conflict-${stamp}${path.slice(dot)}`
      : `${path}.conflict-${stamp}`;
    await this.downloadRemoteFile(conflictPath, remoteItem);
  }

  async deleteLocal(path) {
    if (this.isConfigPath(path)) {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
      }
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.trash(file, false);
    }
  }

  async trashRemote(fileId) {
    await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    }));
  }

  async renameLocalToConflict(path) {
    const dot = path.lastIndexOf(".");
    const stamp = `${formatTimestamp(new Date())}-${randomId(6)}`;
    const conflictPath = dot > 0
      ? `${path.slice(0, dot)}.conflict-${stamp}${path.slice(dot)}`
      : `${path}.conflict-${stamp}`;
    
    if (this.isConfigPath(path)) {
      await this.app.vault.adapter.rename(path, conflictPath);
    } else {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.rename(file, conflictPath);
      }
    }
  }

  async uploadTextContent(filename, rootFolderId, content, existingId, options = {}) {
    const boundary = `drivebridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const metadata = { name: filename, mimeType: "application/json" };
    if (!existingId) {
      metadata.parents = [rootFolderId];
    }
    if (options.commitId) {
      metadata.appProperties = { drivebridgeCommitId: options.commitId };
    }
    let bodyText = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
    bodyText += `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n`;
    bodyText += `--${boundary}--\r\n`;

    const url = existingId
      ? `${DRIVE_UPLOAD_API}/files/${existingId}?uploadType=multipart&fields=id,name,modifiedTime,appProperties`
      : `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,modifiedTime,appProperties`;
    const res = await parseJsonResponse(await this.driveFetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: bodyText
    }));
    return res;
  }

  async saveRemoteSnapshot(rootFolderId, currentRemote, previousDeleted = {}, newDeleted = {}, remoteSnapshotUpdates = {}, options = {}) {
    const remoteState = Object.assign({}, currentRemote || {});
    for (const [path, remote] of Object.entries(remoteSnapshotUpdates || {})) {
      if (remote) {
        remoteState[path] = remote;
      } else {
        delete remoteState[path];
      }
    }
    const deleted = this.mergeRemoteDeleteTombstones(previousDeleted, newDeleted, remoteState);
    if (!options.forceWrite &&
        canonicalJsonString(currentRemote || {}) === canonicalJsonString(remoteState) &&
        canonicalJsonString(previousDeleted || {}) === canonicalJsonString(deleted)) {
      if (this.syncMetrics) {
        this.syncMetrics.remoteSnapshotWriteSkipped++;
      }
      return { written: false, mergedConflict: false };
    }
    return this.writeRemoteSnapshotFile(rootFolderId, remoteState, deleted, Object.assign({}, options, {
      baseFiles: currentRemote || {},
      mutations: remoteSnapshotUpdates || {},
      newDeleted: newDeleted || {}
    }));
  }

  async writeRemoteSnapshotFile(rootFolderId, files, deleted = {}, options = {}) {
    const params = new URLSearchParams({
      q: `'${rootFolderId}' in parents and name='${REMOTE_SNAPSHOT_FILE}' and trashed=false`,
      fields: "files(id,modifiedTime,appProperties)",
      orderBy: "modifiedTime desc",
      spaces: "drive"
    });
    const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
    if (data.files && data.files.length > 1) {
      console.warn(`[drivebridge-obsidian-sync] Multiple ${REMOTE_SNAPSHOT_FILE} files exist; updating the newest visible file.`);
    }
    const existing = data.files && data.files.length ? data.files[0] : null;
    const existingId = existing ? existing.id : null;
    let mergedConflict = false;
    if (existing && options.expectedSnapshotFileId &&
        (existing.id !== options.expectedSnapshotFileId ||
         existing.modifiedTime !== options.expectedSnapshotModifiedTime)) {
      const latest = await this.loadRemoteSnapshotById(existing.id, existing.modifiedTime);
      files = this.mergeRemoteSnapshotMutationSet(options.baseFiles || {}, latest.files, options.mutations || {});
      deleted = this.mergeRemoteDeleteTombstones(latest.deleted || {}, options.newDeleted || {}, files);
      mergedConflict = true;
    }
    const commitId = `${options.runId || "rebuild"}-${randomId(8)}`;
    const content = JSON.stringify({
      version: 2,
      commitId,
      generatedAt: new Date().toISOString(),
      files,
      deleted
    });
    let uploaded;
    try {
      uploaded = await this.uploadTextContent(REMOTE_SNAPSHOT_FILE, rootFolderId, content, existingId, { commitId });
    } catch (err) {
      if (!this.isAmbiguousCreateError(err)) {
        throw err;
      }
      uploaded = await this.reconcileRemoteSnapshotCommit(rootFolderId, commitId);
      if (!uploaded) {
        throw err;
      }
    }
    if (mergedConflict) {
      const verified = await this.reconcileRemoteSnapshotCommit(rootFolderId, commitId);
      if (!verified) {
        const error = new Error(`Concurrent ${REMOTE_SNAPSHOT_FILE} writer replaced the merged commit. Run Recovery to merge again.`);
        error.code = "DRIVEBRIDGE_REMOTE_SNAPSHOT_REPLACED";
        throw error;
      }
      uploaded = Object.assign({}, uploaded, verified);
    }
    this.settings.remoteSnapshotProtocolVersion = 2;
    if (this.syncMetrics) {
      this.syncMetrics.remoteSnapshotWrites++;
      if (mergedConflict) {
        this.syncMetrics.remoteSnapshotConflictMerges++;
      }
    }
    this.settings.lastRemoteSnapshotAt = Date.now();
    return {
      written: true,
      mergedConflict,
      fileId: uploaded.id || existingId || "",
      modifiedTime: uploaded.modifiedTime || "",
      commitId
    };
  }

  async reconcileRemoteSnapshotCommit(rootFolderId, commitId) {
    const params = new URLSearchParams({
      q: `'${rootFolderId}' in parents and name='${REMOTE_SNAPSHOT_FILE}' and trashed=false`,
      fields: "files(id,modifiedTime,appProperties)",
      orderBy: "modifiedTime desc",
      spaces: "drive"
    });
    const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
    for (const file of data.files || []) {
      if (file.appProperties && file.appProperties.drivebridgeCommitId === commitId) {
        return file;
      }
      try {
        const res = await this.driveFetch(`${DRIVE_API}/files/${file.id}?alt=media`);
        if (res.ok) {
          const parsed = JSON.parse(await res.text());
          if (parsed && parsed.commitId === commitId) {
            return file;
          }
        }
      } catch (readError) {
        console.warn(`[drivebridge-obsidian-sync] Could not verify ambiguous ${REMOTE_SNAPSHOT_FILE} commit`, readError);
      }
    }
    return null;
  }

  async loadRemoteSnapshotById(fileId, modifiedTime = "") {
    const res = await this.driveFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
    if (!res.ok) {
      await parseJsonResponse(res);
    }
    const parsed = JSON.parse(await res.text());
    const normalized = normalizeRemoteState(parsed);
    normalized.snapshotFileId = fileId;
    normalized.snapshotModifiedTime = modifiedTime;
    return normalized;
  }

  mergeRemoteSnapshotMutationSet(baseFiles, latestFiles, mutations) {
    const merged = Object.assign({}, latestFiles || {});
    for (const [path, mutation] of Object.entries(mutations || {})) {
      const base = baseFiles && baseFiles[path] || null;
      const latest = latestFiles && latestFiles[path] || null;
      const latestUnchanged = (!base && !latest) ||
        (base && latest && base.id === latest.id && sameRemoteContent(base, latest));
      const alreadyApplied = mutation
        ? latest && latest.id === mutation.id && sameRemoteContent(latest, mutation)
        : !latest;
      if (!latestUnchanged && !alreadyApplied) {
        const error = new Error(`Concurrent remote snapshot change conflicts at ${path}. Recovery/manual review is required.`);
        error.code = "DRIVEBRIDGE_REMOTE_SNAPSHOT_CONFLICT";
        throw error;
      }
      if (mutation) {
        merged[path] = mutation;
      } else {
        delete merged[path];
      }
    }
    return merged;
  }

  async ensureLocalParent(path) {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.isConfigPath(current)) {
        if (!(await this.app.vault.adapter.exists(current))) {
          await this.app.vault.adapter.mkdir(current);
        }
        continue;
      }
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async loadSnapshot() {
    return this.loadPluginDataJsonWithBackup(
      SNAPSHOT_FILE,
      SNAPSHOT_BACKUP_FILE,
      {},
      validateSnapshot,
      "Sync stopped without resetting history."
    );
  }

  async saveSnapshot(snapshot) {
    validateSnapshot(snapshot);
    await this.writePluginDataFileAtomic(SNAPSHOT_FILE, SNAPSHOT_BACKUP_FILE, JSON.stringify(snapshot));
  }

  async loadReviewQueue() {
    return this.loadPluginDataJsonWithBackup(
      REVIEW_QUEUE_FILE,
      REVIEW_QUEUE_BACKUP_FILE,
      { version: 1, items: [] },
      validateReviewQueue,
      "Conflict review stopped without discarding items."
    );
  }

  async saveReviewQueue(queue) {
    const normalized = { version: 1, items: Array.isArray(queue.items) ? queue.items : [] };
    await this.writePluginDataFileAtomic(REVIEW_QUEUE_FILE, REVIEW_QUEUE_BACKUP_FILE, JSON.stringify(normalized));
    this.reviewCount = normalized.items.length;
    this.clearSyncStatus();
  }

  async enqueueDuplicateRepairReviews(groups) {
    if (!groups.length) return;
    const queue = await this.loadReviewQueue();
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    const now = new Date().toISOString();
    for (const group of groups) {
      const id = `duplicate-${group.key}`;
      byId.set(id, {
        id,
        type: "duplicateRepair",
        path: group.path,
        reason: group.reason,
        local: null,
        remote: group.candidates[0] ? remoteInfo(group.path, group.candidates[0]) : null,
        remoteCandidates: group.candidates,
        createdAt: byId.get(id) && byId.get(id).createdAt || now,
        updatedAt: now,
        status: "pending"
      });
    }
    await this.saveReviewQueue({ version: 1, items: Array.from(byId.values()) });
  }

  reviewItemFrom(entry, localItem, remoteItem) {
    const id = reviewIdentityKey(entry.path, localItem, remoteItem);
    const now = new Date().toISOString();
    return {
      id,
      path: entry.path,
      reason: entry.reason || "changed on both sides",
      local: localItem || null,
      remote: remoteItem || null,
      createdAt: now,
      updatedAt: now,
      status: "pending"
    };
  }

  reviewItemsForPlan(plan, context) {
    return (plan.entries || [])
      .filter((entry) => entry.action === "conflict")
      .map((entry) => this.reviewItemFrom(
        entry,
        context.local && context.local[entry.path] || null,
        context.remote && context.remote[entry.path] || null
      ));
  }

  async reconcileReviewQueue(plan, reviewItems) {
    const existing = await this.loadReviewQueue();
    const conflictPaths = new Set((plan.entries || [])
      .filter((entry) => entry.action === "conflict")
      .map((entry) => entry.path));
    const incomingById = new Map((reviewItems || []).map((item) => [item.id, item]));
    const nextById = new Map();
    for (const item of existing.items) {
      if (item.type === "duplicateRepair") {
        nextById.set(item.id, item);
        continue;
      }
      if (!conflictPaths.has(item.path)) {
        continue;
      }
      const replacement = incomingById.get(item.id);
      if (replacement) {
        replacement.createdAt = item.createdAt || replacement.createdAt;
        nextById.set(item.id, replacement);
        incomingById.delete(item.id);
      }
    }
    for (const item of incomingById.values()) {
      nextById.set(item.id, item);
    }
    await this.saveReviewQueue({ version: 1, items: Array.from(nextById.values()).sort((a, b) => a.path.localeCompare(b.path)) });
  }

  async openConflictReview() {
    if (this.syncing) {
      new Notice("Wait for DriveBridge sync to finish before reviewing conflicts.");
      return;
    }
    const queue = await this.loadReviewQueue();
    const modal = new DriveBridgeConflictReviewModal(this.app, this, queue);
    modal.open();
  }

  async resolveReviewItem(itemId, action) {
    if (this.syncing) {
      throw new Error("DriveBridge is already running.");
    }
    this.syncing = true;
    try {
      const queue = await this.loadReviewQueue();
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (!item) {
        throw new Error("This conflict is no longer pending.");
      }
      await this.ensureAccessToken();
      const rootFolderId = await this.ensureRootFolder();
      const localItem = await this.localInfoByPath(item.path);
      const remoteItem = item.remote && item.remote.id
        ? await this.remoteInfoById(item.path, item.remote.id)
        : null;
      if (reviewIdentityKey(item.path, localItem, remoteItem) !== item.id) {
        throw new Error("Local or Drive changed after this review was shown. Run sync to refresh the comparison.");
      }

      let resolvedSnapshot;
      if (action === "keepLocal" || action === "keepBoth") {
        await this.writeConflictCopy(item.path, remoteItem);
        const uploadStart = await this.localInfoByPath(item.path);
        if (reviewIdentityKey(item.path, uploadStart, remoteItem) !== item.id) {
          throw new Error("Local changed while the Drive backup was being created. Run sync to refresh the review.");
        }
        const uploaded = await this.uploadLocalFile(item.path, rootFolderId, remoteItem, { duplicateGuard: false });
        const localAfter = await this.localInfoByPath(item.path);
        if (!sameLocalStrict(uploadStart, localAfter)) {
          throw new Error("Local changed while the reviewed version was uploading. Run sync again.");
        }
        resolvedSnapshot = this.snapshotFrom(localAfter, uploaded);
      } else if (action === "keepRemote") {
        await this.renameLocalToConflict(item.path);
        await this.downloadRemoteFile(item.path, remoteItem);
        const localAfter = await this.localInfoByPath(item.path);
        if (!(await this.hasSameContent(item.path, localAfter, remoteItem))) {
          throw new Error("Downloaded Drive version could not be reverified.");
        }
        resolvedSnapshot = this.snapshotFrom(localAfter, remoteItem);
      } else {
        return;
      }

      const snapshot = await this.loadSnapshot();
      snapshot[item.path] = resolvedSnapshot;
      await this.saveSnapshot(snapshot);
      const remoteState = await this.scanRemoteVault(rootFolderId);
      await this.saveRemoteSnapshot(
        rootFolderId,
        remoteState.files,
        remoteState.deleted,
        {},
        { [item.path]: resolvedSnapshot.remote }
      );
      await this.saveReviewQueue({
        version: 1,
        items: queue.items.filter((candidate) => candidate.id !== item.id)
      });
      this.settings.lastSyncStatus = this.reviewCount ? "completed_incomplete" : "completed";
      this.settings.lastSyncSummary = `Conflict resolved: ${item.path}\nRemaining reviews: ${this.reviewCount}`;
      await this.saveSettings();
      new Notice(`DriveBridge conflict resolved: ${item.path}`);
    } finally {
      this.syncing = false;
      this.clearSyncStatus();
    }
  }

  async writeJournal(journal) {
    await this.writePluginDataFile(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  }

  async safeWriteJournal(journal) {
    try {
      await this.writeJournal(journal);
    } catch (err) {
      console.error("[drivebridge-obsidian-sync] failed to write journal", err);
    }
  }

  async readOperationJournal() {
    return this.loadPluginDataJsonWithBackup(
      OPERATION_JOURNAL_FILE,
      OPERATION_JOURNAL_BACKUP_FILE,
      null,
      validateOperationJournal,
      "Recovery journal could not be read."
    );
  }

  async writeOperationJournal(journal) {
    validateOperationJournal(journal);
    this.operationJournalCache = journal;
    this.operationJournalDirty = false;
    this.operationJournalDirtyCount = 0;
    this.operationJournalLastFlushAt = Date.now();
    await this.writePluginDataFileAtomic(
      OPERATION_JOURNAL_FILE,
      OPERATION_JOURNAL_BACKUP_FILE,
      JSON.stringify(journal)
    );
  }

  markOperationJournalDirty() {
    this.operationJournalDirty = true;
    this.operationJournalDirtyCount++;
  }

  async flushOperationJournal(force = false) {
    if (!this.operationJournalCache || !this.operationJournalDirty) {
      return;
    }
    const elapsed = Date.now() - (this.operationJournalLastFlushAt || 0);
    if (!force && this.operationJournalDirtyCount < 20 && elapsed < 2500) {
      return;
    }
    await this.writeOperationJournal(this.operationJournalCache);
  }

  async safeFlushOperationJournal(force = false) {
    try {
      await this.flushOperationJournal(force);
    } catch (err) {
      console.error("[drivebridge-obsidian-sync] failed to flush operation journal", err);
    }
  }

  async initializeOperationJournal(runId, plan, context) {
    return this.prepareOperationJournal(runId, plan, context, null);
  }

  async prepareOperationJournal(runId, plan, context, existingJournal = null) {
    const previousOperations = existingJournal && existingJournal.runId === runId
      ? existingJournal.operations || {}
      : {};
    const needsReservedId = plan.entries.filter((entry) => {
      const previous = previousOperations[entry.path];
      return this.shouldJournalOperation(entry) &&
        entry.action === "upload" &&
        !context.remote[entry.path] &&
        !(previous && previous.reservedRemoteId);
    });
    const folderPrefixes = Array.from(new Set(needsReservedId.flatMap((entry) => {
      const parts = entry.path.split("/").slice(0, -1);
      return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    })));
    const previousFolderReservations = existingJournal && existingJournal.folderReservations || {};
    const missingFolderPrefixes = folderPrefixes.filter((prefix) => !previousFolderReservations[prefix]);
    const reservedIds = await this.reserveDriveIds(needsReservedId.length + missingFolderPrefixes.length);
    const reservedByPath = new Map(needsReservedId.map((entry, index) => [entry.path, reservedIds[index]]));
    const folderReservations = Object.assign({}, previousFolderReservations);
    missingFolderPrefixes.forEach((prefix, index) => {
      folderReservations[prefix] = reservedIds[needsReservedId.length + index];
    });
    const operations = {};
    for (const entry of plan.entries) {
      if (!this.shouldJournalOperation(entry)) {
        continue;
      }
      const previous = previousOperations[entry.path] && previousOperations[entry.path].action === entry.action
        ? previousOperations[entry.path]
        : null;
      operations[entry.path] = Object.assign({}, previous || {}, {
        runId,
        operationId: previous && previous.operationId
          ? previous.operationId
          : `${runId}-${randomId(8)}`,
        path: entry.path,
        action: entry.action,
        fromPath: entry.fromPath || (previous && previous.fromPath) || "",
        status: previous && previous.status === "done" ? "done" : "pending",
        phase: previous && previous.phase ? previous.phase : "prepared",
        reason: entry.reason || "",
        localBefore: context.local[entry.path] || null,
        remoteBefore: context.remote[entry.path] || (entry.fromPath ? context.remote[entry.fromPath] : null) || null,
        reservedRemoteId: previous && previous.reservedRemoteId
          ? previous.reservedRemoteId
          : reservedByPath.get(entry.path) || "",
        tempPath: this.partialDownloadPath(entry.path),
        startedAt: previous && previous.startedAt || "",
        completedAt: previous && previous.completedAt || "",
        error: previous && previous.error || null
      });
    }
    await this.writeOperationJournal({
      version: 2,
      runId,
      startedAt: existingJournal && existingJournal.startedAt || new Date().toISOString(),
      completedAt: "",
      status: "running",
      expectedRemoteSnapshot: {
        fileId: context.remoteSnapshotFileId || "",
        modifiedTime: context.remoteSnapshotModifiedTime || ""
      },
      folderReservations,
      operations
    });
  }

  reservedRemoteIdForOperation(runId, path) {
    const journal = this.operationJournalCache;
    const operation = journal && journal.runId === runId && journal.operations
      ? journal.operations[path]
      : null;
    return operation && operation.reservedRemoteId || "";
  }

  operationIdForPath(runId, path) {
    const journal = this.operationJournalCache;
    const operation = journal && journal.runId === runId && journal.operations
      ? journal.operations[path]
      : null;
    return operation && operation.operationId || "";
  }

  async updateOperation(runId, entry, status, context, err, details = {}) {
    if (!runId || !entry || !entry.path) {
      return;
    }
    const journal = this.operationJournalCache || await this.readOperationJournal();
    if (!journal || journal.runId !== runId) {
      return;
    }
    this.operationJournalCache = journal;
    if (!journal.operations[entry.path] && !this.shouldJournalOperation(entry)) {
      return;
    }
    const current = journal.operations[entry.path] || {
      runId,
      path: entry.path,
      action: entry.action,
      fromPath: entry.fromPath || "",
      localBefore: context.local[entry.path] || null,
      remoteBefore: context.remote[entry.path] || (entry.fromPath ? context.remote[entry.fromPath] : null) || null,
      tempPath: this.partialDownloadPath(entry.path)
    };
    current.status = status;
    for (const [key, value] of Object.entries(details || {})) {
      if (value !== undefined) {
        current[key] = value;
      }
    }
    if (status === "in_progress") {
      current.startedAt = current.startedAt || new Date().toISOString();
    }
    if (status === "done" || status === "failed" || status === "skipped") {
      current.completedAt = new Date().toISOString();
    }
    if (err) {
      current.error = {
        message: err.message || String(err),
        code: err.code || "",
        time: new Date().toISOString()
      };
    } else if (status === "done") {
      current.error = null;
    }
    journal.operations[entry.path] = current;
    this.markOperationJournalDirty();
    await this.flushOperationJournal(Boolean(err) || status === "failed" || status === "skipped");
  }

  shouldJournalOperation(entry) {
    return entry && entry.action !== "skip" && entry.action !== "adopt";
  }

  async markOperationJournalComplete(runId, executed) {
    const journal = this.operationJournalCache || await this.readOperationJournal();
    if (!journal || journal.runId !== runId) {
      return;
    }
    this.operationJournalCache = journal;
    journal.completedAt = new Date().toISOString();
    journal.status = executed.errors.length
      ? "recovery_required"
      : (executed.skippedChanged.length || executed.skippedSafe.length || executed.reviewItems.length)
        ? "completed_incomplete"
        : "completed";
    journal.stats = executed.stats;
    this.markOperationJournalDirty();
    await this.flushOperationJournal(true);
  }

  async markOperationJournalCommitPending(runId, executed) {
    const journal = this.operationJournalCache || await this.readOperationJournal();
    if (!journal || journal.runId !== runId) {
      return;
    }
    this.operationJournalCache = journal;
    journal.status = "commit_pending";
    journal.commitPendingAt = new Date().toISOString();
    journal.commitSummary = {
      remoteMutationPaths: Object.keys(executed.remoteMutations || {}),
      remoteSnapshotUpdatePaths: Object.keys(executed.remoteSnapshotUpdates || {}),
      remoteDeletePaths: Object.keys(executed.remoteDeleted || {})
    };
    this.markOperationJournalDirty();
    await this.flushOperationJournal(true);
  }

  async updateOperationJournalSnapshotCommit(runId, result) {
    const journal = this.operationJournalCache || await this.readOperationJournal();
    if (!journal || journal.runId !== runId) {
      return;
    }
    this.operationJournalCache = journal;
    journal.remoteSnapshotCommit = Object.assign({ committedAt: new Date().toISOString() }, result || {});
    this.markOperationJournalDirty();
    await this.flushOperationJournal(true);
  }

  async checkInterruptedSync() {
    const journal = await this.readOperationJournal();
    const partials = await this.findPartialDownloads();
    const recoveryStatuses = new Set(["running", "commit_pending", "recovery_required", "completed_with_errors"]);
    const inProgress = journal && recoveryStatuses.has(journal.status)
      ? Object.values(journal.operations || {}).filter((operation) => operation.status === "in_progress")
      : [];
    const journalRunning = Boolean(journal && recoveryStatuses.has(journal.status));
    return {
      interrupted: journalRunning || partials.length > 0,
      runId: journal && journal.runId ? journal.runId : "",
      journal,
      inProgress,
      partials
    };
  }

  async reconcileRecoveryContext(recovery, context) {
    const journal = recovery && recovery.journal;
    if (!journal) {
      return;
    }
    this.operationJournalCache = journal;
    context.remoteBase = Object.assign({}, context.remote);
    context.recoveredRemoteMutations = {};
    context.recoveredRemoteDeleted = {};
    for (const operation of Object.values(journal.operations || {})) {
      if (!operation) {
        continue;
      }
      if (operation.action === "deleteRemote") {
        const plannedRemote = operation.remoteBefore || null;
        if (!context.remote[operation.path] || !plannedRemote || !plannedRemote.id) {
          continue;
        }
        if (this.syncMetrics) {
          this.syncMetrics.recoveryLookups++;
        }
        const current = await this.remoteInfoById(operation.path, plannedRemote.id);
        if (!current) {
          delete context.remote[operation.path];
          context.recoveredRemoteMutations[operation.path] = null;
          context.recoveredRemoteDeleted[operation.path] = this.remoteDeleteTombstone(plannedRemote);
          this.markRecoveredOperation(operation, null, true);
        } else {
          context.remote[operation.path] = current;
        }
        continue;
      }
      if (operation.action === "moveRemote") {
        const fromPath = operation.fromPath || "";
        const plannedRemote = operation.remoteBefore || null;
        if (!fromPath || !plannedRemote || !plannedRemote.id ||
            (context.remote[operation.path] && context.remote[operation.path].id === plannedRemote.id)) {
          continue;
        }
        if (this.syncMetrics) {
          this.syncMetrics.recoveryLookups++;
        }
        const current = await this.remoteInfoById(operation.path, plannedRemote.id);
        const expectedParentId = await this.findRemoteParentReadOnly(operation.path, context.rootFolderId);
        if (current && expectedParentId && current.name === basename(operation.path) && current.parentId === expectedParentId) {
          delete context.remote[fromPath];
          context.remote[operation.path] = current;
          context.recoveredRemoteMutations[fromPath] = null;
          context.recoveredRemoteMutations[operation.path] = current;
          this.markRecoveredOperation(operation, current, true);
        }
        continue;
      }
      if (operation.action !== "upload") {
        continue;
      }
      const knownRemote = context.remote[operation.path];
      const knownId = operation.reservedRemoteId ||
        (operation.remoteResult && operation.remoteResult.id) ||
        (operation.remoteBefore && operation.remoteBefore.id) || "";
      if (knownRemote && knownId && operation.remoteResult && knownRemote.id === knownId &&
          sameRemoteContent(knownRemote, operation.remoteResult)) {
        continue;
      }
      let remote = null;
      if (this.syncMetrics) {
        this.syncMetrics.recoveryLookups++;
      }
      if (knownId) {
        remote = await this.remoteInfoById(operation.path, knownId);
      } else if (Object.prototype.hasOwnProperty.call(this, "findRemoteFileByExactName")) {
        // Preserve an injected adapter/test seam while production uses candidate-aware recovery below.
        remote = await this.findRemoteFileByExactName(operation.path, context.rootFolderId);
      } else {
        const candidates = await this.findRemoteFileCandidates(operation.path, context.rootFolderId);
        if (candidates.length > 1) {
          const ordered = candidates.slice().sort(compareRemoteCreationOrder);
          const sameContent = ordered.every((candidate) => sameDriveContentExact(ordered[0], candidate));
          await this.enqueueDuplicateRepairReviews([{
            key: md5Hex(new TextEncoder().encode(`${operation.path}\n${ordered.map((item) => item.id).join(",")}`).buffer),
            path: operation.path,
            candidates: ordered,
            reason: sameContent
              ? "Recovery found multiple byte-identical candidates; Repair must isolate extras before snapshot commit"
              : "Recovery found multiple different or unverifiable candidates"
          }]);
          if (!sameContent) {
            this.markRecoveredOperation(operation, null, false);
            continue;
          }
          remote = remoteInfo(operation.path, ordered[0]);
        } else {
          remote = candidates.length ? remoteInfo(operation.path, candidates[0]) : null;
        }
      }
      if (!remote) {
        continue;
      }
      context.remote[operation.path] = remote;
      context.recoveredRemoteMutations[operation.path] = remote;
      let contentMatches = false;
      if (await this.localPathExists(operation.path) && remote.md5Checksum) {
        const currentLocal = await this.localInfoByPath(operation.path);
        if (Number(currentLocal.size || 0) !== Number(remote.size || 0)) {
          this.markRecoveredOperation(operation, remote, false);
          continue;
        }
        const localMd5 = await this.localMd5ByPath(operation.path);
        contentMatches = localMd5 === remote.md5Checksum.toLowerCase();
      }
      this.markRecoveredOperation(operation, remote, contentMatches);
    }
    this.markOperationJournalDirty();
    await this.flushOperationJournal(true);
  }

  markRecoveredOperation(operation, remote, success) {
    operation.remoteResult = remote;
    operation.phase = success ? "remote_verified" : "review_required";
    operation.status = success ? "done" : "failed";
    operation.completedAt = success ? new Date().toISOString() : operation.completedAt || "";
    operation.error = success ? null : {
      message: "The observed Google Drive result differs from the planned operation and needs review.",
      code: "DRIVEBRIDGE_RECOVERY_CONTENT_MISMATCH",
      time: new Date().toISOString()
    };
  }

  async previewRecovery() {
    const recovery = await this.checkInterruptedSync();
    const operations = recovery.journal ? Object.values(recovery.journal.operations || {}) : [];
    const dangerousInProgress = recovery.inProgress.filter((operation) => this.isDangerousRecoveryOperation(operation));
    const pendingSafe = operations.filter((operation) => this.isSafeRecoveryOperation(operation));
    const done = operations.filter((operation) => operation.status === "done");
    const failed = operations.filter((operation) => operation.status === "failed");
    const blockers = [];
    if (!recovery.journal) {
      blockers.push("No operation journal found.");
    }
    if (recovery.partials.length) {
      blockers.push(`${recovery.partials.length} partial/replacement file(s) remain. Use Discard partial downloads before resume.`);
    }
    if (dangerousInProgress.length) {
      blockers.push(`${dangerousInProgress.length} dangerous in-progress operation(s) require manual review.`);
    }
    const safe = Boolean(recovery.journal) && blockers.length === 0;
    this.settings.recoveryPreviewRunId = recovery.runId;
    this.settings.recoveryPreviewSafe = safe;
    this.settings.recoveryPlanPreviewRunId = "";
    this.settings.recoveryPlanPreviewAt = 0;
    this.settings.recoveryPlanPreviewSafe = false;
    this.settings.lastRecoverySummary = [
      "Recovery preview",
      `Run ID: ${recovery.runId || "none"}`,
      `Interrupted: ${recovery.interrupted ? "yes" : "no"}`,
      `Done operations: ${done.length}`,
      `Safe pending/failed/skipped operations: ${pendingSafe.length}`,
      `Failed operations: ${failed.length}`,
      `In-progress operations: ${recovery.inProgress.length}`,
      `Partial/replacement files: ${recovery.partials.length}`,
      `Resume gate: ${safe ? "recovery preview passed; run normal Preview next" : "blocked"}`,
      ...(blockers.length ? ["", "Blockers:", ...blockers.map((item) => `- ${item}`)] : [])
    ].join("\n");
    this.settings.lastSyncSummary = this.settings.lastRecoverySummary;
    await this.saveSettings();
    new Notice(safe ? "Recovery preview passed. Run normal Preview next." : "Recovery preview found blockers.", 10000);
  }

  isDangerousRecoveryOperation(operation) {
    const manualConflict = operation && operation.action === "conflict" &&
      (this.settings.conflictAction || DEFAULT_SETTINGS.conflictAction) === "manualReview";
    return operation && !manualConflict &&
      (operation.action === "conflict" || operation.action === "deleteLocal" || operation.action === "deleteRemote");
  }

  isSafeRecoveryOperation(operation) {
    return operation &&
      (operation.status === "pending" || operation.status === "failed" || operation.status === "skipped") &&
      !this.isDangerousRecoveryOperation(operation);
  }

  recoveryPreviewIsCurrent(recovery) {
    return recovery &&
      recovery.runId &&
      this.settings.recoveryPreviewRunId === recovery.runId &&
      this.settings.recoveryPreviewSafe;
  }

  assertRecoveryResumeAllowed(recovery) {
    if (!recovery || !recovery.journal) {
      throw new Error("No recovery journal found. Use normal Run sync instead.");
    }
    if (!this.recoveryPreviewIsCurrent(recovery)) {
      throw new Error("Run Preview recovery before Resume safe operations.");
    }
    if (this.settings.recoveryPlanPreviewRunId !== recovery.runId || !this.settings.recoveryPlanPreviewAt) {
      throw new Error("Run normal Preview after Preview recovery before Resume safe operations.");
    }
    if (!this.settings.recoveryPlanPreviewSafe) {
      throw new Error("Normal Preview still includes conflict/delete actions. Resolve them before Resume safe operations.");
    }
    if (recovery.partials.length) {
      throw new Error("Partial/replacement files remain. Use Discard partial downloads, then Preview recovery and normal Preview again.");
    }
    const dangerousInProgress = recovery.inProgress.filter((operation) => this.isDangerousRecoveryOperation(operation));
    if (dangerousInProgress.length) {
      throw new Error("Dangerous in-progress conflict/delete operation requires manual review before resume.");
    }
  }

  assertResumePlanSafe(plan) {
    const unsafe = this.unsafeResumePlanEntries(plan);
    if (unsafe.length) {
      throw new Error(`Resume safe operations blocked: Preview still includes ${unsafe.length} conflict/delete action(s). Resolve or change mode before resuming.`);
    }
  }

  unsafeResumePlanEntries(plan) {
    return plan.entries.filter((entry) => {
      const manualConflict = entry.action === "conflict" &&
        (this.settings.conflictAction || DEFAULT_SETTINGS.conflictAction) === "manualReview";
      return !manualConflict &&
        (entry.action === "conflict" || entry.action === "deleteLocal" || entry.action === "deleteRemote");
    });
  }

  recoveryDonePaths(recovery) {
    const operations = recovery && recovery.journal ? Object.values(recovery.journal.operations || {}) : [];
    return new Set(operations.filter((operation) => operation.status === "done").map((operation) => operation.path));
  }

  async findPartialDownloads() {
    const result = [];
    await this.collectPartialDownloads("", result);
    return result;
  }

  async collectPartialDownloads(folderPath, result) {
    let listing;
    try {
      listing = await this.app.vault.adapter.list(folderPath);
    } catch (err) {
      return;
    }
    for (const filePath of listing.files || []) {
      if (filePath.endsWith(".drivebridge-partial") || filePath.includes(".drivebridge-replace-")) {
        result.push(filePath);
      }
    }
    for (const childFolder of listing.folders || []) {
      if (!this.isAlwaysExcluded(childFolder)) {
        await this.collectPartialDownloads(childFolder, result);
      }
    }
  }

  async discardPartialDownloads() {
    const partials = await this.findPartialDownloads();
    for (const path of partials) {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
      }
    }
    const journal = await this.readOperationJournal();
    if (journal && ["running", "commit_pending", "recovery_required", "completed_with_errors"].includes(journal.status)) {
      journal.status = "discarded";
      journal.completedAt = new Date().toISOString();
      await this.writeOperationJournal(journal);
    }
    this.settings.recoveryPreviewRunId = "";
    this.settings.recoveryPreviewSafe = false;
    this.settings.recoveryPlanPreviewRunId = "";
    this.settings.recoveryPlanPreviewAt = 0;
    this.settings.recoveryPlanPreviewSafe = false;
    this.settings.lastRecoverySummary = `Discarded ${partials.length} DriveBridge partial/replacement file(s). Run Preview before syncing.`;
    this.settings.lastSyncSummary = this.settings.lastRecoverySummary;
    await this.saveSettings();
    new Notice(this.settings.lastRecoverySummary, 10000);
  }

  async localInfo(file) {
    const info = {
      path: file.path,
      size: file.stat.size,
      mtime: file.stat.mtime
    };
    if (shouldHashLocalFile(file.path, file.stat.size)) {
      const data = await this.app.vault.readBinary(file);
      info.sha256 = await sha256Hex(data);
    }
    return info;
  }

  async localInfoByPath(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return this.localInfo(file);
    }
    const stat = await this.app.vault.adapter.stat(path);
    if (!stat) {
      throw new Error(`Local file not found: ${path}`);
    }
    const info = {
      path,
      size: stat.size,
      mtime: stat.mtime
    };
    if (shouldHashLocalFile(path, stat.size)) {
      const data = await this.app.vault.adapter.readBinary(path);
      info.sha256 = await sha256Hex(data);
    }
    return info;
  }

  async readLocalBinary(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return this.app.vault.readBinary(file);
    }
    return this.app.vault.adapter.readBinary(path);
  }

  async localMd5ByPath(path) {
    const data = await this.readLocalBinary(path);
    return md5Hex(data);
  }

  async hasSameContent(path, localItem, remoteItem) {
    if (!localItem || !remoteItem) {
      return false;
    }
    if (Number(localItem.size || 0) !== Number(remoteItem.size || 0)) {
      return false;
    }
    if (!remoteItem.md5Checksum) {
      return false;
    }
    try {
      const localMd5 = await this.localMd5ByPath(path);
      return localMd5 === remoteItem.md5Checksum.toLowerCase();
    } catch (err) {
      return false;
    }
  }

  async localPathExists(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile || await this.app.vault.adapter.exists(path);
  }

  async assertLocalUnchangedSincePlan(path, plannedLocal, strict = false) {
    if (!plannedLocal) {
      if (await this.localPathExists(path)) {
        throw this.changedDuringSyncError(`Local file appeared during sync: ${path}`, "local");
      }
      return;
    }
    if (!(await this.localPathExists(path))) {
      throw this.changedDuringSyncError(`Local file changed during sync: ${path}`, "local");
    }
    const currentInfo = await this.localInfoByPath(path);
    if (!(strict ? sameLocalStrict(plannedLocal, currentInfo) : sameLocal(plannedLocal, currentInfo))) {
      throw this.changedDuringSyncError(`Local file changed during sync: ${path}`, "local");
    }
  }

  async remoteInfoById(path, fileId) {
    const params = new URLSearchParams({
      fields: "id,name,size,modifiedTime,md5Checksum,parents,trashed"
    });
    const res = await this.driveFetch(`${DRIVE_API}/files/${fileId}?${params}`);
    if (res.status === 404) {
      return null;
    }
    const file = await parseJsonResponse(res);
    if (file.trashed) {
      return null;
    }
    return remoteInfo(path, file);
  }

  async assertRemoteUnchangedSincePlan(path, plannedRemote) {
    if (!plannedRemote || !plannedRemote.id) {
      return;
    }
    const currentInfo = await this.remoteInfoById(path, plannedRemote.id);
    if (!currentInfo || !sameRemote(plannedRemote, currentInfo)) {
      throw this.changedDuringSyncError(
        `Google Drive file differs from planned remote snapshot: ${path}`,
        "remote",
        remoteDiffDetails(plannedRemote, currentInfo),
        currentInfo
      );
    }
  }

  async assertRemoteContentUnchangedSincePlan(path, plannedRemote) {
    if (!plannedRemote || !plannedRemote.id) {
      return null;
    }
    const currentInfo = await this.remoteInfoById(path, plannedRemote.id);
    if (!currentInfo || !sameRemoteContent(plannedRemote, currentInfo)) {
      throw this.changedDuringSyncError(
        `Google Drive file differs from planned remote snapshot: ${path}`,
        "remote",
        remoteDiffDetails(plannedRemote, currentInfo),
        currentInfo
      );
    }
    return currentInfo;
  }

  changedDuringSyncError(message, side, details = "", currentRemote = undefined) {
    const error = new Error(message);
    error.code = "DRIVEBRIDGE_CHANGED_DURING_SYNC";
    error.side = side;
    error.details = details;
    if (currentRemote !== undefined) {
      error.hasCurrentRemote = true;
      error.currentRemote = currentRemote;
    }
    return error;
  }

  shouldSkipChangedDuringSync(err) {
    return this.skipChangedFilesDuringSync && err && err.code === "DRIVEBRIDGE_CHANGED_DURING_SYNC";
  }

  shouldSkipSafeConflict(err) {
    return err && err.code === "DRIVEBRIDGE_SAFE_CONFLICT_SKIP";
  }

  pluginDataPath(filename) {
    return `${this.pluginDataDir()}/${filename}`;
  }

  pluginDataDir() {
    return this.manifest.dir || `${this.getConfigDir()}/plugins/${this.manifest.id}`;
  }

  async ensureAdapterFolderPath(folderPath) {
    const parts = folderPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  async writePluginDataFile(filename, content) {
    await this.ensureAdapterFolderPath(this.pluginDataDir());
    const path = this.pluginDataPath(filename);
    try {
      await this.app.vault.adapter.write(path, content);
    } catch (err) {
      if (!err || !String(err.message || err).includes("Parent folder doesn't exist")) {
        throw err;
      }
      await this.ensureAdapterFolderPath(this.pluginDataDir());
      await this.app.vault.adapter.write(path, content);
    }
  }

  async readPluginDataJson(filename) {
    const path = this.pluginDataPath(filename);
    if (!(await this.app.vault.adapter.exists(path))) return null;
    const text = await this.app.vault.adapter.read(path);
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  }

  async loadPluginDataJsonWithBackup(filename, backupFilename, missingValue, validate, failureConsequence = "Operation stopped.") {
    const candidates = [filename, backupFilename];
    const failures = [];
    for (const candidate of candidates) {
      const path = this.pluginDataPath(candidate);
      if (!(await this.app.vault.adapter.exists(path))) {
        continue;
      }
      try {
        const text = await this.app.vault.adapter.read(path);
        const value = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
        validate(value);
        if (candidate === backupFilename && failures.length) {
          const message = `${filename} is corrupted; using the verified ${backupFilename} backup. The damaged file was preserved.`;
          console.warn(`[drivebridge-obsidian-sync] ${message}`);
          this.pluginDataRecoveredFromBackup = this.pluginDataRecoveredFromBackup || new Set();
          this.pluginDataRecoveredFromBackup.add(filename);
          this.pluginDataRecoveryNotices = this.pluginDataRecoveryNotices || new Set();
          if (!this.pluginDataRecoveryNotices.has(filename)) {
            this.pluginDataRecoveryNotices.add(filename);
            new Notice(`DriveBridge: ${message}`, 10000);
          }
        }
        return value;
      } catch (err) {
        failures.push(`${candidate}: ${err && err.message ? err.message : String(err)}`);
      }
    }
    if (!failures.length) {
      return missingValue;
    }
    throw new Error(`${filename} is corrupted and no verified backup is available. ${failureConsequence} ${failures.join("; ")}`);
  }

  async writePluginDataFileAtomic(filename, backupFilename, content) {
    await this.ensureAdapterFolderPath(this.pluginDataDir());
    const path = this.pluginDataPath(filename);
    const backupPath = this.pluginDataPath(backupFilename);
    const tempPath = this.pluginDataPath(`${filename}.${randomId(8)}.tmp`);
    const recoveredFromBackup = Boolean(this.pluginDataRecoveredFromBackup && this.pluginDataRecoveredFromBackup.has(filename));
    const corruptedPath = recoveredFromBackup
      ? this.pluginDataPath(`${filename}.${Date.now()}.${randomId(6)}.corrupted`)
      : "";
    await this.app.vault.adapter.write(tempPath, content);
    let verified = "";
    let verificationPassed = false;
    let readFailed = false;
    for (const delayMs of ATOMIC_VERIFY_RETRY_DELAYS_MS) {
      if (delayMs) {
        await sleep(delayMs);
      }
      try {
        verified = await this.app.vault.adapter.read(tempPath);
        readFailed = false;
        if (atomicJsonContentEquivalent(content, verified)) {
          verificationPassed = true;
          break;
        }
      } catch (err) {
        readFailed = true;
      }
    }
    if (!verificationPassed) {
      await this.app.vault.adapter.remove(tempPath);
      throw new Error(
        `Atomic write verification failed for ${filename} ` +
        `(expected ${content.length} characters, ` +
        `${readFailed ? "final read failed" : `last read ${verified.length}`}, ` +
        `${ATOMIC_VERIFY_RETRY_DELAYS_MS.length} attempts).`
      );
    }
    let movedCurrent = false;
    let quarantinedCurrent = false;
    try {
      if (await this.app.vault.adapter.exists(path)) {
        if (recoveredFromBackup) {
          await this.app.vault.adapter.rename(path, corruptedPath);
          quarantinedCurrent = true;
        } else {
          if (await this.app.vault.adapter.exists(backupPath)) {
            await this.app.vault.adapter.remove(backupPath);
          }
          await this.app.vault.adapter.rename(path, backupPath);
          movedCurrent = true;
        }
      }
      await this.app.vault.adapter.rename(tempPath, path);
      if (recoveredFromBackup) {
        this.pluginDataRecoveredFromBackup.delete(filename);
      }
    } catch (err) {
      if (!(await this.app.vault.adapter.exists(path)) && movedCurrent && await this.app.vault.adapter.exists(backupPath)) {
        await this.app.vault.adapter.rename(backupPath, path);
      } else if (!(await this.app.vault.adapter.exists(path)) && quarantinedCurrent && await this.app.vault.adapter.exists(corruptedPath)) {
        await this.app.vault.adapter.rename(corruptedPath, path);
      }
      if (await this.app.vault.adapter.exists(tempPath)) {
        await this.app.vault.adapter.remove(tempPath);
      }
      throw err;
    }
  }

  getConfigDir() {
    return this.app.vault.configDir || ".obsidian";
  }

  isConfigPath(path) {
    const dir = this.getConfigDir();
    return path === dir || path.startsWith(`${dir}/`);
  }

  isExcluded(path) {
    if (this.isAlwaysExcluded(path)) {
      return true;
    }
    if (this.isConfigPath(path)) {
      return this.settings.obsidianSyncMode !== "safe" || !this.isSafeObsidianPath(path);
    }
    if (isInExcludedFolder(path, this.settings.excludedFolders)) {
      return true;
    }
    const patterns = patternLines(this.settings.excludedPatterns);
    return patterns.some((pattern) => globMatch(pattern, path));
  }

  isAlwaysExcluded(path) {
    const pluginDir = this.manifest.dir || `${this.getConfigDir()}/plugins/${this.manifest.id}`;
    if (path === pluginDir || path.startsWith(`${pluginDir}/`)) {
      return true;
    }
    if (path.endsWith("/snapshot.json") || path.endsWith("/sync-journal.json") || path.endsWith("/operation-journal.json") || path.endsWith(`/${REVIEW_QUEUE_FILE}`) || path.endsWith(`/${REMOTE_SNAPSHOT_FILE}`)) {
      return true;
    }
    const dir = this.getConfigDir();
    return OBSIDIAN_ALWAYS_EXCLUDE_PATTERNS.some((pattern) => {
      return globMatch(pattern.replace(/^\.obsidian/, dir), path);
    });
  }

  isSafeObsidianPath(path) {
    const dir = this.getConfigDir();
    return OBSIDIAN_SAFE_ALLOW_PATTERNS.some((pattern) => {
      return globMatch(pattern.replace(/^\.obsidian/, dir), path);
    });
  }

  shouldScanLocalFolder(path) {
    if (this.isAlwaysExcluded(path)) {
      return false;
    }
    if (this.isConfigPath(path)) {
      if (this.settings.obsidianSyncMode !== "safe") return false;
      const dir = this.getConfigDir();
      return OBSIDIAN_SAFE_ALLOW_PATTERNS.some((pattern) => {
        return isPrefixOfAnyPattern(path, [pattern.replace(/^\.obsidian/, dir)]);
      });
    }
    if (isInExcludedFolder(path, this.settings.excludedFolders)) {
      return false;
    }
    return !this.isExcluded(path);
  }

  shouldScanRemoteFolder(path) {
    return this.shouldScanLocalFolder(path);
  }

  updateSyncProgress(progress) {
    const text = this.formatProgressText(progress);
    const statusText = this.formatStatusProgressText(progress);
    this.currentSyncProgress = text;
    this.currentProgressState = {
      current: progress.current || 0,
      total: progress.total || 0,
      unit: progress.unit || ""
    };
    this.setSyncStatus(statusText, text.replace(/\n/g, " | "));
    if (!this.syncUiQuiet) {
      this.showProgressModal(text, this.currentProgressState);
    }
  }

  formatStatusProgressText(progress) {
    const parts = [];
    if (progress.total > 0) {
      const percent = Math.min(100, Math.floor((progress.current / progress.total) * 100));
      const fraction = progress.unit === "bytes"
        ? `${formatBytes(progress.current)} / ${formatBytes(progress.total)}`
        : `${progress.current}/${progress.total}`;
      parts.push(`DriveBridge ${fraction} (${percent}%)`);
    } else {
      parts.push(`DriveBridge ${progress.phase}`);
    }
    if (progress.action && progress.path) {
      const fileName = basename(progress.path);
      const tail = fileName.length > 42 ? `...${fileName.slice(-39)}` : fileName;
      parts.push(`${progress.action}: ${tail}`);
    } else if (progress.message) {
      parts.push(progress.message);
    }
    return parts.join(" | ");
  }

  formatProgressText(progress) {
    if (progress.total > 0) {
      const percent = Math.min(100, Math.floor((progress.current / progress.total) * 100));
      const fraction = progress.unit === "bytes"
        ? `${formatBytes(progress.current)} / ${formatBytes(progress.total)}`
        : `${progress.current}/${progress.total}`;
      const lines = [
        `DriveBridge ${progress.phase}: ${fraction} (${percent}%)`
      ];
      if (progress.action && progress.path) {
        lines.push(`${progress.action}: ${progress.path}`);
      }
      if (progress.message) {
        lines.push(progress.message);
      }
      return lines.join("\n");
    }
    return [
      `DriveBridge ${progress.phase}`,
      progress.message || "Preparing..."
    ].join("\n");
  }

  lastProgressForModal() {
    return this.currentProgressState || { current: 0, total: 0 };
  }

  setSyncStatus(message, fullMessage = message) {
    if (!this.statusBarItem) {
      return;
    }
    this.statusBarItem.setText(message);
    this.statusBarItem.setAttribute("title", fullMessage || "");
    this.statusBarItem.setAttribute("aria-label", fullMessage || "");
    this.statusBarItem.style.display = message ? "" : "none";
  }

  clearSyncStatus() {
    if (this.reviewCount > 0) {
      this.setSyncStatus(`DriveBridge: ${this.reviewCount} review`, `${this.reviewCount} DriveBridge conflict(s) need review.`);
    } else {
      this.setSyncStatus("");
    }
  }

  showProgressModal(message, progress) {
    if (this.progressCloseTimer) {
      window.clearTimeout(this.progressCloseTimer);
      this.progressCloseTimer = null;
    }
    if (!this.progressModal) {
      this.progressModal = new DriveBridgeProgressModal(this.app);
      this.progressModal.onClosed = () => {
        this.progressModal = null;
      };
      this.progressModal.open();
    }
    this.progressModal.update(message, progress);
  }

  scheduleProgressModalClose(delayMs) {
    if (this.progressCloseTimer) {
      window.clearTimeout(this.progressCloseTimer);
    }
    this.progressCloseTimer = window.setTimeout(() => {
      this.progressCloseTimer = null;
      if (this.progressModal) {
        this.progressModal.close();
        this.progressModal = null;
      }
    }, delayMs);
  }

  maxFileSizeBytes() {
    return Math.max(1, Number(this.settings.maxFileSizeMb) || DEFAULT_SETTINGS.maxFileSizeMb) * 1024 * 1024;
  }

  remoteDeleteTombstone(remoteItem) {
    return {
      deletedAt: new Date().toISOString(),
      remote: remoteItem ? {
        id: remoteItem.id,
        size: remoteItem.size,
        modifiedTime: remoteItem.modifiedTime,
        md5Checksum: remoteItem.md5Checksum || "",
        parentId: remoteItem.parentId || ""
      } : null
    };
  }

  mergeRemoteDeleteTombstones(previousDeleted, newDeleted, remoteState) {
    const now = Date.now();
    const merged = Object.assign({}, previousDeleted || {}, newDeleted || {});
    for (const path of Object.keys(merged)) {
      if (remoteState[path] || !this.remoteDeleteTombstoneIsFresh(merged[path], now)) {
        delete merged[path];
      }
    }
    return merged;
  }

  remoteDeleteTombstoneIsFresh(tombstone, now = Date.now()) {
    const deletedAt = Date.parse(tombstone && tombstone.deletedAt || "");
    return Number.isFinite(deletedAt) && now - deletedAt <= REMOTE_DELETE_TOMBSTONE_RETENTION_MS;
  }

  localChangedAfterRemoteDeletion(localItem, tombstone) {
    const deletedAt = Date.parse(tombstone && tombstone.deletedAt || "");
    if (!Number.isFinite(deletedAt)) {
      return true;
    }
    return localItem && localItem.mtime > deletedAt + 2000;
  }

  snapshotFrom(localItem, remoteItem) {
    return {
      local: localItem ? { size: localItem.size, mtime: localItem.mtime, sha256: localItem.sha256 || "" } : null,
      remote: remoteItem ? {
        id: remoteItem.id,
        size: remoteItem.size,
        modifiedTime: remoteItem.modifiedTime,
        md5Checksum: remoteItem.md5Checksum || "",
        parentId: remoteItem.parentId || ""
      } : null
    };
  }

  formatPlanSummary(plan, dryRun, elapsedMs) {
    const lines = [
      dryRun ? "Preview only. No files changed." : "Planned real sync.",
      `DriveBridge version: ${this.manifest.version}`,
      `${dryRun ? "Completed" : "Planned"} at: ${formatLogDateTime(new Date())}`,
      `Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
      `Mode: ${this.settings.syncMode}`,
      `Conflict handling: ${this.settings.conflictAction || DEFAULT_SETTINGS.conflictAction}`,
      `Protect modify threshold: ${this.settings.protectModifyPercentage ?? DEFAULT_SETTINGS.protectModifyPercentage}%`,
      `Upload: ${plan.stats.upload}`,
      `Download: ${plan.stats.download}`,
      `Move remote: ${plan.stats.moveRemote}`,
      `Conflicts: ${plan.stats.conflict}`,
      `Adopt unchanged: ${plan.stats.adopt}`,
      `Delete local: ${plan.stats.deleteLocal}`,
      `Delete remote: ${plan.stats.deleteRemote}`,
      `Skipped: ${plan.stats.skip}`
    ];
    const notable = plan.entries
      .filter((entry) => entry.action !== "skip" && entry.action !== "adopt")
      .slice(0, 20)
      .map((entry) => `- ${entry.action}: ${entry.path} (${entry.reason})`);
    if (notable.length) {
      lines.push("", "First planned changes:", ...notable);
    }
    return lines.join("\n");
  }

  formatExecutionSummary(executed, elapsedMs) {
    const incomplete = executed.errors.length || executed.skippedChanged.length || executed.skippedSafe.length || executed.reviewItems.length;
    const lines = [
      `${incomplete ? "Completed with pending items" : "Completed"} in ${(elapsedMs / 1000).toFixed(1)}s`,
      `DriveBridge version: ${this.manifest.version}`,
      `Completed at: ${formatLogDateTime(new Date())}`,
      `Data processed: ${formatBytes(executed.processedBytes || 0)} / ${formatBytes(executed.totalBytes || 0)}`,
      `Uploaded: ${executed.stats.upload}`,
      `Downloaded: ${executed.stats.download}`,
      `Moved remote: ${executed.stats.moveRemote}`,
      `Conflicts: ${executed.stats.conflict}`,
      `Queued for review: ${executed.stats.review}`,
      `Adopted: ${executed.stats.adopt}`,
      `Deleted local: ${executed.stats.deleteLocal}`,
      `Deleted remote: ${executed.stats.deleteRemote}`,
      `Skipped: ${executed.stats.skip}`,
      `Errors: ${executed.errors.length}`
    ];
    if (executed.performance) {
      lines.push(
        `Drive API requests: ${executed.performance.driveRequests}`,
        `Reserved-ID batch requests: ${executed.performance.idReservationRequests}`,
        `Recovery-only lookups: ${executed.performance.recoveryLookups}`,
        `Duplicate guard preflight parents: ${executed.performance.duplicateGuardPreflightParents || 0}`,
        `Duplicate guard postflight parents: ${executed.performance.duplicateGuardPostflightParents || 0}`,
        `Duplicate creates self-healed: ${executed.performance.duplicateGuardSelfHealed || 0}`,
        `Remote snapshot writes: ${executed.performance.remoteSnapshotWrites}`,
        `Remote snapshot writes skipped: ${executed.performance.remoteSnapshotWriteSkipped}`,
        `Remote snapshot conflict merges: ${executed.performance.remoteSnapshotConflictMerges}`
      );
    }
    if (executed.skippedChanged && executed.skippedChanged.length) {
      lines.push("", "Skipped because files changed before/during sync:", ...this.formatSkipLines(executed.skippedChanged, 20));
      lines.push("", `Full latest run details are saved in ${JOURNAL_FILE}.`);
    }
    if (executed.skippedSafe && executed.skippedSafe.length) {
      lines.push("", "Skipped for manual review:", ...this.formatSkipLines(executed.skippedSafe, 20));
      lines.push("", "These files were not auto-resolved because doing so could create heavy or unsafe conflict work.");
      lines.push("", `Full latest run details are saved in ${JOURNAL_FILE}.`);
    }
    if (executed.reviewItems && executed.reviewItems.length) {
      lines.push("", "Queued for BAS-style conflict review:", ...executed.reviewItems.slice(0, 20).map((item) => `- ${item.path} (${item.reason})`));
      if (executed.reviewItems.length > 20) {
        lines.push(`...and ${executed.reviewItems.length - 20} more conflict(s).`);
      }
    }
    if (executed.errors.length) {
      lines.push("", "Error details:", ...this.formatErrorLines(executed.errors, 20));
      lines.push("", `Full latest run details are saved in ${JOURNAL_FILE}.`);
    }
    return lines.join("\n");
  }

  formatFatalErrorSummary(error, elapsedMs) {
    return [
      `Failed after ${(elapsedMs / 1000).toFixed(1)}s`,
      `Stopped at: ${formatLogDateTime(new Date())}`,
      "",
      "Error details:",
      ...this.formatErrorLines([error], 1),
      "",
      `Latest failure details are saved in ${JOURNAL_FILE}.`
    ].join("\n");
  }

  formatErrorModalMessage(title, errors) {
    return [
      title,
      "",
      ...this.formatErrorLines(errors, 3),
      "",
      `Also saved in ${JOURNAL_FILE} and shown in DriveBridge settings.`
    ].join("\n");
  }

  formatErrorLines(errors, limit) {
    const visible = errors.slice(0, limit).map((error, index) => {
      const line = `${index + 1}. ${error.action}: ${error.path}`;
      return `${line}\n   Time: ${error.time || "unknown"}\n   Error: ${error.message}`;
    });
    const remaining = errors.length - visible.length;
    if (remaining > 0) {
      visible.push(`...and ${remaining} more error(s).`);
    }
    return visible;
  }

  errorRecord(entry, err) {
    return {
      path: entry.path || "",
      action: entry.action || "",
      message: err && err.message ? err.message : String(err),
      name: err && err.name ? err.name : "",
      time: new Date().toISOString()
    };
  }

  skipRecord(entry, err) {
    return {
      path: entry.path || "",
      action: entry.action || "",
      reason: err && err.message ? err.message : String(err),
      side: err && err.side ? err.side : "",
      details: err && err.details ? err.details : "",
      time: new Date().toISOString()
    };
  }

  formatSkipLines(skipped, limit) {
    const visible = skipped.slice(0, limit).map((item, index) => {
      const line = `${index + 1}. ${item.action}: ${item.path}`;
      const details = item.details ? `\n   Details: ${item.details}` : "";
      return `${line}\n   Side: ${item.side || "unknown"}\n   Reason: ${item.reason}${details}`;
    });
    const remaining = skipped.length - visible.length;
    if (remaining > 0) {
      visible.push(`...and ${remaining} more skipped file(s).`);
    }
    return visible;
  }
};

class DriveBridgeProgressModal extends Modal {
  constructor(app) {
    super(app);
    this.message = "";
    this.progress = null;
    this.statusEl = null;
    this.progressEl = null;
    this.progressTextEl = null;
    this.onClosed = null;
    this.titleEl = null;
    this.footerEl = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("drivebridge-progress-modal");
    this.titleEl = contentEl.createEl("h2", { text: this.titleForMessage(this.message) });
    this.progressEl = contentEl.createEl("progress", {
      cls: "drivebridge-progress-bar"
    });
    this.progressTextEl = contentEl.createEl("div", {
      cls: "drivebridge-progress-count"
    });
    this.statusEl = contentEl.createEl("pre", {
      text: this.message || "Starting...",
      cls: "drivebridge-progress-message"
    });
    this.footerEl = contentEl.createEl("p", {
      text: this.footerForMessage(this.message),
      cls: "drivebridge-muted"
    });
    this.updateProgressElements();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.onClosed) {
      this.onClosed();
    }
  }

  update(message, progress) {
    this.message = message;
    if (progress) {
      this.progress = progress;
    }
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
    if (this.titleEl) {
      this.titleEl.setText(this.titleForMessage(message));
    }
    if (this.footerEl) {
      this.footerEl.setText(this.footerForMessage(message));
    }
    this.updateProgressElements();
  }

  titleForMessage(message) {
    const text = String(message || "");
    if (text.includes("REPAIR REMOTE INDEX — QUEUED")) return "Repair is queued";
    if (text.includes("REPAIR REMOTE INDEX — COMPLETE")) return "Repair complete";
    if (text.includes("REPAIR REMOTE INDEX — STOPPED")) return "Repair stopped";
    if (text.includes("REPAIR REMOTE INDEX") || text.includes("DriveBridge REPAIR")) return "Repair remote index";
    if (text.includes("failed") || text.includes("Error:")) return "Normal sync stopped";
    return "Normal sync is running";
  }

  footerForMessage(message) {
    const text = String(message || "");
    if (text.includes("QUEUED")) return "Repair will start automatically; keep Obsidian open.";
    if (text.includes("COMPLETE")) return "Repair finished. You may continue with Normal Preview.";
    if (text.includes("STOPPED")) return "Resolve the displayed cause before retrying Repair.";
    if (text.includes("REPAIR REMOTE INDEX")) return "Keep Obsidian open. This is metadata Repair, not a normal backup.";
    return "Keep Obsidian open and avoid editing notes until this finishes.";
  }

  updateProgressElements() {
    if (!this.progressEl || !this.progressTextEl) {
      return;
    }
    const current = this.progress && this.progress.current ? this.progress.current : 0;
    const total = this.progress && this.progress.total ? this.progress.total : 0;
    const unit = this.progress && this.progress.unit ? this.progress.unit : "";
    if (total > 0) {
      const percent = Math.min(100, Math.floor((current / total) * 100));
      const fraction = unit === "bytes"
        ? `${formatBytes(current)} / ${formatBytes(total)}`
        : `${current}/${total}`;
      this.progressEl.style.display = "";
      this.progressTextEl.style.display = "";
      this.progressEl.max = total;
      this.progressEl.value = current;
      this.progressTextEl.setText(`${fraction} (${percent}%)`);
    } else {
      this.progressEl.style.display = "none";
      this.progressTextEl.style.display = "none";
    }
  }
}

class DriveBridgeConflictReviewModal extends Modal {
  constructor(app, plugin, queue) {
    super(app);
    this.plugin = plugin;
    this.queue = queue;
    this.selectedId = queue.items.length ? queue.items[0].id : "";
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  async refreshQueue() {
    this.queue = await this.plugin.loadReviewQueue();
    if (!this.queue.items.some((item) => item.id === this.selectedId)) {
      this.selectedId = this.queue.items.length ? this.queue.items[0].id : "";
    }
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("drivebridge-review-modal");
    contentEl.createEl("h2", { text: `DriveBridge conflict review (${this.queue.items.length})` });
    if (!this.queue.items.length) {
      contentEl.createEl("p", { text: "No conflicts need review.", cls: "drivebridge-muted" });
      return;
    }

    const layout = contentEl.createDiv({ cls: "drivebridge-review-layout" });
    const list = layout.createDiv({ cls: "drivebridge-review-list" });
    const detail = layout.createDiv({ cls: "drivebridge-review-detail" });
    for (const item of this.queue.items) {
      const button = list.createEl("button", {
        cls: `drivebridge-review-item${item.id === this.selectedId ? " is-selected" : ""}`
      });
      button.createDiv({ text: item.path, cls: "drivebridge-review-path" });
      button.createDiv({ text: item.reason, cls: "drivebridge-muted" });
      button.addEventListener("click", () => {
        this.selectedId = item.id;
        this.render();
      });
    }

    const selected = this.queue.items.find((item) => item.id === this.selectedId) || this.queue.items[0];
    detail.createEl("h3", { text: selected.path });
    detail.createEl("p", { text: selected.reason, cls: "drivebridge-muted" });
    const compare = detail.createDiv({ cls: "drivebridge-review-compare" });
    this.renderSide(compare, "Local", selected.local);
    this.renderSide(compare, "Google Drive", selected.remote);
    if (selected.type === "duplicateRepair") {
      detail.createEl("p", {
        text: `${(selected.remoteCandidates || []).length} Drive candidates. Automatic selection is disabled because content or folder identity is ambiguous. Use Duplicate-aware repair Preview again after renaming or reviewing the candidates in Google Drive.`,
        cls: "drivebridge-muted"
      });
      const deferOnly = detail.createDiv({ cls: "drivebridge-review-actions" });
      const defer = deferOnly.createEl("button", { text: "Defer" });
      defer.addEventListener("click", () => this.close());
      return;
    }
    detail.createEl("p", {
      text: "The version not chosen as canonical is saved as a conflict backup.",
      cls: "drivebridge-muted"
    });
    const actions = detail.createDiv({ cls: "drivebridge-review-actions" });
    this.addAction(actions, "Use Local", "keepLocal", selected.id, true);
    this.addAction(actions, "Use Drive", "keepRemote", selected.id, false);
    this.addAction(actions, "Keep both (Local canonical)", "keepBoth", selected.id, false);
    const defer = actions.createEl("button", { text: "Defer" });
    defer.addEventListener("click", () => this.close());
  }

  renderSide(parent, title, info) {
    const card = parent.createDiv({ cls: "drivebridge-review-side" });
    card.createEl("h4", { text: title });
    if (!info) {
      card.createEl("p", { text: "Missing", cls: "drivebridge-muted" });
      return;
    }
    card.createEl("div", { text: `Size: ${formatBytes(info.size || 0)}` });
    if (info.mtime) {
      card.createEl("div", { text: `Modified: ${new Date(info.mtime).toLocaleString()}` });
    }
    if (info.modifiedTime) {
      card.createEl("div", { text: `Modified: ${new Date(info.modifiedTime).toLocaleString()}` });
    }
    const hash = info.sha256 || info.md5Checksum || "not available";
    card.createEl("div", { text: `Hash: ${hash}`, cls: "drivebridge-review-hash" });
  }

  addAction(parent, label, action, itemId, cta) {
    const button = parent.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
    button.addEventListener("click", async () => {
      const buttons = Array.from(parent.querySelectorAll("button"));
      buttons.forEach((candidate) => { candidate.disabled = true; });
      try {
        await this.plugin.resolveReviewItem(itemId, action);
        await this.refreshQueue();
      } catch (err) {
        new Notice(err && err.message ? err.message : String(err), 10000);
        buttons.forEach((candidate) => { candidate.disabled = false; });
      }
    });
  }
}

class DriveBridgeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("drivebridge-settings");
    containerEl.createEl("h2", { text: "DriveBridge for Obsidian" });

    new Setting(containerEl)
      .setName("OAuth Client ID")
      .setDesc("OAuth client ID created in Google Cloud Console.")
      .addText((text) => text
        .setPlaceholder("client-id.apps.googleusercontent.com")
        .setValue(this.plugin.settings.clientId)
        .onChange(async (value) => {
          this.plugin.settings.clientId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("OAuth Client Secret")
      .setDesc("Enter this only if your OAuth client type requires a client secret.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Root folder name")
      .setDesc("Google Drive folder name used as the remote vault root.")
      .addText((text) => text
        .setValue(this.plugin.settings.rootFolderName)
        .onChange(async (value) => {
          const nextName = value.trim() || DEFAULT_SETTINGS.rootFolderName;
          if (nextName !== this.plugin.settings.rootFolderName) {
            this.plugin.settings.rootFolderName = nextName;
            this.plugin.settings.rootFolderId = "";
            this.plugin.settings.duplicateGuardRootChanged = true;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("Use bidirectional for normal sync. Push-only and pull-only are useful for first-time migration.")
      .addDropdown((dropdown) => dropdown
        .addOption("bidirectional", "Bidirectional")
        .addOption("push", "Push local to Drive")
        .addOption("pull", "Pull Drive to local")
        .setValue(this.plugin.settings.syncMode)
        .onChange(async (value) => {
          this.plugin.settings.syncMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Preview by default")
      .setDesc("Commands and automatic sync create a plan without modifying files by default.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.dryRunDefault)
        .onChange(async (value) => {
          this.plugin.settings.dryRunDefault = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Safe initial sync")
      .setDesc("Blocks real sync without explicit approval when both sides contain files and no initial snapshot exists.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.safeInitialSync)
        .onChange(async (value) => {
          this.plugin.settings.safeInitialSync = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Allow first real sync once")
      .setDesc("Allow one first real sync after you have reviewed the preview result.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.allowFirstRealSync)
        .onChange(async (value) => {
          this.plugin.settings.allowFirstRealSync = value;
          this.plugin.settings.approvedFirstSyncDigest = value ? (this.plugin.settings.lastPreviewDigest || "") : "";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Sync deletes")
      .setDesc("Move files deleted on one side to the trash on the other side. Keeping this off is recommended at first.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncDeletes)
        .onChange(async (value) => {
          this.plugin.settings.syncDeletes = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Allow one large delete plan")
      .setDesc("After Preview, approve only that exact plan when 10+ or 20%+ of known files would be deleted. Resets after sync.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.allowLargeDeleteOnce)
        .onChange(async (value) => {
          this.plugin.settings.allowLargeDeleteOnce = value;
          this.plugin.settings.approvedDeletePlanDigest = value ? (this.plugin.settings.lastPreviewDigest || "") : "";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Conflict handling")
      .setDesc("Manual review queues conflicts without blocking other safe files. Automatic modes remain available for advanced use.")
      .addDropdown((dropdown) => dropdown
        .addOption("manualReview", "Manual review (recommended)")
        .addOption("newerWithBackup", "Keep newest, backup older")
        .addOption("keepLocalWithBackup", "Keep local, backup remote")
        .addOption("keepRemoteWithBackup", "Keep remote, backup local")
        .addOption("keepBothLocalWins", "Keep both, local wins")
        .setValue(this.plugin.settings.conflictAction || DEFAULT_SETTINGS.conflictAction)
        .onChange(async (value) => {
          this.plugin.settings.conflictAction = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Protect modify percentage")
      .setDesc("Abort real sync if more than this percentage of local files would change/delete. Set 100 to disable.")
      .addText((text) => text
        .setPlaceholder("40")
        .setValue(String(this.plugin.settings.protectModifyPercentage ?? DEFAULT_SETTINGS.protectModifyPercentage))
        .onChange(async (value) => {
          this.plugin.settings.protectModifyPercentage = Math.max(0, Math.min(100, Number(value) || DEFAULT_SETTINGS.protectModifyPercentage));
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Root folder ID")
      .setDesc("Optional advanced override. Use this to pin DriveBridge to one Google Drive folder when duplicate folder names exist.")
      .addText((text) => text
        .setPlaceholder("Google Drive folder ID")
        .setValue(this.plugin.settings.rootFolderId)
        .onChange(async (value) => {
          const nextId = value.trim();
          if (nextId !== this.plugin.settings.rootFolderId) {
            this.plugin.settings.rootFolderId = nextId;
            this.plugin.settings.duplicateGuardRootChanged = true;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName("Duplicate guard")
      .setDesc("Auto protects only new Drive creates: a lone create uses small exact-name pre/post checks, while batches share parent scans. Strict refreshes the parent before every create. Existing-file updates and unchanged syncs add no guard requests; Off is fastest but less safe.")
      .addDropdown((dropdown) => dropdown
        .addOption("auto", "Auto")
        .addOption("strict", "Strict")
        .addOption("off", "Off")
        .setValue(this.plugin.settings.duplicateGuardMode || DEFAULT_SETTINGS.duplicateGuardMode)
        .onChange(async (value) => {
          this.plugin.settings.duplicateGuardMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Obsidian config sync")
      .setDesc("Off excludes .obsidian. Safe syncs themes, snippets, hotkeys, plugin files, and selected config while always excluding tokens, plugin data, workspaces, and DriveBridge state.")
      .addDropdown((dropdown) => dropdown
        .addOption("off", "Off")
        .addOption("safe", "Safe")
        .setValue(this.plugin.settings.obsidianSyncMode || DEFAULT_SETTINGS.obsidianSyncMode)
        .onChange(async (value) => {
          this.plugin.settings.obsidianSyncMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Auto sync on startup")
      .setDesc("Run sync after Obsidian starts. If Preview by default is on, startup sync only creates a preview.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSyncOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.autoSyncOnStartup = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Auto sync interval minutes")
      .setDesc("Set to 0 to disable. Restart Obsidian after changing this value.")
      .addText((text) => text
        .setPlaceholder("0")
        .setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
        .onChange(async (value) => {
          this.plugin.settings.autoSyncIntervalMinutes = Math.max(0, Number(value) || 0);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Max file size MB")
      .setDesc("Files larger than this limit are skipped.")
      .addText((text) => text
        .setPlaceholder("50")
        .setValue(String(this.plugin.settings.maxFileSizeMb))
        .onChange(async (value) => {
          this.plugin.settings.maxFileSizeMb = Math.max(1, Number(value) || DEFAULT_SETTINGS.maxFileSizeMb);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("One vault-relative folder per line. Files below these folders stay local-only and are not uploaded, downloaded, or deleted remotely.")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
        text.setPlaceholder("folder/to/keep-local")
          .setValue(this.plugin.settings.excludedFolders || "")
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Excluded patterns")
      .setDesc("One pattern per line. `*` and `**` are supported. Excluded paths are local-only and are not uploaded, downloaded, or deleted remotely.")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.cols = 40;
        text.setValue(this.plugin.settings.excludedPatterns)
          .onChange(async (value) => {
            this.plugin.settings.excludedPatterns = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Authorize")
      .setDesc("Use Step 1 to get a code, complete Google authorization, then press Step 2.")
      .addButton((button) => button
        .setButtonText("Step 1: Get code")
        .onClick(async () => {
          await runUiAction(() => this.plugin.startDeviceAuth());
          this.display();
        }))
      .addButton((button) => button
        .setButtonText("Step 2: Finish")
        .onClick(async () => {
          await runUiAction(() => this.plugin.finishDeviceAuth());
          this.display();
        }));

    if (this.plugin.settings.userCode) {
      containerEl.createEl("p", {
        text: `Open ${this.plugin.settings.verificationUrl} and enter ${this.plugin.settings.userCode}`,
        cls: "drivebridge-muted"
      });
    }

    new Setting(containerEl)
      .setName("Sync")
      .setDesc("Preview does not modify files. Run sync applies the planned changes.")
      .addButton((button) => button
        .setButtonText("Preview")
        .onClick(async () => {
          await this.plugin.previewSync();
          this.display();
        }))
      .addButton((button) => button
        .setButtonText("Run sync")
        .setCta()
        .onClick(async () => {
          await this.plugin.syncNow({ dryRun: false });
          this.display();
        }));

    new Setting(containerEl)
      .setName("Conflict review")
      .setDesc(`${this.plugin.reviewCount || 0} conflict(s) are waiting. Other safe files continue syncing.`)
      .addButton((button) => button
        .setButtonText("Open review")
        .setDisabled(!this.plugin.reviewCount)
        .onClick(async () => {
          await runUiAction(() => this.plugin.openConflictReview());
        }));

    new Setting(containerEl)
      .setName("Repair remote index — not Normal sync")
      .setDesc(`Use only when DriveBridge asks for index repair. This full-scans Google Drive metadata and rewrites ${REMOTE_SNAPSHOT_FILE}; it does not upload/download normal note files and is not the regular backup button. Wait for REPAIR COMPLETE before running Normal Preview and Normal sync.`)
      .addButton((button) => button
        .setButtonText("Start index repair")
        .onClick(async () => {
          await runUiAction(() => this.plugin.rebuildRemoteSnapshotFromDrive());
          this.display();
        }));

    new Setting(containerEl)
      .setName("Duplicate-aware repair")
      .setDesc("Preview scans Google Drive only when requested. Apply moves only byte-identical extra files to Drive trash; ambiguous files and folders go to Manual Review.")
      .addButton((button) => button
        .setButtonText("1. Preview duplicates")
        .onClick(async () => {
          await runUiAction(() => this.plugin.scanDuplicateRepairPlan());
          this.display();
        }))
      .addButton((button) => button
        .setButtonText("2. Apply safe repair")
        .setWarning()
        .onClick(async () => {
          await runUiAction(() => this.plugin.applyDuplicateRepairPlan());
          this.display();
        }));

    new Setting(containerEl)
      .setName("Recovery")
      .setDesc("Use in order after an interrupted sync.");

    const recoveryButtonsEl = containerEl.createDiv({ cls: "drivebridge-recovery-flow" });
    this.addRecoveryButton(recoveryButtonsEl, "1. Preview recovery", false, async () => {
      await runUiAction(() => this.plugin.previewRecovery());
      this.display();
    });
    this.addRecoveryButton(recoveryButtonsEl, "2. Discard partial downloads", false, async () => {
      await runUiAction(() => this.plugin.discardPartialDownloads());
      this.display();
    });
    this.addRecoveryButton(recoveryButtonsEl, "3. Normal Preview", !this.plugin.settings.recoveryPreviewSafe, async () => {
      await this.plugin.previewSync();
      this.display();
    });
    const resumeEnabled = this.plugin.settings.recoveryPreviewSafe &&
      Boolean(this.plugin.settings.recoveryPreviewRunId) &&
      this.plugin.settings.recoveryPlanPreviewRunId === this.plugin.settings.recoveryPreviewRunId &&
      Boolean(this.plugin.settings.recoveryPlanPreviewAt) &&
      this.plugin.settings.recoveryPlanPreviewSafe;
    this.addRecoveryButton(recoveryButtonsEl, "4. Resume safe operations", !resumeEnabled, async () => {
      await runUiAction(() => this.plugin.syncNow({ dryRun: false, recoveryResume: true }));
      this.display();
    }, true);

    if (this.plugin.settings.lastRecoverySummary) {
      containerEl.createEl("div", {
        text: this.plugin.settings.lastRecoverySummary,
        cls: "drivebridge-status"
      });
    }

    if (this.plugin.syncing && this.plugin.currentSyncProgress) {
      containerEl.createEl("div", {
        text: this.plugin.currentSyncProgress,
        cls: "drivebridge-status drivebridge-live-status"
      });
    }

    containerEl.createEl("div", {
      text: this.plugin.settings.lastSyncSummary || "No sync has run yet.",
      cls: "drivebridge-status"
    });
  }

  addRecoveryButton(parentEl, text, disabled, onClick, cta = false) {
    const button = parentEl.createEl("button", {
      text,
      cls: cta ? "mod-cta" : ""
    });
    button.disabled = disabled;
    button.addEventListener("click", onClick);
  }
}

async function runUiAction(action) {
  try {
    await action();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    new Notice(message);
    console.error("[drivebridge-obsidian-sync]", err);
  }
}

async function customFetch(url, options = {}) {
  const method = options.method || "GET";
  const headers = {};
  if (options.headers) {
    if (typeof options.headers.forEach === "function") {
      options.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else {
      Object.assign(headers, options.headers);
    }
  }
  let body = options.body;
  if (body instanceof URLSearchParams) {
    body = body.toString();
  }
  const requestParam = {
    url,
    method,
    headers,
    throw: false
  };
  if (body !== undefined) {
    if (ArrayBuffer.isView(body)) {
      requestParam.body = body.buffer;
    } else {
      requestParam.body = body;
    }
  }
  const res = await requestUrl(requestParam);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    statusText: `HTTP ${res.status}`,
    text: async () => res.text,
    json: async () => res.json,
    arrayBuffer: async () => res.arrayBuffer,
    headers: {
      get: (name) => res.headers[name.toLowerCase()] || res.headers[name]
    }
  };
}

async function parseJsonResponse(res) {
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const detail = data.error_description || (data.error && data.error.message) || data.error || res.statusText;
    const error = new Error(`HTTP ${res.status}: ${detail}`);
    error.status = res.status;
    error.responseData = data;
    throw error;
  }
  return data;
}

function newEmptyStats() {
  return {
    upload: 0,
    download: 0,
    moveRemote: 0,
    conflict: 0,
    review: 0,
    adopt: 0,
    deleteLocal: 0,
    deleteRemote: 0,
    skip: 0,
    error: 0
  };
}

function statsFromEntries(entries) {
  const stats = newEmptyStats();
  for (const entry of entries) {
    stats[entry.action] = (stats[entry.action] || 0) + 1;
  }
  return stats;
}

function remoteInfo(path, file) {
  return {
    id: file.id,
    name: file.name || basename(path),
    path,
    size: Number(file.size || 0),
    modifiedTime: file.modifiedTime,
    md5Checksum: file.md5Checksum || "",
    parentId: file.parentId || (file.parents && file.parents.length ? file.parents[0] : "")
  };
}

function normalizeRemoteState(value) {
  if (value && value.files && typeof value.files === "object") {
    return {
      files: value.files || {},
      deleted: value.deleted && typeof value.deleted === "object" ? value.deleted : {}
    };
  }
  return {
    files: value && typeof value === "object" ? value : {},
    deleted: {}
  };
}

function basename(path) {
  return path.split("/").pop();
}

function parentPath(path) {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function sameLocal(previous, current) {
  if (!previous || previous.size !== current.size) {
    return false;
  }
  if (previous.sha256 && current.sha256) {
    return previous.sha256 === current.sha256;
  }
  return Math.abs(previous.mtime - current.mtime) < 2000;
}

function sameRemote(previous, current) {
  return previous &&
    previous.size === current.size &&
    previous.modifiedTime === current.modifiedTime &&
    (previous.md5Checksum || "") === (current.md5Checksum || "");
}

function compareRemoteCreationOrder(left, right) {
  const leftTime = Date.parse(left && left.createdTime || "");
  const rightTime = Date.parse(right && right.createdTime || "");
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER;
  if (normalizedLeft !== normalizedRight) {
    return normalizedLeft - normalizedRight;
  }
  return String(left && left.id || "").localeCompare(String(right && right.id || ""));
}

function sameDriveContentExact(left, right) {
  const leftMd5 = String(left && left.md5Checksum || "").toLowerCase();
  const rightMd5 = String(right && right.md5Checksum || "").toLowerCase();
  return Boolean(leftMd5) &&
    leftMd5 === rightMd5 &&
    Number(left && left.size || 0) === Number(right && right.size || 0);
}

function sameLocalStrict(previous, current) {
  if (!previous || !current || previous.size !== current.size || previous.mtime !== current.mtime) {
    return false;
  }
  if (previous.sha256 && current.sha256) {
    return previous.sha256 === current.sha256;
  }
  return true;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error(`${SNAPSHOT_FILE} must contain an object.`);
  }
  for (const [path, value] of Object.entries(snapshot)) {
    if (!path || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${SNAPSHOT_FILE} contains an invalid entry for ${path || "(empty path)"}.`);
    }
    if (value.local !== null && value.local !== undefined && typeof value.local !== "object") {
      throw new Error(`${SNAPSHOT_FILE} contains invalid local metadata for ${path}.`);
    }
    if (value.remote !== null && value.remote !== undefined && typeof value.remote !== "object") {
      throw new Error(`${SNAPSHOT_FILE} contains invalid remote metadata for ${path}.`);
    }
  }
}

function validateOperationJournal(journal) {
  if (!journal || typeof journal !== "object" || Array.isArray(journal) ||
      ![1, 2].includes(Number(journal.version)) ||
      typeof journal.runId !== "string" || !journal.runId ||
      !journal.operations || typeof journal.operations !== "object" || Array.isArray(journal.operations)) {
    throw new Error(`${OPERATION_JOURNAL_FILE} has an unsupported format.`);
  }
  for (const [path, operation] of Object.entries(journal.operations)) {
    if (!path || !operation || typeof operation !== "object" || Array.isArray(operation) ||
        operation.path !== path || typeof operation.action !== "string") {
      throw new Error(`${OPERATION_JOURNAL_FILE} contains an invalid operation for ${path || "(empty path)"}.`);
    }
  }
}

function validateReviewQueue(queue) {
  if (!queue || queue.version !== 1 || !Array.isArray(queue.items)) {
    throw new Error(`${REVIEW_QUEUE_FILE} has an unsupported format.`);
  }
  const ids = new Set();
  for (const [index, item] of queue.items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof item.id !== "string" || !item.id || typeof item.path !== "string" || !item.path) {
      throw new Error(`${REVIEW_QUEUE_FILE} contains an invalid item at index ${index}.`);
    }
    if (ids.has(item.id)) {
      throw new Error(`${REVIEW_QUEUE_FILE} contains duplicate item id ${item.id}.`);
    }
    ids.add(item.id);
    for (const side of ["local", "remote"]) {
      if (item[side] !== null && item[side] !== undefined &&
          (typeof item[side] !== "object" || Array.isArray(item[side]))) {
        throw new Error(`${REVIEW_QUEUE_FILE} contains invalid ${side} metadata for ${item.path}.`);
      }
    }
  }
}

function reviewIdentityKey(path, localItem, remoteItem) {
  const value = JSON.stringify({
    path,
    local: localItem ? {
      size: localItem.size,
      mtime: localItem.mtime,
      sha256: localItem.sha256 || ""
    } : null,
    remote: remoteItem ? {
      id: remoteItem.id || "",
      size: remoteItem.size,
      modifiedTime: remoteItem.modifiedTime || "",
      md5Checksum: remoteItem.md5Checksum || ""
    } : null
  });
  return md5Hex(new TextEncoder().encode(value).buffer);
}

function planDigest(plan, context) {
  const entries = (plan.entries || []).map((entry) => ({
    path: entry.path,
    fromPath: entry.fromPath || "",
    action: entry.action,
    reason: entry.reason || "",
    local: context.local[entry.path] || null,
    remote: context.remote[entry.path] || null,
    fromRemote: entry.fromPath ? context.remote[entry.fromPath] || null : null
  }));
  return md5Hex(new TextEncoder().encode(JSON.stringify(entries)).buffer);
}

function randomId(length = 8) {
  const bytes = new Uint8Array(Math.max(4, length));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function sameRemoteContent(previous, current) {
  if (!previous || !current || previous.size !== current.size) {
    return false;
  }
  if (previous.md5Checksum && current.md5Checksum) {
    return previous.md5Checksum === current.md5Checksum;
  }
  return sameRemote(previous, current);
}

function remoteDiffDetails(previous, current) {
  if (!previous) {
    return "planned remote missing";
  }
  if (!current) {
    return `current remote missing or trashed; planned id=${previous.id || ""}, size=${previous.size || 0}, md5=${previous.md5Checksum || ""}, modifiedTime=${previous.modifiedTime || ""}`;
  }
  const parts = [];
  if ((previous.id || "") !== (current.id || "")) {
    parts.push(`id planned=${previous.id || ""} current=${current.id || ""}`);
  }
  if (Number(previous.size || 0) !== Number(current.size || 0)) {
    parts.push(`size planned=${previous.size || 0} current=${current.size || 0}`);
  }
  if ((previous.md5Checksum || "") !== (current.md5Checksum || "")) {
    parts.push(`md5 planned=${previous.md5Checksum || ""} current=${current.md5Checksum || ""}`);
  }
  if ((previous.modifiedTime || "") !== (current.modifiedTime || "")) {
    parts.push(`modifiedTime planned=${previous.modifiedTime || ""} current=${current.modifiedTime || ""}`);
  }
  if ((previous.parentId || "") !== (current.parentId || "")) {
    parts.push(`parentId planned=${previous.parentId || ""} current=${current.parentId || ""}`);
  }
  return parts.length ? parts.join("; ") : "remote metadata differs";
}

function sameSize(localItem, remoteItem) {
  return localItem && remoteItem && localItem.size === remoteItem.size;
}

function moveSignatureFromSnapshot(snapshot) {
  if (!snapshot) {
    return "";
  }
  if (snapshot.local && snapshot.local.sha256) {
    return `sha256:${snapshot.local.size}:${snapshot.local.sha256}`;
  }
  if (snapshot.remote && snapshot.remote.md5Checksum) {
    return `md5:${snapshot.remote.size}:${snapshot.remote.md5Checksum.toLowerCase()}`;
  }
  return "";
}

function isLargeBinaryPath(path) {
  const dot = path.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return LARGE_BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  if (unitIndex === 0) {
    return `${Math.round(size)} ${units[unitIndex]}`;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function md5Hex(data) {
  const input = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
  const originalLength = input.length;
  const paddedLength = (((originalLength + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[originalLength] = 0x80;
  const bitLength = originalLength * 8;
  for (let i = 0; i < 8; i++) {
    bytes[paddedLength - 8 + i] = Math.floor(bitLength / Math.pow(2, 8 * i)) & 0xff;
  }

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const constants = Array.from({ length: 64 }, (_, i) => {
    return Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  });

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(16);
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      words[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
    }
    let aa = a;
    let bb = b;
    let cc = c;
    let dd = d;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (bb & cc) | (~bb & dd);
        g = i;
      } else if (i < 32) {
        f = (dd & bb) | (~dd & cc);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = bb ^ cc ^ dd;
        g = (3 * i + 5) % 16;
      } else {
        f = cc ^ (bb | ~dd);
        g = (7 * i) % 16;
      }
      const temp = dd;
      dd = cc;
      cc = bb;
      const sum = (aa + f + constants[i] + words[g]) >>> 0;
      bb = (bb + leftRotate(sum, shifts[i])) >>> 0;
      aa = temp;
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }
  return [a, b, c, d].map(wordToLittleEndianHex).join("");
}

function leftRotate(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function wordToLittleEndianHex(value) {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

function shouldHashLocalFile(path, size) {
  if (size > LOCAL_HASH_MAX_BYTES) {
    return false;
  }
  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const dot = lower.lastIndexOf(".");
  if (dot <= slash) {
    return false;
  }
  return HASHED_LOCAL_EXTENSIONS.has(lower.slice(dot));
}

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function atomicJsonContentEquivalent(expected, actual) {
  if (actual === expected) {
    return true;
  }
  const normalizedExpected = normalizeAtomicJsonText(expected);
  const normalizedActual = normalizeAtomicJsonText(actual);
  if (normalizedActual === normalizedExpected) {
    return true;
  }
  try {
    return canonicalJsonString(JSON.parse(normalizedActual)) ===
      canonicalJsonString(JSON.parse(normalizedExpected));
  } catch (err) {
    return false;
  }
}

function normalizeAtomicJsonText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
}

function canonicalJsonString(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => {
      return `${JSON.stringify(key)}:${canonicalJsonString(value[key])}`;
    }).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSafeRemoteName(name) {
  if (!name || name === "." || name === ".." || /[\/\\\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`Unsafe Google Drive item name: ${JSON.stringify(name)}`);
  }
}

function isPrefixOfAnyPattern(path, patterns) {
  const normalizedPath = path.replace(/\\/g, "/");
  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, "/");
    const wildcardIndex = normalizedPattern.search(/[*?]/);
    if (wildcardIndex >= 0) {
      const staticPrefix = normalizedPattern.slice(0, wildcardIndex);
      const staticFolder = staticPrefix.endsWith("/") ? staticPrefix.slice(0, -1) : staticPrefix;
      return normalizedPath === staticFolder ||
        normalizedPath.startsWith(staticPrefix) ||
        staticPrefix.startsWith(`${normalizedPath}/`);
    }
    return normalizedPattern === normalizedPath ||
      normalizedPattern.startsWith(`${normalizedPath}/`) ||
      globMatch(normalizedPattern, normalizedPath);
  });
}

function makeMultipartBody(boundary, metadata, bytes, mimeType) {
  const encoder = new TextEncoder();
  const before = encoder.encode(
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const after = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(before.length + bytes.byteLength + after.length);
  body.set(before, 0);
  body.set(new Uint8Array(bytes), before.length);
  body.set(after, before.length + bytes.byteLength);
  return body;
}

function getMimeType(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function globMatch(pattern, path) {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedPath = path.replace(/\\/g, "/");
  const regex = new RegExp(`^${globToRegexSource(normalizedPattern)}$`);
  return regex.test(normalizedPath);
}

function patternLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function excludedFolderLines(value) {
  return patternLines(value)
    .map(normalizeVaultFolderPath)
    .filter(Boolean);
}

function normalizeVaultFolderPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

function isInExcludedFolder(path, excludedFolders) {
  const normalizedPath = normalizeVaultFolderPath(path);
  if (!normalizedPath) {
    return false;
  }
  return excludedFolderLines(excludedFolders).some((folder) => {
    return normalizedPath === folder || normalizedPath.startsWith(`${folder}/`);
  });
}

function globToRegexSource(value) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const next = value[i + 1];
    if (char === "*" && next === "*") {
      out += ".*";
      i++;
    } else if (char === "*") {
      out += "[^/]*";
    } else {
      out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

function escapeDriveQuery(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function formatLogDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absoluteOffset / 60));
  const offsetRemainder = pad(absoluteOffset % 60);
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":") + ` (UTC${offsetSign}${offsetHours}:${offsetRemainder})`;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
