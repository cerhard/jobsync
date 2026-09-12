// Mock server-only so the module can be imported in the jest (jsdom) environment
vi.mock("server-only", () => ({}));

// Mock AI SDK packages to avoid loading provider implementations in tests
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: vi.fn() }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: vi.fn() }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("ollama-ai-provider-v2", () => ({ createOllama: vi.fn() }));

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  PROVIDER_FACTORIES,
  PROVIDER_VERIFIERS,
} from "@/lib/ai/provider-registry.server";

describe("PROVIDER_VERIFIERS – openrouter", () => {
  it("returns { success: true } on a 200 OK response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await PROVIDER_VERIFIERS.openrouter("sk-or-valid");

    expect(result).toEqual({ success: true });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      { headers: { Authorization: "Bearer sk-or-valid" } },
    );
  });

  it("returns 'Invalid API key' error on 401", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const result = await PROVIDER_VERIFIERS.openrouter("sk-or-bad-key");

    expect(result).toEqual({ success: false, error: "Invalid API key" });
  });

  it("returns status-based error message on 500", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const result = await PROVIDER_VERIFIERS.openrouter("sk-or-key");

    expect(result).toEqual({
      success: false,
      error: "OpenRouter returned 500",
    });
  });

  it("returns status-based error message on 503", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const result = await PROVIDER_VERIFIERS.openrouter("sk-or-key");

    expect(result).toEqual({
      success: false,
      error: "OpenRouter returned 503",
    });
  });

  it("includes the API key in the Authorization header", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await PROVIDER_VERIFIERS.openrouter("sk-or-my-secret-key");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-or-my-secret-key" },
      }),
    );
  });
});

describe("PROVIDER_VERIFIERS – anthropic", () => {
  it("returns { success: true } on a 200 OK response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await PROVIDER_VERIFIERS.anthropic("sk-ant-valid");

    expect(result).toEqual({ success: true });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      {
        headers: {
          "x-api-key": "sk-ant-valid",
          "anthropic-version": "2023-06-01",
        },
      },
    );
  });

  it("returns 'Invalid API key' error on 401", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const result = await PROVIDER_VERIFIERS.anthropic("sk-ant-bad-key");

    expect(result).toEqual({ success: false, error: "Invalid API key" });
  });

  it("returns status-based error message on 500", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const result = await PROVIDER_VERIFIERS.anthropic("sk-ant-key");

    expect(result).toEqual({
      success: false,
      error: "Anthropic returned 500",
    });
  });
});

describe("PROVIDER_FACTORIES – anthropic", () => {
  it("uses createAnthropic with the API key and model", () => {
    const mockModelInstance = { modelId: "claude-sonnet-4-5" };
    const mockChainFn = vi.fn().mockReturnValue(mockModelInstance);
    (createAnthropic as any).mockReturnValue(mockChainFn);

    const result = PROVIDER_FACTORIES.anthropic(
      "sk-ant-apikey",
      "claude-sonnet-4-5",
    );

    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "sk-ant-apikey" });
    expect(mockChainFn).toHaveBeenCalledWith("claude-sonnet-4-5");
    expect(result).toBe(mockModelInstance);
  });
});

describe("PROVIDER_FACTORIES – openrouter", () => {
  it("uses createOpenAI with the openrouter baseURL", () => {
    const mockModelInstance = { modelId: "openai/gpt-4o" };
    const mockChainFn = vi.fn().mockReturnValue(mockModelInstance);
    (createOpenAI as any).mockReturnValue(mockChainFn);

    const result = PROVIDER_FACTORIES.openrouter(
      "sk-or-apikey",
      "openai/gpt-4o",
    );

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-or-apikey",
      baseURL: "https://openrouter.ai/api/v1",
    });
    expect(mockChainFn).toHaveBeenCalledWith("openai/gpt-4o");
    expect(result).toBe(mockModelInstance);
  });

  it("passes the model name through to the factory chain", () => {
    const mockChainFn = vi.fn().mockReturnValue({});
    (createOpenAI as any).mockReturnValue(mockChainFn);

    PROVIDER_FACTORIES.openrouter("sk-or-key", "google/gemini-flash");

    expect(mockChainFn).toHaveBeenCalledWith("google/gemini-flash");
  });

  it("passes the API key through to createOpenAI", () => {
    const mockChainFn = vi.fn().mockReturnValue({});
    (createOpenAI as any).mockReturnValue(mockChainFn);

    PROVIDER_FACTORIES.openrouter("sk-or-specific-key", "any-model");

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-or-specific-key" }),
    );
  });
});
