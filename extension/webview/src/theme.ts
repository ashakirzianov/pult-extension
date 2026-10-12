// The thread view follows the system's colour scheme by default. In a webview
// the system is VS Code: the body's theme class (`vscode-dark`, `vscode-light`,
// and the high-contrast pair) answers `prefers-color-scheme`, and a theme
// change fires the query's `change`.

const SCHEME_QUERY = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/;

function vscodeIsDark(): boolean {
  const classes = document.body.classList;
  return classes.contains("vscode-dark") || classes.contains("vscode-high-contrast");
}

export function followVsCodeTheme(): void {
  const native = window.matchMedia.bind(window);
  // One list per query text, as a browser keeps them live.
  const lists = new Map<string, { readonly list: MediaQueryList; readonly notify: () => void }>();
  let dark = vscodeIsDark();
  new MutationObserver(() => {
    const next = vscodeIsDark();
    if (next === dark) return;
    dark = next;
    for (const { notify } of lists.values()) notify();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  window.matchMedia = (media: string): MediaQueryList => {
    const scheme = SCHEME_QUERY.exec(media)?.[1];
    if (scheme === undefined) return native(media);
    const existing = lists.get(media);
    if (existing !== undefined) return existing.list;
    const target = new EventTarget();
    let onchange: MediaQueryList["onchange"] = null;
    const list = Object.assign(target, {
      media,
      get matches() {
        return dark === (scheme === "dark");
      },
      get onchange() {
        return onchange;
      },
      set onchange(listener: MediaQueryList["onchange"]) {
        onchange = listener;
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) =>
        target.addEventListener("change", listener as EventListener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) =>
        target.removeEventListener("change", listener as EventListener),
    }) as unknown as MediaQueryList;
    const notify = () => {
      const event = Object.assign(new Event("change"), { media, matches: list.matches });
      target.dispatchEvent(event);
      onchange?.call(list, event as MediaQueryListEvent);
    };
    lists.set(media, { list, notify });
    return list;
  };
}
