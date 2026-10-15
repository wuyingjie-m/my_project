import { describe, it, expect } from "vitest";

const API_KEY = process.env.MINIMAX_API_KEY;
const BASE_URL = "https://api.minimax.io/v1";

describe.skipIf(!API_KEY)("MiniMax API E2E", () => {
  it("completes basic chat with MiniMax-M2.7", async () => {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        messages: [{ role: "user", content: 'Say "test passed"' }],
        max_tokens: 20,
        temperature: 1,
      }),
    });
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.choices[0].message.content).toBeTruthy();
  }, 30000);

  it("completes chat with temperature=1 (recommended for MiniMax)", async () => {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        messages: [{ role: "user", content: "Reply with one word" }],
        max_tokens: 8,
        temperature: 1,
      }),
    });
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.choices[0].message.content).toBeTruthy();
  }, 30000);

  it("completes chat with MiniMax-M2.7-highspeed", async () => {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7-highspeed",
        messages: [{ role: "user", content: 'Reply with "ok"' }],
        max_tokens: 10,
        temperature: 1,
      }),
    });
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.choices[0].message.content).toBeTruthy();
  }, 30000);
});
