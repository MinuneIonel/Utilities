// Whether there's a newer Toolbox: checked once a day, or from Help > Check for Updates.
import { useCallback, useEffect, useState } from "react";
import { bridge, type UpdateInfo } from "../platform";
import { readStore, UPDATE_STORE, writeStore, type Flash } from "./flow";

export function useUpdates(flash: Flash) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    if (!bridge) return;
    const last = readStore<{ at: number }>(UPDATE_STORE, { at: 0 }).at;
    if (Date.now() - last < 24 * 3600 * 1000) return;
    void bridge.checkUpdate().then((u) => {
      writeStore(UPDATE_STORE, { at: Date.now() });
      setUpdate(u);
    });
  }, []);
  const checkUpdate = useCallback(() => {
    flash("Checking for updates…");
    bridge?.checkUpdate(true).then(
      (u) => {
        writeStore(UPDATE_STORE, { at: Date.now() });
        setUpdate(u);
        flash(u ? `Toolbox ${u.version} is out: ${u.canInstall ? "press Update in the top bar" : "download it from the link in the top bar"}.` : "Toolbox is up to date.");
      },
      () => flash("Couldn't reach GitHub to check for updates."),
    );
  }, [flash]);
  return { update, checkUpdate };
}
