// Cloned from @earendil-works/pi-ai (OpenAI Responses transport).
// Source (version-pinned to match the cloned logic):
//   https://raw.githubusercontent.com/earendil-works/pi-ai/v0.84.2/src/api/openai-responses.ts
// This file is a near-verbatim copy of pi-agent's openai-responses module.
// The ONLY provider-specific change is `zenFetch` (below): a module-scoped
// fetch passed to the OpenAI client's `new OpenAI({ fetch })` so the opencode
// User-Agent required to unlock the free tier is forced on zen requests.
// No global fetch monkey-patch; the override is scoped to this client only.
import OpenAI from "openai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "@earendil-works/pi-ai/api/github-copilot-headers";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";

// ---- inlined dependencies (pi-ai utils without package subpath exports, verbatim) ----

// ===== from @earendil-works/pi-ai/utils/deferred-tools.js (verbatim, no package subpath export) =====
const identityToolName = (name) => name;
/** Split current tools into prefix and transcript-loaded definitions. */
export function splitDeferredTools(context, enabled, normalizeName = identityToolName) {
    const uniqueTools = new Map();
    for (const tool of context.tools ?? [])
        uniqueTools.set(normalizeName(tool.name), tool);
    if (!enabled)
        return { immediate: [...uniqueTools.values()], deferred: new Map() };
    const deferredNames = new Set();
    const usedNames = new Set();
    for (const message of context.messages) {
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "toolCall")
                    usedNames.add(normalizeName(block.name));
            }
        }
        else if (message.role === "toolResult") {
            for (const name of message.addedToolNames ?? []) {
                const normalizedName = normalizeName(name);
                if (!usedNames.has(normalizedName))
                    deferredNames.add(normalizedName);
            }
        }
    }
    const immediate = [];
    const deferred = new Map();
    for (const [name, tool] of uniqueTools) {
        if (deferredNames.has(name))
            deferred.set(name, tool);
        else
            immediate.push(tool);
    }
    return { immediate, deferred };
}
//# sourceMappingURL=deferred-tools.js.map

// ===== from @earendil-works/pi-ai/utils/error-body.js (verbatim, no package subpath export) =====
// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.
export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;
export function normalizeProviderError(error) {
    if (!(error instanceof Error)) {
        return { message: safeJsonStringify(error), messageCarriesBody: false };
    }
    const sdkError = error;
    const status = extractStatus(sdkError);
    const body = extractBody(sdkError);
    const messageCarriesBody = body === undefined || error.message.includes(body);
    return {
        status,
        body,
        message: error.message,
        messageCarriesBody,
    };
}
/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error) {
    if (typeof error.statusCode === "number")
        return error.statusCode;
    if (typeof error.status === "number")
        return error.status;
    if (typeof error.$metadata?.httpStatusCode === "number")
        return error.$metadata.httpStatusCode;
    if (typeof error.$response?.statusCode === "number")
        return error.$response.statusCode;
    return undefined;
}
/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
 */
function extractBody(error) {
    const bodyText = pickBodyText(error);
    if (bodyText === undefined)
        return undefined;
    const trimmed = bodyText.trim();
    if (trimmed.length === 0)
        return undefined;
    return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}
function pickBodyText(error) {
    if (typeof error.body === "string")
        return error.body;
    if (isPlainNonEmptyObject(error.error))
        return safeJsonStringify(error.error);
    const responseBody = error.$response?.body;
    if (typeof responseBody === "string")
        return responseBody;
    if (isReadableStreamLike(responseBody))
        return undefined;
    if (isPlainNonEmptyObject(responseBody))
        return safeJsonStringify(responseBody);
    return undefined;
}
function isReadableStreamLike(value) {
    return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}
