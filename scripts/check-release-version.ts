import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ReleaseVersions {
  cargo: string;
  packageJson: string;
  tauri: string;
}

const RELEASE_TAG_PATTERN =
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function cargoPackageVersion(contents: string) {
  const packageSection = contents.match(
    /\[package\]([\s\S]*?)(?=\n\[[^\]]+\]|$)/,
  )?.[1];
  const version = packageSection?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];

  if (!version) {
    throw new Error("无法读取 src-tauri/Cargo.toml 的 package.version");
  }

  return version;
}

export function validateReleaseVersion(
  releaseTag: string,
  versions: ReleaseVersions,
) {
  if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error(
      `版本标签“${releaseTag}”格式无效，应使用 v1.2.3 或 v1.2.3-beta.1`,
    );
  }

  const configuredVersions = new Set(Object.values(versions));
  if (configuredVersions.size !== 1) {
    throw new Error(
      `版本不一致：package.json=${versions.packageJson}，tauri.conf.json=${versions.tauri}，Cargo.toml=${versions.cargo}`,
    );
  }

  const version = versions.tauri;
  if (releaseTag !== `v${version}`) {
    throw new Error(
      `版本标签“${releaseTag}”与应用版本“${version}”不一致，应使用 v${version}`,
    );
  }

  return version;
}

export function validateReleaseRepository(
  endpoints: unknown,
  repository: string,
) {
  const expected = `https://github.com/${repository}/releases/latest/download/latest.json`;
  const endpoint = Array.isArray(endpoints) ? endpoints[0] : undefined;
  const match = typeof endpoint === "string"
    ? endpoint.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/latest\/download\/latest\.json$/)
    : null;
  if (
    !match ||
    match[1].toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error(
      `应用更新渠道与发布仓库不一致：当前地址为 ${String(endpoint)}，${repository} 的更新地址应为 ${expected}`,
    );
  }
}

function readReleaseVersions(repository?: string): ReleaseVersions {
  const projectRoot = resolve(import.meta.dir, "..");
  const packageJson = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8"),
  ) as { version?: string };
  const tauriConfig = JSON.parse(
    readFileSync(resolve(projectRoot, "src-tauri/tauri.conf.json"), "utf8"),
  ) as { version?: string; plugins?: { updater?: { endpoints?: unknown } } };
  const cargoToml = readFileSync(
    resolve(projectRoot, "src-tauri/Cargo.toml"),
    "utf8",
  );

  if (!packageJson.version || !tauriConfig.version) {
    throw new Error("package.json 或 tauri.conf.json 缺少 version");
  }
  if (repository !== undefined) {
    validateReleaseRepository(tauriConfig.plugins?.updater?.endpoints, repository);
  }

  return {
    cargo: cargoPackageVersion(cargoToml),
    packageJson: packageJson.version,
    tauri: tauriConfig.version,
  };
}

if (import.meta.main) {
  try {
    const releaseTag = process.argv[2] ?? "";
    const repository = process.argv[3];
    const version = validateReleaseVersion(releaseTag, readReleaseVersions(repository));
    console.log(`FineShell ${version} 版本校验通过（${releaseTag}）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
