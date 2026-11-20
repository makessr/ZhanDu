import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const [baseline, target, platform, output] = process.argv.slice(2);
const repository = "makessr/ZhanDu";
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
assert.ok(version.test(baseline) && version.test(target), "Enter stable versions without the v prefix");
const first = baseline.split(".").map(BigInt);
const last = target.split(".").map(BigInt);
const change = last.findIndex((part, index) => part !== first[index]);
assert.ok(change >= 0 && last[change] > first[change], "Target must be newer than baseline");

const prefix = "FineShell_" + baseline;
const names = {
  "windows-x64": prefix + "_windows_x64-setup.exe",
  "windows-arm64": prefix + "_windows_arm64-setup.exe",
  "macos-x86_64": prefix + "_darwin_x64.dmg",
  "macos-arm64": prefix + "_darwin_aarch64.dmg",
  "linux-amd64": prefix + "_linux_amd64.deb",
  "linux-arm64": prefix + "_linux_arm64.deb",
};
assert.ok(Object.hasOwn(names, platform) && output, "Unknown platform or missing output path");
const assetName = names[platform];

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

const latest = JSON.parse(gh("api", "repos/" + repository + "/releases/latest", "--jq", "{tag_name, draft, prerelease}"));
assert.equal(latest.tag_name, "v" + target, "The requested target must be the latest stable release");
assert.ok(!latest.draft && !latest.prerelease);
const base = "https://github.com/" + repository + "/releases/";
const response = await fetch(base + "latest/download/latest.json", { signal: AbortSignal.timeout(30_000) });
assert.ok(response.ok, "Could not get the public update manifest");
const feed = await response.json();
assert.equal(feed.version, target, "The public update feed does not serve the requested version");
const entries = Object.values(feed.platforms);
assert.ok(entries.length > 0 && entries.every(({ url, signature }) =>
  url?.startsWith(base + "download/v" + target + "/") && signature?.trim()), "Unexpected manifest URLs or signatures");

const release = JSON.parse(gh("release", "view", "v" + baseline, "-R", repository,
  "--json", "isDraft,isPrerelease,assets"));
assert.ok(!release.isDraft && !release.isPrerelease, "Baseline must be publicly released");
const asset = release.assets.find(({ name }) => name === assetName);
assert.match(asset?.digest ?? "", /^sha256:[0-9a-f]{64}$/i, "Baseline installer has no verified SHA-256");
gh("release", "download", "v" + baseline, "-R", repository, "--pattern", assetName, "--output", output);
const sha = createHash("sha256");
for await (const block of createReadStream(output)) sha.update(block);
assert.equal("sha256:" + sha.digest("hex"), asset.digest.toLowerCase(), "Baseline installer SHA-256 mismatch");
console.log("Verified " + assetName + " and the public v" + target + " update manifest.");