/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
function isPlainNonEmptyObject(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
        return false;
    return Object.keys(value).length > 0;
}
/**
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm, prefix) {
    if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
        return prefix !== undefined && norm.status !== undefined
            ? `${prefix} (${norm.status}): ${norm.message}`
            : norm.message;
    }
    return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}
export function truncateErrorText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}
export function safeJsonStringify(value) {
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? String(value) : serialized;
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=error-body.js.map

// ===== from @earendil-works/pi-ai/utils/headers.js (verbatim, no package subpath export) =====
export function headersToRecord(headers) {
    const result = {};
    for (const [key, value] of headers.entries()) {
        result[key] = value;
    }
    return result;
}
export function providerHeadersToRecord(headers) {
    if (!headers)
        return undefined;
    const result = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value !== null)
            result[key] = value;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
//# sourceMappingURL=headers.js.map

// ===== from @earendil-works/pi-ai/utils/pi-user-agent.js (verbatim, no package subpath export) =====
function loadNodeOs() {
    if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
        return null;
    }
    return process.getBuiltinModule?.("node:os") ?? null;
}
// Keep runtime OS loading browser-safe. A top-level runtime import of node:os breaks browser/Vite builds.
const nodeOs = loadNodeOs();
export function getPiUserAgent() {
    return nodeOs ? `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : "pi (browser)";
}
//# sourceMappingURL=pi-user-agent.js.map

// ===== from @earendil-works/pi-ai/utils/provider-env.js (verbatim, no package subpath export) =====
let procEnvCache = null;
/**
 * Fallback for https://github.com/oven-sh/bun/issues/27802.
 * Bun compiled binaries can expose an empty process.env inside Linux sandboxes
 * even though /proc/self/environ contains the environment.
 *
 * This intentionally duplicates restoreSandboxEnv() in
 * packages/coding-agent/src/bun/restore-sandbox-env.ts. The ai package can be
 * used directly, without going through that entrypoint, so provider env lookup
 * must not depend on process.env having been patched.
 */
function getBunSandboxEnvValue(name) {
    if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) {
        return undefined;
    }
    if (procEnvCache === null) {
        procEnvCache = new Map();
        try {
            const { readFileSync } = require("node:fs");
            const data = readFileSync("/proc/self/environ", "utf-8");
            for (const entry of data.split("\0")) {
                const idx = entry.indexOf("=");
                if (idx > 0) {
                    procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
                }
            }
        }
        catch {
            // /proc/self/environ may not exist or may not be readable.
        }
    }
    return procEnvCache.get(name);
}
/**
 * Resolve a provider env value from scoped overrides, normal process.env, then
 * the duplicated Bun sandbox fallback for direct pi-ai consumers.
 */
export function getProviderEnvValue(name, env) {
    return (env?.[name] ||
        (typeof process !== "undefined" ? process.env[name] : undefined) ||
        getBunSandboxEnvValue(name) ||
        undefined);
}
//# sourceMappingURL=provider-env.js.map

// ===== from @earendil-works/pi-ai/utils/provider-retry.js (verbatim, no package subpath export) =====
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
function isProviderError(error) {
    if (!(error instanceof Error) || !("status" in error) || !("headers" in error))
        return false;
    return ((error.status === undefined || typeof error.status === "number") &&
        (error.headers === undefined || error.headers instanceof Headers));
}
/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
function isRetryableProviderError(error) {
    const shouldRetry = error.headers?.get("x-should-retry");
    if (shouldRetry === "true")
        return true;
    if (shouldRetry === "false")
        return false;
    if (error.status === undefined)
        return true;
    return (error.status === 408 ||
        error.status === 409 ||
        error.status === 429 ||
        (typeof error.status === "number" && error.status >= 500));
}
function validateServerRetryDelayMs(delayMs, maxRetryDelayMs, providerErrorMessage) {
    const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    if (maxDelayMs > 0 && delayMs > maxDelayMs) {
        throw new Error(`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`);
    }
    return delayMs;
}
function getRetryDelayMs(error, retryIndex, maxRetryDelayMs) {
    const retryAfterMs = error.headers?.get("retry-after-ms");
    if (retryAfterMs) {
        const value = Number.parseFloat(retryAfterMs);
        if (!Number.isNaN(value))
            return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
    }
    const retryAfter = error.headers?.get("retry-after");
    if (retryAfter) {
        const seconds = Number.parseFloat(retryAfter);
        const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
        return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
    }
    const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
    return exponentialDelay * (1 - Math.random() * 0.25);
}
function createAbortError() {
    const error = new Error("Request aborted");
    error.name = "AbortError";
    return error;
}
function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timeout);
            reject(createAbortError());
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, Math.max(0, ms));
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export async function retryProviderRequest(request, options = {}) {
    const maxRetries = options.maxRetries ?? 0;
    let retriesRemaining = maxRetries;
    for (;;) {
        try {
            // Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
            return await request();
        }
        catch (error) {
            if (options.signal?.aborted)
                throw createAbortError();
            if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error))
                throw error;
            const retryIndex = maxRetries - retriesRemaining;
            retriesRemaining--;
            await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
        }
    }
}
//# sourceMappingURL=provider-retry.js.map

