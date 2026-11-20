type WorkspaceIconName =
  | "activity"
  | "bot"
  | "download"
  | "folder"
  | "folder-open"
  | "folder-plus"
  | "history"
  | "keyboard"
  | "layout-dashboard"
  | "menu"
  | "monitor"
  | "panel-bottom"
  | "server"
  | "server-rack"
  | "settings"
  | "terminal";

export default function WorkspaceIcon({ name }: { name: WorkspaceIconName }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className="workspace-icon"
      draggable={false}
      height={18}
      src={`/icons/kubai/${name}.svg`}
      width={18}
    />
  );
}
