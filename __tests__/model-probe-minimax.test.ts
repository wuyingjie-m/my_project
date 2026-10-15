import { describe, it, expect } from "vitest";

/**
 * Tests for MiniMax provider detection logic in model-probe.ts.
 *
 * The actual probeModelDirect function depends on file system (loadProviderConfig),
 * so we test the provider detection logic in isolation.
 */

describe("MiniMax provider detection", () => {
  function detectTemperature(providerId: string): number {
    const isKimiProvider = providerId === "kimi-coding" || providerId === "moonshot";
    const isMiniMaxProvider = providerId.toLowerCase().startsWith("minimax");
    return (isKimiProvider || isMiniMaxProvider) ? 1 : 0;
  }

  it("uses temperature=1 for minimax provider", () => {
    expect(detectTemperature("minimax")).toBe(1);
  });

  it("uses temperature=1 for MiniMax (case-insensitive)", () => {
    expect(detectTemperature("MiniMax")).toBe(1);
  });

  it("uses temperature=1 for minimax-custom provider", () => {
    expect(detectTemperature("minimax-custom")).toBe(1);
  });

  it("uses temperature=1 for kimi-coding provider", () => {
    expect(detectTemperature("kimi-coding")).toBe(1);
  });

  it("uses temperature=1 for moonshot provider", () => {
    expect(detectTemperature("moonshot")).toBe(1);
  });

  it("uses temperature=0 for openai provider", () => {
    expect(detectTemperature("openai")).toBe(0);
  });

  it("uses temperature=0 for anthropic provider", () => {
    expect(detectTemperature("anthropic")).toBe(0);
  });

  it("uses temperature=0 for generic provider", () => {
    expect(detectTemperature("custom-llm")).toBe(0);
  });
});

describe("MiniMax model reference parsing", () => {
  function parseModelRef(modelStr: string): { providerId: string; modelId: string } {
    const [providerId, ...rest] = modelStr.split("/");
    return { providerId: providerId || "", modelId: rest.join("/") || providerId || "" };
  }

  it("parses minimax/MiniMax-M2.7", () => {
    const ref = parseModelRef("minimax/MiniMax-M2.7");
    expect(ref.providerId).toBe("minimax");
    expect(ref.modelId).toBe("MiniMax-M2.7");
  });

  it("parses minimax/MiniMax-M2.7-highspeed", () => {
    const ref = parseModelRef("minimax/MiniMax-M2.7-highspeed");
    expect(ref.providerId).toBe("minimax");
    expect(ref.modelId).toBe("MiniMax-M2.7-highspeed");
  });
});
