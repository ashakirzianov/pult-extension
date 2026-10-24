// The thread view follows the system's colour scheme by default. In VS Code
// the system is VS Code's theme: a class on an element answers
// `prefers-color-scheme`, and a theme change fires the query's `change`. In a
// webview it is the body's (`vscode-dark`, `vscode-light`, and the
// high-contrast pair); in Pult's shell, the workbench's (`../shell/main.tsx`).

const SCHEME_QUERY = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/;

function vscodeIsDark(): boolean {
  const classes = document.body.classList;
  return classes.contains("vscode-dark") || classes.contains("vscode-high-contrast");
}

export function followVsCodeTheme(): void {
  followColorScheme(document.body, vscodeIsDark);
}

/** `prefers-color-scheme` answered by `isDark`, asked again whenever `element`'s classes change. */
export function followColorScheme(element: Element, isDark: () => boolean): void {
  const native = window.matchMedia.bind(window);
  // One list per query text, as a browser keeps them live.
  const lists = new Map<string, { readonly list: MediaQueryList; readonly notify: () => void }>();
  let dark = isDark();
  new MutationObserver(() => {
    const next = isDark();
    if (next === dark) return;
    dark = next;
    for (const { notify } of lists.values()) notify();
  }).observe(element, { attributes: true, attributeFilter: ["class"] });

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
