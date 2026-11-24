import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import SftpToolbar from "./SftpToolbar";

function renderToolbar() {
  const inputPathChange = mock(() => undefined);
  const navigate = mock(() => undefined);
  const toggleNameFilter = mock(() => undefined);
  return {
    inputPathChange,
    navigate,
    toggleNameFilter,
    ...render(
      <SftpToolbar
        bookmarks={[]}
        clipboardEntryCount={0}
        commands={{
          clearHistory: () => undefined,
          create: () => undefined,
          inputPathChange,
          navigate,
          openTransfers: () => undefined,
          paste: () => undefined,
          refresh: () => undefined,
          removeBookmark: () => undefined,
          toggleBookmark: () => undefined,
          toggleNameFilter,
          upload: () => undefined,
          up: () => undefined,
        }}
        connected
        currentPath="/var/log/nginx"
        currentPathBookmarked={false}
        history={[]}
        inputPath="/var/log/nginx"
        loading={false}
        nameFilterOpen={false}
        operationLoading={false}
        pathSuggestions={[]}
        ready
        transferActivityCount={0}
      />,
    ),
  };
}

test("opens the SFTP filename filter from the toolbar", () => {
  const { toggleNameFilter } = renderToolbar();
  fireEvent.click(screen.getByRole("button", { name: "筛选文件名" }));
  expect(toggleNameFilter).toHaveBeenCalledTimes(1);
});

describe("SftpToolbar path navigation", () => {
  test("navigates to the directory represented by a breadcrumb item", () => {
    const { navigate } = renderToolbar();

    fireEvent.click(screen.getByText("var"));

    expect(navigate).toHaveBeenCalledWith("/var");
  });

  test("switches the trailing blank area to the full path editor", () => {
    const { inputPathChange } = renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "编辑远程目录路径" }));

    const input = screen.getByRole("textbox", { name: "远程目录路径" });
    expect((input as HTMLInputElement).value).toBe("/var/log/nginx");
    expect(inputPathChange).toHaveBeenCalledWith("/var/log/nginx");
  });
});
