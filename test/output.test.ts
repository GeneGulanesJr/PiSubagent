import { describe, it, expect } from "vitest";
import {
  formatTokens,
  truncateParallelOutput,
  getDisplayItems,
  formatUsageStats,
  formatToolCall,
} from "../src/output.js";
import type { Message } from "@earendil-works/pi-ai";

describe("formatTokens", () => {
  it("returns plain number for small counts", () => {
    expect(formatTokens(500)).toBe("500");
  });
  it("formats thousands with 1 decimal", () => {
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(9500)).toBe("9.5k");
  });
  it("rounds ten-thousands to whole k", () => {
    expect(formatTokens(10500)).toBe("11k");
  });
  it("uses M for millions", () => {
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("truncateParallelOutput", () => {
  it("returns input unchanged when under cap", () => {
    expect(truncateParallelOutput("hello", 100)).toBe("hello");
  });
  it("truncates by bytes near boundary (content capped, suffix appended after)", () => {
    const input = "a".repeat(200);
    const out = truncateParallelOutput(input, 100);
    const content = out.split("\n\n")[0];
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(100);
    expect(out).toMatch(/truncated: \d+ bytes omitted/);
  });
  it("preserves content-cap with multibyte chars", () => {
    const input = "🚀".repeat(100); // each 🚀 is 4 bytes
    const out = truncateParallelOutput(input, 50);
    const content = out.split("\n\n")[0];
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(50);
  });
});

describe("getDisplayItems", () => {
  const assistantText = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "hello" }],
  };
  const assistantTool = {
    role: "assistant" as const,
    content: [
      { type: "toolCall" as const, name: "bash", arguments: { command: "ls" } },
    ],
  };
  const userMsg = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "please ls" }],
  };

  it("extracts text and toolCall from assistant messages only", () => {
    const items = getDisplayItems([assistantText, userMsg, assistantTool] as unknown as Message[]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: "text", text: "hello" });
    expect(items[1]).toEqual({ type: "toolCall", name: "bash", args: { command: "ls" } });
  });
});

describe("formatUsageStats", () => {
  const usage = {
    input: 100,
    output: 200,
    cacheRead: 50,
    cacheWrite: 0,
    cost: 0.0042,
    contextTokens: 350,
    turns: 2,
  };

  it("renders meaningful parts in order turns input output cache cost ctx model", () => {
    expect(formatUsageStats(usage, "sonnet")).toBe(
      "2 turns ↑100 ↓200 R50 $0.0042 ctx:350 sonnet",
    );
  });

  it("omits zero-value parts", () => {
    expect(
      formatUsageStats(
        { ...usage, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        undefined,
      ),
    ).toBe("↑100 ↓200");
  });
});

describe("formatToolCall", () => {
  const identity = (_color: string, text: string) => text;

  it("formats bash with $ prefix and 60-char preview", () => {
    const long = "echo " + "x".repeat(80);
    expect(formatToolCall("bash", { command: long }, identity)).toMatch(
      /^\$ echo x{55}\.\.\.$/,
    );
  });
  it("shortens home path in read", () => {
    const out = formatToolCall("read", { path: `${process.env.HOME}/file.ts` }, identity);
    expect(out).toContain("~/file.ts");
  });
  it("falls back to name + JSON preview for unknown tools", () => {
    const out = formatToolCall("custom", { foo: "bar" }, identity);
    expect(out).toContain("custom");
    expect(out).toContain("foo");
  });
});
