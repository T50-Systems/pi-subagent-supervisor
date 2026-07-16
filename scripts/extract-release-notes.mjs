import { readFile, writeFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const marker = `## [${pkg.version}]`;
const start = changelog.indexOf(marker);
if (start < 0) throw new Error(`missing changelog section ${marker}`);
const remainder = changelog.slice(start + marker.length).replace(/^\s*-\s*\d{4}-\d{2}-\d{2}\s*/, "");
const boundaries = [remainder.search(/\n## \[/), remainder.search(/\n\[\d/)].filter((index) => index >= 0);
const end = boundaries.length > 0 ? Math.min(...boundaries) : remainder.length;
const notes = remainder.slice(0, end).trim();
if (!notes) throw new Error("release notes are empty");
await writeFile(process.argv[2] ?? "release-notes.md", `${notes}\n`, "utf8");
