import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const [assetDir, releaseFile, previousConfig, verifier, repository, tag, commit] = process.argv.slice(2);
const release = JSON.parse(await readFile(releaseFile, "utf8"));
assert.equal(release.tag_name, tag);
assert.equal(release.target_commitish, commit);
assert.equal(release.draft, true);
assert.equal(release.prerelease, false);

const version = release.tag_name.slice(1);
const packagePrefix = "FineShell_" + version + "_";
const canonicalPlatforms = {
  "darwin-aarch64-app": "darwin_aarch64.app.tar.gz",
  "darwin-x86_64-app": "darwin_x64.app.tar.gz",
  "linux-x86_64-deb": "linux_amd64.deb",
  "linux-aarch64-deb": "linux_arm64.deb",
  "windows-x86_64-nsis": "windows_x64-setup.exe",
  "windows-x86_64-msi": "windows_x64.msi",
  "windows-aarch64-nsis": "windows_arm64-setup.exe",
};
const platformPackages = {
  ...canonicalPlatforms,
  "darwin-aarch64": canonicalPlatforms["darwin-aarch64-app"],
  "darwin-x86_64": canonicalPlatforms["darwin-x86_64-app"],
  "linux-x86_64": canonicalPlatforms["linux-x86_64-deb"],
  "linux-aarch64": canonicalPlatforms["linux-aarch64-deb"],
  "windows-x86_64": canonicalPlatforms["windows-x86_64-nsis"],
  "windows-aarch64": canonicalPlatforms["windows-aarch64-nsis"],
};
const signedPackages = Object.values(canonicalPlatforms).map((name) => packagePrefix + name);
const expectedAssets = [
  "latest.json",
  ...signedPackages.flatMap((name) => [name, name + ".sig"]),
  packagePrefix + "darwin_aarch64.dmg",
  packagePrefix + "darwin_x64.dmg",
].sort();

assert.deepEqual(release.assets.map(({ name }) => name).sort(), expectedAssets);
assert.deepEqual((await readdir(assetDir)).sort(), expectedAssets);
for (const { name, digest } of release.assets) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(assetDir, name))) hash.update(chunk);
  assert.equal("sha256:" + hash.digest("hex"), digest, name);
}

const config = JSON.parse(await readFile(previousConfig, "utf8"));
const { pubkey, endpoints } = config.plugins.updater;
assert.equal(endpoints[0], `https://github.com/${repository}/releases/latest/download/latest.json`);
for (const name of signedPackages) {
  execFileSync(verifier, [pubkey, join(assetDir, name), join(assetDir, name + ".sig")], { stdio: "inherit" });
}

const manifestBytes = await readFile(join(assetDir, "latest.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
assert.equal(manifest.version, version);
assert.deepEqual(Object.keys(manifest.platforms).sort(), Object.keys(platformPackages).sort());
for (const [platform, suffix] of Object.entries(platformPackages)) {
  const name = packagePrefix + suffix;
  const { url, signature } = manifest.platforms[platform];
  assert.equal(url, `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`);
  assert.equal(signature, (await readFile(join(assetDir, name + ".sig"), "utf8")).trim());
}
console.log(`Verified ${expectedAssets.length} draft asset digests, ${signedPackages.length} signatures, and ${Object.keys(platformPackages).length} updater entries for ${repository} ${release.tag_name}.`);
