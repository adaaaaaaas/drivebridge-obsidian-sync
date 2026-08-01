const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto, createHash } = require("crypto");

class FakeElement {
  constructor() {
    this.children = [];
    this.style = {};
    this.disabled = false;
  }
  empty() { this.children = []; }
  addClass() {}
  createEl() {
    const child = new FakeElement();
    this.children.push(child);
    return child;
  }
  createDiv() { return this.createEl(); }
  addEventListener() {}
  setAttribute(name, value) { this[name] = value; }
  setText(value) { this.text = value; }
  querySelectorAll() { return []; }
}

class FakePlugin {}
class FakeModal {
  constructor() { this.contentEl = new FakeElement(); }
  open() { if (this.onOpen) this.onOpen(); }
  close() { if (this.onClose) this.onClose(); }
}
class FakeSetting {}
class FakeSettingTab {}
class FakeTFile {}
class FakeTFolder {}

function loadPlugin() {
  const requests = [];
  const responses = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    URLSearchParams,
    Headers,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    crypto: webcrypto,
    Date,
    Math,
    Set,
    Map,
    Promise,
    JSON,
    Object,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    window: {
      setTimeout: (callback) => { callback(); return 1; },
      clearTimeout: () => {},
      setInterval: () => 1
    },
    require: (name) => {
      if (name !== "obsidian") return require(name);
      return {
        Plugin: FakePlugin,
        Modal: FakeModal,
        Setting: FakeSetting,
        PluginSettingTab: FakeSettingTab,
        TFile: FakeTFile,
        Notice: class {},
        requestUrl: async (request) => {
          requests.push(request);
          const response = responses.shift();
          if (response instanceof Error) throw response;
          return response || { status: 200, text: "{}", json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} };
        }
      };
    }
  };
  const code = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8") +
    "\nmodule.exports.__ReviewModal = DriveBridgeConflictReviewModal;" +
    "\nmodule.exports.__ProgressModal = DriveBridgeProgressModal;";
  vm.runInNewContext(code, sandbox, { filename: "main.js" });
  return { PluginClass: sandbox.module.exports, requests, responses };
}

function pluginInstance(PluginClass, settings = {}) {
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = Object.assign({
    syncMode: "bidirectional",
    syncDeletes: false,
    maxFileSizeMb: 50,
    conflictAction: "manualReview",
    excludedFolders: "",
    excludedPatterns: "",
    obsidianSyncMode: "off",
    clientId: "client",
    accessToken: "token",
    tokenExpiresAt: Date.now() + 60000,
    refreshToken: "refresh",
    lastLocalFullScanAt: Date.now()
  }, settings);
  plugin.manifest = { id: "drivebridge-obsidian-sync", dir: ".obsidian/plugins/drivebridge-obsidian-sync" };
  return plugin;
}

