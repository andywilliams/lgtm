import * as fs from "fs";
import * as path from "path";
import { exec as execSync } from "child_process";
import { promisify } from "util";

const execAsync = promisify(execSync);

export interface ContextFile {
  path: string;
  content: string;
  reason: string;
}

export interface ExpandOptions {
  maxFiles?: number;
  importDepth?: number;
  maxConsumers?: number;
  maxLineCount?: number;
}

export function extractImports(content: string): string[] {
  const imports: string[] = [];
  const requireRegex = /require\(["']([^"']+)["']\)/g;
  let match;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  const es6Regex = /import\s+(?:(?:\{[^}]*\})|(?:\*\s+as\s+\w+)|(?:\w+))\s+from\s+["']([^"']+)["']/g;
  while ((match = es6Regex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  const namespaceRegex = /import\s+\*\s+as\s+\w+\s+from\s+["']([^"']+)["']/g;
  while ((match = namespaceRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  const dynamicRegex = /import\(["']([^"']+)["']\)/g;
  while ((match = dynamicRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports.filter(imp => imp.startsWith("./") || imp.startsWith("../"));
}
export function resolveImportPath(
  importSpec: string,
  fromFile: string,
  repoRoot: string
): string | null {
  const fromDir = path.dirname(fromFile);
  const basePath = path.resolve(fromDir, importSpec);
  const possibleNames = [
    basePath,
    basePath + ".ts",
    basePath + ".js",
    basePath + ".tsx",
    basePath + ".jsx",
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.js"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.jsx"),
  ];
  for (const possible of possibleNames) {
    if (fs.existsSync(possible) && fs.statSync(possible).isFile()) {
      return possible;
    }
  }
  return null;
}

export function findImports(
  filePath: string,
  repoRoot: string,
  depth: number,
  visited: Set<string>
): ContextFile[] {
  const results: ContextFile[] = [];
  const canonicalPath = path.resolve(filePath);
  if (visited.has(canonicalPath)) return results;
  visited.add(canonicalPath);
  if (depth <= 0) return results;
  if (!fs.existsSync(canonicalPath)) return results;
  if (!fs.statSync(canonicalPath).isFile()) return results;
  try {
    const content = fs.readFileSync(canonicalPath, "utf-8");
    const imports = extractImports(content);
    for (const importSpec of imports) {
      const resolvedPath = resolveImportPath(importSpec, canonicalPath, repoRoot);
      if (resolvedPath && fs.existsSync(resolvedPath)) {
        const importedContent = fs.readFileSync(resolvedPath, "utf-8");
        results.push({
          path: resolvedPath,
          content: importedContent,
          reason: "imported by " + path.relative(repoRoot, canonicalPath),
        });
        const nested = findImports(resolvedPath, repoRoot, depth - 1, visited);
        results.push(...nested);
      }
    }
  } catch {}
  return results;
}
export async function findConsumers(
  filePath: string,
  repoRoot: string,
  maxCount: number
): Promise<ContextFile[]> {
  const results: ContextFile[] = [];
  const basename = path.basename(filePath, path.extname(filePath));
  const srcDir = path.join(repoRoot, "src");
  if (!fs.existsSync(srcDir)) return results;
  const patterns = [
    "require.*" + basename,
    "from.*" + basename,
    "import.*from.*" + basename,
  ];
  try {
    const grepCmd = 'grep -rlE "' + patterns.join('|') + '" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" "' + srcDir + '" 2>/dev/null | head -' + maxCount;
    const { stdout } = await execAsync(grepCmd);
    const files = stdout.trim().split("\n").filter(Boolean);
    for (const file of files) {
      if (path.resolve(file) === path.resolve(filePath)) continue;
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf-8");
        results.push({ path: file, content: content, reason: "imports " + basename });
      }
    }
  } catch {}
  return results;
}

export function findTests(filePath: string, repoRoot: string): ContextFile[] {
  const results: ContextFile[] = [];
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath, path.extname(filePath));
  const testPatterns = [
    path.join(dir, basename + ".test.ts"),
    path.join(dir, basename + ".test.js"),
    path.join(dir, basename + ".spec.ts"),
    path.join(dir, basename + ".spec.js"),
    path.join(repoRoot, "test", basename + ".test.ts"),
    path.join(repoRoot, "test", basename + ".test.js"),
    path.join(repoRoot, "__tests__", basename + ".test.ts"),
    path.join(repoRoot, "__tests__", basename + ".test.js"),
  ];
  for (const testPath of testPatterns) {
    if (fs.existsSync(testPath)) {
      const content = fs.readFileSync(testPath, "utf-8");
      results.push({ path: testPath, content: content, reason: "test for " + basename });
    }
  }
  return results;
}
export async function scanInfra(
  changedFiles: string[],
  repoRoot: string
): Promise<ContextFile[]> {
  const results: ContextFile[] = [];
  const identifiers = new Set<string>();
  for (const file of changedFiles) {
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, "utf-8");
      const wordRegex = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+|\b[a-z]+(?:[A-Z][a-z]+)+)/g;
      let match;
      while ((match = wordRegex.exec(content)) !== null) {
        identifiers.add(match[1]);
      }
    } catch {}
  }
  if (identifiers.size === 0) return results;
  const infraPatterns = ["serverless.yml", "serverless.yaml"];
  const scanDirs = [repoRoot, path.join(repoRoot, "cdk"), path.join(repoRoot, "infra")];
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const pattern of infraPatterns) {
        const files = fs.readdirSync(dir).filter(f => f.includes(pattern));
        for (const file of files) {
          const filePath = path.join(dir, file);
          if (!fs.statSync(filePath).isFile()) continue;
          const content = fs.readFileSync(filePath, "utf-8");
          for (const id of identifiers) {
            if (content.includes(id)) {
              results.push({ path: filePath, content: content, reason: "defines " + id + " referenced in diff" });
              break;
            }
          }
        }
      }
    } catch {}
  }
  return results;
}
export function filterAndPrioritize(
  files: ContextFile[],
  maxFiles: number,
  maxLineCount: number = 2000
): ContextFile[] {
  const seen = new Set<string>();
  const filtered: ContextFile[] = [];
  for (const file of files) {
    const canonical = path.resolve(file.path);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const lines = file.content.split("\n").length;
    if (lines > maxLineCount) continue;
    if (file.path.includes("node_modules") || file.path.endsWith(".lock")) continue;
    filtered.push(file);
  }
  const priorityOrder = ["infra", "test", "imported by", "imports"];
  filtered.sort((a, b) => {
    const aPri = priorityOrder.findIndex(p => a.reason.includes(p));
    const bPri = priorityOrder.findIndex(p => b.reason.includes(p));
    return aPri - bPri;
  });
  return filtered.slice(0, maxFiles);
}
export async function expandContext(
  changedFiles: string[],
  repoRoot: string,
  options: ExpandOptions = {}
): Promise<ContextFile[]> {
  const opts = {
    maxFiles: options.maxFiles ?? 20,
    importDepth: options.importDepth ?? 3,
    maxConsumers: options.maxConsumers ?? 10,
    maxLineCount: options.maxLineCount ?? 2000,
  };
  
  const allFiles: ContextFile[] = [];
  const visited = new Set<string>();
  
  for (const file of changedFiles) {
    allFiles.push(...findImports(file, repoRoot, opts.importDepth, visited));
    allFiles.push(...await findConsumers(file, repoRoot, opts.maxConsumers));
    allFiles.push(...findTests(file, repoRoot));
  }
  
  allFiles.push(...await scanInfra(changedFiles, repoRoot));
  
  return filterAndPrioritize(allFiles, opts.maxFiles, opts.maxLineCount);
}
