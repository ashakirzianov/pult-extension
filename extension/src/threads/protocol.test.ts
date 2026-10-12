import { describe, expect, it } from "vite-plus/test";

import { isPageCommand } from "./protocol.ts";

describe("isPageCommand", () => {
  it("lets a page run Connect, and no other command", () => {
    expect(isPageCommand("pult.connect")).toBe(true);
    expect(isPageCommand("workbench.action.terminal.sendSequence")).toBe(false);
    expect(isPageCommand({ command: "pult.connect" })).toBe(false);
  });
});
