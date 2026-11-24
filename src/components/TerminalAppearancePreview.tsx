import type { AppSettings } from "../app-settings";
import { terminalFontCss } from "../app-settings";
import { terminalWallpaperStyle } from "../terminal-appearance";
import type { TerminalThemeDefinition } from "../terminal-themes";

export default function TerminalAppearancePreview({
  settings,
  theme,
}: {
  settings: AppSettings;
  theme: TerminalThemeDefinition["theme"];
}) {
  return (
    <div
      aria-label="终端外观预览"
      className={`terminal-theme-preview${settings.terminalBackgroundImage ? " terminal-wallpaper" : ""}`}
      style={{
        ...terminalWallpaperStyle(
          settings.terminalBackgroundImage,
          settings.terminalBackgroundMode,
          settings.terminalBackgroundOpacity,
        ),
        backgroundColor: theme.background,
        color: theme.foreground,
        fontFamily: terminalFontCss(settings),
        fontSize: settings.terminalFontSize,
        fontWeight: settings.terminalFontWeight,
        lineHeight: settings.terminalLineHeight,
      }}
    >
      <div>
        <span style={{ color: theme.green }}>admin@server</span>:
        <span style={{ color: theme.blue }}>~/logs</span>$ ls
      </div>
      <div>
        <span style={{ color: theme.blue }}>archive/</span> app.log{" "}
        <span style={{ color: theme.green }}>rotate.sh</span>
      </div>
      <div>
        <span style={{ color: theme.yellow }}>WARN</span> 磁盘用量 81% <strong>状态正常</strong>
      </div>
      <div>
        $ <span className="terminal-theme-cursor" style={{ backgroundColor: theme.cursor }} />
      </div>
    </div>
  );
}
