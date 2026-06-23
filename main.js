const { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } = require("obsidian");

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
  conflictAction: "newerWithBackup",
  protectModifyPercentage: 40,
  obsidianSyncMode: "off",
  autoSyncOnStartup: false,
  autoSyncIntervalMinutes: 0,
  maxFileSizeMb: 50,
  excludedPatterns: [
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
    "**/*.conflict-*"
  ].join("\n"),
  accessToken: "",
  refreshToken: "",
  tokenExpiresAt: 0,
  deviceCode: "",
  userCode: "",
  verificationUrl: "",
  authStartedAt: 0,
  lastSyncSummary: "",
  lastPlanSummary: "",
  lastSyncAt: 0,
  lastRemoteSnapshotAt: 0
};

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const OAUTH_DEVICE_CODE = "https://oauth2.googleapis.com/device/code";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SNAPSHOT_FILE = "snapshot.json";
const JOURNAL_FILE = "sync-journal.json";
const REMOTE_SNAPSHOT_FILE = "remote_snapshot.json";
const MAX_RETRY_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const LOCAL_HASH_MAX_BYTES = 10 * 1024 * 1024;
const HASHED_LOCAL_EXTENSIONS = new Set([".md", ".txt", ".json", ".css", ".js", ".canvas"]);
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
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/plugins/*/data.json"
];

module.exports = class DriveBridgePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.syncing = false;
    this.folderCache = new Map();
    this.progressModal = null;
    this.progressCloseTimer = null;
    this.currentSyncProgress = "";
    this.syncUiQuiet = false;
    this.skipChangedFilesDuringSync = false;
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
    this.addRibbonIcon("refresh-cw", "Preview Google Drive sync", () => this.previewSync());
    if (this.settings.autoSyncOnStartup) {
      this.app.workspace.onLayoutReady(() => this.syncNow({ dryRun: this.settings.dryRunDefault, quiet: true }));
    }
    if (this.settings.autoSyncIntervalMinutes > 0) {
      this.registerInterval(window.setInterval(
        () => this.syncNow({ dryRun: this.settings.dryRunDefault, quiet: true }),
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
    if (this.syncing) {
      if (!quiet) {
        new Notice("DriveBridge sync is already running.");
      }
      return;
    }
    this.syncing = true;
    this.syncUiQuiet = quiet;
    this.skipChangedFilesDuringSync = quiet;
    const started = Date.now();
    try {
      this.updateSyncProgress({
        phase: dryRun ? "Preview" : "Sync",
        message: "Scanning local vault and Google Drive..."
      });
      if (!quiet) {
        new Notice(dryRun ? "DriveBridge preview started." : "DriveBridge sync started. Avoid editing notes until it completes.");
      }
      const context = await this.buildSyncContext();
      const plan = await this.buildSyncPlan(context);
      const summary = this.formatPlanSummary(plan, dryRun, Date.now() - started);
      this.settings.lastPlanSummary = summary;

      if (dryRun) {
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
      await this.writeJournal({ startedAt: new Date().toISOString(), dryRun, plan });
      const executed = await this.executePlan(context, plan);
      await this.saveSnapshot(executed.nextSnapshot);
      if (!dryRun) {
        await this.saveRemoteSnapshot(context.rootFolderId, executed.nextSnapshot);
      }
      await this.writeJournal({
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        dryRun,
        stats: executed.stats,
        errors: executed.errors,
        skippedChanged: executed.skippedChanged
      });
      this.settings.allowFirstRealSync = false;
      this.settings.lastSyncAt = Date.now();
      this.settings.lastSyncSummary = this.formatExecutionSummary(executed, Date.now() - started);
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
          new Notice("DriveBridge sync complete.");
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
      this.syncing = false;
      this.syncUiQuiet = false;
      this.skipChangedFilesDuringSync = false;
      this.clearSyncStatus();
    }
  }

  async buildSyncContext() {
    await this.ensureAccessToken();
    const rootFolderId = await this.ensureRootFolder();
    const snapshot = await this.loadSnapshot();
    const local = await this.scanLocalVault();
    const remote = await this.scanRemoteVault(rootFolderId);
    return { rootFolderId, snapshot, local, remote };
  }

  async buildSyncPlan(context) {
    const allPaths = Array.from(new Set([
      ...Object.keys(context.local),
      ...Object.keys(context.remote),
      ...Object.keys(context.snapshot)
    ])).sort();
    const entries = [];
    const stats = newEmptyStats();
    for (const path of allPaths) {
      const entry = this.planPath(path, context);
      entries.push(entry);
      stats[entry.action] = (stats[entry.action] || 0) + 1;
    }
    return { entries, stats };
  }

  planPath(path, context) {
    if (this.isExcluded(path)) {
      return { path, action: "skip", reason: "excluded" };
    }
    const localItem = context.local[path];
    const remoteItem = context.remote[path];
    const previous = context.snapshot[path];

    if (!localItem && !remoteItem) {
      return { path, action: "skip", reason: "missing on both sides" };
    }
    if (localItem && localItem.size > this.maxFileSizeBytes()) {
      return { path, action: "skip", reason: `local file exceeds ${this.settings.maxFileSizeMb} MB` };
    }
    if (remoteItem && remoteItem.size > this.maxFileSizeBytes()) {
      return { path, action: "skip", reason: `remote file exceeds ${this.settings.maxFileSizeMb} MB` };
    }

    const localChanged = localItem ? !previous || !sameLocal(previous.local, localItem) : Boolean(previous && previous.local);
    const remoteChanged = remoteItem ? !previous || !sameRemote(previous.remote, remoteItem) : Boolean(previous && previous.remote);

    if (this.settings.syncMode === "push") {
      return this.planPushOnly(path, localItem, remoteItem, previous, localChanged);
    }
    if (this.settings.syncMode === "pull") {
      return this.planPullOnly(path, localItem, remoteItem, previous, remoteChanged);
    }

    if (localItem && !remoteItem) {
      if (previous && previous.remote && this.settings.syncDeletes && !localChanged) {
        return { path, action: "deleteLocal", reason: "remote deletion detected" };
      }
      return { path, action: "upload", reason: "local only" };
    }
    if (!localItem && remoteItem) {
      if (previous && previous.local && this.settings.syncDeletes && !remoteChanged) {
        return { path, action: "deleteRemote", reason: "local deletion detected" };
      }
      return { path, action: "download", reason: "remote only" };
    }
    if (!previous && localItem && remoteItem) {
      return { path, action: "conflict", reason: sameSize(localItem, remoteItem) ? "same-size files on both sides during first scan" : "different files on first scan" };
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
        return { path, action: "deleteLocal", reason: "pull mode remote deletion" };
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
    if (this.settings.safeInitialSync && snapshotEmpty && hasLocal && hasRemote && !this.settings.allowFirstRealSync) {
      throw new Error("First real sync is protected. Run Preview, inspect the plan, then enable 'Allow first real sync once'.");
    }
    const dangerousDeletes = plan.entries.filter((entry) => entry.action === "deleteLocal" || entry.action === "deleteRemote");
    if (dangerousDeletes.length && !this.settings.syncDeletes) {
      throw new Error("Delete actions were planned while delete sync is disabled.");
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

  async executePlan(context, plan) {
    const nextSnapshot = Object.assign({}, context.snapshot);
    const stats = newEmptyStats();
    const errors = [];
    const skippedChanged = [];
    let processed = 0;
    let processedBytes = 0;
    const orderedEntries = this.orderPlanEntries(plan.entries);
    const totalBytes = orderedEntries.reduce((sum, entry) => {
      return sum + this.progressBytesForEntry(entry, context);
    }, 0);
    for (const entry of orderedEntries) {
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
        await this.executeEntry(entry, context, nextSnapshot, stats);
      } catch (err) {
        if (this.shouldSkipChangedDuringSync(err)) {
          skippedChanged.push(this.skipRecord(entry, err));
          stats.skip++;
          continue;
        }
        const error = this.errorRecord(entry, err);
        errors.push(error);
        stats.error++;
        new Notice(`DriveBridge error: ${error.action} ${error.path}: ${error.message}`, 10000);
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
    return { nextSnapshot, stats, errors, skippedChanged, processed, total: orderedEntries.length, processedBytes, totalBytes };
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

  async executeEntry(entry, context, nextSnapshot, stats) {
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
    if (entry.action === "upload") {
      await this.assertLocalUnchangedSincePlan(path, localItem);
      if (remoteItem) {
        await this.assertRemoteUnchangedSincePlan(path, remoteItem);
      }
      const uploaded = await this.uploadLocalFile(path, context.rootFolderId, remoteItem);
      const refreshed = this.app.vault.getAbstractFileByPath(path);
      const localAfter = refreshed instanceof TFile ? await this.localInfo(refreshed) : localItem;
      nextSnapshot[path] = this.snapshotFrom(localAfter, uploaded);
      stats.upload++;
      return;
    }
    if (entry.action === "download") {
      await this.assertLocalUnchangedSincePlan(path, localItem);
      await this.assertRemoteUnchangedSincePlan(path, remoteItem);
      await this.downloadRemoteFile(path, remoteItem);
      const refreshedLocal = (await this.scanLocalVault())[path];
      nextSnapshot[path] = this.snapshotFrom(refreshedLocal, remoteItem);
      stats.download++;
      return;
    }
    if (entry.action === "conflict") {
      await this.assertLocalUnchangedSincePlan(path, localItem);
      await this.assertRemoteUnchangedSincePlan(path, remoteItem);
      nextSnapshot[path] = await this.resolveConflict(path, localItem, remoteItem, context.rootFolderId);
      stats.conflict++;
      return;
    }
    if (entry.action === "deleteLocal") {
      await this.assertLocalUnchangedSincePlan(path, localItem);
      await this.assertRemoteUnchangedSincePlan(path, remoteItem);
      await this.deleteLocal(path);
      delete nextSnapshot[path];
      stats.deleteLocal++;
      return;
    }
    if (entry.action === "deleteRemote") {
      await this.assertRemoteUnchangedSincePlan(path, remoteItem);
      await this.trashRemote(remoteItem.id);
      delete nextSnapshot[path];
      stats.deleteRemote++;
      return;
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
      const refreshedLocal = (await this.scanLocalVault())[path];
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
    const refreshedLocal = (await this.scanLocalVault())[path];
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
    const res = await customFetch(url, Object.assign({}, options, { headers }));
    if (res.status === 401 && this.settings.refreshToken && attempt === 1) {
      this.settings.tokenExpiresAt = 0;
      await this.ensureAccessToken();
      return this.driveFetch(url, options, attempt + 1);
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRY_ATTEMPTS) {
      await sleep(500 * Math.pow(2, attempt - 1));
      return this.driveFetch(url, options, attempt + 1);
    }
    return res;
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
      await this.saveSettings();
      return this.settings.rootFolderId;
    }
    const created = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?fields=id,name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder"
      })
    }));
    this.settings.rootFolderId = created.id;
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
    try {
      const params = new URLSearchParams({
        q: `'${rootFolderId}' in parents and name='${REMOTE_SNAPSHOT_FILE}' and trashed=false`,
        fields: "files(id,modifiedTime)",
        spaces: "drive"
      });
      const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
      if (data.files && data.files.length > 0) {
        const snapId = data.files[0].id;
        const res = await this.driveFetch(`${DRIVE_API}/files/${snapId}?alt=media`);
        if (res.ok) {
          const content = await res.text();
          const parsed = JSON.parse(content);
          this.settings.lastRemoteSnapshotAt = Date.parse(data.files[0].modifiedTime || "") || Date.now();
          return parsed && parsed.files ? parsed.files : parsed;
        }
      }
    } catch (err) {
      console.warn(`[drivebridge-obsidian-sync] Failed to load ${REMOTE_SNAPSHOT_FILE}, falling back to full scan`, err);
    }
    const result = {};
    await this.scanRemoteFolder(rootFolderId, "", result);
    return result;
  }

  async scanRemoteFolder(folderId, prefix, result) {
    let pageToken = "";
    const seenNames = new Set();
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)",
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
          throw new Error(`Duplicate Google Drive item name "${file.name}" under "${folderPath}". Rename duplicates before syncing.`);
        }
        seenNames.add(file.name);
        const path = prefix ? `${prefix}/${file.name}` : file.name;
        if (file.mimeType === "application/vnd.google-apps.folder") {
          if (this.shouldScanRemoteFolder(path)) {
            await this.scanRemoteFolder(file.id, path, result);
          }
        } else if (!file.mimeType.startsWith("application/vnd.google-apps.")) {
          if (this.isExcluded(path)) {
            continue;
          }
          if (result[path]) {
            throw new Error(`Duplicate Google Drive path "${path}". Rename duplicates before syncing.`);
          }
          result[path] = remoteInfo(path, file);
        }
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
  }

  async uploadLocalFile(path, rootFolderId, existingRemote) {
    if (!(await this.localPathExists(path))) {
      throw new Error(`Local file not found: ${path}`);
    }
    const localItem = await this.localInfoByPath(path);
    const data = await this.readLocalBinary(path);
    const parentId = await this.ensureRemoteParent(path, rootFolderId);
    const metadata = { name: basename(path) };
    if (!existingRemote) {
      metadata.parents = [parentId];
    }
    const boundary = `drivebridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = makeMultipartBody(boundary, metadata, data, getMimeType(path));
    const url = existingRemote
      ? `${DRIVE_UPLOAD_API}/files/${existingRemote.id}?uploadType=multipart&fields=id,name,size,modifiedTime,md5Checksum`
      : `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,size,modifiedTime,md5Checksum`;
    const uploaded = await parseJsonResponse(await this.driveFetch(url, {
      method: existingRemote ? "PATCH" : "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    }));
    return {
      id: uploaded.id,
      path,
      size: Number(uploaded.size || localItem.size),
      modifiedTime: uploaded.modifiedTime,
      md5Checksum: uploaded.md5Checksum || ""
    };
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
      parentId = folder ? folder.id : await this.createRemoteFolder(parentId, part);
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
    return data.files && data.files.length ? data.files[0] : null;
  }

  async createRemoteFolder(parentId, name) {
    const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?fields=id,name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        parents: [parentId],
        mimeType: "application/vnd.google-apps.folder"
      })
    }));
    return data.id;
  }

  async downloadRemoteFile(path, remoteItem) {
    const res = await this.driveFetch(`${DRIVE_API}/files/${remoteItem.id}?alt=media`);
    if (!res.ok) {
      await parseJsonResponse(res);
    }
    const buffer = await res.arrayBuffer();
    await this.ensureLocalParent(path);
    if (this.isConfigPath(path)) {
      await this.app.vault.adapter.writeBinary(path, buffer);
      return;
    }
    const current = this.app.vault.getAbstractFileByPath(path);
    if (current instanceof TFile) {
      await this.app.vault.modifyBinary(current, buffer);
    } else {
      await this.app.vault.createBinary(path, buffer);
    }
  }

  async writeConflictCopy(path, remoteItem) {
    const dot = path.lastIndexOf(".");
    const stamp = formatTimestamp(new Date());
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
    const stamp = formatTimestamp(new Date());
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

  async uploadTextContent(filename, rootFolderId, content, existingId) {
    const boundary = `drivebridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const metadata = { name: filename, mimeType: "application/json" };
    if (!existingId) {
      metadata.parents = [rootFolderId];
    }
    let bodyText = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
    bodyText += `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n`;
    bodyText += `--${boundary}--\r\n`;

    const url = existingId
      ? `${DRIVE_UPLOAD_API}/files/${existingId}?uploadType=multipart&fields=id,name`
      : `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name`;
    const res = await parseJsonResponse(await this.driveFetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: bodyText
    }));
    return res.id;
  }

  async saveRemoteSnapshot(rootFolderId, nextSnapshot) {
    const remoteState = {};
    for (const [path, snap] of Object.entries(nextSnapshot)) {
      if (snap.remote) {
        remoteState[path] = snap.remote;
      }
    }
    const content = JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      files: remoteState
    }, null, 2);
    
    let existingId = null;
    try {
      const params = new URLSearchParams({
        q: `'${rootFolderId}' in parents and name='${REMOTE_SNAPSHOT_FILE}' and trashed=false`,
        fields: "files(id)",
        spaces: "drive"
      });
      const data = await parseJsonResponse(await this.driveFetch(`${DRIVE_API}/files?${params}`));
      if (data.files && data.files.length > 0) {
        existingId = data.files[0].id;
      }
    } catch (e) {
      // ignore
    }
    
    await this.uploadTextContent(REMOTE_SNAPSHOT_FILE, rootFolderId, content, existingId);
    this.settings.lastRemoteSnapshotAt = Date.now();
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
    try {
      const text = await this.app.vault.adapter.read(this.pluginDataPath(SNAPSHOT_FILE));
      return JSON.parse(text);
    } catch (err) {
      return {};
    }
  }

  async saveSnapshot(snapshot) {
    await this.app.vault.adapter.write(this.pluginDataPath(SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2));
  }

  async writeJournal(journal) {
    await this.app.vault.adapter.write(this.pluginDataPath(JOURNAL_FILE), JSON.stringify(journal, null, 2));
  }

  async safeWriteJournal(journal) {
    try {
      await this.writeJournal(journal);
    } catch (err) {
      console.error("[drivebridge-obsidian-sync] failed to write journal", err);
    }
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

  async localPathExists(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile || await this.app.vault.adapter.exists(path);
  }

  async assertLocalUnchangedSincePlan(path, plannedLocal) {
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
    if (!sameLocal(plannedLocal, currentInfo)) {
      throw this.changedDuringSyncError(`Local file changed during sync: ${path}`, "local");
    }
  }

  async remoteInfoById(path, fileId) {
    const params = new URLSearchParams({
      fields: "id,size,modifiedTime,md5Checksum,trashed"
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
      throw this.changedDuringSyncError(`Google Drive file changed during sync: ${path}`, "remote");
    }
  }

  changedDuringSyncError(message, side) {
    const error = new Error(message);
    error.code = "DRIVEBRIDGE_CHANGED_DURING_SYNC";
    error.side = side;
    return error;
  }

  shouldSkipChangedDuringSync(err) {
    return this.skipChangedFilesDuringSync && err && err.code === "DRIVEBRIDGE_CHANGED_DURING_SYNC";
  }

  pluginDataPath(filename) {
    const pluginDir = this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${pluginDir}/${filename}`;
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
    const patterns = this.settings.excludedPatterns
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return patterns.some((pattern) => globMatch(pattern, path));
  }

  isAlwaysExcluded(path) {
    const pluginDir = this.manifest.dir || `${this.getConfigDir()}/plugins/${this.manifest.id}`;
    if (path === pluginDir || path.startsWith(`${pluginDir}/`)) {
      return true;
    }
    if (path.endsWith("/snapshot.json") || path.endsWith("/sync-journal.json") || path.endsWith(`/${REMOTE_SNAPSHOT_FILE}`)) {
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
    return !this.isExcluded(path);
  }

  shouldScanRemoteFolder(path) {
    return this.shouldScanLocalFolder(path);
  }

  updateSyncProgress(progress) {
    const text = this.formatProgressText(progress);
    this.currentSyncProgress = text;
    this.currentProgressState = {
      current: progress.current || 0,
      total: progress.total || 0,
      unit: progress.unit || ""
    };
    this.setSyncStatus(text.replace(/\n/g, " | "));
    if (!this.syncUiQuiet) {
      this.showProgressModal(text, this.currentProgressState);
    }
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

  setSyncStatus(message) {
    if (!this.statusBarItem) {
      return;
    }
    this.statusBarItem.setText(message);
    this.statusBarItem.style.display = message ? "" : "none";
  }

  clearSyncStatus() {
    this.setSyncStatus("");
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

  snapshotFrom(localItem, remoteItem) {
    return {
      local: localItem ? { size: localItem.size, mtime: localItem.mtime, sha256: localItem.sha256 || "" } : null,
      remote: remoteItem ? {
        id: remoteItem.id,
        size: remoteItem.size,
        modifiedTime: remoteItem.modifiedTime,
        md5Checksum: remoteItem.md5Checksum || ""
      } : null
    };
  }

  formatPlanSummary(plan, dryRun, elapsedMs) {
    const lines = [
      dryRun ? "Preview only. No files changed." : "Planned real sync.",
      `Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
      `Mode: ${this.settings.syncMode}`,
      `Conflict handling: ${this.settings.conflictAction || DEFAULT_SETTINGS.conflictAction}`,
      `Protect modify threshold: ${this.settings.protectModifyPercentage ?? DEFAULT_SETTINGS.protectModifyPercentage}%`,
      `Upload: ${plan.stats.upload}`,
      `Download: ${plan.stats.download}`,
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
    const lines = [
      `Completed in ${(elapsedMs / 1000).toFixed(1)}s`,
      `Data processed: ${formatBytes(executed.processedBytes || 0)} / ${formatBytes(executed.totalBytes || 0)}`,
      `Uploaded: ${executed.stats.upload}`,
      `Downloaded: ${executed.stats.download}`,
      `Conflicts: ${executed.stats.conflict}`,
      `Adopted: ${executed.stats.adopt}`,
      `Deleted local: ${executed.stats.deleteLocal}`,
      `Deleted remote: ${executed.stats.deleteRemote}`,
      `Skipped: ${executed.stats.skip}`,
      `Errors: ${executed.errors.length}`
    ];
    if (executed.skippedChanged && executed.skippedChanged.length) {
      lines.push("", "Skipped because they changed during auto sync:", ...this.formatSkipLines(executed.skippedChanged, 20));
      lines.push("", `Full latest run details are saved in ${JOURNAL_FILE}.`);
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
      time: new Date().toISOString()
    };
  }

  formatSkipLines(skipped, limit) {
    const visible = skipped.slice(0, limit).map((item, index) => {
      const line = `${index + 1}. ${item.action}: ${item.path}`;
      return `${line}\n   Side: ${item.side || "unknown"}\n   Reason: ${item.reason}`;
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
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("drivebridge-progress-modal");
    contentEl.createEl("h2", { text: "DriveBridge is running" });
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
    contentEl.createEl("p", {
      text: "Keep Obsidian open and avoid editing notes until this finishes.",
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
    this.updateProgressElements();
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

class DriveBridgeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
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
          this.plugin.settings.rootFolderName = value.trim() || DEFAULT_SETTINGS.rootFolderName;
          this.plugin.settings.rootFolderId = "";
          await this.plugin.saveSettings();
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
      .setName("Conflict handling")
      .setDesc("How to resolve files changed on both sides. The default keeps the newest version and backs up the older one.")
      .addDropdown((dropdown) => dropdown
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
          this.plugin.settings.rootFolderId = value.trim();
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
      .setName("Excluded patterns")
      .setDesc("One pattern per line. `*` and `**` are supported.")
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
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return data;
}

function newEmptyStats() {
  return {
    upload: 0,
    download: 0,
    conflict: 0,
    adopt: 0,
    deleteLocal: 0,
    deleteRemote: 0,
    skip: 0,
    error: 0
  };
}

function remoteInfo(path, file) {
  return {
    id: file.id,
    path,
    size: Number(file.size || 0),
    modifiedTime: file.modifiedTime,
    md5Checksum: file.md5Checksum || ""
  };
}

function basename(path) {
  return path.split("/").pop();
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

function sameSize(localItem, remoteItem) {
  return localItem && remoteItem && localItem.size === remoteItem.size;
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

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
