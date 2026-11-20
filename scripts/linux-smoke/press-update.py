import sys
import time

import pyatspi
from gi.repository import GLib


def press_update(pid):
    deadline = time.monotonic() + 70
    observed = set()
    while time.monotonic() < deadline:
        try:
            desktop = pyatspi.Registry.getDesktop(0)
            apps = [app for app in desktop if app is not None and app.get_process_id() == pid]
            nodes = apps[:]
            while nodes:
                node = nodes.pop()
                if node.name and len(observed) < 80:
                    observed.add((node.getRoleName(), node.name))
                if node.getRole() == pyatspi.ROLE_PUSH_BUTTON and node.name.strip() == "立即更新":
                    action = node.queryAction()
                    if action.nActions and action.doAction(0):
                        print("FineShell update button pressed.", flush=True)
                        return True
                nodes.extend(child for child in node if child is not None)
        except GLib.Error:
            # WebKit can replace the accessibility tree while the update dialog loads.
            pass
        time.sleep(1)
    print(f"Observed accessibility nodes for PID {pid}: {sorted(observed)}", file=sys.stderr)
    return False


if __name__ == "__main__" and not press_update(int(sys.argv[1])):
    sys.exit("FineShell update button was not found in the accessibility tree.")
