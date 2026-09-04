/** Split current tools into prefix and transcript-loaded definitions. */
export function splitDeferredTools(context: any, enabled: any, normalizeName?: (name: any) => any): {
    immediate: any[];
    deferred: Map<any, any>;
};
export function normalizeProviderError(error: any): {
    message: string;
    messageCarriesBody: boolean;
    status?: undefined;
    body?: undefined;
} | {
    status: any;
    body: any;
    message: string;
    messageCarriesBody: boolean;
};
/**
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: any, prefix: any): any;
export function truncateErrorText(text: any, maxChars: any): any;
export function safeJsonStringify(value: any): string;
export function headersToRecord(headers: any): {};
export function providerHeadersToRecord(headers: any): {} | undefined;
export function getPiUserAgent(): string;
/**
 * Resolve a provider env value from scoped overrides, normal process.env, then
 * the duplicated Bun sandbox fallback for direct pi-ai consumers.
 */
export function getProviderEnvValue(name: any, env: any): any;
/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export function retryProviderRequest(request: any, options?: {}): Promise<any>;
export const MAX_PROVIDER_ERROR_BODY_CHARS: 4000;
export function stream(model: any, context: any, options: any): AssistantMessageEventStream;
export function streamSimple(model: any, context: any, options: any): AssistantMessageEventStream;
export function installZenUserAgent(ua: any): void;
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
