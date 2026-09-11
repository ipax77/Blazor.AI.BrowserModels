(() => {
    const config = globalThis.__modelConfig ?? {};
    const state = globalThis.__model = {
        config, creates: 0, clones: 0, seedDestroyed: 0, cloneDestroyed: 0,
        aborted: 0, streamCanceled: 0, active: 0, calls: [], liveUrls: 0
    };
    const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
    const urls = new Set();
    URL.createObjectURL = blob => { const url = createUrl(blob); urls.add(url); state.liveUrls = urls.size; return url; };
    URL.revokeObjectURL = url => { urls.delete(url); state.liveUrls = urls.size; revokeUrl(url); };
    const record = (input, options) => {
        if (state.calls.length === 50) state.calls.shift();
        state.calls.push({
            input: input.map(m => ({ role: m.role, content: Array.isArray(m.content)
                ? m.content.map(p => ({ type: p.type, value: p.value instanceof Blob
                    ? { name: p.value.name, size: p.value.size, blob: true } : p.value })) : m.content })),
            constraint: options.responseConstraint ?? null
        });
    };
    const result = options => config.reply ?? (options.responseConstraint
        ? '{"title":"Local inference","keyPoints":["Private","Offline"]}' : 'A local reply.');
    const fail = () => {
        if (config.fail) throw new DOMException(config.fail, config.errorName ?? 'OperationError');
    };
    const session = seed => {
        let destroyed = false;
        let detach = () => {};
        const watch = signal => {
            const abort = () => state.aborted++;
            signal.addEventListener('abort', abort, { once: true });
            detach = () => signal.removeEventListener('abort', abort);
        };
        const value = {
            contextWindow: 8192, contextUsage: 0,
            destroy() {
                if (destroyed) throw new Error('Session destroyed twice');
                destroyed = true; detach();
                if (seed) state.seedDestroyed++;
                else { state.cloneDestroyed++; state.active--; }
            },
            async clone() { state.clones++; state.active++; return session(false); },
            async prompt(input, options) {
                record(input, options); watch(options.signal); fail();
                if (config.hold) await new Promise((_, reject) => {
                    if (options.signal.aborted) reject(options.signal.reason);
                    else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                });
                return result(options);
            },
            promptStreaming(input, options) {
                record(input, options); watch(options.signal);
                let sent = 0;
                return new ReadableStream({
                    pull(controller) {
                        fail();
                        if (options.signal.aborted) { controller.error(options.signal.reason); return; }
                        if (config.hold && sent > 0) return new Promise(() => {});
                        if (sent++ < (config.chunks ?? 96)) controller.enqueue(config.chunk ?? 'x');
                        else controller.close();
                    },
                    cancel() { state.streamCanceled++; }
                }, { highWaterMark: 0 });
            }
        };
        if (config.noClone) delete value.clone;
        return value;
    };
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: config.missing ? undefined : {
        availability: async () => config.unavailable ? 'unavailable' : 'available',
        create: async () => {
            state.creates++;
            if (config.createFail) throw new Error('Initialization failed');
            return session(true);
        }
    } });
})();
