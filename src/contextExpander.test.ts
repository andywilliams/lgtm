import { describe, it } from "node:test";
import assert from "node:assert";
import { extractImports, findImports, expandContext } from "./contextExpander.js";

describe("extractImports", () => {
  it("parses require() correctly", () => {
    const content = `const foo = require("./foo");
const bar = require("../bar");
const baz = require("external-lib");`;
    const imports = extractImports(content);
    assert.deepStrictEqual(imports, ["./foo", "../bar"]);
  });

  it("parses ES6 import correctly", () => {
    const content = `import foo from "./foo";
import { bar } from "../bar";
import * as baz from "./baz";
import("../dynamic");`;
    const imports = extractImports(content);
    assert.strictEqual(imports.includes("./foo"), true);
    assert.strictEqual(imports.includes("../bar"), true);
    assert.strictEqual(imports.includes("./baz"), true);
  });

  it("filters out non-relative imports", () => {
    const content = `const foo = require("fs");
const bar = require("path");
const baz = require("./local");`;
    const imports = extractImports(content);
    assert.deepStrictEqual(imports, ["./local"]);
  });
});

describe("findImports", () => {
  it("follows import chain", () => {
    // Create temp test files
    const fs = require("fs");
    const path = require("path");
    const testDir = "/tmp/context-expander-test";
    
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    
    // Create a.js that imports b.js
    fs.writeFileSync(path.join(testDir, "a.js"), `const b = require("./b");`);
    fs.writeFileSync(path.join(testDir, "b.js"), `const c = require("./c");`);
    fs.writeFileSync(path.join(testDir, "c.js"), `module.exports = {};`);
    
    const visited = new Set();
    const results = findImports(path.join(testDir, "a.js"), testDir, 3, visited);
    
    // Should find b.js and c.js
    const foundPaths = results.map(r => path.basename(r.path));
    assert.strictEqual(foundPaths.includes("b.js"), true);
    assert.strictEqual(foundPaths.includes("c.js"), true);
    
    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});

describe("expandContext", () => {
  it("returns ContextFile array with correct structure", async () => {
    const fs = require("fs");
    const path = require("path");
    const testDir = "/tmp/context-expander-test2";
    
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    }
    
    // Create a simple test file
    fs.writeFileSync(path.join(testDir, "src", "test.js"), `module.exports = {};`);
    
    const result = await expandContext(
      [path.join(testDir, "src", "test.js")],
      testDir,
      { maxFiles: 10 }
    );
    
    assert.ok(Array.isArray(result));
    if (result.length > 0) {
      assert.ok(typeof result[0].path === "string");
      assert.ok(typeof result[0].content === "string");
      assert.ok(typeof result[0].reason === "string");
    }
    
    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});
