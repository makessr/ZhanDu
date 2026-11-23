import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Button, Radio, Slider } from "@arco-design/web-react";
import type { AppSettings } from "../app-settings";
import { useResolvedAppearance } from "../hooks/useResolvedAppearance";
import { prepareTerminalBackground, type TerminalBackgroundMode } from "../terminal-appearance";
import { resolveTerminalTheme } from "../terminal-themes";
import TerminalAppearancePreview from "./TerminalAppearancePreview";

export default function TerminalBackgroundSettings({
  settings,
  setSettings,
}: {
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
}) {
  const appearance = useResolvedAppearance();
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { theme } = resolveTerminalTheme(settings.terminalColorScheme, appearance, settings.terminalCustomThemes);
  return (
    <div className="settings-group terminal-background-settings">
      <div className="terminal-theme-library-header">
        <strong>终端背景</strong>
        <div className="terminal-theme-actions">
          <input
            accept="image/png,image/jpeg,image/webp"
            ref={inputRef}
            type="file"
            hidden
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              setError("");
              setLoading(true);
              try {
                const image = await prepareTerminalBackground(file);
                setSettings((current) => ({ ...current, terminalBackgroundImage: image }));
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "无法读取背景图片");
              } finally {
                setLoading(false);
              }
            }}
          />
          <Button size="small" loading={loading} onClick={() => inputRef.current?.click()}>选择图片</Button>
          <Button size="small" disabled={loading || !settings.terminalBackgroundImage} onClick={() => {
            setError("");
            setSettings((current) => ({ ...current, terminalBackgroundImage: "" }));
          }}>移除图片</Button>
        </div>
      </div>
      {error && <div role="alert">{error}</div>}
      {settings.terminalBackgroundImage && (
        <>
          <Radio.Group
            aria-label="背景填充方式"
            options={[{ label: "铺满", value: "cover" }, { label: "完整显示", value: "contain" }, { label: "平铺", value: "tile" }]}
            value={settings.terminalBackgroundMode}
            onChange={(value) => setSettings((current) => ({
              ...current,
              terminalBackgroundMode: value as TerminalBackgroundMode,
            }))}
          />
          <div className="terminal-background-opacity">
            <span>图片不透明度</span>
            <Slider
              aria-label="图片不透明度"
              value={settings.terminalBackgroundOpacity}
              onChange={(value) => {
                if (typeof value === "number") {
                  setSettings((current) => ({ ...current, terminalBackgroundOpacity: value }));
                }
              }}
            />
            <span>{settings.terminalBackgroundOpacity}%</span>
          </div>
        </>
      )}
      <TerminalAppearancePreview settings={settings} theme={theme} />
    </div>
  );
}
