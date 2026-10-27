// The provider packages the copy's `src/components/settings/providerDriverMeta.ts`
// imports, which are not installed here (`providerDriverMeta.ts` beside this file
// stands in for that module in the bundle); declared so the copy still typechecks.
declare module "@t3tools/provider-acp-registry/client" {
  export const acpRegistryClient: import("@t3tools/provider-core/client").ProviderClientDefinition;
}
declare module "@t3tools/provider-cursor/client" {
  export const cursorClient: import("@t3tools/provider-core/client").ProviderClientDefinition;
}
declare module "@t3tools/provider-grok/client" {
  export const grokClient: import("@t3tools/provider-core/client").ProviderClientDefinition;
}
declare module "@t3tools/provider-muse/client" {
  export const museClient: import("@t3tools/provider-core/client").ProviderClientDefinition;
}
declare module "@t3tools/provider-opencode/client" {
  export const openCodeClient: import("@t3tools/provider-core/client").ProviderClientDefinition;
}
declare module "@t3tools/provider-pi/client" {
  export const piClient: import("@t3tools/provider-core/client").ProviderClientDefinition;
}
