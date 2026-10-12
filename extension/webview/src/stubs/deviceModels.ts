// Stands in for the copy's `src/components/device/deviceModels.ts` (`../../stubs.ts`):
// no 3D models, so the device panel shows its flat stream.
import type {
  DeviceAccessorySource,
  DeviceModelSource,
} from "@t3tools/client-runtime/device/model";
import type { DevicePlatform } from "@t3tools/contracts";

import type * as Upstream from "../../t3/src/components/device/deviceModels";

export const deviceModel: typeof Upstream.deviceModel = (
  _platform: DevicePlatform,
  _name: string,
): DeviceModelSource | null => null;

export const deviceKeyboard: typeof Upstream.deviceKeyboard = (
  _platform: DevicePlatform,
  _name: string,
): DeviceAccessorySource | null => null;
