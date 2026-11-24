import type { ComponentProps } from "react";
import {
  ArchiveDialog,
  CreateEntryDialog,
  ExternalEditConflictDialog,
  PasteConflictDialog,
  PermissionsDialog,
  RenameDialog,
  TextEditorDialog,
} from "./SftpDialogs";
import SftpTransferDrawer from "./SftpTransferDrawer";

export interface SftpOverlayHostProps {
  archive: ComponentProps<typeof ArchiveDialog>;
  createEntry: ComponentProps<typeof CreateEntryDialog>;
  externalEditConflict: ComponentProps<typeof ExternalEditConflictDialog>;
  pasteConflict: ComponentProps<typeof PasteConflictDialog>;
  permissions: ComponentProps<typeof PermissionsDialog>;
  rename: ComponentProps<typeof RenameDialog>;
  textEditor: ComponentProps<typeof TextEditorDialog>;
  transferDrawer: ComponentProps<typeof SftpTransferDrawer>;
}

export default function SftpOverlayHost({
  archive,
  createEntry,
  externalEditConflict,
  pasteConflict,
  permissions,
  rename,
  textEditor,
  transferDrawer,
}: SftpOverlayHostProps) {
  return (
    <>
      <SftpTransferDrawer {...transferDrawer} />
      <TextEditorDialog {...textEditor} />
      <ExternalEditConflictDialog {...externalEditConflict} />
      <PasteConflictDialog {...pasteConflict} />
      <ArchiveDialog {...archive} />
      <CreateEntryDialog {...createEntry} />
      <PermissionsDialog {...permissions} />
      <RenameDialog {...rename} />
    </>
  );
}
