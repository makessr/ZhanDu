import assert from "node:assert/strict";

export const RELEASE_SCOPES = ["all", "windows"];
export const RELEASE_VISIBILITIES = ["draft", "public"];

const CANONICAL_PLATFORMS = {
  "darwin-aarch64-app": "darwin_aarch64.app.tar.gz",
  "darwin-x86_64-app": "darwin_x64.app.tar.gz",
  "linux-x86_64-deb": "linux_amd64.deb",
  "linux-aarch64-deb": "linux_arm64.deb",
  "windows-x86_64-nsis": "windows_x64-setup.exe",
  "windows-x86_64-msi": "windows_x64.msi",
  "windows-aarch64-nsis": "windows_arm64-setup.exe",
};

export const PLATFORM_PACKAGES = {
  ...CANONICAL_PLATFORMS,
  "darwin-aarch64": CANONICAL_PLATFORMS["darwin-aarch64-app"],
  "darwin-x86_64": CANONICAL_PLATFORMS["darwin-x86_64-app"],
  "linux-x86_64": CANONICAL_PLATFORMS["linux-x86_64-deb"],
  "linux-aarch64": CANONICAL_PLATFORMS["linux-aarch64-deb"],
  "windows-x86_64": CANONICAL_PLATFORMS["windows-x86_64-nsis"],
  "windows-aarch64": CANONICAL_PLATFORMS["windows-aarch64-nsis"],
};

const DISK_IMAGES = ["darwin_aarch64.dmg", "darwin_x64.dmg"];

export function releaseVersion(tag) {
  assert.match(
    tag ?? "",
    /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "Release tag must use the vMAJOR.MINOR.PATCH format",
  );
  return tag.slice(1);
}

export function releaseAssetName(tag, suffix) {
  const version = releaseVersion(tag);
  const [major, minor] = version.split(".").map(Number);
  const prefix = major > 0 || minor >= 11 ? "ZhanDu" : "FineShell";
  return `${prefix}_${version}_${suffix}`;
}

export function expectedPlatforms(scope) {
  assert.ok(RELEASE_SCOPES.includes(scope), "Invalid release platform scope");
  return Object.entries(PLATFORM_PACKAGES).filter(
    ([key]) => scope === "all" || key.startsWith("windows-"),
  );
}

export function signedPackageNames(tag, scope) {
  assert.ok(RELEASE_SCOPES.includes(scope), "Invalid release platform scope");
  return Object.entries(CANONICAL_PLATFORMS)
    .filter(([key]) => scope === "all" || key.startsWith("windows-"))
    .map(([, suffix]) => releaseAssetName(tag, suffix));
}

export function expectedAssetNames(tag, scope) {
  const signed = signedPackageNames(tag, scope);
  const diskImages =
    scope === "all" ? DISK_IMAGES.map((suffix) => releaseAssetName(tag, suffix)) : [];
  return ["latest.json", ...signed.flatMap((name) => [name, name + ".sig"]), ...diskImages].sort();
}

export function manifestAssetUrl(repository, tag, assetName) {
  return `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
}

export function validateReleaseMetadata(release, { tag, commit, visibility }) {
  assert.ok(RELEASE_VISIBILITIES.includes(visibility), "Invalid release visibility");
  assert.match(commit ?? "", /^[0-9a-f]{40}$/, "Release commit must be a full SHA");
  assert.equal(release.tag_name, tag);
  assert.equal(release.target_commitish, commit);
  assert.equal(release.draft, visibility === "draft");
  assert.equal(release.prerelease, tag.includes("-"));
}

export function validateReleaseAssetList(release, expectedAssets) {
  assert.deepEqual(release.assets.map(({ name }) => name).sort(), expectedAssets);
  for (const { name, digest, state } of release.assets) {
    assert.equal(state, "uploaded", name);
    assert.match(digest ?? "", /^sha256:[0-9a-f]{64}$/i, `${name} is missing a SHA-256 digest`);
  }
}

export function validateUpdaterManifest(manifest, { repository, tag, platforms, signatureFor }) {
  assert.equal(manifest.version, releaseVersion(tag));
  assert.deepEqual(Object.keys(manifest.platforms).sort(), platforms.map(([key]) => key).sort());
  for (const [platform, suffix] of platforms) {
    const name = releaseAssetName(tag, suffix);
    const { url, signature } = manifest.platforms[platform];
    assert.equal(url, manifestAssetUrl(repository, tag, name));
    assert.equal(signature, signatureFor(name).trim());
  }
}
