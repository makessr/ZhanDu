import { diagnosticInvoke } from "./diagnostics";

export interface PickedLocalPath {
  path: string;
  token: string;
}

export interface LocalPathPickOptions {
  mode: "open" | "save";
  title: string;
  defaultPath?: string;
  filterName?: string;
  extensions?: string[];
}

/**
 * Opens a native dialog in the backend and returns a single-use token for the
 * chosen path. The token is required by the file commands instead of raw paths.
 */
export function pickLocalPath(options: LocalPathPickOptions) {
  return diagnosticInvoke<PickedLocalPath | null>("pick_local_path", { request: options });
}