async function run() {
  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const handlers = {};
    plugin.app = {
      vault: {
        on: (name, callback) => {
          handlers[name] = callback;
          return { name };
        }
      }
    };
    plugin.registerEvent = () => {};
    plugin.localDirtyPaths = new Map();
    plugin.localDirtyGeneration = 0;
    plugin.localDirtyTrusted = true;
    plugin.isExcluded = () => false;
    plugin.scheduleDirtyQueueFlush = () => {};
    plugin.registerLocalDirtyEvents();

    const file = new FakeTFile();
    file.path = "notes/file.md";
    handlers.create(file);
    assert.ok(plugin.localDirtyPaths.has(file.path), "file events must enter the dirty queue");
    handlers.rename(file, "notes/old-file.md");
    assert.ok(plugin.localDirtyPaths.has("notes/old-file.md"), "file rename must retain the old path");
    handlers.delete(file);
    assert.ok(plugin.localDirtyPaths.has(file.path), "file delete must retain the deleted path");

    const folder = new FakeTFolder();
    folder.path = "notes/folder";
    plugin.localDirtyTrusted = true;
    handlers.create(folder);
    assert.strictEqual(plugin.localDirtyTrusted, false, "folder create must force the next local scan to be full");
    assert.strictEqual(plugin.localDirtyPaths.has(folder.path), false, "folders must never enter the file dirty queue");

    plugin.localDirtyTrusted = true;
    handlers.rename(folder, "notes/old-folder");
    assert.strictEqual(plugin.localDirtyTrusted, false, "folder rename must force the next local scan to be full");
    assert.strictEqual(plugin.localDirtyPaths.has("notes/old-folder"), false);

    plugin.localDirtyTrusted = true;
    handlers.delete(folder);
    assert.strictEqual(plugin.localDirtyTrusted, false, "folder delete must force the next local scan to be full");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const folder = new FakeTFolder();
    folder.path = "notes/folder";
    plugin.localDirtyTrusted = true;
    plugin.localDirtyPaths = new Map([[folder.path, 2]]);
    plugin.isExcluded = () => false;
    plugin.app = {
      vault: {
        getAbstractFileByPath: () => folder
      }
    };
    plugin.localPathExists = async () => {
      throw new Error("folder paths must be rejected before existence checks");
    };
    const result = await plugin.scanLocalVault({});
    assert.strictEqual(result[folder.path], undefined, "saved dirty folders must not become local file entries");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const folder = new FakeTFolder();
    folder.path = "notes/folder";
    let readAttempted = false;
    plugin.app = {
      vault: {
        getAbstractFileByPath: () => folder
      }
    };
    plugin.localPathExists = async () => true;
    plugin.readLocalBinary = async () => {
      readAttempted = true;
      return new ArrayBuffer(0);
    };
    await assert.rejects(
      () => plugin.uploadLocalFile(folder.path, "root", null),
      /Local path is not a file/
    );
    assert.strictEqual(readAttempted, false, "folder upload must stop before binary reads");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isExcluded = () => false;
    const entry = plugin.planPath("note.md", {
      local: { "note.md": { path: "note.md", size: 10, mtime: 1 } },
      remote: { "note.md": { path: "note.md", id: "r1", size: 10, modifiedTime: "2026-01-01", md5Checksum: "abc" } },
      snapshot: {},
      remoteDeleted: {}
    });
    assert.strictEqual(entry.action, "conflict");
    assert.match(entry.reason, /content verification/);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { syncMode: "pull", syncDeletes: true });
    plugin.isExcluded = () => false;
    const entry = plugin.planPath("note.md", {
      local: { "note.md": { path: "note.md", size: 10, mtime: 1 } },
      remote: {},
      snapshot: { "note.md": { local: { size: 10, mtime: 1 }, remote: { id: "r1", size: 10 } } },
      remoteDeleted: {}
    });
    assert.strictEqual(entry.action, "skip");
    assert.match(entry.reason, /without a trusted deletion tombstone/);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isExcluded = () => false;
    plugin.detectMoveEntries = async (entries) => entries;
    plugin.bypassBulkTimestampUpdate = async (entries) => entries;
    plugin.hasSameContent = async () => true;
    const plan = await plugin.buildSyncPlan({
      local: { "note.md": { path: "note.md", size: 10, mtime: 1 } },
      remote: { "note.md": { path: "note.md", id: "r1", size: 10, modifiedTime: "2026-01-01", md5Checksum: "abc" } },
      snapshot: {},
      remoteDeleted: {}
    });
    assert.strictEqual(plan.entries[0].action, "adopt");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isExcluded = () => false;
    plugin.detectMoveEntries = async (entries) => entries;
    plugin.bypassBulkTimestampUpdate = async (entries) => entries;
    plugin.hasSameContent = async () => {
      throw new Error("large first-scan files must not be hashed automatically");
    };
    const largeSize = 11 * 1024 * 1024;
    const plan = await plugin.buildSyncPlan({
      local: { "large.pdf": { path: "large.pdf", size: largeSize, mtime: 1 } },
      remote: { "large.pdf": { path: "large.pdf", id: "r1", size: largeSize, modifiedTime: "2026-01-01", md5Checksum: "abc" } },
      snapshot: {},
      remoteDeleted: {}
    });
    assert.strictEqual(plan.entries[0].action, "conflict");
    assert.match(plan.entries[0].reason, /large same-size/);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    let written;
    plugin.writeRemoteSnapshotFile = async (_root, files, deleted) => { written = { files, deleted }; };
    plugin.mergeRemoteDeleteTombstones = (_previous, _next, remote) => remote.deletedMarker || {};
    await plugin.saveRemoteSnapshot("root", {
      "current.md": { id: "new", size: 2 }
    }, {}, {}, {
      "removed.md": null,
      "added.md": { id: "added", size: 3 }
    });
    assert.strictEqual(written.files["current.md"].id, "new");
    assert.strictEqual(written.files["added.md"].id, "added");
    assert.strictEqual(written.files["removed.md"], undefined);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    let writes = 0;
    plugin.writeRemoteSnapshotFile = async () => { writes++; };
    plugin.mergeRemoteDeleteTombstones = (previous) => previous;
    const result = await plugin.saveRemoteSnapshot("root", {
      "same.md": { id: "same", size: 2, md5Checksum: "abc" }
    }, {}, {}, {});
    assert.strictEqual(result.written, false);
    assert.strictEqual(writes, 0, "unchanged sync must not query or rewrite remote_snapshot.json");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const calls = [];
    plugin.driveFetch = async (url) => {
      calls.push(url);
      const count = Number(new URL(url).searchParams.get("count"));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ids: Array.from({ length: count }, (_, index) => `id-${calls.length}-${index}`) })
      };
    };
    const ids = await plugin.reserveDriveIds(1001);
    assert.strictEqual(ids.length, 1001);
    assert.strictEqual(calls.length, 2, "Drive IDs must be reserved in batches, not per file");
    assert.match(calls[0], /count=1000/);
    assert.match(calls[1], /count=1/);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    let reserveCount = 0;
    plugin.reserveDriveIds = async (count) => {
      reserveCount = count;
      return Array.from({ length: count }, (_, index) => `reserved-${index}`);
    };
    let journal;
    plugin.writeOperationJournal = async (value) => { journal = value; plugin.operationJournalCache = value; };
    const plan = { entries: [
      { path: "new-a.md", action: "upload" },
      { path: "new-b.md", action: "upload" },
      { path: "existing.md", action: "upload" },
      { path: "same.md", action: "adopt" }
    ] };
    await plugin.prepareOperationJournal("run-1", plan, {
      local: {
        "new-a.md": { size: 1 },
        "new-b.md": { size: 1 },
        "existing.md": { size: 1 }
      },
      remote: { "existing.md": { id: "existing" } }
    });
    assert.strictEqual(reserveCount, 2, "only create operations need reserved IDs");
    assert.strictEqual(journal.version, 2);
    assert.strictEqual(journal.operations["new-a.md"].reservedRemoteId, "reserved-0");
    assert.strictEqual(journal.operations["existing.md"].reservedRemoteId, "");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const bytes = new TextEncoder().encode("reserved upload").buffer;
    plugin.localPathExists = async () => true;
    plugin.localInfoByPath = async () => ({ path: "note.md", size: bytes.byteLength, mtime: 1 });
    plugin.readLocalBinary = async () => bytes;
    plugin.ensureRemoteParent = async () => "parent-1";
    let requests = 0;
    plugin.driveFetch = async () => {
      requests++;
      const error = new Error("response lost");
      error.code = "DRIVEBRIDGE_NETWORK_ERROR";
      throw error;
    };
    let reconciliations = 0;
    plugin.reconcileReservedUpload = async (_path, id, expected) => {
      reconciliations++;
      assert.strictEqual(id, "reserved-1");
      assert.strictEqual(expected.parentId, "parent-1");
      assert.ok(expected.md5Checksum);
      return { id, name: "note.md", size: bytes.byteLength, modifiedTime: "now", md5Checksum: expected.md5Checksum, parentId: "parent-1" };
    };
    const uploaded = await plugin.uploadLocalFile("note.md", "root", null, { reservedRemoteId: "reserved-1" });
    assert.strictEqual(uploaded.id, "reserved-1");
    assert.strictEqual(requests, 1);
    assert.strictEqual(reconciliations, 1, "ambiguous POST must be reconciled by reserved ID");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const bytes = new TextEncoder().encode("unchanged large PDF bytes").buffer;
    const md5Checksum = createHash("md5").update(Buffer.from(bytes)).digest("hex");
    plugin.localPathExists = async () => true;
    plugin.localStatInfoByPath = async () => ({ path: "paper.pdf", size: bytes.byteLength, mtime: 2 });
    plugin.readLocalBinary = async () => bytes;
    plugin.ensureRemoteParent = async () => { throw new Error("matching content must not prepare an upload"); };
    plugin.driveFetch = async () => { throw new Error("matching content must not reach Google Drive upload"); };
    const remote = {
      id: "remote-pdf",
      path: "paper.pdf",
      size: bytes.byteLength,
      modifiedTime: "same",
      md5Checksum,
      parentId: "parent"
    };
    const result = await plugin.uploadLocalFile("paper.pdf", "root", remote, {
      adoptIfContentMatches: true,
      beforeRemoteCommit: async () => remote
    });
    assert.strictEqual(result.contentAlreadyMatched, true, "same-size matching MD5 must adopt instead of uploading");
    assert.strictEqual(result.id, remote.id);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const base = {
      "ours.md": { id: "ours-old", size: 1, md5Checksum: "a" }
    };
    const latest = {
      "ours.md": { id: "ours-old", size: 1, md5Checksum: "a" },
      "theirs.md": { id: "theirs", size: 2, md5Checksum: "b" }
    };
    const merged = plugin.mergeRemoteSnapshotMutationSet(base, latest, {
      "ours.md": { id: "ours-new", size: 3, md5Checksum: "c" }
    });
    assert.strictEqual(merged["ours.md"].id, "ours-new");
    assert.strictEqual(merged["theirs.md"].id, "theirs", "unrelated concurrent changes must survive merge");
    assert.throws(() => plugin.mergeRemoteSnapshotMutationSet(base, {
      "ours.md": { id: "theirs-edit", size: 4, md5Checksum: "d" }
    }, {
      "ours.md": { id: "ours-new", size: 3, md5Checksum: "c" }
    }), /conflicts at ours\.md/);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const base = { "ours.md": { id: "old", size: 1, md5Checksum: "a" } };
    plugin.driveFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ files: [{ id: "snapshot", modifiedTime: "new-generation" }] })
    });
    plugin.loadRemoteSnapshotById = async () => ({
      files: Object.assign({}, base, { "theirs.md": { id: "theirs", size: 2, md5Checksum: "b" } }),
      deleted: {}
    });
    let writtenContent;
    plugin.uploadTextContent = async (_name, _root, content) => {
      writtenContent = JSON.parse(content);
      return { id: "snapshot", modifiedTime: "written" };
    };
    plugin.reconcileRemoteSnapshotCommit = async () => ({ id: "snapshot", modifiedTime: "verified" });
    plugin.mergeRemoteDeleteTombstones = (previous) => previous;
    const result = await plugin.writeRemoteSnapshotFile("root", {
      "ours.md": { id: "new", size: 3, md5Checksum: "c" }
    }, {}, {
      runId: "run",
      expectedSnapshotFileId: "snapshot",
      expectedSnapshotModifiedTime: "old-generation",
      baseFiles: base,
      mutations: { "ours.md": { id: "new", size: 3, md5Checksum: "c" } },
      newDeleted: {}
    });
    assert.strictEqual(result.mergedConflict, true);
    assert.strictEqual(writtenContent.files["ours.md"].id, "new");
    assert.strictEqual(writtenContent.files["theirs.md"].id, "theirs");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { remoteSnapshotProtocolVersion: 2 });
    const responses = [
      { files: [{ id: "snapshot", modifiedTime: "now" }] },
      { version: 1, files: {}, deleted: {} }
    ];
    plugin.driveFetch = async () => {
      const value = responses.shift();
      return { ok: true, status: 200, text: async () => JSON.stringify(value) };
    };
    await assert.rejects(
      () => plugin.loadRemoteSnapshotFile("root"),
      /downgraded by an older DriveBridge device/
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const journal = {
      version: 1,
      runId: "old-run",
      status: "completed_with_errors",
      operations: {
        "note.md": {
          runId: "old-run",
          path: "note.md",
          action: "upload",
          status: "failed",
          localBefore: { size: 4 }
        }
      }
    };
    plugin.findRemoteFileByExactName = async () => ({
      id: "already-created",
      name: "note.md",
      size: 4,
      md5Checksum: "abcd",
      parentId: "root"
    });
    plugin.localPathExists = async () => true;
    plugin.localInfoByPath = async () => ({ path: "note.md", size: 4, mtime: 1 });
    plugin.localMd5ByPath = async () => "abcd";
    plugin.writeOperationJournal = async (value) => {
      plugin.operationJournalCache = value;
      plugin.operationJournalDirty = false;
    };
    const context = { rootFolderId: "root", remote: {}, remoteDeleted: {} };
    await plugin.reconcileRecoveryContext({ journal }, context);
    assert.strictEqual(context.remote["note.md"].id, "already-created");
    assert.strictEqual(context.recoveredRemoteMutations["note.md"].id, "already-created");
    assert.strictEqual(journal.operations["note.md"].status, "done");
    assert.strictEqual(journal.operations["note.md"].phase, "remote_verified");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const remoteBefore = { id: "deleted-id", path: "gone.md", size: 7, md5Checksum: "dead" };
    const journal = {
      version: 2,
      runId: "delete-run",
      status: "commit_pending",
      operations: {
        "gone.md": {
          path: "gone.md",
          action: "deleteRemote",
          status: "in_progress",
          remoteBefore
        }
      }
    };
    plugin.remoteInfoById = async () => null;
    plugin.writeOperationJournal = async (value) => {
      plugin.operationJournalCache = value;
      plugin.operationJournalDirty = false;
    };
    const context = {
      rootFolderId: "root",
      remote: { "gone.md": remoteBefore },
      remoteDeleted: {}
    };
    await plugin.reconcileRecoveryContext({ journal }, context);
    assert.strictEqual(context.remote["gone.md"], undefined);
    assert.strictEqual(context.recoveredRemoteMutations["gone.md"], null);
    assert.ok(context.recoveredRemoteDeleted["gone.md"]);
    assert.strictEqual(journal.operations["gone.md"].status, "done");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.assertLocalUnchangedSincePlan = async () => {};
    plugin.assertRemoteUnchangedSincePlan = async () => {};
    plugin.hasSameContent = async () => {
      throw new Error("large manual conflicts must not be hashed during execution");
    };
    const reviews = [];
    const stats = { review: 0 };
    const largeSize = 11 * 1024 * 1024;
    await plugin.executeEntry(
      { path: "note.md", action: "conflict", reason: "changed on both sides" },
      {
        local: { "note.md": { path: "note.md", size: largeSize, mtime: 1 } },
        remote: { "note.md": { path: "note.md", id: "r1", size: largeSize, modifiedTime: "2026-01-01", md5Checksum: "a" } }
      },
      {},
      stats,
      {},
      {},
      reviews
    );
    assert.strictEqual(stats.review, 1);
    assert.strictEqual(reviews.length, 1);
  }

  {
    const { PluginClass, requests, responses } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.ensureAccessToken = async () => {};
    responses.push(
      { status: 503, text: "{}", json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} },
      { status: 200, text: "{}", json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} }
    );
    const response = await plugin.driveFetch("https://example.test/create", { method: "POST" });
    assert.strictEqual(response.status, 503);
    assert.strictEqual(requests.length, 1, "POST must not be blindly retried");
  }

  {
    const { PluginClass, requests, responses } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.ensureAccessToken = async () => {};
    responses.push(
      new Error("offline"),
      { status: 200, text: "{}", json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} }
    );
    const response = await plugin.driveFetch("https://example.test/read");
    assert.strictEqual(response.status, 200);
    assert.strictEqual(requests.length, 2, "idempotent reads should retry transient network failures");
  }

  {
    const { PluginClass, requests, responses } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.ensureAccessToken = async () => {};
    responses.push(new Error("offline"));
    await assert.rejects(
      () => plugin.driveFetch("https://example.test/create", { method: "POST" }),
      (error) => error.code === "DRIVEBRIDGE_NETWORK_ERROR"
    );
    assert.strictEqual(requests.length, 1, "ambiguous POST must be reconciled by its caller, not blindly retried");
  }

  {
    const { PluginClass, requests, responses } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.ensureAccessToken = async () => {};
    responses.push(new Error("net::ERR_INVALID_ARGUMENT"));
    await assert.rejects(
      () => plugin.driveFetch("https://example.test/upload", { method: "PUT" }),
      (error) => error.code === "DRIVEBRIDGE_NETWORK_ERROR" && error.retryable === false
    );
    assert.strictEqual(requests.length, 1, "deterministic Electron request errors must not be retried");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const files = new Map();
    const folders = new Set(["", ".obsidian", ".obsidian/plugins", plugin.manifest.dir]);
    let readTransform = (value) => value;
    const adapter = {
      exists: async (target) => files.has(target) || folders.has(target),
      read: async (target) => {
        if (!files.has(target)) throw new Error(`missing ${target}`);
        return readTransform(files.get(target), target);
      },
      write: async (target, value) => { files.set(target, value); },
      remove: async (target) => { files.delete(target); },
      rename: async (from, to) => {
        if (!files.has(from)) throw new Error(`missing ${from}`);
        files.set(to, files.get(from));
        files.delete(from);
      },
      mkdir: async (target) => { folders.add(target); }
    };
    plugin.app = { vault: { adapter } };
    const snapshot = { "note.md": { local: { size: 1, mtime: 1 }, remote: { id: "r", size: 1 } } };
    await plugin.saveSnapshot(snapshot);
    assert.strictEqual(files.get(plugin.pluginDataPath("snapshot.json")).includes("\n"), false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await plugin.loadSnapshot())), snapshot);

    readTransform = (value, target) => target.endsWith(".tmp")
      ? `\uFEFF${value.replace(/\n/g, "\r\n")}`
      : value;
    const normalizedSnapshot = { "note.md": { local: { size: 2, mtime: 2 }, remote: { id: "r", size: 2 } } };
    await plugin.saveSnapshot(normalizedSnapshot);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await plugin.loadSnapshot())), normalizedSnapshot);

    readTransform = (value, target) => target.endsWith(".tmp")
      ? JSON.stringify(JSON.parse(value), null, 2)
      : value;
    const reformattedSnapshot = { "note.md": { local: { size: 3, mtime: 3 }, remote: { id: "r", size: 3 } } };
    await plugin.saveSnapshot(reformattedSnapshot);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await plugin.loadSnapshot())), reformattedSnapshot);

    let transientReadAttempts = 0;
    readTransform = (value, target) => {
      if (!target.endsWith(".tmp")) return value;
      transientReadAttempts++;
      return transientReadAttempts < 3 ? value.slice(0, -8) : value;
    };
    const retriedSnapshot = { "note.md": { local: { size: 4, mtime: 4 }, remote: { id: "r", size: 4 } } };
    await plugin.saveSnapshot(retriedSnapshot);
    assert.strictEqual(transientReadAttempts, 3);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await plugin.loadSnapshot())), retriedSnapshot);

    const largeJson = JSON.stringify({ payload: "x".repeat(1225000) });
    let largeReadAttempts = 0;
    readTransform = (value, target) => {
      if (!target.endsWith(".tmp")) return value;
      largeReadAttempts++;
      return largeReadAttempts === 1 ? value.slice(0, 1002892) : value;
    };
    await plugin.writePluginDataFileAtomic("large-test.json", "large-test.previous.json", largeJson);
    assert.strictEqual(largeReadAttempts, 2);
    assert.strictEqual(files.get(plugin.pluginDataPath("large-test.json")), largeJson);

    readTransform = (value) => value;
    const operationJournal1 = {
      version: 2,
      runId: "journal-run",
      status: "running",
      operations: {
        "note.md": { path: "note.md", action: "upload", status: "pending" }
      }
    };
    const operationJournal2 = JSON.parse(JSON.stringify(operationJournal1));
    operationJournal2.status = "commit_pending";
    await plugin.writeOperationJournal(operationJournal1);
    await plugin.writeOperationJournal(operationJournal2);
    assert.strictEqual((await plugin.readOperationJournal()).status, "commit_pending");
    files.set(plugin.pluginDataPath("operation-journal.json"), "{");
    assert.strictEqual((await plugin.readOperationJournal()).status, "running",
      "a corrupted operation journal must fall back to its atomic previous generation");

    const savedBeforeMismatch = files.get(plugin.pluginDataPath("snapshot.json"));
    readTransform = (value, target) => target.endsWith(".tmp") ? "{\"different\":true}" : value;
    await assert.rejects(() => plugin.saveSnapshot(snapshot), /Atomic write verification failed/);
    assert.strictEqual(files.get(plugin.pluginDataPath("snapshot.json")), savedBeforeMismatch);

    readTransform = (value, target) => target.endsWith(".tmp") ? "{" : value;
    await assert.rejects(() => plugin.saveSnapshot(snapshot), /Atomic write verification failed/);
    assert.strictEqual(files.get(plugin.pluginDataPath("snapshot.json")), savedBeforeMismatch);

    readTransform = (value) => value;
    files.set(plugin.pluginDataPath("snapshot.json"), "{");
    files.delete(plugin.pluginDataPath("snapshot.previous.json"));
    await assert.rejects(() => plugin.loadSnapshot(), /corrupted/);

    const snapshotBackup = { "backup.md": { local: { size: 5, mtime: 5 }, remote: { id: "backup", size: 5 } } };
    files.set(plugin.pluginDataPath("snapshot.previous.json"), JSON.stringify(snapshotBackup));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await plugin.loadSnapshot())), snapshotBackup);
    assert.strictEqual(files.get(plugin.pluginDataPath("snapshot.json")), "{", "recovery must preserve the damaged primary for diagnosis");

    files.set(plugin.pluginDataPath("review-queue.json"), "{");
    const queueBackup = { version: 1, items: [{ id: "review-1", path: "conflict.md" }] };
    files.set(plugin.pluginDataPath("review-queue.previous.json"), `\uFEFF${JSON.stringify(queueBackup)}`);
    assert.deepStrictEqual(await plugin.loadReviewQueue(), queueBackup);
    assert.strictEqual(files.get(plugin.pluginDataPath("review-queue.json")), "{", "review recovery must not overwrite the damaged primary");

    files.set(plugin.pluginDataPath("review-queue.json"), JSON.stringify({ version: 1, items: [null] }));
    assert.deepStrictEqual(await plugin.loadReviewQueue(), queueBackup, "structurally invalid JSON must also fall back");

    const replacementQueue = { version: 1, items: [{ id: "review-2", path: "new-conflict.md" }] };
    await plugin.saveReviewQueue(replacementQueue);
    assert.deepStrictEqual(JSON.parse(files.get(plugin.pluginDataPath("review-queue.json"))), replacementQueue);
    assert.deepStrictEqual(JSON.parse(files.get(plugin.pluginDataPath("review-queue.previous.json")).slice(1)), queueBackup,
      "the verified recovery backup must not be replaced by the damaged primary");
    assert.ok(Array.from(files.keys()).some((target) => target.endsWith(".corrupted")),
      "the damaged primary must be quarantined for diagnosis after a successful replacement");

    files.set(plugin.pluginDataPath("review-queue.json"), "{");
    files.set(plugin.pluginDataPath("review-queue.previous.json"), "[]");
    await assert.rejects(() => plugin.loadReviewQueue(), /no verified backup.*without discarding items/);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, {
      syncDeletes: true,
      protectModifyPercentage: 100,
      allowLargeDeleteOnce: false,
      approvedDeletePlanDigest: ""
    });
    const snapshot = {};
    const local = {};
    const remote = {};
    const entries = [];
    for (let index = 0; index < 10; index++) {
      const pathValue = `note-${index}.md`;
      snapshot[pathValue] = { local: { size: 1, mtime: 1 }, remote: { id: `r${index}`, size: 1 } };
      local[pathValue] = { path: pathValue, size: 1, mtime: 1 };
      remote[pathValue] = { path: pathValue, id: `r${index}`, size: 1 };
      entries.push({ path: pathValue, action: "deleteRemote" });
    }
    const context = { snapshot, local, remote, planDigest: "approved-plan" };
    const plan = { entries };
    assert.throws(() => plugin.assertRealSyncAllowed(context, plan), /Large delete safeguard/);
    plugin.settings.allowLargeDeleteOnce = true;
    plugin.settings.approvedDeletePlanDigest = "approved-plan";
    plugin.assertRealSyncAllowed(context, plan);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const local = { path: "note.md", size: 1, mtime: 1 };
    const remote = { path: "note.md", id: "r1", size: 1, modifiedTime: "2026-01-01", md5Checksum: "a" };
    const incoming = plugin.reviewItemFrom({ path: "note.md", reason: "changed" }, local, remote);
    const existing = Object.assign({}, incoming, { createdAt: "old-time" });
    plugin.loadReviewQueue = async () => ({ version: 1, items: [existing] });
    let writes = 0;
    plugin.saveReviewQueue = async () => { writes++; };
    const changed = await plugin.reconcileReviewQueue({ entries: [{ path: "note.md", action: "conflict" }] }, [incoming]);
    assert.strictEqual(changed, false);
    assert.strictEqual(writes, 0, "an unchanged review queue must not be atomically rewritten");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const snapshot = plugin.snapshotFrom(
      { path: "note.md", size: 1, mtime: 1 },
      { path: "note.md", id: "r1", size: 1, modifiedTime: "2026-01-01", md5Checksum: "a", parentId: "folder-1" }
    );
    assert.strictEqual(snapshot.remote.parentId, "folder-1");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { conflictAction: "manualReview" });
    assert.strictEqual(plugin.isDangerousRecoveryOperation({ action: "conflict" }), false);
    assert.strictEqual(plugin.unsafeResumePlanEntries({ entries: [{ action: "conflict" }] }).length, 0);
    plugin.settings.conflictAction = "newerWithBackup";
    assert.strictEqual(plugin.isDangerousRecoveryOperation({ action: "conflict" }), true);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const files = new Map();
    plugin.app = {
      vault: {
        adapter: {
          exists: async (target) => files.has(target),
          writeBinary: async (target, value) => { files.set(target, value); },
          remove: async (target) => { files.delete(target); },
          rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); }
        }
      }
    };
    plugin.ensureLocalParent = async () => {};
    plugin.assertDownloadedTempMatchesRemote = async () => {};
    plugin.localPathExists = async () => false;
    let rechecked = false;
    plugin.assertLocalUnchangedSincePlan = async (_path, planned) => {
      rechecked = planned === null;
    };
    await plugin.writeVerifiedDownload(
      "note.md",
      { id: "r1", size: 1 },
      new ArrayBuffer(1),
      { plannedLocal: null }
    );
    assert.strictEqual(rechecked, true, "download must recheck local state immediately before replacement");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.localPathExists = async () => true;
    plugin.localInfoByPath = async () => ({ path: "note.md", size: 1, mtime: 1001 });
    await plugin.assertLocalUnchangedSincePlan("note.md", { path: "note.md", size: 1, mtime: 1000 });
    await assert.rejects(
      () => plugin.assertLocalUnchangedSincePlan("note.md", { path: "note.md", size: 1, mtime: 1000 }, true),
      /changed during sync/
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.loadReviewQueue = async () => ({ version: 1, items: [] });
    const modal = new PluginClass.__ReviewModal({}, plugin, { version: 1, items: [] });
    await modal.refreshQueue();
    assert.strictEqual(modal.queue.items.length, 0, "review modal refresh must render an empty queue without runtime errors");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const item = {
      id: "review-1",
      path: "0_Notes/03_Lab_Notes/a-very-long-conflict-name.md",
      reason: "changed on both sides",
      local: { size: 10, mtime: 1 },
      remote: { id: "remote-1", size: 11, modifiedTime: "2026-07-18T00:00:00Z" }
    };
    const modal = new PluginClass.__ReviewModal({}, plugin, { version: 1, items: [item] });
    assert.doesNotThrow(() => modal.render(), "review modal must render selectable conflict rows");
    assert.strictEqual(modal.checkedIds.size, 0);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.syncing = false;
    const calls = [];
    plugin.resolveReviewItem = async (itemId, action, options) => {
      calls.push({ itemId, action, options, locked: plugin.syncing });
      if (itemId === "stale") throw new Error("changed after review");
      return `${itemId}.md`;
    };
    plugin.clearSyncStatus = () => {};
    const result = await PluginClass.prototype.resolveReviewItems.call(
      plugin,
      ["first", "stale", "last", "first"],
      "keepRemote"
    );
    assert.strictEqual(calls.length, 3, "bulk review must deduplicate selected IDs");
    assert.ok(calls.every((call) => call.locked && call.options.lockHeld && call.options.silent),
      "bulk review must hold one sync lock while reusing the single-item verification path");
    assert.strictEqual(JSON.stringify(result.resolved.map((item) => item.id)), JSON.stringify(["first", "last"]));
    assert.strictEqual(JSON.stringify(result.failed.map((item) => item.id)), JSON.stringify(["stale"]));
    assert.strictEqual(plugin.syncing, false, "bulk review must release the sync lock after partial failure");
    await assert.rejects(
      () => PluginClass.prototype.resolveReviewItems.call(plugin, ["first"], "keepBoth"),
      /only Local or Drive/
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const local = { path: "conflict.md", size: 3, mtime: 10 };
    const remote = {
      path: "conflict.md",
      id: "remote-1",
      size: 4,
      modifiedTime: "2026-01-01T00:00:00Z",
      md5Checksum: "abcd"
    };
    const item = plugin.reviewItemsForPlan({ entries: [
      { path: "conflict.md", action: "conflict", reason: "changed on both sides" }
    ] }, { local: { "conflict.md": local }, remote: { "conflict.md": remote } })[0];
    plugin.syncing = false;
    plugin.loadReviewQueue = async () => ({ version: 1, items: [item] });
    plugin.ensureAccessToken = async () => {};
    plugin.ensureRootFolder = async () => "root";
    plugin.localInfoByPath = async () => local;
    plugin.remoteInfoById = async () => remote;
    let conflictCopies = 0;
    plugin.writeConflictCopy = async () => { conflictCopies++; };
    plugin.uploadLocalFile = async () => ({ ...remote, size: local.size });
    plugin.snapshotFrom = () => ({ local: {}, remote: {} });
    plugin.loadSnapshot = async () => ({});
    plugin.saveSnapshot = async () => {};
    plugin.scanRemoteVault = async () => ({ files: {}, deleted: {} });
    plugin.saveRemoteSnapshot = async () => {};
    plugin.saveReviewQueue = async () => { plugin.reviewCount = 0; };
    plugin.saveSettings = async () => {};
    plugin.clearSyncStatus = () => {};
    await plugin.resolveReviewItem(item.id, "keepLocal", { silent: true });
    assert.strictEqual(conflictCopies, 0, "Use Local must discard the Drive version without creating a conflict copy");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const local = { path: "conflict.md", size: 3, mtime: 10 };
    const localAfter = { path: "conflict.md", size: 4, mtime: 20 };
    const remote = {
      path: "conflict.md",
      id: "remote-1",
      size: 4,
      modifiedTime: "2026-01-01T00:00:00Z",
      md5Checksum: "abcd"
    };
    const item = plugin.reviewItemsForPlan({ entries: [
      { path: "conflict.md", action: "conflict", reason: "changed on both sides" }
    ] }, { local: { "conflict.md": local }, remote: { "conflict.md": remote } })[0];
    plugin.syncing = false;
    plugin.loadReviewQueue = async () => ({ version: 1, items: [item] });
    plugin.ensureAccessToken = async () => {};
    plugin.ensureRootFolder = async () => "root";
    let downloaded = false;
    plugin.localInfoByPath = async () => downloaded ? localAfter : local;
    plugin.remoteInfoById = async () => remote;
    let conflictRenames = 0;
    plugin.renameLocalToConflict = async () => { conflictRenames++; };
    let plannedLocal;
    plugin.downloadRemoteFile = async (_path, _remote, options) => {
      plannedLocal = options.plannedLocal;
      downloaded = true;
    };
    plugin.hasSameContent = async () => true;
    plugin.snapshotFrom = () => ({ local: {}, remote: {} });
    plugin.loadSnapshot = async () => ({});
    plugin.saveSnapshot = async () => {};
    plugin.scanRemoteVault = async () => ({ files: {}, deleted: {} });
    plugin.saveRemoteSnapshot = async () => {};
    plugin.saveReviewQueue = async () => { plugin.reviewCount = 0; };
    plugin.saveSettings = async () => {};
    plugin.clearSyncStatus = () => {};
    await plugin.resolveReviewItem(item.id, "keepRemote", { silent: true });
    assert.strictEqual(conflictRenames, 0, "Use Drive must replace Local without creating a conflict copy");
    assert.strictEqual(plannedLocal, local, "Use Drive must recheck the planned Local version before atomic replacement");
  }

  {
    const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
    assert.match(css, /\.drivebridge-review-item\s*\{[^}]*height:\s*auto/s,
      "review rows must override Obsidian's fixed button height for wrapped paths");
    assert.match(css, /\.drivebridge-review-row\s*\{[^}]*grid-template-columns:/s,
      "review rows must reserve a separate checkbox column");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, {
      duplicateGuardMode: "auto",
      lastSyncHadErrors: false,
      duplicateGuardRootChanged: false,
      duplicateGuardAfterRebuild: false,
      duplicateGuardFolderPaths: ""
    });
    const context = {
      snapshot: { "existing.md": { remote: { id: "existing" } } },
      remoteSnapshotAt: 1,
      remoteSnapshotMissing: false,
      remoteSnapshotFromFullScan: false,
      newUploadParentPathCounts: { folder: 1 }
    };
    assert.strictEqual(
      plugin.shouldUseDuplicateGuard(context, { path: "folder/new.md", action: "upload" }, null),
      true,
      "Auto must guard every new Drive create, even in a healthy-looking single-upload sync"
    );
    assert.strictEqual(
      plugin.shouldUseDuplicateGuard(context, { path: "folder/existing.md", action: "upload" }, { id: "existing" }),
      false,
      "updates to a known Drive ID must not pay the create preflight cost"
    );
    assert.strictEqual(
      plugin.shouldUseExactNameDuplicateGuard(context, { path: "folder/new.md", action: "upload" }, null),
      true,
      "a lone Auto create must use the small exact-name query instead of listing a large parent"
    );
    context.newUploadParentPathCounts.folder = 2;
    assert.strictEqual(
      plugin.shouldUseExactNameDuplicateGuard(context, { path: "folder/new.md", action: "upload" }, null),
      false,
      "multiple Auto creates in one parent must share one parent scan"
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { duplicateGuardMode: "auto" });
    plugin.remoteChildCache = new Map();
    plugin.syncMetrics = { duplicateGuardPreflightParents: 0 };
    let requests = 0;
    plugin.driveFetch = async () => {
      requests++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ files: [{ id: "old", name: "old.md", mimeType: "text/markdown" }] })
      };
    };
    await plugin.ensureNoRemoteNameCollision("parent", "new-a.md", "folder");
    await plugin.ensureNoRemoteNameCollision("parent", "new-b.md", "folder");
    assert.strictEqual(requests, 1, "Auto preflight must be shared by every new upload in the same parent");
    assert.strictEqual(plugin.syncMetrics.duplicateGuardPreflightParents, 1);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { duplicateGuardMode: "auto" });
    plugin.syncMetrics = { duplicateGuardPreflightParents: 0 };
    let exactQueries = 0;
    plugin.remoteFilesByExactName = async () => { exactQueries++; return []; };
    await plugin.ensureNoExactRemoteNameCollision("parent", "new.md", "folder");
    assert.strictEqual(exactQueries, 1);
    assert.strictEqual(plugin.syncMetrics.duplicateGuardPreflightParents, 1);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { duplicateGuardMode: "auto" });
    plugin.syncMetrics = { duplicateGuardPostflightParents: 0, duplicateGuardSelfHealed: 0 };
    const oldFile = {
      id: "old-id",
      name: "same.md",
      size: "4",
      md5Checksum: "abcd",
      createdTime: "2026-07-09T00:00:00.000Z",
      modifiedTime: "2026-07-09T00:00:00.000Z",
      mimeType: "text/markdown",
      parents: ["parent"]
    };
    const newFile = Object.assign({}, oldFile, {
      id: "new-id",
      createdTime: "2026-07-10T00:00:00.000Z",
      modifiedTime: "2026-07-10T00:00:00.000Z"
    });
    let listCalls = 0;
    plugin.remoteFilesByExactName = async () => {
      listCalls++;
      return [oldFile, newFile];
    };
    const trashed = [];
    plugin.trashRemote = async (id) => { trashed.push(id); };
    let operationDetails;
    plugin.updateOperation = async (_runId, _entry, _status, _context, _error, details) => {
      operationDetails = details;
    };
    const context = { remote: {}, local: { "folder/same.md": { size: 4, mtime: 1 } } };
    const entries = [{ path: "folder/same.md", action: "upload" }];
    const nextSnapshot = {
      "folder/same.md": plugin.snapshotFrom(context.local["folder/same.md"], {
        id: "new-id", size: 4, md5Checksum: "abcd", modifiedTime: newFile.modifiedTime, parentId: "parent"
      })
    };
    const remoteMutations = {
      "folder/same.md": { id: "new-id", name: "same.md", size: 4, md5Checksum: "abcd", modifiedTime: newFile.modifiedTime, parentId: "parent" }
    };
    await plugin.verifyCreatedUploadDuplicates(context, entries, nextSnapshot, remoteMutations, "run-1");
    assert.deepStrictEqual(trashed, ["new-id"], "only this run's later exact duplicate may be trashed");
    assert.strictEqual(remoteMutations["folder/same.md"].id, "old-id");
    assert.strictEqual(nextSnapshot["folder/same.md"].remote.id, "old-id");
    assert.strictEqual(listCalls, 1, "postflight is batched once per parent");
    assert.strictEqual(plugin.syncMetrics.duplicateGuardPostflightParents, 1);
    assert.strictEqual(plugin.syncMetrics.duplicateGuardSelfHealed, 1);
    assert.strictEqual(operationDetails.remoteResult.id, "old-id");
    assert.strictEqual(operationDetails.reservedRemoteId, "", "Recovery must prefer the adopted canonical ID over the trashed reserved ID");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { duplicateGuardMode: "auto" });
    plugin.syncMetrics = { duplicateGuardPostflightParents: 0, duplicateGuardSelfHealed: 0 };
    plugin.remoteFilesByExactName = async () => [{
      id: "old-id", name: "same.md", size: "4", md5Checksum: "old", createdTime: "2026-07-09T00:00:00.000Z", mimeType: "text/markdown", parents: ["parent"]
    }, {
      id: "new-id", name: "same.md", size: "4", md5Checksum: "new", createdTime: "2026-07-10T00:00:00.000Z", mimeType: "text/markdown", parents: ["parent"]
    }];
    let trashed = false;
    plugin.trashRemote = async () => { trashed = true; };
    const context = { remote: {}, local: { "folder/same.md": { size: 4, mtime: 1 } } };
    const entries = [{ path: "folder/same.md", action: "upload" }];
    const nextSnapshot = { "folder/same.md": plugin.snapshotFrom(context.local["folder/same.md"], {
      id: "new-id", size: 4, md5Checksum: "new", parentId: "parent"
    }) };
    const remoteMutations = { "folder/same.md": {
      id: "new-id", name: "same.md", size: 4, md5Checksum: "new", parentId: "parent"
    } };
    await assert.rejects(
      () => plugin.verifyCreatedUploadDuplicates(context, entries, nextSnapshot, remoteMutations, "run-1"),
      /different content|could not be safely reconciled/
    );
    assert.strictEqual(trashed, false, "different-content duplicates must never be auto-trashed");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { duplicateGuardMode: "auto" });
    let trashed = false;
    plugin.trashRemote = async () => { trashed = true; };
    const same = { name: "same.md", size: "4", md5Checksum: "same", mimeType: "text/markdown" };
    const matches = [
      Object.assign({ id: "old-a", createdTime: "2026-07-08T00:00:00.000Z" }, same),
      Object.assign({ id: "old-b", createdTime: "2026-07-09T00:00:00.000Z" }, same),
      Object.assign({ id: "new", createdTime: "2026-07-10T00:00:00.000Z" }, same)
    ];
    await assert.rejects(
      () => plugin.reconcileCreatedUploadDuplicate(
        "folder/same.md",
        { id: "new", size: 4, md5Checksum: "same", parentId: "parent" },
        matches,
        "parent",
        { local: { "folder/same.md": { size: 4, mtime: 1 } } },
        {},
        {},
        "run-1"
      ),
      /could not be safely reconciled/
    );
    assert.strictEqual(trashed, false, "more than one pre-existing candidate is ambiguous and must not be auto-trashed");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { duplicateGuardMode: "auto" });
    plugin.syncMetrics = { duplicateGuardPostflightParents: 0, duplicateGuardSelfHealed: 0 };
    let queries = 0;
    plugin.remoteFilesByExactName = async () => { queries++; return []; };
    await assert.rejects(
      () => plugin.verifyCreatedUploadDuplicates(
        { remote: {}, local: { "folder/new.md": { size: 1, mtime: 1 } } },
        [{ path: "folder/new.md", action: "upload" }],
        {},
        { "folder/new.md": { id: "reserved", name: "new.md", size: 1, md5Checksum: "a", parentId: "parent" } },
        "run-1"
      ),
      /not visible during duplicate verification/
    );
    assert.strictEqual(queries, 2, "an inconclusive postflight gets one collision-only visibility retry");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { duplicateGuardMode: "auto" });
    plugin.syncMetrics = { duplicateGuardPostflightParents: 0, duplicateGuardSelfHealed: 0 };
    let listCalls = 0;
    plugin.remoteChildren = async () => {
      listCalls++;
      return [{ id: "a", name: "a.md", size: "1", md5Checksum: "a", mimeType: "text/markdown" },
        { id: "b", name: "b.md", size: "1", md5Checksum: "b", mimeType: "text/markdown" }];
    };
    const context = { remote: {}, local: {} };
    const entries = [{ path: "folder/a.md", action: "upload" }, { path: "folder/b.md", action: "upload" }];
    const remoteMutations = {
      "folder/a.md": { id: "a", name: "a.md", size: 1, md5Checksum: "a", parentId: "parent" },
      "folder/b.md": { id: "b", name: "b.md", size: 1, md5Checksum: "b", parentId: "parent" }
    };
    await plugin.verifyCreatedUploadDuplicates(context, entries, {}, remoteMutations, "run-1");
    assert.strictEqual(listCalls, 1, "all creates in one parent must share one postflight list request");
    assert.strictEqual(plugin.syncMetrics.duplicateGuardPostflightParents, 1);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    let verified = false;
    let flushedAfterVerification = false;
    let guardRequests = 0;
    const verifyCreatedUploadDuplicates = plugin.verifyCreatedUploadDuplicates.bind(plugin);
    plugin.verifyCreatedUploadDuplicates = async (...args) => {
      verified = true;
      return verifyCreatedUploadDuplicates(...args);
    };
    plugin.remoteChildren = async () => { guardRequests++; return []; };
    plugin.flushOperationJournal = async () => { flushedAfterVerification = verified; };
    let operationUpdates = 0;
    plugin.updateOperation = async () => { operationUpdates++; };
    const unchangedEntries = Array.from({ length: 3064 }, (_, index) => ({
      path: `unchanged-${index}.pdf`,
      action: "skip",
      reason: "unchanged"
    }));
    const result = await plugin.executePlan({ snapshot: {}, local: {}, remote: {} }, { entries: unchangedEntries }, "");
    assert.strictEqual(verified, true, "executePlan must run duplicate postflight before returning");
    assert.strictEqual(flushedAfterVerification, true, "operation journal must flush after postflight reconciliation");
    assert.strictEqual(guardRequests, 0, "an unchanged sync must not make duplicate-guard Drive requests");
    assert.strictEqual(operationUpdates, 0, "unchanged paths must be accounted for in bulk without per-file operation work");
    assert.strictEqual(result.stats.skip, unchangedEntries.length);
    assert.strictEqual(result.total, unchangedEntries.length);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { deviceId: "device-test" });
    plugin.runtimeEpoch = "old-runtime";
    globalThis.__drivebridgeRuntimeEpoch = "new-runtime";
    assert.throws(() => plugin.assertCurrentRuntime(), /newer DriveBridge runtime/);
    plugin.runtimeEpoch = "";
    assert.doesNotThrow(() => plugin.assertCurrentRuntime());
    assert.deepStrictEqual(JSON.parse(JSON.stringify(plugin.provenanceProperties("op-1", "run-1"))), {
      drivebridgeOperationId: "op-1",
      drivebridgeRunId: "run-1",
      drivebridgeDeviceId: "device-test",
      drivebridgeProtocolVersion: "2"
    });
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const pages = [{
      files: [
        { id: "old", name: "same.md", mimeType: "text/markdown", size: "4", createdTime: "2026-01-01T00:00:00Z", md5Checksum: "abcd", parents: ["root"] },
        { id: "new", name: "same.md", mimeType: "text/markdown", size: "4", createdTime: "2026-01-02T00:00:00Z", md5Checksum: "abcd", parents: ["root"] }
      ]
    }];
    plugin.driveFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(pages.shift()) });
    plugin.isExcluded = () => false;
    const groups = [];
    const files = {};
    await plugin.scanRemoteFolder("root", "", files, { duplicateGroups: groups, continueOnDuplicate: true });
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].candidates.length, 2);
    assert.strictEqual(files["same.md"].id, "old", "repair preview keeps a deterministic first candidate without mutating Drive");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.manifest = { version: "0.5.6" };
    const plan = { stats: { upload: 0, download: 0, moveRemote: 0, conflict: 0, adopt: 0, deleteLocal: 0, deleteRemote: 0, skip: 0 }, entries: [] };
    const preview = plugin.formatPlanSummary(plan, true, 500);
    assert.match(preview, /Completed at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);
    const success = plugin.formatRemoteIndexRepairSuccess(42, 3, 1250);
    assert.match(success, /REPAIR REMOTE INDEX — COMPLETE/);
    assert.match(success, /not Normal sync \/ not a file backup/);
    assert.match(success, /Completed at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);
    assert.match(success, /Next: run Normal Preview, then Normal sync/);
    const failure = plugin.formatRemoteIndexRepairFailure({ path: "remote_snapshot.json", message: "duplicate name" }, 2500);
    assert.match(failure, /REPAIR REMOTE INDEX — STOPPED WITH ERROR/);
    assert.match(failure, /Stopped at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);
    assert.match(failure, /Stopped while processing: remote_snapshot\.json/);
    assert.match(failure, /Normal sync was not run/);
    assert.match(failure, /duplicate name/);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.readOperationJournal = async () => ({
      version: 2,
      runId: "interrupted-run",
      status: "running",
      startedAt: "2026-07-17T03:39:18.626Z",
      operations: {
        "done.md": { path: "done.md", action: "upload", status: "done", completedAt: "2026-07-17T03:43:15.452Z" },
        "pending.md": { path: "pending.md", action: "upload", status: "pending" },
        "failed.md": { path: "failed.md", action: "upload", status: "failed", error: { time: "2026-07-17T03:42:00.000Z" } }
      }
    });
    plugin.findPartialDownloads = async () => [];
    const recovery = await plugin.checkInterruptedSync();
    assert.strictEqual(recovery.done.length, 1);
    assert.strictEqual(recovery.pending.length, 1);
    assert.strictEqual(recovery.inProgress.length, 0);
    assert.strictEqual(recovery.failed.length, 1);
    assert.strictEqual(recovery.lastActivityAt, "2026-07-17T03:43:15.452Z");
    const interruptedMessage = plugin.formatInterruptedSyncMessage(recovery);
    assert.match(interruptedMessage, /Journal status: running/);
    assert.match(interruptedMessage, /Done: 1/);
    assert.match(interruptedMessage, /Pending: 1/);
    assert.match(interruptedMessage, /In-progress: 0/);
    assert.match(interruptedMessage, /Failed: 1/);
    assert.match(interruptedMessage, /Stopped at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);

    plugin.checkInterruptedSync = async () => recovery;
    plugin.saveSettings = async () => {};
    await plugin.previewRecovery();
    assert.match(plugin.settings.lastRecoverySummary, /Completed at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);
    assert.match(plugin.settings.lastSyncSummary, /Completed at:/);
    assert.match(plugin.formatErrorModalMessage("DriveBridge sync error 1. Continuing...", [{ action: "upload", path: "note.md", time: "now", message: "failure" }]), /Logged at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { conflictAction: "manualReview" });
    const plan = { entries: [
      { path: "safe.md", action: "download", reason: "remote changed" },
      { path: "gone-local.md", action: "deleteLocal", reason: "remote deletion tombstone detected" },
      { path: "gone-drive.md", action: "deleteRemote", reason: "local deletion detected" },
      { path: "review.md", action: "conflict", reason: "changed on both sides" }
    ] };
    const unsafe = plugin.unsafeResumePlanEntries(plan);
    assert.strictEqual(unsafe.length, 2, "manual-review conflicts are non-mutating during safe resume; deletes are deferred");
    assert.strictEqual(JSON.stringify(plugin.resumeDeferredActionCounts(unsafe)), JSON.stringify({ deletes: 2, conflicts: 0 }));
    const safePlan = plugin.safeResumePlan(plan);
    assert.strictEqual(
      JSON.stringify(safePlan.entries.map((entry) => [entry.path, entry.action, entry.deferredAction || ""])),
      JSON.stringify([
        ["safe.md", "download", ""],
        ["gone-local.md", "skip", "deleteLocal"],
        ["gone-drive.md", "skip", "deleteRemote"],
        ["review.md", "conflict", ""]
      ]),
      "safe resume must execute safe work while preserving delete paths for a later Normal Preview"
    );
    assert.doesNotThrow(() => plugin.assertResumePlanSafe(safePlan));

    plugin.settings.conflictAction = "newerWithBackup";
    const automaticConflictPlan = plugin.safeResumePlan({ entries: [
      { path: "automatic.md", action: "conflict", reason: "changed on both sides" }
    ] });
    assert.strictEqual(automaticConflictPlan.entries[0].action, "skip", "automatic conflict writes must also be deferred");
    assert.strictEqual(automaticConflictPlan.entries[0].deferredAction, "conflict");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.syncing = true;
    plugin.activeOperation = "sync";
    let queuedMessage = "";
    plugin.showProgressModal = (message) => { queuedMessage = message; };
    await plugin.rebuildRemoteSnapshotFromDrive();
    assert.strictEqual(plugin.remoteIndexRepairPending, true, "Repair click during Normal sync must be queued, not dropped");
    assert.match(queuedMessage, /REPAIR REMOTE INDEX — QUEUED/);
    plugin.syncing = false;
    let starts = 0;
    plugin.rebuildRemoteSnapshotFromDrive = async () => { starts++; plugin.remoteIndexRepairPending = false; };
    plugin.startPendingRemoteIndexRepair();
    assert.strictEqual(starts, 1, "queued Repair must start automatically after Normal sync releases DriveBridge");
    const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert.match(source, /this\.skipChangedFilesDuringSync = false;\s+this\.clearSyncStatus\(\);\s+this\.startPendingRemoteIndexRepair\(\);/,
      "Normal sync finally must trigger the queued Repair starter");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const context = {
      local: { "conflict.md": { path: "conflict.md", size: 3, mtime: 10 } },
      remote: { "conflict.md": { path: "conflict.md", id: "remote-1", size: 4, modifiedTime: "2026-01-01T00:00:00Z" } }
    };
    const items = plugin.reviewItemsForPlan({ entries: [
      { path: "upload.md", action: "upload" },
      { path: "conflict.md", action: "conflict", reason: "changed on both sides" }
    ] }, context);
    assert.strictEqual(items.length, 1, "Preview must create review items only for planned conflicts");
    assert.strictEqual(items[0].path, "conflict.md");
    assert.strictEqual(items[0].remote.id, "remote-1");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const bytes = new TextEncoder().encode("unchanged note").buffer;
    let reads = 0;
    const file = { path: "note.md", stat: { size: bytes.byteLength, mtime: 1234 } };
    plugin.app = {
      vault: {
        getFiles: () => [file],
        readBinary: async () => { reads++; return bytes; }
      }
    };
    plugin.isExcluded = () => false;
    const previousHash = "a".repeat(64);
    const result = await plugin.scanLocalVault({
      "note.md": { local: { size: bytes.byteLength, mtime: 1234, sha256: previousHash } }
    });
    assert.strictEqual(reads, 0, "unchanged files must reuse the verified snapshot hash without rereading content");
    assert.strictEqual(result["note.md"].sha256, previousHash);

    file.stat.mtime = 1235;
    const changed = await plugin.scanLocalVault({
      "note.md": { local: { size: bytes.byteLength, mtime: 1234, sha256: previousHash } }
    });
    assert.strictEqual(reads, 1, "a metadata change must force content to be read and hashed again");
    assert.notStrictEqual(changed["note.md"].sha256, previousHash);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { mobileLightweightMode: true });
    plugin.activeSyncContext = {
      local: {
        "z-large.pdf": { size: 50 },
        "a-note.md": { size: 5 },
        "b-config.json": { size: 3 },
        "c-image.png": { size: 4 }
      },
      remote: {}
    };
    const ordered = plugin.orderPlanEntries([
      { path: "z-large.pdf", action: "upload" },
      { path: "delete.md", action: "deleteRemote" },
      { path: "c-image.png", action: "upload" },
      { path: "review.md", action: "conflict" },
      { path: "b-config.json", action: "upload" },
      { path: "a-note.md", action: "upload" }
    ]);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(ordered.map((entry) => entry.path))),
      ["a-note.md", "b-config.json", "c-image.png", "z-large.pdf", "review.md", "delete.md"],
      "notes and small files must run before large attachments, conflicts, and deletes"
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const file = new FakeTFile();
    const bytes = new TextEncoder().encode("hash once").buffer;
    file.path = "note.md";
    file.stat = { size: bytes.byteLength, mtime: 10 };
    let reads = 0;
    plugin.app = {
      vault: {
        getAbstractFileByPath: () => file,
        readBinary: async () => { reads++; return bytes; }
      }
    };
    const first = await plugin.localInfoByPath("note.md");
    const second = await plugin.localInfoByPath("note.md");
    const md5 = await plugin.localMd5ByPath("note.md");
    assert.strictEqual(first.sha256, second.sha256);
    assert.strictEqual(typeof md5, "string");
    assert.strictEqual(reads, 1, "SHA-256 and MD5 for the same size+mtime must share one binary read");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.transferChunkBytes = () => 2;
    plugin.waitForForegroundBeforeLargeTransfer = async () => {};
    plugin.updateTransferProgress = () => {};
    const data = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const requests = [];
    plugin.driveFetch = async (url, options) => {
      requests.push({ url, options });
      if (url.includes("uploadType=resumable")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === "location" ? "https://upload-session" : null }
        };
      }
      const range = options.headers["Content-Range"];
      if (range === "bytes 0-1/5") {
        return { ok: false, status: 308, headers: { get: () => "bytes=0-1" } };
      }
      if (range === "bytes 2-3/5") {
        return { ok: false, status: 308, headers: { get: () => "bytes=0-3" } };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "uploaded", name: "file.bin", size: "5" })
      };
    };
    const progress = [];
    const uploaded = await plugin.uploadResumableFile("file.bin", null, { name: "file.bin" }, data, {
      onChunkProgress: async (value) => progress.push(value)
    });
    assert.strictEqual(uploaded.id, "uploaded");
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(requests.slice(1).map((item) => item.options.body.byteLength))),
      [2, 2, 1],
      "resumable upload must send bounded chunks instead of a second whole-file multipart body"
    );
    assert.ok(
      requests.slice(1).every((item) => !Object.keys(item.options.headers).some((name) => name.toLowerCase() === "content-length")),
      "resumable chunk PUTs must let Electron derive Content-Length from the request body"
    );
    assert.strictEqual(progress.at(-1).uploadedBytes, 5);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    let requestOptions;
    plugin.driveFetch = async (_url, options) => {
      requestOptions = options;
      return {
        ok: false,
        status: 308,
        headers: { get: () => "bytes=0-1" }
      };
    };
    const status = await plugin.queryResumableUpload("https://upload-session", 5);
    assert.strictEqual(status.offset, 2);
    assert.ok(
      !Object.keys(requestOptions.headers).some((name) => name.toLowerCase() === "content-length"),
      "resumable status PUTs must not set Electron's restricted Content-Length header"
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { mobileLightweightMode: true });
    plugin.isMobileRuntime = () => true;
    assert.strictEqual(plugin.transferChunkBytes(), 2 * 1024 * 1024, "mobile transfers should use 2 MiB chunks");
    plugin.isMobileRuntime = () => false;
    assert.strictEqual(plugin.transferChunkBytes(), 1024 * 1024, "desktop transfer chunk behavior must stay unchanged");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const rendered = [];
    plugin.updateSyncProgress = (progress) => rendered.push(progress);
    plugin.activeTransferProgress = {
      completedBytes: 200,
      entryBytes: 100,
      totalBytes: 1000,
      transferredBytes: 0
    };
    plugin.updateTransferProgress("Upload", "large.pdf", 25, 100);
    plugin.updateTransferProgress("Upload", "large.pdf", 10, 100);
    plugin.updateTransferProgress("Upload", "large.pdf", 100, 100);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(rendered.map((item) => item.current))),
      [225, 225, 300],
      "chunk progress must be monotonic and composed into the whole-sync progress bar"
    );
    assert.ok(rendered.every((item) => item.total === 1000));
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.overallProgressContext = {
      startedAt: Date.now() - 10000,
      completedItems: 4,
      totalItems: 20,
      totalBytes: 100
    };
    const progress = plugin.enrichOverallProgress({
      phase: "Attachments",
      current: 25,
      total: 100,
      unit: "bytes",
      action: "upload",
      path: "large.pdf"
    });
    assert.strictEqual(progress.completedItems, 4);
    assert.strictEqual(progress.totalItems, 20);
    assert.match(progress.elapsedText, /^10s$/);
    assert.match(progress.etaText, /^about 30s$/);
    assert.match(progress.finishText, /^\d{2}:\d{2}$/);
    const display = plugin.formatProgressText(progress);
    assert.match(display, /Overall: 25 B \/ 100 B \(25%\)/);
    assert.match(display, /Files: 4 \/ 20/);
    assert.match(display, /ETA: about 30s/);
    assert.match(display, /Finish around: \d{2}:\d{2}/);
    assert.match(display, /Phase: Attachments/);
    assert.match(display, /upload: large\.pdf/);

    const finalizing = plugin.enrichOverallProgress({ current: 100, total: 100, unit: "bytes" });
    assert.strictEqual(finalizing.etaText, "Finalizing...");
    const complete = plugin.enrichOverallProgress({ current: 100, total: 100, unit: "bytes", complete: true });
    assert.strictEqual(complete.etaText, "Done");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const rendered = [];
    plugin.overallProgressContext = {
      startedAt: Date.now() - 10000,
      completedItems: 0,
      totalItems: 0,
      totalBytes: 0
    };
    plugin.updateSyncProgress = (progress) => {
      rendered.push({
        progress: JSON.parse(JSON.stringify(progress)),
        context: JSON.parse(JSON.stringify(plugin.overallProgressContext))
      });
    };
    plugin.planPath = (path) => ({
      path,
      action: path === "conflict.md" ? "conflict" : "skip",
      reason: path === "conflict.md" ? "changed on both sides" : "unchanged"
    });
    plugin.detectMoveEntries = async (entries) => entries;
    plugin.bypassBulkTimestampUpdate = async (entries) => entries;
    const plan = await plugin.buildSyncPlan({
      local: { "conflict.md": {}, "note.md": {} },
      remote: { "conflict.md": {}, "note.md": {} },
      snapshot: {},
      remoteDeleted: {}
    });
    assert.strictEqual(plan.entries.length, 2);
    assert.strictEqual(rendered.length, 3);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(rendered.map((item) => item.progress.current))),
      [0, 1, 2],
      "Preview planning must advance monotonically against the complete path count"
    );
    assert.ok(rendered.every((item) => item.progress.total === 2 && item.progress.unit === "items"));
    assert.ok(rendered.every((item) => item.context.totalItems === 2));
    assert.strictEqual(rendered.at(-1).context.completedItems, 2);
    assert.strictEqual(
      rendered[0].context.startedAt,
      rendered.at(-1).context.startedAt,
      "Preview planning must preserve elapsed time from the beginning of Preview"
    );
    assert.ok(
      rendered[0].context.etaStartedAt >= rendered[0].context.startedAt,
      "Preview ETA must use the comparison phase rate instead of treating earlier scanning as per-path work"
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.transferChunkBytes = () => 2;
    plugin.waitForForegroundBeforeLargeTransfer = async () => {};
    plugin.updateTransferProgress = () => {};
    const source = new Uint8Array([10, 20, 30, 40, 50, 60]);
    plugin.driveFetch = async (_url, options) => {
      const match = options.headers.Range.match(/bytes=(\d+)-(\d+)/);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const chunk = source.slice(start, end + 1);
      return {
        ok: true,
        status: 206,
        headers: { get: (name) => name.toLowerCase() === "content-range" ? `bytes ${start}-${end}/${source.byteLength}` : null },
        arrayBuffer: async () => chunk.buffer
      };
    };
    let written;
    plugin.writeVerifiedDownload = async (_path, _remote, buffer, options) => {
      written = { bytes: Array.from(new Uint8Array(buffer)), options };
    };
    await plugin.downloadRemoteFileInRanges("file.bin", { id: "remote", size: 6 }, {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(written.bytes)), Array.from(source));
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const responseBoundary = "batch-response";
    const body = [
      `--${responseBoundary}\r\nContent-Type: application/http\r\nContent-ID: <response-drivebridge-0>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ id: "a", name: "a.md", size: "1", parents: ["root"] })}\r\n`,
      `--${responseBoundary}\r\nContent-Type: application/http\r\nContent-ID: <response-drivebridge-1>\r\n\r\nHTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{}\r\n`,
      `--${responseBoundary}--\r\n`
    ].join("");
    plugin.driveFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => `multipart/mixed; boundary=${responseBoundary}` },
      text: async () => body
    });
    const values = await plugin.batchGetRemoteInfo(["a", "missing"]);
    assert.strictEqual(values[0].id, "a");
    assert.strictEqual(values[1], null);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.localDirtyTrusted = true;
    plugin.localDirtyPaths = new Map([["changed.md", 2]]);
    plugin.isExcluded = () => false;
    plugin.localPathExists = async () => true;
    let statCalls = 0;
    plugin.localInfoByPath = async (path) => {
      statCalls++;
      return { path, size: 2, mtime: 2, sha256: "b".repeat(64) };
    };
    const result = await plugin.scanLocalVault({
      "unchanged.md": { local: { size: 1, mtime: 1, sha256: "a".repeat(64) } },
      "changed.md": { local: { size: 1, mtime: 1, sha256: "a".repeat(64) } }
    });
    assert.strictEqual(statCalls, 1, "trusted dirty scan must stat only changed paths");
    assert.strictEqual(result["unchanged.md"].mtime, 1);
    assert.strictEqual(result["changed.md"].mtime, 2);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, {
      driveChangesEnabled: true,
      driveChangesPageToken: "token-1"
    });
    const cached = {
      version: 2,
      rootFolderId: "root",
      snapshotFileId: "snapshot",
      snapshotModifiedTime: "2026-07-25T00:00:00Z",
      files: {
        "note.md": { id: "r1", name: "note.md", path: "note.md", size: 1, modifiedTime: "old", md5Checksum: "old", parentId: "root" }
      },
      deleted: {},
      folders: {},
      folderIndexComplete: true
    };
    plugin.loadRemoteStateCache = async () => cached;
    plugin.loadRemoteSnapshotFile = async () => {
      throw new Error("a valid local changes base must avoid downloading remote_snapshot.json");
    };
    plugin.applyRemoteChanges = async (_root, base, token) => {
      assert.strictEqual(base, cached);
      assert.strictEqual(token, "token-1");
      return Object.assign({}, base, { nextPageToken: "token-2" });
    };
    const state = await plugin.scanRemoteVault("root");
    assert.strictEqual(state.nextPageToken, "token-2");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, {
      driveChangesEnabled: true,
      driveChangesPageToken: "stale-token"
    });
    const sharedSnapshot = {
      files: {
        "note.md": { id: "r1", name: "note.md", path: "note.md", size: 1, modifiedTime: "old", md5Checksum: "old", parentId: "root" }
      },
      deleted: {},
      snapshotFileId: "snapshot",
      snapshotModifiedTime: "2026-07-25T00:00:00Z"
    };
    plugin.loadRemoteStateCache = async () => null;
    plugin.loadRemoteSnapshotFile = async () => sharedSnapshot;
    plugin.getDriveStartPageToken = async () => "fresh-token";
    let fullScans = 0;
    plugin.scanRemoteFolder = async (_root, _prefix, files, options) => {
      fullScans++;
      Object.assign(files, sharedSnapshot.files);
      options.folderPaths["folder-1"] = "folder";
    };
    plugin.applyRemoteChanges = async (_root, base, token) => {
      assert.strictEqual(token, "fresh-token", "an incompatible cache must not reuse its stale Changes token");
      assert.strictEqual(base.folderIndexComplete, true);
      assert.strictEqual(base.folders["folder-1"], "folder");
      return Object.assign({}, base, { nextPageToken: "token-2" });
    };
    const previousWarn = console.warn;
    console.warn = () => {};
    let state;
    try {
      state = await plugin.scanRemoteVault("root");
    } finally {
      console.warn = previousWarn;
    }
    assert.strictEqual(fullScans, 1, "a missing or incompatible cache with an existing token must rebuild the folder index once");
    assert.strictEqual(plugin.settings.driveChangesPageToken, "", "the stale token must be cleared before bootstrap");
    assert.strictEqual(state.nextPageToken, "token-2");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.loadPluginDataJsonWithBackup = async (_primary, _backup, _fallback, validate) => {
      const legacy = {
        version: 1,
        rootFolderId: "root",
        snapshotFileId: "snapshot",
        snapshotModifiedTime: "2026-07-25T00:00:00Z",
        files: {},
        deleted: {}
      };
      validate(legacy);
      return legacy;
    };
    const previousWarn = console.warn;
    console.warn = () => {};
    let state;
    try {
      state = await plugin.loadRemoteStateCache("root");
    } finally {
      console.warn = previousWarn;
    }
    assert.strictEqual(state, null, "a legacy v1 cache must fail closed and trigger the full-scan bootstrap path");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isExcluded = () => false;
    plugin.driveFetch = async (url) => {
      assert.match(url, /\/changes\?/);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          newStartPageToken: "token-2",
          changes: [{
            fileId: "r1",
            removed: false,
            file: {
              id: "r1",
              name: "note.md",
              mimeType: "text/markdown",
              size: "2",
              modifiedTime: "2026-07-25T00:00:00Z",
              md5Checksum: "new",
              parents: ["root"],
              trashed: false
            }
          }]
        })
      };
    };
    const state = await plugin.applyRemoteChanges("root", {
      files: {
        "note.md": { id: "r1", name: "note.md", path: "note.md", size: 1, modifiedTime: "old", md5Checksum: "old", parentId: "root" }
      },
      deleted: {}
    }, "token-1");
    assert.strictEqual(state.files["note.md"].size, 2);
    assert.strictEqual(state.nextPageToken, "token-2");
    assert.strictEqual(state.changesApplied, true);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.prefetchRemoteInfoForEntries = async () => {};
    plugin.isExcluded = () => false;
    plugin.updateOperation = async () => {};
    plugin.executeEntry = async () => { throw new Error("expected failure"); };
    plugin.updateSyncProgress = () => {};
    plugin.showProgressModal = () => {};
    plugin.flushOperationJournal = async () => {};
    plugin.verifyCreatedUploadDuplicates = async () => {};
    plugin.appendSyncDetail = async () => {};
    const entries = Array.from({ length: 25 }, (_, index) => ({ path: `note-${index}.md`, action: "upload" }));
    const local = Object.fromEntries(entries.map((entry) => [entry.path, { path: entry.path, size: 1, mtime: 1 }]));
    const previousConsoleError = console.error;
    console.error = () => {};
    let result;
    try {
      result = await plugin.executePlan({ snapshot: {}, local, remote: {} }, { entries }, "run");
    } finally {
      console.error = previousConsoleError;
    }
    assert.strictEqual(result.errorCount, 25);
    assert.strictEqual(result.errors.length, 20, "in-memory error details must be capped");
    assert.strictEqual(result.detailsTruncated, true);
    assert.strictEqual(plugin.localDirtyPaths.size, 25, "every failed path must remain dirty without a second unbounded path collection");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.localDirtyPaths = new Map([
      ["done.md", 1],
      ["failed.md", 3]
    ]);
    plugin.localDirtyGeneration = 3;
    plugin.isExcluded = () => false;
    await plugin.commitLocalDirtyScan({
      localScanWasFull: false,
      localDirtyVersionsScanned: {
        "done.md": 1,
        "failed.md": 2
      }
    });
    assert.strictEqual(plugin.localDirtyPaths.has("done.md"), false);
    assert.strictEqual(plugin.localDirtyPaths.get("failed.md"), 3, "a newer failure generation must survive commit");
    assert.strictEqual(plugin.localDirtyTrusted, true);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.hasSameContent = async () => false;
    plugin.assertLocalUnchangedSincePlan = async () => {};
    let forceOption;
    plugin.assertRemoteUnchangedSincePlan = async (_path, remote, options) => {
      forceOption = options;
      return remote;
    };
    plugin.assertRemoteContentUnchangedSincePlan = async (_path, remote, options) => {
      forceOption = options;
      return remote;
    };
    const local = { path: "large.pdf", size: 60 * 1024 * 1024, mtime: 1 };
    const remote = { id: "remote", path: "large.pdf", size: local.size, md5Checksum: "old" };
    plugin.localInfoByPath = async () => local;
    plugin.uploadLocalFile = async () => Object.assign({}, remote, { md5Checksum: "new" });
    plugin.resumableStateForOperation = () => ({});
    plugin.shouldUseDuplicateGuard = () => false;
    plugin.shouldRefreshDuplicateGuardPreflight = () => false;
    plugin.shouldUseExactNameDuplicateGuard = () => false;
    plugin.reservedRemoteIdForOperation = () => "";
    plugin.operationIdForPath = () => "";
    await plugin.executeEntry(
      { path: "large.pdf", action: "upload" },
      { rootFolderId: "root", local: { "large.pdf": local }, remote: { "large.pdf": remote } },
      {},
      { upload: 0 },
      {},
      {},
      [],
      "run"
    );
    assert.strictEqual(forceOption.force, true, "upload must bypass the batch metadata cache around the overwrite");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.hasSameContent = async () => false;
    plugin.assertLocalUnchangedSincePlan = async () => {};
    plugin.assertRemoteUnchangedSincePlan = async (_path, remote) => remote;
    const local = { path: "large.pdf", size: 60 * 1024 * 1024, mtime: 2 };
    const remote = { id: "remote", path: "large.pdf", size: local.size, md5Checksum: "same" };
    plugin.localInfoByPath = async () => local;
    let adoptOption = false;
    plugin.uploadLocalFile = async (_path, _root, currentRemote, options) => {
      adoptOption = options.adoptIfContentMatches;
      return Object.assign({}, currentRemote, { contentAlreadyMatched: true });
    };
    plugin.resumableStateForOperation = () => ({});
    plugin.shouldUseDuplicateGuard = () => false;
    plugin.shouldRefreshDuplicateGuardPreflight = () => false;
    plugin.shouldUseExactNameDuplicateGuard = () => false;
    plugin.reservedRemoteIdForOperation = () => "";
    plugin.operationIdForPath = () => "";
    const nextSnapshot = {};
    const stats = { upload: 0, adopt: 0 };
    const remoteMutations = {};
    await plugin.executeEntry(
      { path: "large.pdf", action: "upload" },
      { rootFolderId: "root", local: { "large.pdf": local }, remote: { "large.pdf": remote } },
      nextSnapshot,
      stats,
      {},
      remoteMutations,
      [],
      "run"
    );
    assert.strictEqual(adoptOption, true);
    assert.strictEqual(stats.adopt, 1);
    assert.strictEqual(stats.upload, 0);
    assert.strictEqual(remoteMutations["large.pdf"], undefined, "MD5 adoption must not record a Drive mutation");
    assert.ok(nextSnapshot["large.pdf"]);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.remoteInfoById = async () => ({
      id: "remote",
      name: "renamed-remotely.pdf",
      path: "large.pdf",
      size: 10,
      modifiedTime: "same",
      md5Checksum: "same",
      parentId: "root"
    });
    await assert.rejects(
      () => plugin.assertRemoteUnchangedSincePlan("large.pdf", {
        id: "remote",
        name: "large.pdf",
        path: "large.pdf",
        size: 10,
        modifiedTime: "same",
        md5Checksum: "same",
        parentId: "root"
      }, { force: true }),
      /differs from planned remote snapshot/,
      "a remote rename must block an overwrite even when content metadata is unchanged"
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isExcluded = () => false;
    plugin.driveFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        newStartPageToken: "token-2",
        changes: [{
          fileId: "folder-1",
          removed: false,
          file: {
            id: "folder-1",
            name: "moved-folder",
            mimeType: "application/vnd.google-apps.folder",
            modifiedTime: "2026-07-25T00:00:00Z",
            parents: ["outside-root"],
            trashed: false
          }
        }]
      })
    });
    let fullScans = 0;
    plugin.scanRemoteFolder = async (_root, _path, files) => {
      fullScans++;
      files["remaining.md"] = { id: "remaining", path: "remaining.md", size: 1 };
    };
    const state = await plugin.applyRemoteChanges("root", {
      files: { "old/file.md": { id: "old", path: "old/file.md", size: 1 } },
      deleted: {}
    }, "token-1");
    assert.strictEqual(fullScans, 1, "folder moves must force a safe full remote scan");
    assert.ok(state.files["remaining.md"]);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    let writeOptions;
    plugin.writeRemoteSnapshotFile = async (_root, files, deleted, options) => {
      writeOptions = { files, deleted, options };
      return { files, deleted, written: true };
    };
    plugin.mergeRemoteDeleteTombstones = (previous, next) => Object.assign({}, previous, next);
    const oldRemote = { id: "r1", path: "note.md", size: 1, modifiedTime: "old", md5Checksum: "old" };
    const changedRemote = { id: "r1", path: "note.md", size: 2, modifiedTime: "new", md5Checksum: "new" };
    await plugin.saveRemoteSnapshot("root", {
      "note.md": changedRemote
    }, {}, {}, {}, {
      forceWrite: true,
      mergeBaseFiles: { "note.md": oldRemote }
    });
    assert.strictEqual(writeOptions.options.baseFiles["note.md"].md5Checksum, "old");
    assert.strictEqual(writeOptions.options.mutations["note.md"].md5Checksum, "new", "Changes API updates must participate in a concurrent snapshot merge");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { remoteSnapshotProtocolVersion: 2 });
    plugin.driveFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: 1, files: {}, deleted: {} })
    });
    await assert.rejects(
      () => plugin.loadRemoteSnapshotById("snapshot", "now"),
      /downgraded by an older DriveBridge device/,
      "cache/Changes paths must enforce the same snapshot protocol guard"
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.transferChunkBytes = () => 2;
    plugin.waitForForegroundBeforeLargeTransfer = async () => {};
    plugin.updateTransferProgress = () => {};
    plugin.driveFetch = async () => ({
      ok: true,
      status: 206,
      headers: { get: () => "bytes 1-2/4" },
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer
    });
    await assert.rejects(
      () => plugin.downloadRemoteFileInRanges("large.pdf", { id: "remote", size: 4 }, {}),
      /Content-Range mismatch/,
      "a same-length but wrong range must not be written"
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { lastLocalFullScanAt: 1 });
    plugin.localDirtyTrusted = true;
    plugin.localDirtyPaths = new Map();
    plugin.isExcluded = () => false;
    plugin.app = {
      vault: {
        getFiles: () => [{ path: "audit.md", stat: { size: 1, mtime: 1 } }]
      }
    };
    plugin.localInfo = async (file) => ({ path: file.path, size: 1, mtime: 1 });
    const result = await plugin.scanLocalVault({});
    assert.ok(result["audit.md"]);
    assert.strictEqual(plugin.lastLocalScanMeta.full, true, "a trusted dirty queue still needs a bounded periodic full audit");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.syncing = false;
    plugin.activeOperation = "";
    plugin.resetSyncDetailLog = async () => {};
    plugin.checkInterruptedSync = async () => ({ interrupted: true });
    plugin.formatInterruptedSyncMessage = () => "interrupted";
    plugin.saveSettings = async () => {};
    plugin.safeFlushOperationJournal = async () => {};
    plugin.flushSyncDetailBuffer = async () => {};
    plugin.flushDirtyQueue = async () => { throw new Error("adapter unavailable"); };
    plugin.clearSyncStatus = () => {};
    plugin.startPendingRemoteIndexRepair = () => {};
    const previousWarn = console.warn;
    console.warn = () => {};
    await plugin.syncNow({ dryRun: false, quiet: true });
    console.warn = previousWarn;
    assert.strictEqual(plugin.syncing, false, "cleanup must release the sync lock even when dirty queue persistence fails");
    assert.strictEqual(plugin.activeOperation, "");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { maxFileSizeMb: 100 });
    plugin.localDirtyTrusted = true;
    plugin.localDirtyPaths = new Map();
    plugin.localScanProfile = JSON.stringify({
      excludedFolders: "",
      excludedPatterns: "",
      obsidianSyncMode: "off",
      syncMode: "bidirectional",
      maxFileSizeMb: 50
    });
    plugin.isExcluded = () => false;
    plugin.app = {
      vault: {
        getFiles: () => [{ path: "large.pdf", stat: { size: 60 * 1024 * 1024, mtime: 1 } }]
      }
    };
    plugin.localInfo = async (file) => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime });
    const result = await plugin.scanLocalVault({});
    assert.ok(result["large.pdf"], "raising Max file size must force a full scan that rediscovers a previously skipped PDF");
    assert.strictEqual(plugin.lastLocalScanMeta.full, true);
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const now = Date.now();
    const older = { deletedAt: new Date(now - 10000).toISOString(), remote: { id: "old" } };
    const newer = { deletedAt: new Date(now).toISOString(), remote: { id: "new" } };
    const merged = plugin.mergeRemoteDeleteTombstones(
      { "note.md": newer },
      { "note.md": older },
      {}
    );
    assert.strictEqual(merged["note.md"].remote.id, "new", "concurrent merge must retain the newest same-path tombstone");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    const now = Date.now();
    const invalidFuture = {
      deletedAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      remote: { id: "future" }
    };
    assert.strictEqual(
      plugin.remoteDeleteTombstoneIsFresh(invalidFuture, now),
      false,
      "an implausibly future-dated tombstone must not remain fresh indefinitely"
    );
    assert.strictEqual(
      plugin.localChangedAfterRemoteDeletion({ mtime: now }, invalidFuture),
      true,
      "an implausibly future-dated tombstone must not delete a current local edit"
    );
    const plausibleSkew = {
      deletedAt: new Date(now + 60 * 1000).toISOString(),
      remote: { id: "skewed" }
    };
    assert.strictEqual(
      plugin.localChangedAfterRemoteDeletion({ mtime: now }, plausibleSkew),
      true,
      "even plausible positive clock skew must defer local deletion until the timestamp is trustworthy"
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isExcluded = () => false;
    plugin.driveFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        newStartPageToken: "token-2",
        changes: [{
          fileId: "folder-1",
          removed: true
        }]
      })
    });
    plugin.scanRemoteFolder = async () => {};
    const state = await plugin.applyRemoteChanges("root", {
      files: {
        "folder/child.pdf": {
          id: "child",
          path: "folder/child.pdf",
          size: 10,
          modifiedTime: "old",
          md5Checksum: "hash",
          parentId: "folder-1"
        }
      },
      deleted: {},
      folders: { "folder-1": "folder" },
      folderIndexComplete: true
    }, "token-1");
    assert.ok(state.deleted["folder/child.pdf"], "a folder full-scan fallback must create tombstones for disappeared children");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isExcluded = () => false;
    plugin.driveFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        newStartPageToken: "token-2",
        changes: [{ fileId: "unknown", removed: true }]
      })
    });
    plugin.scanRemoteFolder = async () => {};
    const state = await plugin.applyRemoteChanges("root", {
      files: {
        "still-unconfirmed.pdf": {
          id: "existing",
          path: "still-unconfirmed.pdf",
          size: 10,
          modifiedTime: "old",
          md5Checksum: "hash",
          parentId: "root"
        }
      },
      deleted: {},
      folders: {},
      folderIndexComplete: true
    }, "token-1");
    assert.strictEqual(
      state.deleted["still-unconfirmed.pdf"],
      undefined,
      "absence from a safety full scan must not become a deletion tombstone without path-specific proof"
    );
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isExcluded = () => false;
    plugin.driveFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        newStartPageToken: "token-2",
        changes: [{
          fileId: "outside-folder",
          removed: false,
          file: {
            id: "outside-folder",
            name: "outside",
            mimeType: "application/vnd.google-apps.folder",
            parents: ["outside-root"],
            trashed: false
          }
        }]
      })
    });
    plugin.resolveChangedDriveFilePath = async () => "";
    plugin.scanRemoteFolder = async () => {
      throw new Error("a known outside-root folder must not trigger a full scan");
    };
    const state = await plugin.applyRemoteChanges("root", {
      files: {},
      deleted: {},
      folders: {},
      folderIndexComplete: true
    }, "token-1");
    assert.strictEqual(state.folderIndexComplete, true);
  }

  {
    const { PluginClass, responses } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.transferChunkBytes = () => 2;
    plugin.waitForForegroundBeforeLargeTransfer = async () => {};
    plugin.updateTransferProgress = () => {};
    responses.push({
      status: 206,
      text: "",
      json: {},
      arrayBuffer: new Uint8Array([1, 2]).buffer,
      headers: { "Content-Range": "bytes 0-1/2" }
    });
    let written = false;
    plugin.writeVerifiedDownload = async () => { written = true; };
    await plugin.downloadRemoteFileInRanges("large.pdf", { id: "remote", size: 2 }, {});
    assert.strictEqual(written, true, "requestUrl response headers must be matched case-insensitively");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.transferChunkBytes = () => 2;
    plugin.waitForForegroundBeforeLargeTransfer = async () => {};
    plugin.updateTransferProgress = () => {};
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    let beforeCommitCalls = 0;
    let putCalls = 0;
    plugin.driveFetch = async (url, options) => {
      if (url.includes("uploadType=resumable")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === "location" ? "session" : null }
        };
      }
      putCalls++;
      if (putCalls === 1) {
        return { ok: false, status: 308, headers: { get: () => "bytes=0-1" } };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "remote", name: "large.pdf", size: "4", modifiedTime: "new", md5Checksum: "hash" })
      };
    };
    await plugin.uploadResumableFile(
      "large.pdf",
      { id: "remote" },
      { name: "large.pdf" },
      data,
      { beforeRemoteCommit: async () => { beforeCommitCalls++; } }
    );
    assert.strictEqual(beforeCommitCalls, 1, "existing resumable uploads must revalidate immediately before the final chunk");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isMobileRuntime = () => true;
    plugin.localPathExists = async () => true;
    plugin.localStatInfoByPath = async () => ({ path: "empty.pdf", size: 0, mtime: 1 });
    plugin.readLocalBinary = async () => new ArrayBuffer(0);
    plugin.ensureRemoteParent = async () => "root";
    let requestedUrl = "";
    plugin.driveFetch = async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "empty", name: "empty.pdf", size: "0", modifiedTime: "now", md5Checksum: "d41d8cd98f00b204e9800998ecf8427e" })
      };
    };
    await plugin.uploadLocalFile("empty.pdf", "root", null, {});
    assert.match(requestedUrl, /uploadType=multipart/, "zero-byte mobile files must not enter an empty resumable loop");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    plugin.isExcluded = () => false;
    plugin.localDirtyPaths = new Map();
    plugin.prefetchRemoteInfoForEntries = async () => {};
    plugin.updateOperation = async () => {};
    plugin.executeEntry = async () => undefined;
    plugin.updateSyncProgress = () => {};
    plugin.flushOperationJournal = async () => {};
    plugin.verifyCreatedUploadDuplicates = async () => {};
    const entry = { path: "resolved.pdf", action: "conflict" };
    await plugin.executePlan(
      { snapshot: {}, local: {}, remote: {} },
      { entries: [entry] },
      "run"
    );
    assert.strictEqual(plugin.localDirtyPaths.size, 0, "a conflict adopted as same content must not be requeued solely from its original plan action");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    let requestedIds;
    plugin.batchGetRemoteInfo = async (ids) => {
      requestedIds = ids;
      return ids.map((id) => ({ id, name: `${id}.md`, size: "1", modifiedTime: "now", md5Checksum: "hash", parents: ["root"] }));
    };
    await plugin.prefetchRemoteInfoForEntries([
      { path: "download.md", action: "download" },
      { path: "upload.md", action: "upload" },
      { path: "move.md", fromPath: "old.md", action: "moveRemote" }
    ], {
      remote: {
        "download.md": { id: "download" },
        "upload.md": { id: "upload" },
        "old.md": { id: "move" }
      }
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(requestedIds)), ["download"], "batch prefetch must not duplicate just-in-time GETs for Drive mutations");
  }

  {
    const { PluginClass, responses } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    responses.push(new Error("temporary network failure"));
    responses.push({ status: 200, text: "{}", json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
    let rechecks = 0;
    const response = await plugin.driveFetch(
      "https://www.googleapis.com/upload/drive/v3/files/remote?uploadType=media",
      {
        method: "PUT",
        body: new Uint8Array([1]),
        beforeRetry: async () => { rechecks++; }
      }
    );
    assert.strictEqual(response.ok, true);
    assert.strictEqual(rechecks, 1, "a retried final upload request must repeat its remote precondition check");
  }

  {
    const { PluginClass } = loadPlugin();
    const modal = new PluginClass.__ProgressModal({});
    assert.strictEqual(
      modal.titleForMessage("DriveBridge sync error 1. Continuing...\nError: temporary"),
      "Normal sync is running with errors"
    );
    assert.strictEqual(
      modal.titleForMessage("DriveBridge sync completed with errors.\nError: temporary"),
      "Normal sync completed with errors"
    );
    assert.strictEqual(modal.titleForMessage("DriveBridge Sync: 10 / 10\nSync complete."), "Normal sync complete");
    assert.strictEqual(modal.titleForMessage("DriveBridge failed.\nError: fatal"), "Normal sync stopped");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass);
    let saved;
    plugin.writePluginDataFileAtomic = async (_primary, _backup, content) => {
      saved = JSON.parse(content);
    };
    await plugin.saveRemoteStateCache("root", {
      fileId: "snapshot",
      modifiedTime: "2026-07-25T00:00:00Z",
      files: {},
      deleted: {}
    }, {
      "folder-1": "folder"
    }, true);
    assert.strictEqual(saved.version, 2);
    assert.strictEqual(saved.folderIndexComplete, true);
    assert.strictEqual(saved.folders["folder-1"], "folder");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { driveChangesEnabled: false });
    let writes = 0;
    plugin.writePluginDataFileAtomic = async () => { writes++; };
    const result = await plugin.saveRemoteStateCache("root", null, {}, false);
    assert.strictEqual(result, null);
    assert.strictEqual(writes, 0, "disabling Drive Changes must not write or validate its dedicated cache");
  }

  {
    const { PluginClass } = loadPlugin();
    const plugin = pluginInstance(PluginClass, { driveChangesEnabled: true });
    assert.strictEqual(
      plugin.shouldSaveRemoteStateCache({ remoteChangesApplied: false }, { written: false }),
      false,
      "an unchanged incremental scan must keep the existing remote-state cache"
    );
    assert.strictEqual(
      plugin.shouldSaveRemoteStateCache({ remoteSnapshotFromFullScan: true }, { written: false }),
      true,
      "a full remote scan must refresh the cache"
    );
    assert.strictEqual(
      plugin.shouldSaveRemoteStateCache({ remoteChangesApplied: false }, { written: true }),
      true,
      "a remote snapshot mutation must refresh the cache"
    );
  }

  console.log("DriveBridge tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
