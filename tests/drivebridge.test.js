const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");

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
  setText() {}
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
    "\nmodule.exports.__ReviewModal = DriveBridgeConflictReviewModal;";
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
    accessToken: "token",
    tokenExpiresAt: Date.now() + 60000,
    refreshToken: "refresh"
  }, settings);
  plugin.manifest = { id: "drivebridge-obsidian-sync", dir: ".obsidian/plugins/drivebridge-obsidian-sync" };
  return plugin;
}

async function run() {
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
    let saved;
    plugin.saveReviewQueue = async (queue) => { saved = queue; };
    await plugin.reconcileReviewQueue({ entries: [{ path: "note.md", action: "conflict" }] }, [incoming]);
    assert.strictEqual(saved.items.length, 1);
    assert.strictEqual(saved.items[0].createdAt, "old-time");
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

  console.log("DriveBridge tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
