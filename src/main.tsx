import React from "react";
import ReactDOM from "react-dom/client";
import "@arco-design/web-react/dist/css/arco.css";
import "./App.css";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ApplicationErrorBoundary from "./components/ApplicationErrorBoundary";
import { installGlobalDiagnostics } from "./diagnostics";
import { installSelectAllShortcuts } from "./select-all-shortcut";
import { windowViewFromContext } from "./window-view";
import { initializeAppearance } from "./appearance";
import { startHostSync } from "./host-sync";
import { showMainWindowEarly } from "./workspace-startup";

initializeAppearance();
void showMainWindowEarly();
installGlobalDiagnostics();
installSelectAllShortcuts();

const App = React.lazy(() => import("./App"));
const SettingsWindow = React.lazy(() => import("./components/SettingsWindow"));
const ShortcutGuideWindow = React.lazy(() => import("./components/ShortcutGuideWindow"));

if (isTauri()) {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
}

const view = windowViewFromContext({
  windowLabel: isTauri() ? getCurrentWindow().label : null,
});
const RootView =
  view === "settings" ? SettingsWindow : view === "shortcuts" ? ShortcutGuideWindow : App;

if (RootView === App) startHostSync();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ApplicationErrorBoundary>
      <React.Suspense fallback={null}>
        <RootView />
      </React.Suspense>
    </ApplicationErrorBoundary>
  </React.StrictMode>,
);
