import assert from "node:assert/strict";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const OTA_PLATFORMS = {
  "windows-x64": "windows_x64-setup.exe",
  "windows-arm64": "windows_arm64-setup.exe",
  "macos-x86_64": "darwin_x64.dmg",
  "macos-arm64": "darwin_aarch64.dmg",
  "linux-amd64": "linux_amd64.deb",
  "linux-arm64": "linux_arm64.deb",
};

export function parseStableVersion(value) {
  assert.match(value ?? "", STABLE_VERSION, "Enter stable versions without the v prefix");
  return value.split(".").map(BigInt);
}

export function assertTargetNewer(baseline, target) {
  const first = parseStableVersion(baseline);
  const last = parseStableVersion(target);
  const change = last.findIndex((part, index) => part !== first[index]);
  assert.ok(change >= 0 && last[change] > first[change], "Target must be newer than baseline");
}

export function baselineAssetNames(platform, baseline) {
  assert.ok(Object.hasOwn(OTA_PLATFORMS, platform), `Unknown OTA platform: ${platform}`);
  const prefixes = platform.startsWith("windows-") ? ["FineShell", "ZhanDu"] : ["FineShell"];
  return prefixes.map((prefix) => [prefix, baseline, OTA_PLATFORMS[platform]].join("_"));
}

export function validateLatestRelease(latest, target) {
  assert.equal(
    latest.tag_name,
    "v" + target,
    "The requested target must be the latest stable release",
  );
  assert.ok(!latest.draft && !latest.prerelease, "The target release must be public and stable");
}

export function validateUpdateFeed(feed, target, repository) {
  assert.equal(feed.version, target, "The public update feed does not serve the requested version");
  const base = "https://github.com/" + repository + "/releases/download/v" + target + "/";
  const entries = Object.values(feed.platforms ?? {});
  assert.ok(
    entries.length > 0 &&
      entries.every(({ url, signature }) => url?.startsWith(base) && signature?.trim()),
    "Unexpected manifest URLs or signatures",
  );
}

export function validateBaselineRelease(release, assetNames) {
  assert.ok(!release.isDraft && !release.isPrerelease, "Baseline must be publicly released");
  const matches = release.assets.filter(({ name }) => assetNames.includes(name));
  assert.equal(matches.length, 1, "Expected exactly one baseline installer");
  const [asset] = matches;
  assert.match(
    asset?.digest ?? "",
    /^sha256:[0-9a-f]{64}$/i,
    "Baseline installer has no verified SHA-256",
  );
  return asset.name;
}
