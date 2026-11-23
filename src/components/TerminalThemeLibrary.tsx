import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Button, Input } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings } from "../app-settings";
import { useResolvedAppearance } from "../hooks/useResolvedAppearance";
import { commandErrorMessage, invokeProtocolCommand as invoke } from "../tauri-protocol";
import {
  ANSI_COLOR_KEYS,
  BASE24_TERMINAL_THEMES,
  MAX_CUSTOM_TERMINAL_THEMES,
  TERMINAL_THEMES,
  customTerminalThemeId,
  parseGhosttyTheme,
  resolveTerminalTheme,
  type StoredTerminalTheme,
  type TerminalColorScheme,
} from "../terminal-themes";

interface GhosttyThemeFile {
  name: string;
  contents: string;
}

export default function TerminalThemeLibrary({
  settings,
  setSettings,
}: {
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
}) {
  const appearance = useResolvedAppearance();
  const [search, setSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [diskThemes, setDiskThemes] = useState<StoredTerminalTheme[]>([]);
  const [scanError, setScanError] = useState("");
  const [actionError, setActionError] = useState("");
  const [importing, setImporting] = useState(false);
  const desktop = isTauri();

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    setScanError("");
    void invoke<GhosttyThemeFile[]>("read_ghostty_themes", {})
      .then((files) => {
        if (disposed) return;
        const themes = files.flatMap((file) => {
          try {
            return [parseGhosttyTheme(file.name, file.contents)];
          } catch {
            return [];
          }
        });
        setDiskThemes(themes);
      })
      .catch((error) => {
        if (!disposed) setScanError(commandErrorMessage(error));
      });
    return () => { disposed = true; };
  }, [desktop, refresh]);

  const custom = useMemo(() => {
    const entries = new Map<string, StoredTerminalTheme>();
    for (const theme of [...settings.terminalCustomThemes, ...diskThemes]) {
      const id = customTerminalThemeId(theme.name);
      if (!entries.has(id)) entries.set(id, theme);
    }
    return entries;
  }, [diskThemes, settings.terminalCustomThemes]);

  const groups = [
    ["栈渡", [
      { id: "appearance", name: "跟随界面外观" },
      ...Object.entries(TERMINAL_THEMES).map(([id, theme]) => ({ id, name: theme.label })),
    ]],
    ["Ghostty 主题", [...custom].map(([id, theme]) => ({ id, name: theme.name }))],
    ["Base24", [...BASE24_TERMINAL_THEMES].map(([id, theme]) => ({
      id, name: theme.label, author: theme.author,
    }))],
  ] as const;
  const words = search.trim().toLowerCase().split(/\s+/);
  const filteredGroups = groups.map(([title, entries]) => [
    title,
    entries.filter((entry) => words.every((word) =>
      `${entry.name} ${entry.id} ${"author" in entry ? entry.author : ""}`.toLowerCase().includes(word),
    )),
  ] as const);
  const preview = resolveTerminalTheme(settings.terminalColorScheme, appearance, settings.terminalCustomThemes);
  const theme = preview.theme;
  const selectedCustom = settings.terminalCustomThemes.find(
    ({ name }) => customTerminalThemeId(name) === settings.terminalColorScheme,
  );

  function selectTheme(id: TerminalColorScheme, imported?: StoredTerminalTheme) {
    const existing = settings.terminalCustomThemes;
    if (imported && !existing.some(({ name }) => name === imported.name) &&
      existing.length >= MAX_CUSTOM_TERMINAL_THEMES) {
      setActionError("已达到自定义主题上限，请先移除一套主题");
      return;
    }
    setActionError("");
    setSettings((current) => ({
      ...current,
      terminalColorScheme: id,
      terminalCustomThemes: imported
        ? [...current.terminalCustomThemes.filter(({ name }) => name !== imported.name), imported]
        : current.terminalCustomThemes,
    }));
  }

  async function importTheme() {
    setImporting(true);
    setActionError("");
    try {
      const path = await open({ title: "导入 Ghostty 主题" });
      if (typeof path !== "string") return;
      const contents = await invoke<string>("read_config_file", { path });
      const imported = parseGhosttyTheme(path.split(/[/\\]/).pop() ?? "", contents);
      setSearch("");
      selectTheme(customTerminalThemeId(imported.name), imported);
    } catch (error) {
      setActionError(commandErrorMessage(error));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="settings-group terminal-theme-library">
      <div className="terminal-theme-library-header">
        <strong>终端主题库</strong>
        <div className="terminal-theme-actions">
          <Button size="small" disabled={!desktop || importing} onClick={() => void importTheme()}>
            导入 Ghostty 主题
          </Button>
          <Button size="small" disabled={!desktop} onClick={() => setRefresh((value) => value + 1)}>
            刷新主题目录
          </Button>
        </div>
      </div>
      {(scanError || actionError) && <div role="status">{[scanError, actionError].filter(Boolean).join(" · ")}</div>}
      <div className="terminal-theme-library-grid">
        <div className="terminal-theme-picker">
          <Input allowClear aria-label="搜索终端主题" placeholder="搜索名称或作者" value={search} onChange={setSearch} />
          <select
            aria-label="终端配色方案"
            size={7}
            value={settings.terminalColorScheme}
            disabled={importing}
            onChange={(event) => {
              const id = event.target.value as TerminalColorScheme;
              const saved = settings.terminalCustomThemes.some(({ name }) => customTerminalThemeId(name) === id);
              selectTheme(id, saved ? undefined : custom.get(id));
            }}
          >
            {filteredGroups.filter(([, entries]) => entries.length).map(([title, entries]) => (
              <optgroup label={title} key={title}>
                {entries.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </optgroup>
            ))}
          </select>
          {filteredGroups.every(([, entries]) => !entries.length) && <span role="status">没有匹配的主题</span>}
        </div>
        <div className="terminal-theme-preview-column">
          <div className="terminal-theme-preview-title">
            <span>{settings.terminalColorScheme === "appearance" ? "跟随界面外观" : preview.label}</span>
            {selectedCustom && (
              <Button size="mini" disabled={importing} onClick={() => {
                setActionError("");
                setSettings((current) => ({
                  ...current,
                  terminalColorScheme: "appearance",
                  terminalCustomThemes: current.terminalCustomThemes.filter(({ name }) => name !== selectedCustom.name),
                }));
              }}>
                移除已保存主题
              </Button>
            )}
          </div>
          <div className="terminal-theme-preview" style={{ backgroundColor: theme.background, color: theme.foreground }}>
            <div><span style={{ color: theme.green }}>admin@server</span>:<span style={{ color: theme.blue }}>~/logs</span>$ ls</div>
            <div><span style={{ color: theme.blue }}>archive/</span>  app.log  <span style={{ color: theme.green }}>rotate.sh</span></div>
            <div>$ <span className="terminal-theme-cursor" style={{ backgroundColor: theme.cursor }} /></div>
          </div>
          <div className="terminal-theme-ansi" aria-label="16 色 ANSI 色板">
            {ANSI_COLOR_KEYS.map((key, index) => (
              <span key={key} title={`ANSI ${index} · ${theme[key]}`} style={{ backgroundColor: theme[key] }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
