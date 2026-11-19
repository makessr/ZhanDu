import { describe, expect, test } from "bun:test";
import { validateUpdaterManifest } from "./validate-updater-manifest";

const platform = {
  signature: "signed-update",
  url: "https://github.com/example/app/releases/download/v1.2.3/app.tar.gz",
};
const repository = "example/app";

function manifest(platforms: Record<string, unknown>) {
  return { platforms, version: "1.2.3" };
}

describe("updater manifest validation", () => {
  test("requires both Windows architectures for a Windows-only release", () => {
    const windows = manifest({
      "windows-x86_64-nsis": platform,
      "windows-aarch64-nsis": platform,
    });
    expect(validateUpdaterManifest(windows, "v1.2.3", repository, "windows")).toEqual([
      "windows-x86_64-nsis", "windows-aarch64-nsis",
    ]);
    expect(() => validateUpdaterManifest(
      manifest({ "windows-x86_64-nsis": platform }), "v1.2.3", repository, "windows",
    )).toThrow("缺少 Windows ARM64");
  });

  test("accepts a complete cross-platform manifest", () => {
    expect(
      validateUpdaterManifest(
        manifest({
          "darwin-aarch64-app": platform,
          "darwin-x86_64": platform,
          "linux-x86_64-deb": platform,
          "linux-aarch64-deb": platform,
          "windows-x86_64-nsis": platform,
          "windows-aarch64-nsis": platform,
        }),
        "v1.2.3",
        repository,
      ),
    ).toEqual([
      "darwin-aarch64-app",
      "darwin-x86_64",
      "linux-x86_64-deb",
      "linux-aarch64-deb",
      "windows-x86_64-nsis",
      "windows-aarch64-nsis",
    ]);
  });

  test("rejects a manifest without ARM64 updater platforms", () => {
    expect(() =>
      validateUpdaterManifest(
        manifest({
          "darwin-aarch64": platform,
          "darwin-x86_64": platform,
          "linux-x86_64-deb": platform,
          "windows-x86_64-nsis": platform,
        }),
        "v1.2.3",
        repository,
      ),
    ).toThrow("缺少 Linux ARM64");
  });

  test("rejects AppImage-only Linux updater platforms", () => {
    expect(() =>
      validateUpdaterManifest(
        manifest({
          "darwin-aarch64": platform,
          "darwin-x86_64": platform,
          "linux-x86_64-appimage": platform,
          "linux-aarch64-deb": platform,
          "windows-x86_64-nsis": platform,
          "windows-aarch64-nsis": platform,
        }),
        "v1.2.3",
        repository,
      ),
    ).toThrow("缺少 Linux x64");
  });

  test("rejects a manifest without Windows ARM64", () => {
    expect(() =>
      validateUpdaterManifest(
        manifest({
          "darwin-aarch64": platform,
          "darwin-x86_64": platform,
          "linux-x86_64-deb": platform,
          "linux-aarch64-deb": platform,
          "windows-x86_64-nsis": platform,
        }),
        "v1.2.3",
        repository,
      ),
    ).toThrow("缺少 Windows ARM64");
  });

  test("rejects a manifest without macOS updater platforms", () => {
    expect(() =>
      validateUpdaterManifest(
        manifest({
          "linux-x86_64": platform,
          "windows-x86_64": platform,
        }),
        "v1.2.3",
        repository,
      ),
    ).toThrow("缺少 macOS Apple Silicon");
  });

  test("rejects invalid platform entries and version mismatches", () => {
    expect(() =>
      validateUpdaterManifest(
        manifest({
          "darwin-aarch64": { ...platform, signature: "" },
        }),
        "v1.2.3",
        repository,
      ),
    ).toThrow("缺少签名");

    expect(() =>
      validateUpdaterManifest(manifest({}), "v1.2.4", repository),
    ).toThrow("版本不一致");
  });

  test("requires HTTPS download URLs", () => {
    expect(() =>
      validateUpdaterManifest(
        manifest({
          "darwin-aarch64": { ...platform, url: "http://example.com/app" },
        }),
        "v1.2.3",
        repository,
      ),
    ).toThrow("必须使用 HTTPS");
  });

  test("rejects GitHub API asset URLs", () => {
    expect(() =>
      validateUpdaterManifest(
        manifest({
          "darwin-aarch64": {
            ...platform,
            url: "https://api.github.com/repos/example/app/releases/assets/1",
          },
        }),
        "v1.2.3",
        repository,
      ),
    ).toThrow("必须使用当前版本的 GitHub Release 公开下载地址");
  });

  test("rejects draft release download paths", () => {
    expect(() =>
      validateUpdaterManifest(
        manifest({
          "darwin-aarch64": {
            ...platform,
            url: "https://github.com/example/app/releases/download/untagged-draft/app.tar.gz",
          },
        }),
        "v1.2.3",
        repository,
      ),
    ).toThrow("必须使用当前版本的 GitHub Release 公开下载地址");
  });

  test("rejects another owner or repository in any platform download URL", () => {
    for (const otherRepository of ["another/app", "example/app-other"]) {
      const windows = manifest({
        "windows-x86_64-nsis": platform,
        "windows-aarch64-nsis": {
          ...platform,
          url: platform.url.replace(repository, otherRepository),
        },
      });
      expect(() => validateUpdaterManifest(windows, "v1.2.3", repository, "windows"))
        .toThrow(`下载地址必须属于发布仓库 ${repository}`);
    }
  });
});
