vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/api-key-resolver", () => ({
  resolveApiKey: vi.fn(),
}));

// NextResponse.json uses Response.json() internally; provide a working implementation
vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

import { GET } from "@/app/api/ai/anthropic/models/route";
import { auth } from "@/auth";
import { resolveApiKey } from "@/lib/api-key-resolver";

describe("GET /api/ai/anthropic/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no API key is configured", async () => {
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
    (resolveApiKey as any).mockResolvedValue(null);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toContain("Anthropic API key not configured");
  });

  it("returns model data on successful fetch", async () => {
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
    (resolveApiKey as any).mockResolvedValue("sk-ant-valid");

    const mockModels = {
      data: [{ id: "claude-sonnet-4-5" }, { id: "claude-haiku-4-5" }],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockModels,
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(mockModels);
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

  it("returns the upstream status code when Anthropic fetch fails", async () => {
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
    (resolveApiKey as any).mockResolvedValue("sk-ant-valid");
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.error).toBe("Failed to fetch Anthropic models");
  });

  it("returns 500 on unexpected fetch error", async () => {
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
    (resolveApiKey as any).mockResolvedValue("sk-ant-valid");
    global.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

    const response = await GET();

    expect(response.status).toBe(500);
  });

  it("resolves the API key using the authenticated user's id", async () => {
    (auth as any).mockResolvedValue({ user: { id: "user-42" } });
    (resolveApiKey as any).mockResolvedValue(null);

    await GET();

    expect(resolveApiKey).toHaveBeenCalledWith("user-42", "anthropic");
  });
});
