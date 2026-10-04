"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { createServices } = require("../app/server/lib/services");
const { runWorker } = require("../app/server/lib/worker");

const SILENT_LOGGER = { write() {}, tail() { return ""; } };
const LISTING = "Type = zip\n----------\n"
  + "Path = keep.txt\nSize = 4\nAttributes = A\n\n"
  + "Path = omit.txt\nSize = 4\nAttributes = A\n\n";

function createFixture(t, { selectedPaths = ["keep.txt"], deleteSource = true,
  archiveName = "sample.zip" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chzip-delete-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archivePath = path.join(root, archiveName);
  fs.writeFileSync(archivePath, "fake-archive");
  const sources = [archivePath];
  if (archiveName.endsWith(".001")) {
    sources.push(path.join(root, archiveName.replace(/001$/, "002")));
    fs.writeFileSync(sources[1], "fake-volume");
  }
  const services = createServices({
    runtimeRoot: path.join(root, "runtime"),
    logger: SILENT_LOGGER,
    findTool: () => ({ path: process.execPath, source: "test" }),
    runSync: (tool, args) => {
      if (args[0] === "x") {
        const outputDir = args.find((arg) => arg.startsWith("-o")).slice(2);
        fs.writeFileSync(path.join(outputDir, "inner.tar"), "fake-tar");
      }
      return { exitCode: 0, log: "", stdout: LISTING, stderr: "" };
    },
    discoverRoots: () => [{ path: root, canBrowse: true, canSelect: true }],
    spawnWorker: () => ({ unref() {} }),
    inspectSource: (filePath) => {
      const resolved = fs.realpathSync(filePath);
      const stat = fs.statSync(resolved);
      return {
        path: resolved, readable: true, mode: "0644", uid: 1000, gid: 1000,
        size: stat.size, modified: stat.mtime.toISOString(),
        application: { uid: 1000, gid: 1000, groups: [] }, components: [], stat,
      };
    },
  });
  const result = services.extract({ path: archivePath, destinationRoot: root,
    selectedPaths, deleteSource });
  return { root, archivePath, sources, services, ...result };
}

async function runFixture(fixture, onExtract = () => {}) {
  return runWorker(fixture.jobId, {
    store: fixture.services.store,
    logger: SILENT_LOGGER,
    validateListing: async () => ({ entryCount: 2, format: "zip" }),
    runPhase: async (phase, context) => {
      if (phase === "preparing") {
        const outputDir = context.args.find((arg) => arg.startsWith("-o")).slice(2);
        fs.writeFileSync(path.join(outputDir, "inner.tar"), "fake-tar");
      } else {
        fs.writeFileSync(path.join(fixture.outputDir, "keep.txt"), "kept");
        await onExtract(context);
      }
      return { exitCode: 0, log: "" };
    },
  });
}

for (const options of [
  { name: "full extraction", selectedPaths: null },
  { name: "selective extraction" },
  { name: "selective split archive", archiveName: "sample.7z.001" },
  { name: "selective nested tar", archiveName: "sample.tar.gz" },
]) {
  test(`delete source: ${options.name} carries opt-in through services and worker`, async (t) => {
    const fixture = createFixture(t, options);
    const stored = fixture.services.store.read(fixture.jobId);
    assert.equal(stored.deleteSource, true);
    assert.equal(typeof stored.selection, "object", "selection holds archive metadata");
    if (options.selectedPaths !== null) {
      assert.equal(fs.readFileSync(stored.selectionFile, "utf8"), "keep.txt\n");
    }
    const job = await runFixture(fixture, ({ args }) => {
      if (stored.selectionFile) {
        assert.ok(args.includes(`-i@${stored.selectionFile}`));
      }
    });
    assert.equal(job.status, "success");
    assert.equal(job.deletedSourceCount, fixture.sources.length);
    for (const source of fixture.sources) assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(path.join(fixture.outputDir, "keep.txt"), "utf8"), "kept");
  });
}

