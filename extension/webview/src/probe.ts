// The headless load's view of a thread tab's page (`../../test/load.ts`): its
// text. Separate from `testHooks.ts`, whose imports load the thread view, so the
// entry can answer before the view loads, and when it fails to.
import { onHostMessage, post } from "./bridge.ts";

/** The page's text, answered from the start, so a page that failed to mount still answers. */
export function installProbe(): void {
  onHostMessage((message) => {
    if (message.type !== "test.probe") return;
    post({
      type: "test.result",
      requestId: message.requestId,
      text: document.body.innerText,
      error: null,
    });
  });
}
