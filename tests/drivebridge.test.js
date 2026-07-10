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
          return responses.shift() || { status: 200, text: "{}", json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} };
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
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await plugin.loadSnapshot())), snapshot);

    readTransform = (value, target) => target.endsWith(".tmp")
      ? `\uFEFF${value.replace(/\n/g, "\r\n")}`
      : value;
    const normalizedSnapshot = { "note.md": { local: { size: 2, mtime: 2 }, remote: { id: "r", size: 2 } } };
    await plugin.saveSnapshot(normalizedSnapshot);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await plugin.loadSnapshot())), normalizedSnapshot);

    readTransform = (value, target) => target.endsWith(".tmp")
      ? JSON.stringify(JSON.parse(value))
      : value;
    const reformattedSnapshot = { "note.md": { local: { size: 3, mtime: 3 }, remote: { id: "r", size: 3 } } };
    await plugin.saveSnapshot(reformattedSnapshot);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await plugin.loadSnapshot())), reformattedSnapshot);

    const savedBeforeMismatch = files.get(plugin.pluginDataPath("snapshot.json"));
    readTransform = (value, target) => target.endsWith(".tmp") ? "{\"different\":true}" : value;
    await assert.rejects(() => plugin.saveSnapshot(snapshot), /Atomic write verification failed/);
    assert.strictEqual(files.get(plugin.pluginDataPath("snapshot.json")), savedBeforeMismatch);

    readTransform = (value, target) => target.endsWith(".tmp") ? "{" : value;
    await assert.rejects(() => plugin.saveSnapshot(snapshot), /Atomic write verification failed/);
    assert.strictEqual(files.get(plugin.pluginDataPath("snapshot.json")), savedBeforeMismatch);

    readTransform = (value) => value;
    files.set(plugin.pluginDataPath("snapshot.json"), "{");
    await assert.rejects(() => plugin.loadSnapshot(), /corrupted/);
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
