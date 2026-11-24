import { useMemo } from "react";
import { MAX_SFTP_BOOKMARKS } from "../../config-database";
import { matchRemoteDirectoryPaths, setRemotePathBookmark } from "../../sftp-utils";
import type useSftpLocations from "./useSftpLocations";

type LocationsApi = ReturnType<typeof useSftpLocations>;

interface UseSftpBookmarksOptions {
  browserPath?: string;
  browserInputPath?: string;
  hostId?: string;
  locations: LocationsApi;
}

export default function useSftpBookmarks({
  browserPath,
  browserInputPath,
  hostId,
  locations,
}: UseSftpBookmarksOptions) {
  const { commitLocation, locationForHost } = locations;
  const currentLocation = locationForHost(hostId);
  const currentPathBookmarked = Boolean(
    browserPath && currentLocation.bookmarks.includes(browserPath),
  );
  const pathSuggestions = useMemo(
    () =>
      matchRemoteDirectoryPaths(
        currentLocation.bookmarks,
        currentLocation.history,
        browserInputPath ?? "",
      ),
    [browserInputPath, currentLocation.bookmarks, currentLocation.history],
  );

  function toggleCurrentPathBookmark() {
    if (!hostId || !browserPath) return;
    const add = !currentLocation.bookmarks.includes(browserPath);
    commitLocation(hostId, (current) => ({
      ...current,
      bookmarks: setRemotePathBookmark(current.bookmarks, browserPath, add, MAX_SFTP_BOOKMARKS),
    }));
  }

  function removePathBookmark(path: string) {
    if (!hostId) return;
    commitLocation(hostId, (current) => ({
      ...current,
      bookmarks: setRemotePathBookmark(current.bookmarks, path, false, MAX_SFTP_BOOKMARKS),
    }));
  }

  function clearPathHistory() {
    if (!hostId) return;
    commitLocation(hostId, (current) => ({
      ...current,
      history: [],
    }));
  }

  return {
    clearPathHistory,
    currentLocation,
    currentPathBookmarked,
    pathSuggestions,
    removePathBookmark,
    toggleCurrentPathBookmark,
  };
}
