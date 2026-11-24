import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expectedAssetNames,
  expectedPlatforms,
  releaseVersion,
  signedPackageNames,
  validateReleaseAssetList,
  validateReleaseMetadata,
  validateUpdaterManifest,
  WINDOWS_ASSET_PREFIXES,
  RELEASE_SCOPES,
  RELEASE_VISIBILITIES,
} from "./release-assets.mjs";

const [
  assetDir,
  releaseFile,
  previousConfig,
  verifier,
  repository,
  tag,
  commit,
  scope,
  visibility,
  windowsPrefix = "FineShell",
] = process.argv.slice(2);
assert.ok(RELEASE_SCOPES.includes(scope), "Invalid release platform scope");
assert.ok(RELEASE_VISIBILITIES.includes(visibility), "Invalid release visibility");
assert.ok(WINDOWS_ASSET_PREFIXES.includes(windowsPrefix), "Invalid Windows asset prefix");
releaseVersion(tag);

const release = JSON.parse(await readFile(releaseFile, "utf8"));
validateReleaseMetadata(release, { tag, commit, visibility });

const version = releaseVersion(tag);
const expectedAssets = expectedAssetNames(tag, scope, windowsPrefix);
validateReleaseAssetList(release, expectedAssets);
assert.deepEqual((await readdir(assetDir)).sort(), expectedAssets);
for (const { name, digest } of release.assets) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(assetDir, name))) hash.update(chunk);
  assert.equal("sha256:" + hash.digest("hex"), digest, name);
}

const config = JSON.parse(await readFile(previousConfig, "utf8"));
const { pubkey, endpoints } = config.plugins.updater;
assert.ok(typeof pubkey === "string" && pubkey.length > 0, "Missing updater public key");
assert.equal(endpoints[0], `https://github.com/${repository}/releases/latest/download/latest.json`);

const platforms = expectedPlatforms(scope);
const signedPackages = signedPackageNames(tag, scope, windowsPrefix);
for (const name of signedPackages) {
  execFileSync(verifier, [pubkey, join(assetDir, name), join(assetDir, name + ".sig")], {
    stdio: "inherit",
  });
}

const manifest = JSON.parse(await readFile(join(assetDir, "latest.json"), "utf8"));
const signatureFiles = new Map(
  await Promise.all(
    signedPackages.map(async (name) => [
      name,
      await readFile(join(assetDir, name + ".sig"), "utf8"),
    ]),
  ),
);
validateUpdaterManifest(manifest, {
  repository,
  tag,
  platforms,
  windowsPrefix,
  signatureFor: (name) => {
    const signature = signatureFiles.get(name);
    assert.ok(signature !== undefined, `Missing signature for ${name}`);
    return signature;
  },
});
console.log(
  `Verified ${expectedAssets.length} asset digests, ${signedPackages.length} signatures, and ${platforms.length} updater entries for ${repository} ${release.tag_name} (${version}).`,
);
