import { expect, test } from "bun:test";
import {
  isSingleTerminalCommand,
  remoteCompletionDirectory,
  shellCompletionWord,
  terminalCommandCompletion,
} from "./terminal-command-bar";

test("completes paths with spaces and resolves home and relative directory segments", () => {
  expect(terminalCommandCompletion("cd 'my folder/sub")).toEqual({
    firstWord: false,
    prefix: "cd ",
    token: "my folder/sub",
  });
  expect(terminalCommandCompletion("ls my\\ folder/").token).toBe("my folder/");
  expect(terminalCommandCompletion("dock").firstWord).toBe(true);
  expect(remoteCompletionDirectory("../项目/a", "/srv/current", "/home/user")).toEqual({
    directory: "/srv/项目",
    prefix: "../项目/",
    fragment: "a",
  });
  expect(remoteCompletionDirectory("~/folder/", "/srv", "/home/user")).toEqual({
    directory: "/home/user/folder",
    prefix: "/home/user/folder/",
    fragment: "",
  });
});

test("quotes shell metacharacters in completed names and blocks multiline submission", () => {
  expect(shellCompletionWord("name with ' &")).toBe("'name with '\\'' &'");
  expect(shellCompletionWord("目录/")).toBe("目录/");
  expect(isSingleTerminalCommand("pwd")).toBe(true);
  expect(isSingleTerminalCommand("pwd\nls")).toBe(false);
  expect(isSingleTerminalCommand("who\u001b")).toBe(false);
});
