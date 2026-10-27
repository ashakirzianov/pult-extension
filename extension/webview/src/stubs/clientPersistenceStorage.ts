// Stands in for the copy's `src/clientPersistenceStorage.ts` (`../../stubs.ts`):
// the same client settings, but the composer's context window meter is always
// on. Upstream defaults it off behind a toggle on its settings page, which
// Pult does not have; a Pult setting for it would be the workbench's.
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "@t3tools/contracts";

import type * as Upstream from "../../t3/src/clientPersistenceStorage";
import { getLocalStorageItem, setLocalStorageItem } from "../../t3/src/hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

export const readBrowserClientSettings: typeof Upstream.readBrowserClientSettings = () => {
  const stored = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
  return { ...(stored ?? DEFAULT_CLIENT_SETTINGS), contextWindowMeterEnabled: true };
};

export const writeBrowserClientSettings: typeof Upstream.writeBrowserClientSettings = (
  settings: ClientSettings,
) => setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
