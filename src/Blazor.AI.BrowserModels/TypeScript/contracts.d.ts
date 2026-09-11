/** A snapshot of model metadata. Null means the browser does not expose the value. */
export interface BrowserModelInfo {
    supportsImages: boolean;
    /** Underlying model identifier, not a guessed product label. */
    name: string | null;
    /** Model download size in bytes, not memory use or required free disk space. */
    sizeBytes: number | null;
    /** Maximum session context in tokens. */
    contextWindowTokens: number | null;
    /** Tokens currently occupied, including retained conversation history. */
    contextUsageTokens: number | null;
    topK: number | null;
    temperature: number | null;
}

export interface SamplingOptions {
    topK?: number | null;
    temperature?: number | null;
}

export interface BrowserModelSamplingInfo {
    support: 'Supported' | 'Unsupported' | 'Unknown';
    defaultTopK: number | null;
    maxTopK: number | null;
    defaultTemperature: number | null;
    maxTemperature: number | null;
}

// The small subset of the Prompt API used by this library.
export interface ModelOptions extends SamplingOptions {
    expectedInputs: ({ type: 'text'; languages: string[] } | { type: 'image' })[];
    expectedOutputs: { type: 'text'; languages: string[] }[];
}

export interface ModelSession {
    clone?(options: { signal: AbortSignal }): Promise<ModelSession>;
    readonly topK?: number;
    readonly temperature?: number;
    readonly contextWindow?: number;
    readonly contextUsage?: number;
    prompt(text: string | { role: 'system' | 'user' | 'assistant'; content: string | ({ type: 'text'; value: string } | { type: 'image'; value: Blob })[] }[], options: { signal: AbortSignal; responseConstraint?: object }): Promise<string>;
    promptStreaming?(text: Parameters<ModelSession['prompt']>[0], options: { signal: AbortSignal }): ReadableStream<string>;
    destroy(): void;
}

export interface ModelApi {
    params?(): Promise<unknown>;
    availability(options: ModelOptions): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
    create(options: ModelOptions & {
        initialPrompts?: { role: 'system'; content: string }[];
        signal: AbortSignal;
        monitor(monitor: {
            addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void;
        }): void;
    }): Promise<ModelSession>;
}

export interface DotNetCallback {
    invokeMethodAsync(method: 'ReportAsync', state: string, message: string): Promise<unknown>;
}
