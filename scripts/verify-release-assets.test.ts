import { describe, expect, test } from "bun:test";
import {
  expectedAssetNames,
  expectedPlatforms,
  manifestAssetUrl,
  releaseAssetName,
  releaseVersion,
  signedPackageNames,
  validateReleaseAssetList,
  validateReleaseMetadata,
  validateUpdaterManifest,
} from "./release-assets.mjs";

const commit = "0".repeat(40);

describe("release version parsing", () => {
  test("accepts stable and prerelease tags", () => {
    expect(releaseVersion("v1.2.3")).toBe("1.2.3");
    expect(releaseVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });

  test("rejects tags without the v prefix or malformed versions", () => {
    expect(() => releaseVersion("1.2.3")).toThrow("vMAJOR.MINOR.PATCH");
    expect(() => releaseVersion("v1.2")).toThrow("vMAJOR.MINOR.PATCH");
    expect(() => releaseVersion(undefined)).toThrow("vMAJOR.MINOR.PATCH");
  });
});

describe("release asset naming", () => {
  test("uses the project brand on every platform from v0.11.0", () => {
    expect(releaseAssetName("v0.10.0", "windows_x64-setup.exe")).toBe(
      "FineShell_0.10.0_windows_x64-setup.exe",
    );
    expect(releaseAssetName("v0.11.0", "windows_x64-setup.exe")).toBe(
      "ZhanDu_0.11.0_windows_x64-setup.exe",
    );
    expect(releaseAssetName("v0.11.0", "darwin_aarch64.dmg")).toBe(
      "ZhanDu_0.11.0_darwin_aarch64.dmg",
    );
    expect(releaseAssetName("v0.11.0-beta.1", "linux_arm64.deb")).toBe(
      "ZhanDu_0.11.0-beta.1_linux_arm64.deb",
    );
  });

  test("lists updater assets per platform scope", () => {
    expect(expectedPlatforms("windows").map(([key]) => key)).toEqual([
      "windows-x86_64-nsis",
      "windows-x86_64-msi",
      "windows-aarch64-nsis",
      "windows-x86_64",
      "windows-aarch64",
    ]);
    expect(expectedPlatforms("all")).toHaveLength(13);
    expect(signedPackageNames("v1.2.3", "windows")).toEqual([
      "ZhanDu_1.2.3_windows_x64-setup.exe",
      "ZhanDu_1.2.3_windows_x64.msi",
      "ZhanDu_1.2.3_windows_arm64-setup.exe",
    ]);
  });

  test("windows scope omits disk images while the full scope includes them", () => {
    const windows = expectedAssetNames("v1.2.3", "windows");
    expect(windows).toContain("latest.json");
    expect(windows.some((name) => name.endsWith(".dmg"))).toBe(false);
    expect(windows).toContain("ZhanDu_1.2.3_windows_x64-setup.exe.sig");

    const all = expectedAssetNames("v1.2.3", "all");
    expect(all).toContain("ZhanDu_1.2.3_darwin_aarch64.dmg");
    expect(all).toContain("ZhanDu_1.2.3_darwin_x64.dmg");
    expect(all.filter((name) => name.endsWith(".sig"))).toHaveLength(7);
  });

  test("rejects unknown scopes", () => {
    expect(() => expectedAssetNames("v1.2.3", "linux")).toThrow("Invalid release platform scope");
  });
});

describe("release metadata validation", () => {
  const release = {
    tag_name: "v1.2.3",
    target_commitish: commit,
    draft: true,
    prerelease: false,
  };

  test("accepts a matching draft release", () => {
    expect(() =>
      validateReleaseMetadata(release, { tag: "v1.2.3", commit, visibility: "draft" }),
    ).not.toThrow();
  });

  test("rejects mismatched commit, tag and visibility", () => {
    expect(() =>
      validateReleaseMetadata(release, {
        tag: "v1.2.4",
        commit,
        visibility: "draft",
      }),
    ).toThrow();
    expect(() =>
      validateReleaseMetadata(release, {
        tag: "v1.2.3",
        commit: "1".repeat(40),
        visibility: "draft",
      }),
    ).toThrow();
    expect(() =>
      validateReleaseMetadata(release, { tag: "v1.2.3", commit, visibility: "public" }),
    ).toThrow();
    expect(() =>
      validateReleaseMetadata(release, { tag: "v1.2.3", commit: "abc", visibility: "draft" }),
    ).toThrow("full SHA");
  });

  test("validates uploaded asset digests", () => {
    const digest = "sha256:" + "a".repeat(64);
    expect(() =>
      validateReleaseAssetList({ assets: [{ name: "latest.json", digest, state: "uploaded" }] }, [
        "latest.json",
      ]),
    ).not.toThrow();
    expect(() =>
      validateReleaseAssetList({ assets: [{ name: "latest.json", digest, state: "starter" }] }, [
        "latest.json",
      ]),
    ).toThrow();
    expect(() =>
      validateReleaseAssetList(
        { assets: [{ name: "latest.json", digest: "sha256:short", state: "uploaded" }] },
        ["latest.json"],
      ),
    ).toThrow("SHA-256");
  });
});

describe("updater manifest validation", () => {
  const platforms = [
    ["windows-x86_64", "windows_x64-setup.exe"],
    ["darwin-aarch64", "darwin_aarch64.app.tar.gz"],
  ];
  const manifest = {
    version: "1.2.3",
    platforms: {
      "windows-x86_64": {
        url: manifestAssetUrl("makessr/ZhanDu", "v1.2.3", "ZhanDu_1.2.3_windows_x64-setup.exe"),
        signature: "windows-sig",
      },
      "darwin-aarch64": {
        url: manifestAssetUrl("makessr/ZhanDu", "v1.2.3", "ZhanDu_1.2.3_darwin_aarch64.app.tar.gz"),
        signature: "mac-sig",
      },
    },
  };
  const signatures = {
    "ZhanDu_1.2.3_windows_x64-setup.exe": "windows-sig\n",
    "ZhanDu_1.2.3_darwin_aarch64.app.tar.gz": "mac-sig\n",
  };

  test("accepts a manifest whose URLs and signatures match the release", () => {
    expect(() =>
      validateUpdaterManifest(manifest, {
        repository: "makessr/ZhanDu",
        tag: "v1.2.3",
        platforms,
        signatureFor: (name) => signatures[name],
      }),
    ).not.toThrow();
  });

  test("rejects a manifest for another version or with a wrong signature", () => {
    expect(() =>
      validateUpdaterManifest(
        { ...manifest, version: "1.2.2" },
        {
          repository: "makessr/ZhanDu",
          tag: "v1.2.3",
          platforms,
          signatureFor: (name) => signatures[name],
        },
      ),
    ).toThrow();
    expect(() =>
      validateUpdaterManifest(
        {
          ...manifest,
          platforms: {
            ...manifest.platforms,
            "darwin-aarch64": { ...manifest.platforms["darwin-aarch64"], signature: "tampered" },
          },
        },
        {
          repository: "makessr/ZhanDu",
          tag: "v1.2.3",
          platforms,
          signatureFor: (name) => signatures[name],
        },
      ),
    ).toThrow();
  });
});