test("delete source: an unchecked option preserves the archive", async (t) => {
  const fixture = createFixture(t, { deleteSource: false });
  const job = await runFixture(fixture);
  assert.equal(job.status, "success");
  assert.equal(job.deletedSourceCount, 0);
  assert.ok(fs.existsSync(fixture.archivePath));
});

for (const code of ["DAMAGED", "ENGINE", "CANCELLED"]) {
  test(`delete source: ${code} preserves the archive despite opt-in`, async (t) => {
    const fixture = createFixture(t);
    const job = await runFixture(fixture, () => {
      throw Object.assign(new Error(code), { code });
    });
    assert.equal(job.status, code === "CANCELLED" ? "cancelled" : "failed");
    assert.equal(job.deletedSourceCount, 0);
    assert.ok(fs.existsSync(fixture.archivePath));
  });
}

test("delete source: cancellation immediately before success keeps the archive", async (t) => {
  const fixture = createFixture(t);
  const { store } = fixture.services;
  // Inject a cancellation at the final locked update, after runPhase has resolved.
  const update = store.update.bind(store);
  let armed = false;
  store.update = (id, mutator) => {
    if (armed) {
      armed = false;
      update(id, (current) => ({ ...current, status: "cancelling",
        cancelRequestedAt: new Date().toISOString() }));
    }
    return update(id, mutator);
  };
  const job = await runFixture(fixture, () => { armed = true; });
  assert.equal(job.status, "cancelled");
  assert.equal(job.deletedSourceCount, 0);
  assert.ok(fs.existsSync(fixture.archivePath));
});

for (const change of ["replaced", "modified"]) {
  test(`delete source: a ${change} source is preserved after extraction`, async (t) => {
    const fixture = createFixture(t);
    const job = await runFixture(fixture, () => {
      if (change === "replaced") fs.renameSync(fixture.archivePath, `${fixture.archivePath}.original`);
      fs.writeFileSync(fixture.archivePath, "different-archive-content");
    });
    assert.equal(job.status, "success");
    assert.equal(job.deletedSourceCount, 0);
    assert.match(job.deleteSourceNote, /未自动删除/);
    assert.equal(fs.readFileSync(fixture.archivePath, "utf8"), "different-archive-content");
  });
}

test("delete source: selection changes preserve an enabled checked option", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/www/js/app.js"), "utf8");
  const start = source.indexOf("    function updateActionAvailability() {");
  const end = source.indexOf("    function setFileViewMode(", start);
  assert.ok(start >= 0 && end > start);
  const elements = new Proxy({}, { get(target, key) {
    return target[key] ||= { disabled: false, checked: true,
      parentElement: { setAttribute() {} } };
  } });
  const state = {
    elements, entries: [], allFilePaths: ["keep.txt", "omit.txt"],
    selectedPaths: new Set(["keep.txt"]), previewReady: true, previewLimited: false,
    previewing: false, running: false, info: { tool: {} }, selectedDirectory: "/out",
  };
  const context = vm.createContext({ state, uiPreview: {},
    passwordManagerApi: { updatePasswordManagerStatus() {} } });
  const update = () => vm.runInContext(`${source.slice(start, end)}\nupdateActionAvailability();`, context);
  update();
  assert.equal(elements.deleteSourceInput.disabled, false);
  assert.equal(elements.deleteSourceInput.checked, true);
  state.selectedPaths.clear();
  update();
  assert.equal(elements.extractBtn.disabled, true);
  assert.equal(elements.deleteSourceInput.checked, true);
  state.selectedPaths = new Set(state.allFilePaths);
  update();
  assert.equal(elements.deleteSourceInput.disabled, false);
  for (const key of ["running", "previewing"]) {
    state[key] = true;
    update();
    assert.equal(elements.deleteSourceInput.disabled, true);
    assert.equal(elements.deleteSourceInput.checked, true);
    state[key] = false;
  }
});
