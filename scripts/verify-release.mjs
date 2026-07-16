import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const expectedTag = `v${pkg.version}`;
const requestedTagIndex = process.argv.indexOf("--tag");
const requestedTag = requestedTagIndex >= 0 ? process.argv[requestedTagIndex + 1] : undefined;

if (!changelog.includes(`## [${pkg.version}]`)) {
  throw new Error(`CHANGELOG.md has no ${pkg.version} section`);
}
if (requestedTag && requestedTag !== expectedTag) {
  throw new Error(`tag ${requestedTag} does not match package version ${expectedTag}`);
}
console.log(`release verification ok: ${expectedTag}`);
