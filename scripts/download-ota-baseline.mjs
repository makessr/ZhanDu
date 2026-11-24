import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  assertTargetNewer,
  baselineAssetNames,
  validateBaselineRelease,
  validateLatestRelease,
  validateUpdateFeed,
} from "./ota-baseline.mjs";

const [baseline, target, platform, output] = process.argv.slice(2);
const repository = "makessr/ZhanDu";
assertTargetNewer(baseline, target);
assert.ok(output, "Missing output path");
const assetNames = baselineAssetNames(platform, baseline);

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

const latest = JSON.parse(
  gh("api", "repos/" + repository + "/releases/latest", "--jq", "{tag_name, draft, prerelease}"),
);
validateLatestRelease(latest, target);
const feed = JSON.parse(
  gh(
    "release",
    "download",
    "v" + target,
    "-R",
    repository,
    "--pattern",
    "latest.json",
    "--output",
    "-",
  ),
);
validateUpdateFeed(feed, target, repository);

const release = JSON.parse(
  gh("release", "view", "v" + baseline, "-R", repository, "--json", "isDraft,isPrerelease,assets"),
);
const assetName = validateBaselineRelease(release, assetNames);
const [asset] = release.assets.filter(({ name }) => name === assetName);
gh(
  "release",
  "download",
  "v" + baseline,
  "-R",
  repository,
  "--pattern",
  assetName,
  "--output",
  output,
);
const sha = createHash("sha256");
for await (const block of createReadStream(output)) sha.update(block);
assert.equal(
  "sha256:" + sha.digest("hex"),
  asset.digest.toLowerCase(),
  "Baseline installer SHA-256 mismatch",
);
console.log("Verified " + assetName + " and the public v" + target + " update manifest.");
