// The headless load's handle on a thread tab (`../../test/load.ts`), outside
// production only: the page's text, and a message sent the way a user sends
// one, through the composer's own submit.
import type { AnyRouter } from "@tanstack/react-router";

import { type ComposerThreadTarget, useComposerDraftStore } from "../t3/src/composerDraftStore";
import { resolveThreadRouteTarget } from "../t3/src/threadRoutes";
import { onHostMessage, post } from "./bridge.ts";

const SUBMIT_WAIT_MS = 30_000;

function composerTarget(router: AnyRouter): ComposerThreadTarget {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  if (target === null) throw new Error("The tab shows no thread.");
  return target.kind === "server" ? target.threadRef : target.draftId;
}

/** Resolves once the composer's submit button can be pressed. */
function enabledSubmit(): Promise<HTMLButtonElement> {
  return new Promise((resolve, reject) => {
    const find = () =>
      document.querySelector<HTMLButtonElement>(
        'form:has([data-testid="composer-editor"]) button[type="submit"]:not([disabled])',
      );
    const found = find();
    if (found !== null) return resolve(found);
    const observer = new MutationObserver(() => {
      const button = find();
      if (button === null) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(button);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("The composer never offered to send."));
    }, SUBMIT_WAIT_MS);
  });
}

export function installTestHooks(router: AnyRouter): void {
  onHostMessage((message) => {
    if (message.type === "test.send") {
      const { requestId, text } = message;
      void (async () => {
        useComposerDraftStore.getState().setPrompt(composerTarget(router), text);
        const button = await enabledSubmit();
        button.form?.requestSubmit(button);
      })().then(
        () => post({ type: "test.result", requestId, text: "", error: null }),
        (error: unknown) =>
          post({ type: "test.result", requestId, text: "", error: String(error) }),
      );
    }
  });
}
