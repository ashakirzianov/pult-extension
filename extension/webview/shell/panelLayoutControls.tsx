// Stands in for the copy's `src/components/chat/PanelLayoutControls.tsx` in
// the shell's build (`../stubs.ts`): no toggles for the thread details panel,
// the terminal drawer or the right panel at the pane's top right. In Pult
// those are the workbench's to show, not the thread view's; the panels'
// keybindings still work. Memoised as upstream's, with its props. The right
// panel's maximize control, shown beside them while that panel is open, and
// the wrappers that place them in the title bar and the thread's header go the
// same way.
import { type ComponentProps, memo } from "react";

import type * as Upstream from "../t3/src/components/chat/PanelLayoutControls";

export type PanelLayoutControlsProps = Upstream.PanelLayoutControlsProps;

export function RightPanelMaximizeControl(
  _props: ComponentProps<typeof Upstream.RightPanelMaximizeControl>,
) {
  return null;
}

export const PanelLayoutControls = memo(function PanelLayoutControls(
  _props: PanelLayoutControlsProps,
) {
  return null;
});

export function ThreadPanelHeaderControl(_props: PanelLayoutControlsProps) {
  return null;
}

export function WorkspaceTitlebarControls(
  _props: ComponentProps<typeof Upstream.WorkspaceTitlebarControls>,
) {
  return null;
}
