export function isSingleTerminalCommand(command: string): boolean {
  return command.length <= 4_096 && command.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(command);
}

export function terminalCommandCompletion(line: string) {
  const tokens = [...line.matchAll(/(?:\\[^\r\n]|'[^']*'?|"[^"]*"?|[^\s"'\\])+/g)];
  const last = tokens[tokens.length - 1];
  const atEnd = last && last.index + last[0].length === line.length;
  const prefix = atEnd ? line.slice(0, last.index) : line;
  const raw = atEnd ? last[0] : "";
  const token = raw.replace(/\\(.)|'([^']*)'?|"([^"]*)"?/g,
    (_, escaped, single, double) => escaped ?? single ?? double);
  return { prefix, token, firstWord: prefix.trim() === "" };
}

export function remoteCompletionDirectory(typed: string, cwd: string, home: string) {
  const separator = typed.lastIndexOf("/");
  const folder = typed.slice(0, separator + 1);
  const fragment = typed.slice(separator + 1);
  const resolvedFolder = folder.startsWith("~/") ? `${home}/${folder.slice(2)}` : folder;
  if (folder.startsWith("~/") && !home.startsWith("/")) return null;
  const absolute = resolvedFolder.startsWith("/") ? resolvedFolder : cwd && `${cwd}/${resolvedFolder}`;
  if (!absolute.startsWith("/")) return null;
  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return {
    directory: `/${segments.join("/")}`,
    prefix: folder.startsWith("~/") ? `${home.replace(/\/$/, "")}/${folder.slice(2)}` : folder,
    fragment,
  };
}

export function shellCompletionWord(value: string) {
  if (/^[\p{L}\p{M}\p{N}._/+\-]+$/u.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
