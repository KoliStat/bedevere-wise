import type { AppSettings, PersistenceService } from "./PersistenceService";
import { DuckDBService } from "./DuckDBService";
import { buildSystemPrompt, buildUserMessage } from "./agent/promptBuilder";
import { getSchemaSnapshot } from "./agent/schemaSnapshot";

export const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";
export const SUPPORTED_AGENT_MODELS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-7",
] as const;
export type AgentModel = (typeof SUPPORTED_AGENT_MODELS)[number];

export interface AgentCompletionOpts {
  duckDBService: DuckDBService;
  /** Called for each text delta as the model streams its response. */
  onProgress?: (textDelta: string) => void;
  signal?: AbortSignal;
}

export interface AgentConfig {
  apiKey: string;
  baseURL?: string;
  model: AgentModel;
}

/**
 * One-shot text-to-SQL agent. Lazy-loads the Anthropic SDK on first use so
 * the SDK chunk doesn't land in the main bundle. Reads its config from
 * `PersistenceService.loadAppSettings()` (Help → Settings → AI assistant).
 *
 * The system prompt is built from a deterministic schema snapshot and
 * marked `cache_control: ephemeral`, so repeated `.ai` calls within a 5-min
 * window hit Anthropic's prompt cache and only pay full price for the
 * (small) user prompt.
 */
export class AgentService {
  constructor(private readonly persistence: PersistenceService) {}

  /** True when the user has opted in via Settings AND a key/proxy is set. */
  public isEnabled(): boolean {
    const s = this.persistence.loadAppSettings();
    if (!s.aiEnabled) return false;
    const mode = s.aiMode ?? "direct";
    if (mode === "direct") return Boolean(s.aiApiKey && s.aiApiKey.length > 0);
    return Boolean(s.aiProxyUrl && s.aiProxyUrl.length > 0);
  }

  /**
   * Run a text-to-SQL prompt. Returns the model's full response text,
   * trimmed. Streams progress through `opts.onProgress` while the response
   * is still arriving.
   */
  public async complete(prompt: string, opts: AgentCompletionOpts): Promise<string> {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      throw new Error("`.ai` needs a prompt — try `.ai show me the top 10 penguins by body mass`.");
    }

    const settings = this.persistence.loadAppSettings();
    if (!settings.aiEnabled) {
      throw new Error("AI features are disabled. Enable them in Help (Ctrl+/) → Settings → AI assistant.");
    }
    const config = this.resolveConfig(settings);

    // Lazy-load: keeps the SDK out of the main page-load chunk. Mirrors the
    // dynamic-import pattern used for vega-embed (TabManager.ts) and
    // DuckDBDataProvider.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");

    const schema = await getSchemaSnapshot(opts.duckDBService);
    const systemPrompt = buildSystemPrompt(schema);
    const userMessage = buildUserMessage(prompt);

    const client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      dangerouslyAllowBrowser: true,
    });

    let result = "";
    try {
      const stream = client.messages.stream({
        model: config.model,
        // Generous ceiling for adaptive thinking + SQL output. Token
        // accounting includes thinking on 4.6/4.7, so leave headroom.
        max_tokens: 16000,
        // Adaptive thinking: model self-controls depth. Required for 4.6
        // family; 4.7 forbids the older `enabled+budget_tokens` shape.
        thinking: { type: "adaptive" },
        system: [
          {
            type: "text",
            text: systemPrompt,
            // Cache the system + schema prefix. Identical bytes across
            // `.ai` calls in a session → ~90% cheaper after the first hit.
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userMessage }],
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          result += event.delta.text;
          opts.onProgress?.(event.delta.text);
        }
        if (opts.signal?.aborted) {
          stream.controller.abort();
          throw new DOMException("aborted", "AbortError");
        }
      }

      const finalMessage = await stream.finalMessage();
      if (import.meta.env.DEV) {
        console.log("[AgentService] usage:", finalMessage.usage);
      }

      return stripCodeFences(result.trim());
    } catch (err) {
      // Translate SDK errors into messages the StatusBar can show as-is.
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error("AI: invalid API key. Re-check Help → Settings → AI assistant.");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error("AI: rate-limited by the provider. Wait a moment and retry.");
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(`AI: ${err.status ?? ""} ${err.message}`.trim());
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private resolveConfig(settings: AppSettings): AgentConfig {
    const mode = settings.aiMode ?? "direct";
    const model = (settings.aiModel as AgentModel) ?? DEFAULT_AGENT_MODEL;
    if (!SUPPORTED_AGENT_MODELS.includes(model as AgentModel)) {
      throw new Error(`AI: unsupported model "${model}". Pick one in Help → Settings → AI assistant.`);
    }
    if (mode === "direct") {
      const apiKey = settings.aiApiKey ?? "";
      if (apiKey.length === 0) {
        throw new Error("AI: direct mode is selected but no API key is configured. Add one in Help → Settings → AI assistant.");
      }
      return { apiKey, model };
    }
    const baseURL = settings.aiProxyUrl ?? "";
    if (baseURL.length === 0) {
      throw new Error("AI: proxy mode is selected but no proxy URL is configured. Add one in Help → Settings → AI assistant.");
    }
    // Proxy mode: the worker injects the real key; the SDK still requires a
    // non-empty placeholder, otherwise it short-circuits with an error.
    return { apiKey: "proxy", baseURL, model };
  }
}

/**
 * Defensive: if the model returns the SQL wrapped in ``` fences despite the
 * system prompt forbidding them, strip them so the editor doesn't show
 * Markdown chrome.
 */
function stripCodeFences(text: string): string {
  const fence = /^\s*```(?:sql)?\s*\n?([\s\S]*?)\n?```\s*$/i;
  const m = fence.exec(text);
  return m ? m[1].trim() : text;
}
