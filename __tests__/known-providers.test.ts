import { describe, it, expect } from "vitest";
import { getKnownProvider, enrichModelMeta } from "../lib/known-providers";

describe("getKnownProvider", () => {
  it("returns MiniMax provider metadata for exact match", () => {
    const provider = getKnownProvider("minimax");
    expect(provider).not.toBeNull();
    expect(provider!.displayName).toBe("MiniMax");
    expect(provider!.api).toBe("openai-completions");
    expect(provider!.baseUrl).toBe("https://api.minimax.io/v1");
  });

  it("returns MiniMax provider metadata for case-insensitive match", () => {
    const provider = getKnownProvider("MiniMax");
    expect(provider).not.toBeNull();
    expect(provider!.displayName).toBe("MiniMax");
  });

  it("returns null for unknown provider", () => {
    const provider = getKnownProvider("unknown-provider");
    expect(provider).toBeNull();
  });

  it("includes both MiniMax models", () => {
    const provider = getKnownProvider("minimax");
    expect(provider!.models).toHaveLength(2);
    const ids = provider!.models.map((m) => m.id);
    expect(ids).toContain("MiniMax-M2.7");
    expect(ids).toContain("MiniMax-M2.7-highspeed");
  });

  it("MiniMax models have correct contextWindow and maxTokens", () => {
    const provider = getKnownProvider("minimax");
    for (const model of provider!.models) {
      expect(model.contextWindow).toBe(204800);
      expect(model.maxTokens).toBe(192000);
      expect(model.reasoning).toBe(false);
      expect(model.input).toEqual(["text"]);
    }
  });
});

describe("enrichModelMeta", () => {
  it("fills in missing metadata for known MiniMax model", () => {
    const model = { id: "MiniMax-M2.7", name: "MiniMax-M2.7" };
    const enriched = enrichModelMeta("minimax", model);
    expect(enriched.contextWindow).toBe(204800);
    expect(enriched.maxTokens).toBe(192000);
    expect(enriched.reasoning).toBe(false);
    expect(enriched.input).toEqual(["text"]);
  });

  it("does not override existing metadata", () => {
    const model = {
      id: "MiniMax-M2.7",
      name: "Custom Name",
      contextWindow: 100000,
      maxTokens: 50000,
      reasoning: true,
      input: ["text", "image"],
    };
    const enriched = enrichModelMeta("minimax", model);
    expect(enriched.name).toBe("Custom Name");
    expect(enriched.contextWindow).toBe(100000);
    expect(enriched.maxTokens).toBe(50000);
    expect(enriched.reasoning).toBe(true);
    expect(enriched.input).toEqual(["text", "image"]);
  });

  it("fills in undefined fields while keeping defined ones", () => {
    const model = {
      id: "MiniMax-M2.7-highspeed",
      name: "Highspeed",
      contextWindow: undefined as unknown as number,
      maxTokens: 50000,
    };
    const enriched = enrichModelMeta("minimax", model);
    expect(enriched.name).toBe("Highspeed");
    expect(enriched.contextWindow).toBe(204800);
    expect(enriched.maxTokens).toBe(50000);
  });

  it("returns model unchanged for unknown provider", () => {
    const model = { id: "gpt-4", name: "GPT-4" };
    const enriched = enrichModelMeta("openai", model);
    expect(enriched).toEqual(model);
  });

  it("returns model unchanged for unknown model in known provider", () => {
    const model = { id: "unknown-model", name: "Unknown" };
    const enriched = enrichModelMeta("minimax", model);
    expect(enriched).toEqual(model);
  });

  it("performs case-insensitive model ID matching", () => {
    const model = { id: "minimax-m2.7" };
    const enriched = enrichModelMeta("minimax", model);
    expect(enriched.contextWindow).toBe(204800);
  });
});