// ===== zenFetch (provider-specific; see header comment) =====
// It captures a *reference* to the ambient fetch (never mutates globalThis.fetch)
// and, solely for requests targeting opencode's zen endpoint, forces the
// `user-agent` to the opencode identity required to unlock the free tier. Every
// other request is passed through untouched. This keeps the UA override scoped
// to this provider's transport and out of the global fetch path.
const zenNativeFetch = globalThis.fetch;
// Opencode identity required to unlock the free tier; set via installZenUserAgent.
let zenUserAgent = undefined;
function installZenUserAgent(ua) {
    zenUserAgent = ua;
}
const zenFetch = (input, init) => {
    let url;
    if (typeof input === 'string')
        url = input;
    else if (input instanceof URL)
        url = input.href;
    else if (input instanceof Request)
        url = input.url;
    else
        url = String(input);
    if (url.includes('opencode.ai/zen') && zenUserAgent) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set('user-agent', zenUserAgent);
        return zenNativeFetch(input, { ...init, headers });
    }
    return zenNativeFetch(input, init);
};
export { installZenUserAgent };
// ===== @earendil-works/pi-ai/api/openai-responses.js (verbatim, zenFetch injected) =====
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
function hasHeader(headers, name) {
    if (!headers)
        return false;
    const expected = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === expected && value !== null && value.trim().length > 0)
            return true;
    }
    return false;
}
function getClientApiKey(provider, apiKey, headers) {
    if (apiKey)
        return apiKey;
    if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization"))
        return "unused";
    throw new Error(`No API key for provider: ${provider}`);
}
function detectSessionAffinityFormat(model) {
    return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}
/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention, env) {
    if (cacheRetention) {
        return cacheRetention;
    }
    if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
        return "long";
    }
    return "short";
}
function getCompat(model) {
    return {
        supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
        sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
        supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
        supportsStrictMode: model.compat?.supportsStrictMode ?? false,
        supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
        supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
        supportsToolSearch: model.compat?.supportsToolSearch ?? false,
        supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
    };
}
function getPromptCacheRetention(compat, cacheRetention) {
    return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}
function formatOpenAIResponsesError(error) {
    return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}
/**
 * Generate function for OpenAI Responses API
 */
