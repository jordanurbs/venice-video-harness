// ---------------------------------------------------------------------------
// VeniceClient -- low-level HTTP transport for the Venice AI REST API.
//
// Handles authentication, serialisation, retries with exponential back-off,
// and a simple inter-request rate-limit delay.
// ---------------------------------------------------------------------------

import type { VeniceApiError } from "./types.js";

// ---- Configuration constants ----------------------------------------------

const DEFAULT_BASE_URL = "https://api.venice.ai";
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000; // 1 s
const RATE_LIMIT_DELAY_MS = 250; // 250 ms between requests

// ---- Custom error ---------------------------------------------------------

export class VeniceRequestError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "VeniceRequestError";
    this.status = status;
    this.body = body;
  }
}

// ---- Client ---------------------------------------------------------------

export class VeniceClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  /**
   * Timestamp (epoch ms) of the last request that completed.  Used by the
   * simple rate-limiter to ensure a minimum gap between consecutive calls.
   */
  private lastRequestAt = 0;

  /**
   * @param apiKey  Bearer token for the Venice API.  Falls back to the
   *                `VENICE_API_KEY` environment variable when omitted.
   * @param baseUrl Root URL for the API (no trailing slash).
   */
  constructor(apiKey?: string, baseUrl?: string) {
    const resolvedKey = apiKey ?? process.env.VENICE_API_KEY;
    if (!resolvedKey) {
      throw new Error(
        "Venice API key is required. Pass it explicitly or set the VENICE_API_KEY environment variable.",
      );
    }
    this.apiKey = resolvedKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  // ---- Public API ---------------------------------------------------------

  /**
   * Send a POST request to `path` with a JSON body and return the parsed
   * response.
   *
   * Automatically retries on transient failures (HTTP 429 / 5xx) up to
   * {@link MAX_RETRIES} times using exponential back-off.  A small delay is
   * inserted between consecutive requests to stay within rate limits.
   *
   * @typeParam T  Expected shape of the parsed JSON response.
   * @param path   API path **including** the leading slash (e.g. `/api/v1/image/generate`).
   * @param body   Request payload -- will be JSON-stringified.
   * @returns      Parsed JSON response body.
   * @throws {VeniceRequestError} On non-retryable HTTP errors (4xx other than 429).
   * @throws {Error}              When all retry attempts are exhausted.
   */
  async post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    await this.applyRateLimit();

    const url = `${this.baseUrl}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await VeniceClient.sleep(backoff);
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        this.lastRequestAt = Date.now();

        if (response.ok) {
          return (await response.json()) as T;
        }

        // Parse the error body for diagnostics.
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = { raw: await response.text().catch(() => "") };
        }

        const apiError = errorBody as Partial<VeniceApiError>;
        const message =
          apiError?.error?.message ??
          `Venice API returned HTTP ${response.status}`;

        // Retry on rate-limit (429) and server errors (5xx).
        if (response.status === 429 || response.status >= 500) {
          lastError = new VeniceRequestError(message, response.status, errorBody);
          continue;
        }

        // Non-retryable client error -- throw immediately.
        throw new VeniceRequestError(message, response.status, errorBody);
      } catch (err) {
        // Network errors (DNS failure, connection reset, etc.) are retryable.
        if (err instanceof VeniceRequestError) {
          // Already classified above; re-throw non-retryable errors.
          if (err.status > 0 && err.status < 500 && err.status !== 429) {
            throw err;
          }
          lastError = err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    throw lastError ?? new Error("Venice API request failed after all retries.");
  }

  /**
   * POST with JSON body, receive raw binary (e.g. image/png from multi-edit).
   * Same retry/rate-limit logic as {@link post}.
   */
  async postBinary(path: string, body: Record<string, unknown>): Promise<Buffer> {
    await this.applyRateLimit();

    const url = `${this.baseUrl}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await VeniceClient.sleep(backoff);
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        this.lastRequestAt = Date.now();

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          return Buffer.from(arrayBuffer);
        }

        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = { raw: await response.text().catch(() => "") };
        }

        const apiError = errorBody as Partial<VeniceApiError>;
        const message =
          apiError?.error?.message ??
          `Venice API returned HTTP ${response.status}`;

        if (response.status === 429 || response.status >= 500) {
          lastError = new VeniceRequestError(message, response.status, errorBody);
          continue;
        }

        throw new VeniceRequestError(message, response.status, errorBody);
      } catch (err) {
        if (err instanceof VeniceRequestError) {
          if (err.status > 0 && err.status < 500 && err.status !== 429) {
            throw err;
          }
          lastError = err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    throw lastError ?? new Error("Venice API request failed after all retries.");
  }

  /**
   * POST with JSON body, receive either JSON status data or raw binary media.
   * Useful for async retrieval endpoints that return JSON while processing and
   * switch to binary once the asset is ready for download.
   */
  async postBinaryOrJson<T = unknown>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ contentType: string; value: T | Buffer }> {
    await this.applyRateLimit();

    const url = `${this.baseUrl}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await VeniceClient.sleep(backoff);
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        this.lastRequestAt = Date.now();

        if (response.ok) {
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            return {
              contentType,
              value: (await response.json()) as T,
            };
          }

          return {
            contentType,
            value: Buffer.from(await response.arrayBuffer()),
          };
        }

        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = { raw: await response.text().catch(() => "") };
        }

        const apiError = errorBody as Partial<VeniceApiError>;
        const message =
          apiError?.error?.message ??
          `Venice API returned HTTP ${response.status}`;

        if (response.status === 429 || response.status >= 500) {
          lastError = new VeniceRequestError(message, response.status, errorBody);
          continue;
        }

        throw new VeniceRequestError(message, response.status, errorBody);
      } catch (err) {
        if (err instanceof VeniceRequestError) {
          if (err.status > 0 && err.status < 500 && err.status !== 429) {
            throw err;
          }
          lastError = err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    throw lastError ?? new Error("Venice API request failed after all retries.");
  }

  /**
   * Send a chat completion request with multimodal content (text + images).
   * Uses the OpenAI-compatible chat completions endpoint.
   */
  async chatWithVision(
    model: string,
    systemPrompt: string,
    imageDataUris: string[],
    userPrompt: string,
  ): Promise<string> {
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    for (const uri of imageDataUris) {
      content.push({ type: 'image_url', image_url: { url: uri } });
    }
    content.push({ type: 'text', text: userPrompt });

    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content },
      ],
      max_tokens: 2000,
      temperature: 0.3,
    };

    const response = await this.post<{
      choices: Array<{ message: { content: string } }>;
    }>('/api/v1/chat/completions', body as unknown as Record<string, unknown>);

    return response.choices?.[0]?.message?.content ?? '';
  }

  // ---- Internals ----------------------------------------------------------

  /**
   * Ensure at least {@link RATE_LIMIT_DELAY_MS} ms have elapsed since the
   * previous request completed.
   */
  private async applyRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < RATE_LIMIT_DELAY_MS) {
      await VeniceClient.sleep(RATE_LIMIT_DELAY_MS - elapsed);
    }
  }

  /** Promise-based sleep helper. */
  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
