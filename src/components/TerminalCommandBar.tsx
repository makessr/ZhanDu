import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@arco-design/web-react";
import { diagnosticInvoke as invoke } from "../diagnostics";
import type { SftpListResult, TerminalCommandHistoryRecord } from "../models";
import type { AppSettings } from "../app-settings";
import { isSingleTerminalCommand, remoteCompletionDirectory, shellCompletionWord, terminalCommandCompletion } from "../terminal-command-bar";
import { commandErrorMessage } from "../tauri-protocol";

const SHELL_BUILTINS = ["cd", "export", "pwd", "read", "set", "type", "umask", "unset"];
const MAX_CHOICES = 24;

export default function TerminalCommandBar({
  connected,
  getDirectory,
  getHistory,
  hostId,
  inputRef,
  onFocusTerminal,
  onSubmit,
  sessionId,
  settings,
}: {
  connected: boolean;
  getDirectory: () => string;
  getHistory: () => TerminalCommandHistoryRecord[];
  hostId: string;
  inputRef: RefObject<HTMLInputElement>;
  onFocusTerminal: () => void;
  onSubmit: (command: string) => Promise<void>;
  sessionId: string;
  settings: AppSettings;
}) {
  const [draft, setDraft] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const completionRequest = useRef(0);
  const remoteCommands = useRef<Promise<[string, string[]]>>();

  useEffect(() => {
    if (!connected) {
      completionRequest.current += 1;
      remoteCommands.current = undefined;
      setChoices([]);
      setNotice("");
    }
  }, [connected]);

  function clearChoices() {
    completionRequest.current += 1;
    setChoices([]);
    setSelected(0);
    setNotice("");
  }

  function pasteChoice(value: string) {
    clearChoices();
    setDraft(value);
    inputRef.current?.focus();
  }

  function showHistory() {
    clearChoices();
    const history = getHistory()
      .filter((item) => item.hostId === hostId && isSingleTerminalCommand(item.command))
      .map((item) => item.command);
    const matches = [...new Set(history)].filter((command) =>
      !draft.trim() || command.toLowerCase().includes(draft.trim().toLowerCase()),
    );
    setChoices((matches.length ? matches : history).slice(0, MAX_CHOICES));
    if (!history.length) setNotice("当前主机还没有本地命令历史");
    inputRef.current?.focus();
  }

  function loadRemoteCommands() {
    remoteCommands.current ??= invoke<[string, string[]]>("ssh_command_names", { sessionId });
    return remoteCommands.current;
  }

  async function complete() {
    const revision = ++completionRequest.current;
    setNotice("");
    const cursor = inputRef.current?.selectionStart ?? draft.length;
    if (cursor !== draft.length) {
      setNotice("请将光标移到行尾再补全");
      return;
    }
    const { prefix, token, firstWord } = terminalCommandCompletion(draft);
    try {
      let matches: string[];
      if (firstWord && !token.includes("/") && settings.terminalCommandBarNames) {
        const [, names] = await loadRemoteCommands().catch((): [string, string[]] => ["", []]);
        matches = [...new Set([...SHELL_BUILTINS, ...names])]
          .filter((name) => name.startsWith(token))
          .slice(0, MAX_CHOICES)
          .map((name) => `${prefix}${name} `);
      } else if (settings.terminalCommandBarPaths) {
        if (/[$*?\x00-\x1f]/.test(token)) return;
        const home = token.startsWith("~/") ? (await loadRemoteCommands())[0] : "";
        const path = remoteCompletionDirectory(token, getDirectory(), home);
        if (!path) throw new Error("等待终端报告当前目录，或输入绝对路径");
        const result = await invoke<SftpListResult>("sftp_list", { sessionId, path: path.directory });
        matches = result.entries
          .filter(({ name }) => name.startsWith(path.fragment) &&
            (path.fragment.startsWith(".") || !name.startsWith(".")) && !/[\x00-\x1f\x7f]/.test(name))
          .slice(0, MAX_CHOICES)
          .map(({ name, kind }) => {
            const directory = kind === "directory";
            const safePrefix = !path.prefix && name.startsWith("-") ? "./" : path.prefix;
            return `${prefix}${shellCompletionWord(safePrefix + name + (directory ? "/" : ""))}${directory ? "" : " "}`;
          });
      } else {
        return;
      }
      if (revision !== completionRequest.current) return;
      if (matches.length === 1) pasteChoice(matches[0]);
      else {
        setChoices(matches);
        setSelected(0);
        if (!matches.length) setNotice("没有匹配的补全项");
      }
    } catch (error) {
      if (revision === completionRequest.current) setNotice(commandErrorMessage(error));
    }
  }

  async function send() {
    if (!connected || sendingRef.current || !isSingleTerminalCommand(draft)) return;
    sendingRef.current = true;
    inputRef.current?.focus({ preventScroll: true });
    clearChoices();
    setSending(true);
    try {
      await onSubmit(draft);
      setDraft("");
    } catch (error) {
      setNotice(commandErrorMessage(error));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <div className="terminal-command-bar">
      <span aria-hidden className="terminal-command-prompt">›_</span>
      <input
        aria-label="命令输入框"
        className="terminal-command-input"
        aria-busy={sending}
        disabled={!connected}
        readOnly={sending}
        maxLength={4096}
        placeholder="输入命令，回车发送"
        ref={inputRef}
        value={draft}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) clearChoices();
        }}
        onChange={(event) => {
          clearChoices();
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            if (choices.length || notice) clearChoices();
            else onFocusTerminal();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (choices.length) pasteChoice(choices[selected]);
            else void send();
          } else if (event.key === "Tab" && !event.shiftKey &&
            (settings.terminalCommandBarPaths || settings.terminalCommandBarNames)) {
            event.preventDefault();
            if (choices.length) pasteChoice(choices[selected]);
            else void complete();
          } else if (choices.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setSelected((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
          } else if (settings.terminalCommandBarHistory &&
            (event.key === "ArrowUp" || (event.altKey && event.key.toLowerCase() === "h"))) {
            event.preventDefault();
            showHistory();
          }
        }}
      />
      {settings.terminalCommandBarHistory && (
        <Button size="mini" disabled={!connected || sending} onClick={showHistory}>历史</Button>
      )}
      <Button size="mini" disabled={!connected || sending || !isSingleTerminalCommand(draft)} onClick={() => void send()}>
        发送
      </Button>
      {choices.length > 0 && (
        <div className="terminal-command-choices" aria-label="命令建议">
          {choices.map((choice, index) => (
            <button
              className={selected === index ? "is-selected" : undefined}
              key={choice}
              onClick={() => pasteChoice(choice)}
              type="button"
            >{choice}</button>
          ))}
        </div>
      )}
      {notice && <div className="terminal-command-notice" role="status">{notice}</div>}
    </div>
  );
}