export const stream = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    // Start async processing
    (async () => {
        const output = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "pending",
            timestamp: Date.now(),
        };
        try {
            // Create OpenAI client
            const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
            const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
            const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
            const compat = getCompat(model);
            const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools);
            const client = createClient(model, context, apiKey, options?.headers, options?.fetch, cacheSessionId);
            let params = buildParams(model, context, options, compat, grammarToolInputProperties);
            const nextParams = await options?.onPayload?.(params, model);
            if (nextParams !== undefined) {
                params = nextParams;
            }
            const requestOptions = {
                ...(options?.signal ? { signal: options.signal } : {}),
                ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
                maxRetries: 0,
            };
            const { data: openaiStream, response } = await retryProviderRequest(() => client.responses.create(params, requestOptions).withResponse(), {
                maxRetries: options?.maxRetries,
                maxRetryDelayMs: options?.maxRetryDelayMs,
                signal: options?.signal,
            });
            await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
            stream.push({ type: "start", partial: output });
            await processResponsesStream(openaiStream, output, stream, model, {
                serviceTier: options?.serviceTier,
                grammarToolInputProperties,
                applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
            });
            if (options?.signal?.aborted) {
                throw new Error("Request was aborted");
            }
            if (output.stopReason === "pending") {
                throw new Error("OpenAI Responses stream ended without a stop reason");
            }
            if (output.stopReason === "aborted" || output.stopReason === "error") {
                throw new Error(output.errorMessage || "An unknown error occurred");
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
            for (const block of output.content) {
                delete block.index;
                // Streaming scratch buffers are only used during parsing; never persist them.
                delete block.partialJson;
                delete block.customInput;
            }
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = formatOpenAIResponsesError(error);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();
    return stream;
};
export const streamSimple = (model, context, options) => {
    getClientApiKey(model.provider, options?.apiKey, options?.headers);
    const base = {
        ...buildBaseOptions(model, context, options, options?.apiKey),
        toolChoice: options?.toolChoice,
    };
    const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
    const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
    return stream(model, context, {
        ...base,
        reasoningEffort,
    });
};
function createClient(model, context, apiKey, optionsHeaders, _fetch, sessionId) {
    const compat = getCompat(model);
    const headers = { "User-Agent": getPiUserAgent(), ...model.headers };
    if (model.provider === "github-copilot") {
        const hasImages = hasCopilotVisionInput(context.messages);
        const copilotHeaders = buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages,
        });
        Object.assign(headers, copilotHeaders);
    }
    if (sessionId) {
        if (compat.sessionAffinityFormat === "openrouter") {
            headers["x-session-id"] = sessionId;
        }
        else {
            if (compat.sessionAffinityFormat === "openai") {
                headers.session_id = sessionId;
            }
            headers["x-client-request-id"] = sessionId;
        }
    }
    // Merge options headers last so they can override defaults
    if (optionsHeaders) {
        Object.assign(headers, optionsHeaders);
    }
    return new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        fetch: zenFetch,
        defaultHeaders: headers,
    });
}
function buildParams(model, context, options, compat = getCompat(model), grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools)) {
    const deferredToolsMode = compat.supportsAdditionalTools
        ? "additional-tools"
        : compat.supportsToolSearch
            ? "tool-search"
            : undefined;
    const toolPlacement = splitDeferredTools(context, deferredToolsMode !== undefined);
    const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
        grammarToolInputProperties,
        deferredTools: toolPlacement.deferred,
        deferredToolsMode,
        toolOptions: {
            supportsStrictMode: compat.supportsStrictMode,
            supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
        },
    });
    const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
    const disableImplicitPromptCache = cacheRetention === "none" && compat.supportsExplicitPromptCacheMode;
    const params = {
        model: model.id,
        input: messages,
        stream: true,
        prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
        prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
        prompt_cache_options: disableImplicitPromptCache ? { mode: "explicit" } : undefined,
        store: false,
    };
    if (options?.maxTokens) {
        params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
    }
    if (options?.temperature !== undefined) {
        params.temperature = options?.temperature;
    }
    if (options?.serviceTier !== undefined) {
        params.service_tier = options.serviceTier;
    }
    if (toolPlacement.immediate.length > 0) {
        params.tools = convertResponsesTools(toolPlacement.immediate, {
            supportsStrictMode: compat.supportsStrictMode,
            supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
        });
    }
    if (options?.toolChoice !== undefined) {
        params.tool_choice = options.toolChoice;
    }
    if (model.reasoning) {
        if (options?.reasoningEffort || options?.reasoningSummary) {
            const effort = options?.reasoningEffort
                ? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
                : "medium";
            params.reasoning = {
                effort: effort,
                summary: options?.reasoningSummary || "auto",
            };
            params.include = ["reasoning.encrypted_content"];
        }
        else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
            params.reasoning = {
                effort: (model.thinkingLevelMap?.off ?? "none"),
            };
        }
        if (model.provider === "xai")
            params.include = ["reasoning.encrypted_content"];
    }
    // Last so custom keys override the named request fields.
    if (options?.samplingParams) {
        Object.assign(params, options.samplingParams);
    }
    return params;
}
function getServiceTierCostMultiplier(model, serviceTier) {
    switch (serviceTier) {
        case "flex":
            return 0.5;
        case "priority":
            return model.id === "gpt-5.5" ? 2.5 : 2;
        default:
            return 1;
    }
}
function applyServiceTierPricing(usage, serviceTier, model) {
    const multiplier = getServiceTierCostMultiplier(model, serviceTier);
    if (multiplier === 1)
        return;
    usage.cost.input *= multiplier;
    usage.cost.output *= multiplier;
    usage.cost.cacheRead *= multiplier;
    usage.cost.cacheWrite *= multiplier;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
//# sourceMappingURL=openai-responses.js.map