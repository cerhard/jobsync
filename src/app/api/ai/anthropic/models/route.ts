import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/api-key-resolver";
import { log } from "@/lib/telemetry";

export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    const apiKey = await resolveApiKey(userId, "anthropic");

    if (!apiKey) {
      return NextResponse.json(
        { error: "Anthropic API key not configured. Add your key in API Keys settings." },
        { status: 401 }
      );
    }

    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch Anthropic models" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    log.error("Error fetching models", {
      provider: "anthropic",
      error: String(error),
    });
    return NextResponse.json(
      { error: "Failed to fetch Anthropic models" },
      { status: 500 }
    );
  }
}
