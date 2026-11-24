import { useCallback, useEffect, useRef, useState } from "react";
import { Message } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { loadConfiguration, MAX_SFTP_PATH_HISTORY } from "../../config-database";
import { updateSftpLocation } from "../../configuration-mutations";
import type { SftpLocationRecord } from "../../models";
import { addRemotePathHistory } from "../../sftp-utils";
import { emitProtocolEventTo, listenProtocolEvent } from "../../tauri-protocol";

const EMPTY_SFTP_LOCATION: SftpLocationRecord = {
  hostId: "",
  bookmarks: [],
  history: [],
};

function samePaths(left: string[], right: string[]) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

export default function useSftpLocations() {
  const [locations, setLocations] = useState<Record<string, SftpLocationRecord>>({});
  const locationsRef = useRef(locations);
  const persistenceErrorRef = useRef(false);
  const editVersion = useRef(0);

  const applyLocations = useCallback((records: SftpLocationRecord[]) => {
    const next = Object.fromEntries(records.map((location) => [location.hostId, location]));
    locationsRef.current = next;
    setLocations(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    function refresh() {
      const version = editVersion.current;
      void loadConfiguration()
        .then((configuration) => {
          if (!disposed && version === editVersion.current) {
            applyLocations(configuration.sftpLocations);
          }
        })
        .catch(() => {
          if (!disposed) Message.warning("无法读取 SFTP 目录记录");
        });
    }
    const listener = isTauri() ? listenProtocolEvent("configuration:changed", refresh) : undefined;
    void listener?.catch(() => undefined);
    refresh();
    return () => {
      disposed = true;
      void listener?.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [applyLocations]);

  const commitLocation = useCallback(
    (hostId: string, update: (current: SftpLocationRecord) => SftpLocationRecord) => {
      const current = locationsRef.current[hostId] ?? {
        ...EMPTY_SFTP_LOCATION,
        hostId,
      };
      const next = update(current);
      const bookmarksChanged = !samePaths(current.bookmarks, next.bookmarks);
      if (!bookmarksChanged && samePaths(current.history, next.history)) {
        return;
      }
      const updated = { ...locationsRef.current, [hostId]: next };
      locationsRef.current = updated;
      setLocations(updated);
      const version = ++editVersion.current;
      void updateSftpLocation(hostId, update)
        .then((configuration) => {
          persistenceErrorRef.current = false;
          if (version === editVersion.current) applyLocations(configuration.sftpLocations);
          if (bookmarksChanged && isTauri()) {
            void emitProtocolEventTo("main", "configuration:changed").catch(() => undefined);
          }
        })
        .catch(() => {
          if (persistenceErrorRef.current) return;
          persistenceErrorRef.current = true;
          Message.warning("SFTP 目录记录保存失败");
        });
    },
    [applyLocations],
  );

  const recordVisitedPath = useCallback(
    (hostId: string, path: string) => {
      commitLocation(hostId, (current) => ({
        ...current,
        history: addRemotePathHistory(current.history, path, MAX_SFTP_PATH_HISTORY),
      }));
    },
    [commitLocation],
  );

  const locationForHost = useCallback(
    (hostId?: string) =>
      hostId ? (locations[hostId] ?? { ...EMPTY_SFTP_LOCATION, hostId }) : EMPTY_SFTP_LOCATION,
    [locations],
  );

  return {
    commitLocation,
    locationForHost,
    recordVisitedPath,
  };
}
