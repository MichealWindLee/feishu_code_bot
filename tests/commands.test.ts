import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/bot/commands.js";

describe("parseCommand", () => {
  it("parses supported commands", () => {
    expect(parseCommand("/help")).toEqual({ type: "help" });
    expect(parseCommand("/projects")).toEqual({ type: "projects" });
    expect(parseCommand("/use bot")).toEqual({ type: "use", projectKey: "bot" });
    expect(parseCommand("/end")).toEqual({ type: "end" });
    expect(parseCommand("/close")).toEqual({ type: "end" });
    expect(parseCommand("/exit")).toEqual({ type: "end" });
    expect(parseCommand("/approve abc123")).toEqual({ type: "approve", approvalId: "abc123" });
    expect(parseCommand("/deny abc123")).toEqual({ type: "deny", approvalId: "abc123" });
  });

  it("ignores ordinary text and incomplete commands", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("/use")).toBeNull();
    expect(parseCommand("/approve")).toBeNull();
    expect(parseCommand("/unknown")).toBeNull();
  });
});
