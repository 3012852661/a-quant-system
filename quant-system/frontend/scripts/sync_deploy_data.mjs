import fs from "node:fs";
import path from "node:path";

const frontendRoot = process.cwd();
const repoRoot = path.resolve(frontendRoot, "../..");
const targetRoot = path.join(frontendRoot, "deploy-data");
const reportsSourceRoot = path.join(repoRoot, "reports/data");
const knowledgeSourceRoot = path.join(repoRoot, "quant-system/knowledge");

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyMatchingDir(sourceDir, targetDir, matcher) {
  if (!fs.existsSync(sourceDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      count += copyMatchingDir(source, target, matcher);
    } else if (entry.isFile() && matcher(source)) {
      copyFile(source, target);
      count += 1;
    }
  }
  return count;
}

if (!fs.existsSync(reportsSourceRoot) && !fs.existsSync(knowledgeSourceRoot)) {
  console.log("synced deploy data: source roots unavailable; kept bundled deploy-data");
  process.exit(0);
}

fs.rmSync(targetRoot, { recursive: true, force: true });

const reportsCount = copyMatchingDir(
  reportsSourceRoot,
  path.join(targetRoot, "reports/data"),
  (file) => /\.(json|jsonl|md)$/i.test(file),
);

const knowledgeCount = copyMatchingDir(
  knowledgeSourceRoot,
  path.join(targetRoot, "quant-system/knowledge"),
  (file) => /\.md$/i.test(file),
);

console.log(`synced deploy data: reports=${reportsCount}, knowledge=${knowledgeCount}`);
