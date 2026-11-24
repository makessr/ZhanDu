import { describe, expect, test } from "bun:test";
import {
  assertTargetNewer,
  baselineAssetNames,
  parseStableVersion,
  validateBaselineRelease,
  validateLatestRelease,
  validateUpdateFeed,
} from "./ota-baseline.mjs";

describe("OTA version ordering", () => {
  test("parses stable versions into numeric parts", () => {
    expect(parseStableVersion("1.10.2")).toEqual([1n, 10n, 2n]);
    expect(() => parseStableVersion("01.2.3")).toThrow("stable versions");
    expect(() => parseStableVersion("v1.2.3")).toThrow("stable versions");
  });

  test("requires the target version to be newer", () => {
    expect(() => assertTargetNewer("1.2.3", "1.2.4")).not.toThrow();
    expect(() => assertTargetNewer("1.2.3", "1.3.0")).not.toThrow();
    expect(() => assertTargetNewer("1.2.3", "2.0.0")).not.toThrow();
    expect(() => assertTargetNewer("1.2.3", "1.2.3")).toThrow("newer");
    expect(() => assertTargetNewer("1.2.3", "1.2.2")).toThrow("newer");
    expect(() => assertTargetNewer("2.0.0", "1.9.9")).toThrow("newer");
  });
});

describe("OTA baseline asset selection", () => {
  test("accepts historical and rebranded installers on each platform", () => {
    expect(baselineAssetNames("windows-x64", "1.2.2")).toEqual([
      "FineShell_1.2.2_windows_x64-setup.exe",
      "ZhanDu_1.2.2_windows_x64-setup.exe",
    ]);
    expect(baselineAssetNames("macos-arm64", "1.2.2")).toEqual([
      "FineShell_1.2.2_darwin_aarch64.dmg",
      "ZhanDu_1.2.2_darwin_aarch64.dmg",
    ]);
    expect(baselineAssetNames("linux-amd64", "1.2.2")).toEqual([
      "FineShell_1.2.2_linux_amd64.deb",
      "ZhanDu_1.2.2_linux_amd64.deb",
    ]);
  });

  test("rejects unknown platforms", () => {
    expect(() => baselineAssetNames("freebsd", "1.2.2")).toThrow("Unknown OTA platform");
  });
});

describe("OTA release and feed validation", () => {
  test("requires the target to be the latest public stable release", () => {
    expect(() =>
      validateLatestRelease({ tag_name: "v1.2.4", draft: false, prerelease: false }, "1.2.4"),
    ).not.toThrow();
    expect(() =>
      validateLatestRelease({ tag_name: "v1.2.3", draft: false, prerelease: false }, "1.2.4"),
    ).toThrow("latest stable release");
    expect(() =>
      validateLatestRelease({ tag_name: "v1.2.4", draft: true, prerelease: false }, "1.2.4"),
    ).toThrow("public and stable");
    expect(() =>
      validateLatestRelease({ tag_name: "v1.2.4", draft: false, prerelease: true }, "1.2.4"),
    ).toThrow("public and stable");
  });

  test("validates public feed URLs and signatures", () => {
    const repository = "makessr/ZhanDu";
    const valid = {
      version: "1.2.4",
      platforms: {
        "windows-x86_64": {
          url: "https://github.com/makessr/ZhanDu/releases/download/v1.2.4/FineShell_1.2.4_windows_x64-setup.exe",
          signature: "sig",
        },
      },
    };
    expect(() => validateUpdateFeed(valid, "1.2.4", repository)).not.toThrow();
    expect(() => validateUpdateFeed({ ...valid, version: "1.2.3" }, "1.2.4", repository)).toThrow(
      "requested version",
    );
    expect(() =>
      validateUpdateFeed(
        {
          version: "1.2.4",
          platforms: {
            "windows-x86_64": {
              url: "https://example.com/FineShell_1.2.4_windows_x64-setup.exe",
              signature: "sig",
            },
          },
        },
        "1.2.4",
        repository,
      ),
    ).toThrow("URLs or signatures");
    expect(() =>
      validateUpdateFeed({ version: "1.2.4", platforms: {} }, "1.2.4", repository),
    ).toThrow("URLs or signatures");
  });

  test("requires exactly one public baseline installer with a digest", () => {
    const digest = "sha256:" + "b".repeat(64);
    const assets = [
      { name: "FineShell_1.2.2_windows_x64-setup.exe", digest },
      { name: "ZhanDu_1.2.2_windows_x64-setup.exe" },
    ];
    expect(() =>
      validateBaselineRelease({ isDraft: false, isPrerelease: false, assets }, [
        "FineShell_1.2.2_windows_x64-setup.exe",
      ]),
    ).not.toThrow();
    expect(() =>
      validateBaselineRelease({ isDraft: false, isPrerelease: false, assets }, [
        "FineShell_1.2.2_windows_x64-setup.exe",
        "ZhanDu_1.2.2_windows_x64-setup.exe",
      ]),
    ).toThrow("exactly one");
    expect(() =>
      validateBaselineRelease(
        {
          isDraft: false,
          isPrerelease: false,
          assets: [{ name: "FineShell_1.2.2_windows_x64-setup.exe" }],
        },
        ["FineShell_1.2.2_windows_x64-setup.exe"],
      ),
    ).toThrow("SHA-256");
    expect(() =>
      validateBaselineRelease(
        {
          isDraft: true,
          isPrerelease: false,
          assets: [{ name: "FineShell_1.2.2_windows_x64-setup.exe", digest }],
        },
        ["FineShell_1.2.2_windows_x64-setup.exe"],
      ),
    ).toThrow("publicly released");
  });
});
