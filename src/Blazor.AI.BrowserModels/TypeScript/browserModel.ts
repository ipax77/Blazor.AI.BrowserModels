// Generated JavaScript is checked in for .NET consumers. Edit TypeScript and run npm run build.
import type { BrowserModelInfo, BrowserModelSamplingInfo, SamplingOptions, DotNetCallback, ModelApi, ModelOptions, ModelSession } from './contracts.js';
import { createAttachments, type Attachments } from './attachments.js';

const options: ModelOptions = {
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }]
};

export function attach(button: HTMLButtonElement, callback: DotNetCallback, settings: SamplingOptions = {}, panel: HTMLElement | null = null, enableImages = false,
    systemPrompt: string | null = null, systemPromptInput: HTMLTextAreaElement | null = null, stateless = false) {
    if (stateless && (systemPrompt?.trim() || systemPromptInput))
        throw new Error('Stateless sessions take system instructions from agent messages.');
    const model = (globalThis as typeof globalThis & { LanguageModel?: ModelApi }).LanguageModel;
    let session: ModelSession | undefined;
    let initializing = false;
    let generating = false;
    let disposed = false;
    let initialization: AbortController | undefined;
    let generation: AbortController | undefined;
    let activeRequestId: string | undefined;
    let activeClone: ModelSession | undefined;
    let lastProgress = -1;
    let lastProgressTime = 0;
    let sessionOptions = options;
    let supportsImages = false;
    let imageDiscoveryComplete = !enableImages;
    const attachments = new Set<Attachments>();
    // No eviction: old history must replay exactly or fail explicitly.
    const retained = new Map<string, File[]>();
    let retainedCount = 0;
    let retainedBytes = 0;
    let nextImageId = 0;
    let imageNamespace: string | undefined;
    function retainImages(images: Attachments): string | null {
        if (disposed || !session) throw new Error('Initialize the browser model first.');
        if (!stateless) throw new Error('Image retention requires Stateless session mode.');
        if (generating) throw new Error('A reply is already being generated.');
        if (!attachments.has(images)) throw new Error('These attachments do not belong to this session.');
        const files = images.snapshot();
        if (!files.length) return null;
        if (!supportsImages) throw new Error('Image attachments are unsupported in this session.');
        const bytes = files.reduce((total, file) => total + file.size, 0);
        if (retainedCount + files.length > 16 || retainedBytes + bytes > 64 * 1024 * 1024)
            throw new Error('Image history limit reached (16 images / 64 MiB). Start a new conversation.');
        imageNamespace ??= globalThis.crypto.randomUUID();
        const id = `${imageNamespace}:${++nextImageId}`;
        retained.set(id, files);
        retainedCount += files.length;
        retainedBytes += bytes;
        images.clear(); // Revoke previews; keep original File objects without copying bytes.
        return id;
    }
    function clearImages() {
        if (generating) throw new Error('A reply is already being generated.');
        retained.clear();
        retainedCount = retainedBytes = 0;
        for (const item of attachments) item.clear();
    }
    const topKInput = panel?.querySelector<HTMLInputElement>('input[name="topK"]');
    const temperatureInput = panel?.querySelector<HTMLInputElement>('input[name="temperature"]');
    const fields = panel?.querySelector<HTMLFieldSetElement>('fieldset');
    const samplingMessage = panel?.querySelector<HTMLElement>('[data-sampling-status]');
    // Capture initialization configuration once. Input edits stay entirely in the browser.
    const configured = { topK: settings.topK, temperature: settings.temperature };
    if (topKInput) topKInput.value = settings.topK?.toString() ?? '';
    if (temperatureInput) temperatureInput.value = settings.temperature?.toString() ?? '';
    if (systemPromptInput) systemPromptInput.value = systemPrompt ?? '';
    let samplingInfo = emptySamplingInfo('Unknown');
    function updateControls() {
        if (fields) fields.disabled = disposed || initializing || !!session || samplingInfo.support !== 'Supported';
        if (systemPromptInput) systemPromptInput.disabled = disposed || initializing || !!session;
    }
    updateControls();
    async function discoverSampling(): Promise<BrowserModelSamplingInfo> {
        if (!globalThis.isSecureContext || typeof model?.params !== 'function') return emptySamplingInfo('Unsupported');
        try {
            const result = await model.params();
            if (result === null) return emptySamplingInfo('Unsupported');
            if (typeof result !== 'object' || !result) return emptySamplingInfo('Unknown');
            const p = result as Record<string, unknown>;
            if (!positiveInteger(p.defaultTopK) || !positiveInteger(p.maxTopK) || p.defaultTopK > p.maxTopK ||
                !nonnegative(p.defaultTemperature) || !nonnegative(p.maxTemperature) || p.defaultTemperature > p.maxTemperature) {
                return emptySamplingInfo('Unknown');
            }
            return { support: 'Supported', defaultTopK: p.defaultTopK, maxTopK: p.maxTopK,
                defaultTemperature: p.defaultTemperature, maxTemperature: p.maxTemperature };
        } catch { return emptySamplingInfo('Unknown'); }
    }
    function samplingOptions(): SamplingOptions | undefined {
        // A bad numeric input can have an empty value; do not mistake that for a default.
        if (topKInput?.validity.badInput || temperatureInput?.validity.badInput) throw new Error('Enter valid numeric sampling settings.');
        const topK = topKInput ? (topKInput.value === '' ? null : topKInput.valueAsNumber) : configured.topK;
        const temperature = temperatureInput ? (temperatureInput.value === '' ? null : temperatureInput.valueAsNumber) : configured.temperature;
        if (topK == null && temperature == null) return undefined;
        if (samplingInfo.support !== 'Supported') throw new Error('Numeric sampling support is not confirmed. Clear Top K and Temperature to use browser defaults.');
        const resolvedTopK = topK ?? samplingInfo.defaultTopK!;
        const resolvedTemperature = temperature ?? samplingInfo.defaultTemperature!;
        if (!positiveInteger(resolvedTopK) || resolvedTopK > samplingInfo.maxTopK!) throw new Error(`Top K must be an integer from 1 to ${samplingInfo.maxTopK}.`);
        if (!nonnegative(resolvedTemperature) || resolvedTemperature > samplingInfo.maxTemperature!) throw new Error(`Temperature must be a finite number from 0 to ${samplingInfo.maxTemperature}.`);
        return { topK: resolvedTopK, temperature: resolvedTemperature };
    }
    const report = (state: string, message: string) => {
        if (!disposed) callback.invokeMethodAsync("ReportAsync", state, message).catch(() => dispose());
    };
    async function availability() {
        if (!globalThis.isSecureContext || !model) return "unavailable";
        return model.availability(sessionOptions);
    }
    async function discoverAvailability() {
        if (enableImages && globalThis.isSecureContext && model) {
            const imageOptions: ModelOptions = { ...options, expectedInputs: [...options.expectedInputs, { type: 'image' }] };
            try {
                const state = await model.availability(imageOptions);
                if (disposed) return 'unavailable';
                if (state !== 'unavailable') {
                    sessionOptions = imageOptions;
                    supportsImages = true;
                    imageDiscoveryComplete = true;
                    return state;
                }
            } catch { /* Probe only: retain text support if image discovery fails. */ }
        }
        imageDiscoveryComplete = true;
        return availability();
    }
    function errorMessage(cause: unknown) {
        const error = cause instanceof Error ? cause : new Error(typeof cause === 'string' ? cause : 'The browser model failed.');
        if (error.name === "NotAllowedError") return "Chrome could not initialize the model. Check browser permissions and click Initialize again.";
        if (error.name === "QuotaExceededError") return "The prompt exceeds the model's context capacity. Try a shorter prompt or fewer/smaller images.";
        if (error.name === "NotSupportedError") return "This browser or device does not support the requested text or image input. Check Chrome's Prompt API requirements.";
        if (error.name === "TimeoutError") return "Generation took too long. Try a shorter prompt.";
        return `${error.message || "The browser model failed."} Try again, or reload the page.`;
    }
    async function initialize() {
        if (disposed || initializing || session || !imageDiscoveryComplete || !globalThis.isSecureContext || !model) return;
        initializing = true;
        updateControls();
        button.disabled = true;
        lastProgress = -1;
        lastProgressTime = 0;
        try {
            const sampling = samplingOptions();
            const instructions = systemPromptInput ? systemPromptInput.value : systemPrompt;
            initialization = new AbortController();
            // Call create before any await or server round trip to preserve user activation.
            const pending = model.create({
                ...sessionOptions,
                ...sampling,
                ...(instructions?.trim() ? { initialPrompts: [{ role: 'system' as const, content: instructions }] } : {}),
                signal: initialization.signal,
                monitor(monitor) {
                    monitor.addEventListener("downloadprogress", event => {
                        const percent = Math.round(event.loaded * 100);
                        const now = performance.now();
                        if (percent !== lastProgress && (now - lastProgressTime >= 250 || percent === 100)) {
                            lastProgress = percent;
                            lastProgressTime = now;
                            report("downloading", `Downloading browser model: ${percent}%`);
                        }
                    });
                }
            });
            report("downloading", "Preparing browser model; the first use may download model files…");
            const created = await pending;
            if (disposed) { created.destroy(); return; }
            session = created;
            report("ready", enableImages && !supportsImages ? "Browser model ready for text. Image attachments are unsupported in this browser or device." : "Browser model ready.");
        } catch (error) {
            if (!disposed) report("failed", errorMessage(error));
        } finally {
            initializing = false;
            updateControls();
            if (!disposed) button.disabled = !!session;
        }
    }
    async function prompt(text: string, images?: Attachments) {
        if (stateless) throw new Error('Incremental prompts require Conversation session mode.');
        if (disposed || !session) throw new Error("Initialize the browser model first.");
        if (generating) throw new Error("A reply is already being generated.");
        if (typeof text !== "string" || !text.trim()) throw new Error("Enter a prompt first.");
        if (images && !attachments.has(images)) throw new Error('These attachments do not belong to this session.');
        const files = images?.snapshot() ?? [];
        if (files.length && !supportsImages) throw new Error('Image attachments are unsupported in this session.');
        generating = true;
        for (const item of attachments) item.setBusy(true);
        generation = new AbortController();
        // Cooperative deadline: a frozen page cannot run this timer until it resumes.
        const timeout = setTimeout(() => generation?.abort(new DOMException("Generation timed out", "TimeoutError")), 120000);
        try {
            const input: Parameters<ModelSession['prompt']>[0] = files.length
                ? [{ role: 'user', content: [{ type: 'text', value: text }, ...files.map(value => ({ type: 'image' as const, value }))] }]
                : text;
            const result = await session.prompt(input, { signal: generation.signal });
            images?.clear();
            return result;
        } catch (error) {
            throw new Error(errorMessage(error));
        } finally {
            clearTimeout(timeout);
            generating = false;
            generation = undefined;
            for (const item of attachments) item.setBusy(false);
        }
    }
    function getInfo(): BrowserModelInfo {
        if (disposed || !session) throw new Error("Initialize the browser model first.");
        return {
            supportsImages,
            // The Prompt API does not expose model identity or download size.
            name: null,
            sizeBytes: null,
            contextWindowTokens: tokenCount(session.contextWindow),
            contextUsageTokens: tokenCount(session.contextUsage),
            topK: positiveInteger(session.topK) ? session.topK : null,
            temperature: tokenCount(session.temperature)
        };
    }
    async function promptMessages(messages: { role: 'system' | 'user' | 'assistant'; content: string; parts?: { type: string; value: string }[] | null }[], requestId: string, responseConstraint?: object | null, sink?: { invokeMethodAsync(method: string, text: string): Promise<unknown> }) {
        if (disposed || !session) throw new Error('Initialize the browser model first.');
        if (!stateless) throw new Error('Full message histories require Stateless session mode.');
        if (generating) throw new Error('A reply is already being generated.');
        if (!Array.isArray(messages) || !messages.length || messages.some((m, i) => !m ||
            (m.parts == null && (typeof m.content !== 'string' || !m.content.trim())) ||
            (m.role !== 'user' && m.role !== 'assistant' && !(m.role === 'system' && i === 0))))
            throw new Error('Provide nonempty text messages with at most one leading system message.');
        // Resolve before cloning; text-only histories need no replacement arrays.
        const input = messages.some(m => m.parts != null) ? messages.map(m => {
            if (m.parts == null) return { role: m.role, content: m.content };
            if (m.role !== 'user' || !Array.isArray(m.parts) || !m.parts.length)
                throw new Error('Only user messages support nonempty image parts.');
            const content: ({ type: 'text'; value: string } | { type: 'image'; value: Blob })[] = [];
            for (const part of m.parts) {
                if (!part || typeof part.value !== 'string' || !part.value.trim()) throw new Error('Invalid message part.');
                if (part.type === 'text') content.push({ type: 'text', value: part.value });
                else if (part.type === 'image') {
                    const files = retained.get(part.value);
                    if (!supportsImages || !files) throw new Error('Image reference expired or belongs to another session. Start a new conversation.');
                    for (const value of files) content.push({ type: 'image', value });
                } else throw new Error('Unsupported message part.');
            }
            return { role: m.role, content };
        }) : messages;
        if (typeof requestId !== 'string' || !requestId) throw new Error('A request ID is required.');
        if (responseConstraint != null && (typeof responseConstraint !== 'object' || Array.isArray(responseConstraint)))
            throw new Error('Unsupported response constraint: provide a JSON schema object.');
        if (sink && responseConstraint != null) throw new Error('Streaming structured output is unsupported. Use completed responses.');
        if (typeof session.clone !== 'function') throw new Error('This browser does not support session cloning required by the agent adapter.');
        generating = true;
        activeRequestId = requestId;
        const abort = new AbortController();
        generation = abort;
        // Cooperative deadline: a frozen page cannot run this timer until it resumes.
        const timeout = setTimeout(() => abort.abort(new DOMException('Generation timed out', 'TimeoutError')), 120000);
        let cloned: ModelSession | undefined;
        try {
            cloned = await session.clone({ signal: abort.signal });
            abort.signal.throwIfAborted();
            activeClone = cloned;
            const options: { signal: AbortSignal; responseConstraint?: object } = { signal: abort.signal };
            if (responseConstraint != null) options.responseConstraint = responseConstraint;
            if (sink) {
                if (typeof cloned.promptStreaming !== 'function') throw new Error('This browser does not support streaming.');
                await streamBatches(cloned.promptStreaming(input, options), sink, abort.signal);
                return '';
            }
            const result = await cloned.prompt(input, options);
            abort.signal.throwIfAborted();
            return result;
        } catch (error) {
            if (responseConstraint != null && !abort.signal.aborted && error instanceof DOMException) {
                if (error.name === 'NotSupportedError') throw new Error(`Structured output is not supported for this schema: ${error.message}`);
                if (error.name === 'SyntaxError') throw new Error(`The browser could not produce valid structured output: ${error.message}`);
            }
            throw new Error(errorMessage(error));
        } finally {
            clearTimeout(timeout);
            // dispose() may already have destroyed the active clone.
            if (cloned && (!disposed || cloned !== activeClone)) cloned.destroy();
            activeClone = undefined;
            activeRequestId = undefined;
            generation = undefined;
            generating = false;
        }
    }
    function cancelPrompt(requestId: string) {
        if (requestId === activeRequestId) generation?.abort();
    }
    function dispose() {
        if (disposed) return;
        disposed = true;
        updateControls();
        observer.disconnect();
        button.removeEventListener("click", initialize);
        globalThis.removeEventListener("pagehide", dispose);
        generation?.abort();
        activeClone?.destroy();
        initialization?.abort();
        session?.destroy();
        session = undefined;
        for (const item of attachments) item.dispose();
        attachments.clear();
        retained.clear();
        retainedCount = retainedBytes = 0;
    }
    const observer = new MutationObserver(() => {
        if (!button.isConnected) dispose();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    button.addEventListener("click", initialize);
    globalThis.addEventListener("pagehide", dispose);
    const samplingDiscovery = discoverSampling().then(info => {
        if (disposed) return info;
        samplingInfo = info;
        updateControls();
        if (topKInput && info.maxTopK !== null) topKInput.max = info.maxTopK.toString();
        if (temperatureInput && info.maxTemperature !== null) temperatureInput.max = info.maxTemperature.toString();
        if (samplingMessage) samplingMessage.textContent = info.support === 'Supported'
            ? `Browser defaults: Top K ${info.defaultTopK}, Temperature ${info.defaultTemperature}. Maximums: Top K ${info.maxTopK}, Temperature ${info.maxTemperature}. Leave blank for defaults. Reload to change settings after initialization.`
            : info.support === 'Unsupported'
                ? 'Numeric sampling is not exposed in this browser context. Browser defaults are available. Top K and Temperature require a supported extension or experimental context.'
                : 'Could not determine numeric sampling support. Browser defaults are still available.';
        return info;
    });
    async function getSamplingInfo(): Promise<BrowserModelSamplingInfo> {
        if (disposed) throw new Error('The browser model has been disposed.');
        const info = await samplingDiscovery;
        if (disposed) throw new Error('The browser model has been disposed.');
        return { ...info };
    }
    discoverAvailability().then(state => {
        if (disposed) return;
        if (initializing || session) return;
        button.disabled = state === "unavailable";
        report(state, state === "unavailable"
            ? "Browser model unavailable. Use compatible desktop Chrome on localhost or HTTPS and check the Prompt API hardware requirements."
            : `Click Initialize browser model to begin. Chrome may download the model on first use.${enableImages && !supportsImages ? ' Image attachments are unsupported; text chat is available.' : ''}`);
    }).catch(error => {
        if (disposed || initializing || session) return;
        button.disabled = false;
        report("failed", errorMessage(error));
    });
    function attachImages(root: HTMLElement) {
        if (disposed || !session) throw new Error('Initialize the browser model first.');
        const item = createAttachments(root, supportsImages, () => attachments.delete(item));
        attachments.add(item);
        item.setBusy(generating);
        return item;
    }
    return { availability, prompt, promptMessages, cancelPrompt, getInfo, getSamplingInfo, attachImages, retainImages, clearImages, dispose };
}

function emptySamplingInfo(support: BrowserModelSamplingInfo['support']): BrowserModelSamplingInfo {
    return { support, defaultTopK: null, maxTopK: null, defaultTemperature: null, maxTemperature: null };
}

function nonnegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
    return nonnegative(value) && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}

function tokenCount(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Await every acknowledgement before reading more: no per-token interop or growing transcript.
// Native streams may buffer internally; these bounds apply to the adapter's own buffers.
async function streamBatches(stream: ReadableStream<string>, sink: { invokeMethodAsync(method: string, text: string): Promise<unknown> }, signal: AbortSignal) {
    const reader = stream.getReader();
    let ended = false;
    try {
        signal.throwIfAborted();
        let batch = '';
        let chunks = 0;
        while (true) {
            const { value, done } = await abortable(reader.read(), signal);
            if (done) { ended = true; break; }
            if (typeof value !== 'string') throw new Error('The browser returned a non-text streaming chunk.');
            let offset = 0;
            while (offset < value.length) {
                const take = Math.min(4096 - batch.length, value.length - offset);
                batch += value.slice(offset, offset + take);
                offset += take;
                if (batch.length === 4096) {
                    const tail = batch.charCodeAt(4095);
                    const carry = tail >= 0xD800 && tail <= 0xDBFF ? batch.slice(-1) : '';
                    await abortable(sink.invokeMethodAsync('ReceiveAsync', carry ? batch.slice(0, -1) : batch), signal);
                    batch = carry;
                    chunks = 0;
                }
            }
            if (++chunks >= 32 && batch.length) {
                const tail = batch.charCodeAt(batch.length - 1);
                const carry = tail >= 0xD800 && tail <= 0xDBFF ? batch.slice(-1) : '';
                const text = carry ? batch.slice(0, -1) : batch;
                if (text) await abortable(sink.invokeMethodAsync('ReceiveAsync', text), signal);
                batch = carry;
                chunks = 0;
            }
        }
        if (batch) await abortable(sink.invokeMethodAsync('ReceiveAsync', batch), signal);
        signal.throwIfAborted();
    } finally {
        if (!ended) void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

// Remove listeners after each wait rather than retaining one Promise.race continuation per token.
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        pending.then(value => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, error => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
        if (signal.aborted) { signal.removeEventListener('abort', onAbort); reject(signal.reason); }
    });
}
