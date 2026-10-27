// Stands in for the copy's `src/components/settings/providerDriverMeta.ts` (`../../stubs.ts`):
// the registry of the providers built into the contracts, without the provider
// packages (`@t3tools/provider-cursor` and the rest), which carry their servers'
// SDKs and are not installed here. Their providers show by name, with no icon.
import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";

import type * as Upstream from "../../t3/src/components/settings/providerDriverMeta";

export const providerClients: typeof Upstream.providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
]);
