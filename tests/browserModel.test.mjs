import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { attach } from '../src/Blazor.AI.BrowserModels/TypeScript/browserModel.ts';
import { attachmentDom, choose, file } from './helpers/attachmentDom.mjs';

const controllers = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const flush = () => new Promise(resolve => setImmediate(resolve));

test('structured constraint is passed unchanged only to its request clone', async () => {
    const clone = { prompt: vi.fn(async () => '{"title":"Hello"}'), destroy: vi.fn() };
    const h = await statelessHarness(vi.fn(async () => clone));
    const messages = [{ role: 'user', content: 'Summarize' }];
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
    await h.controller.promptMessages(messages, '1', schema);
    assert.equal(clone.prompt.mock.calls[0][1].responseConstraint, schema);
    assert.ok(clone.prompt.mock.calls[0][1].signal instanceof AbortSignal);
    await h.controller.promptMessages(messages, '2', {});
    assert.deepEqual(clone.prompt.mock.calls[1][1].responseConstraint, {});
    await h.controller.promptMessages(messages, '3');
    assert.equal(Object.hasOwn(clone.prompt.mock.calls[2][1], 'responseConstraint'), false);
    assert.equal(h.seed.clone.mock.calls.length, 3);
    assert.equal(clone.destroy.mock.calls.length, 3);
    assert.equal(h.model.availability.mock.calls.length, 1);
});

test.each([true, [], 'json', 1])('rejects invalid response constraint %j before cloning', async constraint => {
    const h = await statelessHarness(vi.fn());
    await assert.rejects(h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1', constraint), /Unsupported response constraint/);
    assert.equal(h.seed.clone.mock.calls.length, 0);
});

test.each([['NotSupportedError', /not supported/], ['SyntaxError', /valid structured output/]])(
    'structured %s destroys clone and allows an unconstrained retry', async (name, message) => {
        const clone = { prompt: vi.fn().mockRejectedValueOnce(new DOMException('Constraint failure', name)).mockResolvedValue('Recovered'), destroy: vi.fn() };
        const h = await statelessHarness(vi.fn(async () => clone));
        const messages = [{ role: 'user', content: 'Hi' }];
        await assert.rejects(h.controller.promptMessages(messages, '1', {}), message);
        assert.equal(clone.prompt.mock.calls.length, 1);
        assert.equal(clone.destroy.mock.calls.length, 1);
        assert.equal(await h.controller.promptMessages(messages, '2'), 'Recovered');
        assert.equal(clone.destroy.mock.calls.length, 2);
    });

async function statelessHarness(clone) {
    const seed = { clone, prompt: vi.fn(), destroy: vi.fn() };
    const model = { create: vi.fn(async () => seed), availability: vi.fn(async () => 'available') };
    const h = setup(model, {}, null, false, null, null, true);
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    return { ...h, seed, model };
}

test('stateless requests clone a clean seed once per request without duplicated history', async () => {
    const clones = [];
    const h = await statelessHarness(vi.fn(async () => {
        const item = { prompt: vi.fn(async () => 'Reply'), destroy: vi.fn() };
        clones.push(item);
        return item;
    }));
    const first = [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'First' }];
    const second = [...first, { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Second' }];
    await h.controller.promptMessages(first, '1');
    await h.controller.promptMessages(second, '2');
    assert.deepEqual(clones.map(c => c.prompt.mock.calls[0][0]), [first, second]);
    assert.ok(clones.every(c => c.destroy.mock.calls.length === 1));
    assert.equal(h.seed.prompt.mock.calls.length, 0);
    assert.equal(h.seed.clone.mock.calls.length, 2);
    assert.equal(h.model.create.mock.calls.length, 1);
    assert.equal(h.model.availability.mock.calls.length, 1);
    assert.equal(h.model.create.mock.calls[0][0].initialPrompts, undefined);
    await assert.rejects(h.controller.prompt('Incremental'), /Conversation/);
});

test('stateless rejects malformed messages and missing clone support before inference', async () => {
    const clone = vi.fn();
    const h = await statelessHarness(clone);
    for (const messages of [[], [{ role: 'tool', content: 'x' }], [{ role: 'user', content: '' }],
        [{ role: 'user', content: 'Hi' }, { role: 'system', content: 'Late' }]])
        await assert.rejects(h.controller.promptMessages(messages, '1'), /nonempty/);
    assert.equal(clone.mock.calls.length, 0);
    h.seed.clone = undefined;
    await assert.rejects(h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1'), /cloning/);
});

test('stateless rejects configured system instructions and editor', () => {
    assert.throws(() => setup({}, {}, null, false, 'Instructions', null, true), /Stateless/);
    assert.throws(() => setup({}, {}, null, false, null, { value: '' }, true), /Stateless/);
});

test('clone failure releases the gate for retry', async () => {
    const item = { prompt: vi.fn(async () => 'Recovered'), destroy: vi.fn() };
    const h = await statelessHarness(vi.fn().mockRejectedValueOnce(new Error('Clone failed')).mockResolvedValue(item));
    const messages = [{ role: 'user', content: 'Hi' }];
    await assert.rejects(h.controller.promptMessages(messages, '1'), /Clone failed/);
    assert.equal(await h.controller.promptMessages(messages, '2'), 'Recovered');
    assert.equal(item.destroy.mock.calls.length, 1);
});

test.each(['cancel', 'pagehide', 'removed'])('late clone is destroyed after %s', async action => {
    let resolve;
    const clone = { prompt: vi.fn(), destroy: vi.fn() };
    const h = await statelessHarness(() => new Promise(r => resolve = r));
    const pending = h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1');
    const rejected = assert.rejects(pending);
    if (action === 'cancel') h.controller.cancelPrompt('1');
    else if (action === 'pagehide') h.lifecycle.dispatchEvent(new Event('pagehide'));
    else h.removed();
    resolve(clone);
    await rejected;
    assert.equal(clone.prompt.mock.calls.length, 0);
    assert.equal(clone.destroy.mock.calls.length, 1);
});

test.each([undefined, {}])('cancellation with constraint %j affects only the matching request; concurrent requests do not clone', async constraint => {
    const clones = [];
    const h = await statelessHarness(vi.fn(async () => {
        const item = { destroy: vi.fn(), prompt: (messages, { signal }) => new Promise((resolve, reject) => {
            item.resolve = resolve;
            item.signal = signal;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }) };
        clones.push(item);
        return item;
    }));
    const messages = [{ role: 'user', content: 'Hi' }];
    const first = h.controller.promptMessages(messages, '1', constraint);
    const rejected = assert.rejects(first);
    await flush();
    await assert.rejects(h.controller.promptMessages(messages, '2'), /already/);
    assert.equal(h.seed.clone.mock.calls.length, 1);
    h.controller.cancelPrompt('wrong');
    assert.equal(clones[0].signal.aborted, false);
    h.controller.cancelPrompt('1');
    await rejected;
    const second = h.controller.promptMessages(messages, '2');
    await flush();
    h.controller.cancelPrompt('1');
    assert.equal(clones[1].signal.aborted, false);
    clones[1].resolve('Recovered');
    assert.equal(await second, 'Recovered');
    assert.ok(clones.every(c => c.destroy.mock.calls.length === 1));
});

test.each(['timeout', 'pagehide', 'failure'])('stateless %s releases the active clone', async action => {
    const clone = { destroy: vi.fn(), prompt: vi.fn((messages, { signal }) => new Promise((resolve, reject) => {
        if (action === 'failure') reject(new Error('Model failure'));
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) };
    const h = await statelessHarness(async () => clone);
    vi.useFakeTimers();
    try {
        const pending = h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1');
        const rejected = assert.rejects(pending);
        await Promise.resolve();
        if (action === 'timeout') await vi.advanceTimersByTimeAsync(120000);
        if (action === 'pagehide') h.lifecycle.dispatchEvent(new Event('pagehide'));
        await rejected;
        assert.equal(clone.destroy.mock.calls.length, 1);
        if (action !== 'pagehide') {
            clone.prompt.mockResolvedValue('Recovered');
            assert.equal(await h.controller.promptMessages([{ role: 'user', content: 'Retry' }], '2'), 'Recovered');
        }
    } finally { vi.useRealTimers(); }
});
const limits = { defaultTopK: 3, maxTopK: 128, defaultTemperature: 1, maxTemperature: 2 };

test.each([null, '', ' \n\t ', '  Be concise.\nKeep formatting.  '])('system prompt configuration %j is creation-only', async instructions => {
    const inference = vi.fn(async () => 'Hello');
    const create = vi.fn(async () => ({ destroy() {}, prompt: inference }));
    const availability = vi.fn(async () => 'available');
    const h = setup({ create, availability }, {}, null, false, instructions);
    await flush();
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 1, 'Creation remains synchronous');
    const passed = create.mock.calls[0][0];
    if (instructions?.trim()) assert.deepEqual(passed.initialPrompts, [{ role: 'system', content: instructions }]);
    else assert.equal(Object.hasOwn(passed, 'initialPrompts'), false);
    assert.equal(Object.hasOwn(availability.mock.calls[0][0], 'initialPrompts'), false);
    await flush();
    await h.controller.prompt('Hello');
    await h.controller.prompt('Follow up');
    assert.deepEqual(inference.mock.calls.map(call => call[0]), ['Hello', 'Follow up']);
    assert.equal(create.mock.calls.length, 1);
    assert.equal(availability.mock.calls.length, 1);
});

test('system prompt editor works without sampling support and unlocks for retry', async () => {
    const editor = { value: '', disabled: true };
    const panel = samplingPanel();
    let reject;
    const create = vi.fn().mockImplementationOnce(() => new Promise((_, r) => reject = r))
        .mockResolvedValue({ destroy() {} });
    const h = setup({ create, availability: async () => 'available' }, {}, panel, false, 'Initial', editor);
    await flush();
    assert.equal(editor.value, 'Initial');
    assert.equal(editor.disabled, false);
    assert.equal(panel.fields.disabled, true);
    editor.value = '  Edited\nInstructions  ';
    h.button.dispatchEvent(new Event('click'));
    assert.equal(editor.disabled, true);
    assert.deepEqual(create.mock.calls[0][0].initialPrompts, [{ role: 'system', content: editor.value }]);
    reject(new Error('Failed'));
    await flush();
    assert.equal(editor.disabled, false);
    assert.equal(editor.value, '  Edited\nInstructions  ');
    editor.value = ' \n ';
    h.button.dispatchEvent(new Event('click'));
    assert.equal(Object.hasOwn(create.mock.calls[1][0], 'initialPrompts'), false, 'Clearing the editor overrides the configured value');
    await flush();
    assert.equal(editor.disabled, true);
    h.controller.dispose();
    assert.equal(editor.disabled, true);
});

test('system prompt editor stays locked when disposed during initialization or discovery', async () => {
    const editor = { value: '', disabled: true };
    let resolveSession;
    let resolveSampling;
    const destroy = vi.fn();
    const h = setup({ availability: async () => 'available', params: () => new Promise(r => resolveSampling = r),
        create: () => new Promise(r => resolveSession = r) }, {}, null, false, 'Instructions', editor);
    await flush();
    h.button.dispatchEvent(new Event('click'));
    h.controller.dispose();
    resolveSampling(limits);
    resolveSession({ destroy });
    await flush();
    assert.equal(editor.disabled, true);
    assert.equal(destroy.mock.calls.length, 1);
});

test.each([true, false])('system instructions coexist with image support %s and fallback', async supported => {
    const inference = vi.fn(async () => 'Reply');
    const create = vi.fn(async () => ({ destroy() {}, prompt: inference }));
    const h = setup({ create, availability: async options =>
        !supported && options.expectedInputs.some(input => input.type === 'image') ? 'unavailable' : 'available'
    }, {}, null, true, 'Describe carefully.');
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    assert.deepEqual(create.mock.calls[0][0].initialPrompts, [{ role: 'system', content: 'Describe carefully.' }]);
    assert.equal(h.controller.getInfo().supportsImages, supported);
    if (supported) {
        const dom = attachmentDom();
        const images = h.controller.attachImages(dom.root);
        images.setDisabled(false);
        choose(dom, [file()]);
        await h.controller.prompt('Describe', images);
        assert.equal(inference.mock.calls[0][0][0].role, 'user');
        assert.equal(inference.mock.calls[0][0][0].content[1].type, 'image');
    }
    await h.controller.prompt('Follow up');
    assert.equal(inference.mock.calls.at(-1)[0], 'Follow up');
    assert.equal(create.mock.calls.length, 1);
});

test.each(['available', 'downloadable', 'downloading', 'unavailable', 'rejected'])('image availability %s selects matching creation options', async imageState => {
    const availability = vi.fn(async options => {
        if (options.expectedInputs.some(input => input.type === 'image')) {
            if (imageState === 'rejected') throw new Error('Unsupported image options');
            return imageState;
        }
        return 'available';
    });
    const create = vi.fn(async () => ({ destroy() {} }));
    const h = setup({ availability, create }, {}, null, true);
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 0, 'No creation until image discovery finishes');
    await flush();
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 1, 'Creation must happen before the native handler yields');
    await flush();
    const supported = imageState !== 'unavailable' && imageState !== 'rejected';
    assert.equal(h.controller.getInfo().supportsImages, supported);
    assert.deepEqual(create.mock.calls[0][0].expectedInputs, availability.mock.calls.at(-1)[0].expectedInputs);
    assert.equal(availability.mock.calls.length, supported ? 1 : 2);
    if (!supported) assert.match(h.reports.at(-1)[1], /unsupported/);
});

test('late image discovery after disposal never enables controls or creates a model', async () => {
    let resolve;
    const create = vi.fn();
    const h = setup({ availability: () => new Promise(r => resolve = r), create }, {}, null, true);
    h.controller.dispose();
    resolve('available');
    await flush();
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 0);
    assert.equal(h.button.disabled, true);
});

test('image prompt retains files on failure, locks edits, then clears on success without recreating the session', async () => {
    let reject;
    const inference = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve, r) => reject = r))
        .mockResolvedValue('The images show two cats.');
    const create = vi.fn(async () => ({ destroy() {}, prompt: inference }));
    const h = setup({ availability: async () => 'available', create }, {}, null, true);
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    const dom = attachmentDom();
    const images = h.controller.attachImages(dom.root);
    images.setDisabled(false);
    const files = [file('first.png'), file('second.webp', 'image/webp')];
    choose(dom, files);
    await assert.rejects(h.controller.prompt(' ', images), /Enter a prompt/);
    const pending = h.controller.prompt('Compare them', images);
    assert.equal(dom.fields.disabled, true);
    choose(dom, [file()]);
    assert.deepEqual(images.snapshot(), files);
    assert.deepEqual(inference.mock.calls[0][0], [{ role: 'user', content: [
        { type: 'text', value: 'Compare them' }, ...files.map(value => ({ type: 'image', value }))
    ] }]);
    assert.equal(inference.mock.calls[0][0][0].content[1].value, files[0]);
    await assert.rejects(h.controller.prompt('duplicate', images), /already/);
    reject(new DOMException('Too large', 'QuotaExceededError'));
    await assert.rejects(pending, /fewer\/smaller images/);
    assert.deepEqual(images.snapshot(), files);
    assert.equal(dom.fields.disabled, false);
    assert.equal(dom.revoked.mock.calls.length, 0);
    assert.equal(await h.controller.prompt('Try again', images), 'The images show two cats.');
    assert.deepEqual(images.snapshot(), []);
    assert.equal(dom.revoked.mock.calls.length, 2);
    await h.controller.prompt('What color?', images);
    assert.equal(inference.mock.calls.at(-1)[0], 'What color?');
    assert.equal(create.mock.calls.length, 1);
    await assert.rejects(h.controller.prompt('wrong session', { snapshot: () => files }), /belong/);
});

test('disposal aborts image inference and releases previews even if the model resolves late', async () => {
    let resolve;
    let signal;
    const h = setup({ availability: async () => 'available', create: async () => ({ destroy() {},
        prompt: (_, options) => { signal = options.signal; return new Promise(r => resolve = r); }
    }) }, {}, null, true);
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    const dom = attachmentDom();
    const images = h.controller.attachImages(dom.root);
    images.setDisabled(false);
    choose(dom, [file()]);
    const pending = h.controller.prompt('Describe it', images);
    h.controller.dispose();
    assert.equal(signal.aborted, true);
    assert.equal(dom.revoked.mock.calls.length, 1);
    assert.throws(() => images.snapshot(), /disposed/);
    resolve('late');
    await pending;
    assert.equal(dom.revoked.mock.calls.length, 1);
    assert.equal(dom.fields.disabled, true);
});

function samplingPanel() {
    const input = () => ({ value: '', get valueAsNumber() { return Number(this.value); }, validity: { badInput: false } });
    const topK = input();
    const temperature = input();
    const fields = { disabled: true };
    const message = { textContent: 'Checking' };
    return { topK, temperature, fields, message, querySelector(selector) {
        return { 'input[name="topK"]': topK, 'input[name="temperature"]': temperature,
            fieldset: fields, '[data-sampling-status]': message }[selector];
    } };
}

test.each([
    [{}, undefined, undefined],
    [{ topK: 10 }, 10, 1],
    [{ temperature: 0 }, 3, 0],
    [{ topK: 128, temperature: 2 }, 128, 2]
])('sampling defaults and overrides (%j) preserve synchronous creation', async (settings, topK, temperature) => {
    const params = vi.fn(async () => limits);
    const create = vi.fn(async options => ({ topK: options.topK ?? 3, temperature: options.temperature ?? 1, destroy() {} }));
    const availability = vi.fn(async () => 'available');
    const h = setup({ params, create, availability }, settings);
    const first = await h.controller.getSamplingInfo();
    assert.deepEqual(first, { support: 'Supported', ...limits });
    first.maxTopK = 1;
    assert.equal((await h.controller.getSamplingInfo()).maxTopK, 128);
    assert.equal(create.mock.calls.length, 0);
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 1);
    const passed = create.mock.calls[0][0];
    assert.equal(passed.topK, topK);
    assert.equal(passed.temperature, temperature);
    if (topK === undefined) assert.equal(Object.hasOwn(passed, 'topK'), false);
    await flush();
    assert.equal(h.controller.getInfo().topK, topK ?? 3);
    assert.equal(h.controller.getInfo().temperature, temperature ?? 1);
    await h.controller.getSamplingInfo();
    assert.equal(params.mock.calls.length, 1);
    assert.equal(availability.mock.calls.length, 1);
});

test.each([
    [undefined, 'Unsupported'], [async () => null, 'Unsupported'],
    [async () => { throw new Error('failed'); }, 'Unknown'],
    [() => { throw new Error('sync failure'); }, 'Unknown'],
    [async () => ({}), 'Unknown'],
    [async () => ({ ...limits, maxTopK: 1 }), 'Unknown'],
    [async () => ({ ...limits, defaultTopK: 1.5 }), 'Unknown'],
    [async () => ({ ...limits, maxTemperature: NaN }), 'Unknown'],
    [async () => ({ ...limits, defaultTemperature: 3 }), 'Unknown'],
    [async () => ({ ...limits, maxTemperature: '2' }), 'Unknown']
])('sampling discovery failure remains compatible with defaults (%s)', async (params, support) => {
    const create = vi.fn(async () => ({ destroy() {} }));
    const h = setup({ params, create, availability: async () => 'available' });
    assert.equal((await h.controller.getSamplingInfo()).support, support);
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 1);
    assert.equal(Object.hasOwn(create.mock.calls[0][0], 'temperature'), false);
});

test.each([{ topK: 0 }, { topK: 1.2 }, { topK: 129 }, { topK: Infinity }, { temperature: -1 },
    { temperature: NaN }, { temperature: Infinity }, { temperature: 2.1 }])('invalid settings (%j) prevent creation', async settings => {
    const create = vi.fn();
    const h = setup({ params: async () => limits, create, availability: async () => 'available' }, settings);
    await h.controller.getSamplingInfo();
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 0);
    assert.equal(h.reports.at(-1)[0], 'failed');
    assert.equal(h.button.disabled, false);
});

test('unconfirmed numeric requests fail without silently using defaults', async () => {
    const create = vi.fn();
    const h = setup({ create, availability: async () => 'available' }, { topK: 3 });
    await h.controller.getSamplingInfo();
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 0);
    assert.match(h.reports.at(-1)[1], /not confirmed/);
});

test.each([undefined, NaN, Infinity, -1])('unexposed or invalid effective sampling values (%s) become null', async value => {
    const h = setup({ availability: async () => 'available', create: async () => ({ topK: value, temperature: value, destroy() {} }) });
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    assert.equal(h.controller.getInfo().topK, null);
    assert.equal(h.controller.getInfo().temperature, null);
});

test('unsupported sampling keeps visible inputs disabled and rejects configured overrides', async () => {
    const panel = samplingPanel();
    const create = vi.fn();
    const h = setup({ availability: async () => 'available', create }, { topK: 4 }, panel);
    await h.controller.getSamplingInfo();
    assert.equal(panel.fields.disabled, true);
    assert.match(panel.message.textContent, /not exposed/);
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 0);
    assert.equal(panel.fields.disabled, true);
});

test('native input edits validate, recover after failure, and lock after success', async () => {
    const panel = samplingPanel();
    const create = vi.fn().mockRejectedValueOnce(new Error('retry')).mockResolvedValue({ destroy() {} });
    const h = setup({ params: async () => limits, create, availability: async () => 'available' }, { topK: 4 }, panel);
    assert.equal(panel.fields.disabled, true);
    await h.controller.getSamplingInfo();
    assert.equal(panel.topK.value, '4');
    assert.equal(panel.fields.disabled, false);
    assert.equal(panel.topK.max, '128');
    panel.temperature.validity.badInput = true;
    h.button.dispatchEvent(new Event('click'));
    assert.equal(create.mock.calls.length, 0);
    panel.temperature.validity.badInput = false;
    panel.topK.value = '8';
    panel.temperature.value = '0';
    h.button.dispatchEvent(new Event('click'));
    assert.equal(panel.fields.disabled, true);
    assert.equal(create.mock.calls[0][0].topK, 8);
    assert.equal(create.mock.calls[0][0].temperature, 0);
    await flush();
    assert.equal(panel.fields.disabled, false);
    panel.topK.value = '';
    panel.temperature.value = '';
    h.button.dispatchEvent(new Event('click'));
    await flush();
    assert.equal(Object.hasOwn(create.mock.calls[1][0], 'topK'), false);
    assert.equal(panel.fields.disabled, true);
});

test('late discovery does not unlock an initializing session or mutate a disposed panel', async () => {
    let resolveParams;
    let resolveSession;
    const panel = samplingPanel();
    const h = setup({ params: () => new Promise(r => resolveParams = r), availability: async () => 'available',
        create: () => new Promise(r => resolveSession = r) }, {}, panel);
    const info = assert.rejects(h.controller.getSamplingInfo(), /disposed/);
    h.button.dispatchEvent(new Event('click'));
    assert.equal(panel.fields.disabled, true);
    h.controller.dispose();
    resolveParams(limits);
    await info;
    assert.equal(panel.fields.disabled, true);
    assert.equal(panel.message.textContent, 'Checking');
    const destroy = vi.fn();
    resolveSession({ destroy });
    await flush();
    assert.equal(destroy.mock.calls.length, 1);
    await assert.rejects(h.controller.getSamplingInfo(), /disposed/);
});

test('discovery completing during initialization keeps controls locked', async () => {
    let resolveParams;
    let resolveSession;
    const panel = samplingPanel();
    const h = setup({ params: () => new Promise(r => resolveParams = r), availability: async () => 'available',
        create: () => new Promise(r => resolveSession = r) }, {}, panel);
    h.button.dispatchEvent(new Event('click'));
    resolveParams(limits);
    await h.controller.getSamplingInfo();
    assert.equal(panel.fields.disabled, true);
    resolveSession({ destroy() {} });
    await flush();
    assert.equal(panel.fields.disabled, true);
});
function setup(model, settings, panel, enableImages = false, systemPrompt = null, systemPromptInput = null, stateless = false) {
    const button = new EventTarget();
    button.isConnected = true;
    button.disabled = true;
    const reports = [];
    let observer;
    const lifecycle = new EventTarget();
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('LanguageModel', model);
    const document = Object.assign(new EventTarget(), { body: {}, visibilityState: 'visible' });
    vi.stubGlobal('document', document);
    vi.stubGlobal('addEventListener', lifecycle.addEventListener.bind(lifecycle));
    vi.stubGlobal('removeEventListener', lifecycle.removeEventListener.bind(lifecycle));
    vi.stubGlobal('MutationObserver', class {
        constructor(callback) { this.callback = callback; observer = this; }
        observe() {}
        disconnect() { this.disconnected = true; }
    });
    const controller = attach(button, { invokeMethodAsync: async (...args) => reports.push(args.slice(1)) }, settings, panel, enableImages, systemPrompt, systemPromptInput, stateless);
    controllers.push(controller);
    return { button, controller, reports, lifecycle, document, removed() { button.isConnected = false; observer.callback(); }, observer: () => observer };
}

test('unsupported browser disables initialization', async () => {
    const h = setup(undefined);
    await flush();
    assert.equal(await h.controller.availability(), 'unavailable');
    assert.equal(h.button.disabled, true);
    assert.equal(h.reports.at(-1)[0], 'unavailable');
    h.controller.dispose();
});

test('initialization is synchronous, deduplicated, and progress is throttled', async () => {
    let creates = 0;
    let resolve;
    const h = setup({ availability: async () => 'downloadable', create(options) {
        creates++;
        const monitor = new EventTarget();
        options.monitor(monitor);
        for (let i = 0; i <= 100; i++) {
            const event = new Event('downloadprogress');
            event.loaded = i / 100;
            monitor.dispatchEvent(event);
        }
        return new Promise(r => resolve = r);
    } });
    await flush();
    h.button.dispatchEvent(new Event('click'));
    assert.equal(creates, 1);
    h.button.dispatchEvent(new Event('click'));
    assert.equal(creates, 1);
    resolve({ destroy() {} });
    await flush();
    assert.equal(h.reports.at(-1)[0], 'ready');
    assert.ok(h.reports.filter(r => r[1].includes('%')).length <= 2);
    h.controller.dispose();
});

test('initialization failure permits retry', async () => {
    let attempts = 0;
    const h = setup({ availability: async () => 'available', create: async () => {
        if (++attempts === 1) throw new DOMException('Permission denied', 'NotAllowedError');
        return { destroy() {} };
    } });
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    assert.equal(h.reports.at(-1)[0], 'failed');
    assert.equal(h.button.disabled, false);
    h.button.dispatchEvent(new Event('click'));
    await flush();
    assert.equal(h.reports.at(-1)[0], 'ready');
    h.controller.dispose();
});

test('availability failure permits an initialization retry', async () => {
    const h = setup({ availability: async () => { throw new Error('Temporary failure'); } });
    await flush();
    assert.equal(h.button.disabled, false);
    assert.equal(h.reports.at(-1)[0], 'failed');
    h.controller.dispose();
});

test('prompts validate, reject overlap, return a complete reply, and recover after failure', async () => {
    let resolve;
    let fail = false;
    let creates = 0;
    const h = setup({ availability: async () => 'available', create: async () => {
        creates++;
        return { destroy() {}, prompt() {
            if (fail) throw new DOMException('Too large', 'QuotaExceededError');
            return new Promise(r => resolve = r);
        } };
    } });
    await flush();
    await assert.rejects(h.controller.prompt('hello'), /Initialize/);
    h.button.dispatchEvent(new Event('click'));
    await flush();
    await assert.rejects(h.controller.prompt('  '), /Enter a prompt/);
    const pending = h.controller.prompt('hello');
    await assert.rejects(h.controller.prompt('hello'), /already/);
    resolve('Hello World');
    assert.equal(await pending, 'Hello World');
    fail = true;
    await assert.rejects(h.controller.prompt('hello'), /shorter prompt/);
    fail = false;
    const retry = h.controller.prompt('hello again');
    resolve('Hello again');
    assert.equal(await retry, 'Hello again');
    assert.equal(creates, 1);
    h.controller.dispose();
});

test('DOM removal aborts generation and releases resources once', async () => {
    let destroys = 0;
    const h = setup({ availability: async () => 'available', create: async () => ({
        destroy() { destroys++; },
        prompt(text, { signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); }
    }) });
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    const pending = h.controller.prompt('hello');
    h.removed();
    await assert.rejects(pending);
    h.controller.dispose();
    assert.equal(destroys, 1);
    assert.equal(h.observer().disconnected, true);
});

test('pagehide during initialization releases a late-created session', async () => {
    let resolve;
    let destroys = 0;
    let signal;
    const h = setup({ availability: async () => 'available', create(options) {
        signal = options.signal;
        return new Promise(r => resolve = r);
    } });
    await flush();
    h.button.dispatchEvent(new Event('click'));
    h.lifecycle.dispatchEvent(new Event('pagehide'));
    assert.equal(signal.aborted, true);
    resolve({ destroy() { destroys++; } });
    await flush();
    assert.equal(destroys, 1);
    assert.equal(h.reports.some(r => r[0] === 'ready'), false);
});


test('metadata reads current tokens without additional model creation or inference', async () => {
    const session = { contextWindow: 8192, contextUsage: 0, destroy: vi.fn(), prompt: vi.fn(async () => {
        session.contextUsage = 42;
        return 'Hello';
    }) };
    const create = vi.fn(async () => session);
    const h = setup({ availability: async () => 'available', create });
    assert.throws(() => h.controller.getInfo(), /Initialize/);
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    const initial = h.controller.getInfo();
    assert.deepEqual(initial, { supportsImages: false, name: null, sizeBytes: null, contextWindowTokens: 8192, contextUsageTokens: 0, topK: null, temperature: null });
    assert.equal(session.prompt.mock.calls.length, 0);
    await h.controller.prompt('Hello');
    assert.equal(h.controller.getInfo().contextUsageTokens, 42);
    assert.equal(initial.contextUsageTokens, 0);
    assert.equal(create.mock.calls.length, 1);
    h.controller.dispose();
    assert.throws(() => h.controller.getInfo(), /Initialize/);
});

test.each([undefined, NaN, Infinity, -1])('unknown or invalid token values (%s) serialize as null', async value => {
    const h = setup({ availability: async () => 'available', create: async () => ({
        contextWindow: value, contextUsage: value, destroy() {}
    }) });
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(h.controller.getInfo())), {
        supportsImages: false, name: null, sizeBytes: null, contextWindowTokens: null, contextUsageTokens: null, topK: null, temperature: null
    });
});

test.each([false, true])('late availability result cannot overwrite initialization (failure: %s)', async fail => {
    let resolveAvailability;
    let rejectAvailability;
    let resolveSession;
    const h = setup({
        availability: () => new Promise((resolve, reject) => { resolveAvailability = resolve; rejectAvailability = reject; }),
        create: () => new Promise(resolve => { resolveSession = resolve; })
    });
    h.button.dispatchEvent(new Event('click'));
    if (fail) rejectAvailability(new Error('late failure'));
    else resolveAvailability('available');
    await flush();
    assert.equal(h.button.disabled, true);
    assert.equal(h.reports.at(-1)[0], 'downloading');
    resolveSession({ destroy() {} });
    await flush();
    assert.equal(h.reports.at(-1)[0], 'ready');
});

test('timeout aborts inference and permits a subsequent prompt', async () => {
    const h = setup({ availability: async () => 'available', create: async () => ({
        destroy() {},
        prompt: vi.fn()
            .mockImplementationOnce((text, { signal }) => new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }))
            .mockResolvedValue('Recovered')
    }) });
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    vi.useFakeTimers();
    try {
        const pending = assert.rejects(h.controller.prompt('Hello'), /took too long/);
        await vi.advanceTimersByTimeAsync(120000);
        await pending;
        assert.equal(await h.controller.prompt('Try again'), 'Recovered');
        assert.equal(vi.getTimerCount(), 0);
    } finally {
        vi.useRealTimers();
    }
});

async function imageAgentHarness() {
    const clone = { prompt: vi.fn(async () => 'Reply'), destroy: vi.fn() };
    const seed = { clone: vi.fn(async () => clone), destroy: vi.fn() };
    const model = { create: vi.fn(async () => seed), availability: vi.fn(async () => 'available') };
    const h = setup(model, {}, null, true, null, null, true);
    await flush();
    h.button.dispatchEvent(new Event('click'));
    await flush();
    const dom = attachmentDom();
    const images = h.controller.attachImages(dom.root);
    images.setDisabled(false);
    return { ...h, dom, images, seed, clone, model };
}
const imageMessage = id => ({ role: 'user', content: '', parts: [
    { type: 'text', value: 'Before' }, { type: 'image', value: id }, { type: 'text', value: 'After' }
] });

test('agent replays original images in order after composer disposal and resets references', async () => {
    const h = await imageAgentHarness();
    const files = [file('first.png'), file('second.png')];
    choose(h.dom, files);
    const id = h.controller.retainImages(h.images);
    assert.equal(h.images.snapshot().length, 0);
    assert.equal(h.dom.revoked.mock.calls.length, 2);
    h.images.dispose();
    const first = imageMessage(id);
    const history = [first, { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Compare again' }];
    await h.controller.promptMessages([first], '1', {});
    await h.controller.promptMessages(history, '2');
    for (const [input] of h.clone.prompt.mock.calls) {
        assert.deepEqual(input[0].content.map(p => p.value), ['Before', ...files, 'After']);
        assert.equal(input[0].content[1].value, files[0]);
    }
    assert.equal(h.clone.prompt.mock.calls[1][0].length, 3);
    assert.equal(h.clone.destroy.mock.calls.length, 2);
    assert.equal(h.model.availability.mock.calls.length, 1);
    h.controller.clearImages();
    await assert.rejects(h.controller.promptMessages([first], '3'), /expired/);
    assert.equal(h.seed.clone.mock.calls.length, 2);
});

test.each(['count', 'bytes'])('retention %s limit rejects atomically and reset restores capacity', async kind => {
    const h = await imageAgentHarness();
    const batch = kind === 'count' ? 4 : 3;
    const size = kind === 'count' ? 1 : 10 * 1024 * 1024;
    const rounds = kind === 'count' ? 4 : 2;
    for (let i = 0; i < rounds; i++) {
        choose(h.dom, Array.from({ length: batch }, () => file('x.png', 'image/png', size)));
        h.controller.retainImages(h.images);
    }
    choose(h.dom, [file('extra.png', 'image/png', size)]);
    assert.throws(() => h.controller.retainImages(h.images), /limit/);
    assert.equal(h.images.snapshot().length, 1);
    h.controller.clearImages();
    assert.equal(h.images.snapshot().length, 0);
    choose(h.dom, [file()]);
    assert.ok(h.controller.retainImages(h.images));
});

test('image cancellation keeps references for retry and forbids reset during inference', async () => {
    const h = await imageAgentHarness();
    choose(h.dom, [file()]);
    const id = h.controller.retainImages(h.images);
    h.clone.prompt.mockImplementationOnce((_, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = h.controller.promptMessages([imageMessage(id)], '1');
    await flush();
    assert.throws(() => h.controller.clearImages(), /already/);
    assert.throws(() => h.controller.retainImages(h.images), /already/);
    h.controller.cancelPrompt('1');
    await assert.rejects(pending, /Aborted/);
    assert.equal(await h.controller.promptMessages([imageMessage(id)], '2'), 'Reply');
    assert.equal(h.clone.destroy.mock.calls.length, 2);
});

test('foreign and malformed image references reject before clone; disposal releases session', async () => {
    const h = await imageAgentHarness();
    const other = await imageAgentHarness();
    choose(h.dom, [file()]);
    const id = h.controller.retainImages(h.images);
    assert.throws(() => other.controller.retainImages(h.images), /belong/);
    for (const message of [imageMessage(id), { role: 'assistant', parts: [{ type: 'image', value: id }] },
        { role: 'user', parts: [] }, { role: 'user', parts: [{ type: 'audio', value: id }] }]) {
        await assert.rejects(other.controller.promptMessages([message], '1'));
    }
    assert.equal(other.seed.clone.mock.calls.length, 0);
    h.controller.dispose();
    await assert.rejects(h.controller.promptMessages([imageMessage(id)], '2'), /Initialize/);
    assert.throws(() => h.controller.retainImages(h.images), /Initialize/);
});

function streamedClone(chunks) {
    const cancel = vi.fn();
    const pull = vi.fn(controller => {
        if (chunks.length) controller.enqueue(chunks.shift());
        else controller.close();
    });
    return { promptStreaming: vi.fn(() => new ReadableStream({ pull, cancel }, { highWaterMark: 0 })),
        prompt: vi.fn(async () => 'Recovered'), destroy: vi.fn(), pull, cancel };
}

test('streaming batches deltas, splits huge chunks and preserves Unicode without transcript replay', async () => {
    const expected = 'a'.repeat(4095) + '😀' + 'b'.repeat(12000);
    const clone = streamedClone([expected]);
    const h = await statelessHarness(async () => clone);
    const batches = [];
    const sink = { invokeMethodAsync: async (method, text) => { assert.equal(method, 'ReceiveAsync'); batches.push(text); } };
    const messages = [{ role: 'system', content: 'Concise' }, { role: 'user', content: 'First' }];
    assert.equal(await h.controller.promptMessages(messages, '1', null, sink), '');
    assert.equal(batches.join(''), expected);
    assert.ok(batches.every(b => b.length > 0 && b.length <= 4096 && b.isWellFormed()));
    assert.equal(batches.length, 4);
    assert.deepEqual(clone.promptStreaming.mock.calls[0][0], messages);
    assert.equal(clone.prompt.mock.calls.length, 0);
    assert.equal(clone.destroy.mock.calls.length, 1);
    assert.equal(h.seed.prompt.mock.calls.length, 0);
    assert.equal(h.model.availability.mock.calls.length, 1);
});

test('streaming coalesces small chunks and stops reads while acknowledgement is pending', async () => {
    const clone = streamedClone(Array(100).fill('x'));
    const h = await statelessHarness(async () => clone);
    const batches = [];
    let acknowledge;
    const sink = { invokeMethodAsync: (method, text) => {
        batches.push(text);
        return batches.length === 1 ? new Promise(resolve => acknowledge = resolve) : Promise.resolve();
    } };
    const pending = h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1', null, sink);
    await flush();
    assert.equal(clone.pull.mock.calls.length, 32);
    assert.equal(batches.length, 1);
    await assert.rejects(h.controller.promptMessages([{ role: 'user', content: 'Overlap' }], '2'), /already/);
    acknowledge();
    await pending;
    assert.deepEqual(batches.map(b => b.length), [32, 32, 32, 4]);
    assert.equal(clone.destroy.mock.calls.length, 1);
});

test.each(['cancel', 'timeout', 'pagehide', 'removed', 'callbackFailure'])(
    'streaming %s during backpressure releases clone and reader', async action => {
        const clone = streamedClone(['x'.repeat(4096), 'never read']);
        const h = await statelessHarness(async () => clone);
        vi.useFakeTimers();
        try {
            let callbackReached;
            const reached = new Promise(resolve => callbackReached = resolve);
            const sink = { invokeMethodAsync: () => {
                callbackReached();
                return action === 'callbackFailure' ? Promise.reject(new Error('Disconnected callback')) : new Promise(() => {});
            } };
            const pending = h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1', null, sink);
            const rejected = assert.rejects(pending);
            await reached;
            h.controller.cancelPrompt('wrong');
            assert.equal(clone.promptStreaming.mock.calls[0][1].signal.aborted, false);
            if (action === 'cancel') h.controller.cancelPrompt('1');
            if (action === 'timeout') await vi.advanceTimersByTimeAsync(120000);
            if (action === 'pagehide') h.lifecycle.dispatchEvent(new Event('pagehide'));
            if (action === 'removed') h.removed();
            await rejected;
            assert.equal(clone.destroy.mock.calls.length, 1);
            assert.equal(clone.cancel.mock.calls.length, 1);
            assert.equal(clone.pull.mock.calls.length, 1);
            if (!['pagehide', 'removed'].includes(action))
                assert.equal(await h.controller.promptMessages([{ role: 'user', content: 'Retry' }], '2'), 'Recovered');
        } finally { vi.useRealTimers(); }
    });

test('stream cancellation releases a pending native read even when the model ignores abort', async () => {
    const cancel = vi.fn();
    const clone = { promptStreaming: () => new ReadableStream({ cancel }), destroy: vi.fn() };
    const h = await statelessHarness(async () => clone);
    const pending = h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1', null, { invokeMethodAsync: vi.fn() });
    const rejected = assert.rejects(pending);
    await flush();
    h.controller.cancelPrompt('1');
    await rejected;
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(clone.destroy.mock.calls.length, 1);
});

test('stream failure after partial output propagates without fallback and allows retry', async () => {
    let reads = 0;
    const clone = { promptStreaming: () => new ReadableStream({ pull(controller) {
        if (++reads === 1) controller.enqueue('x'.repeat(4096));
        else controller.error(new Error('Native stream failed'));
    } }, { highWaterMark: 0 }), destroy: vi.fn(), prompt: vi.fn(async () => 'Recovered') };
    const h = await statelessHarness(async () => clone);
    const sink = { invokeMethodAsync: vi.fn(async () => {}) };
    await assert.rejects(h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1', null, sink), /Native stream failed/);
    assert.equal(sink.invokeMethodAsync.mock.calls.length, 1);
    assert.equal(clone.destroy.mock.calls.length, 1);
    assert.equal(clone.prompt.mock.calls.length, 0);
    assert.equal(await h.controller.promptMessages([{ role: 'user', content: 'Retry' }], '2'), 'Recovered');
});

test('streaming unsupported capability and structured output fail explicitly', async () => {
    const clone = { destroy: vi.fn(), prompt: vi.fn() };
    const h = await statelessHarness(vi.fn(async () => clone));
    const sink = { invokeMethodAsync: vi.fn() };
    const messages = [{ role: 'user', content: 'Hi' }];
    await assert.rejects(h.controller.promptMessages(messages, '1', {}, sink), /structured/);
    assert.equal(h.seed.clone.mock.calls.length, 0);
    await assert.rejects(h.controller.promptMessages(messages, '2', null, sink), /streaming/);
    assert.equal(clone.destroy.mock.calls.length, 1);
    assert.equal(clone.prompt.mock.calls.length, 0);
});


test('hiding a tab does not create a background job or cancel an active completed request', async () => {
    let resolve;
    const clone = { prompt: vi.fn(() => new Promise(r => resolve = r)), destroy: vi.fn() };
    const h = await statelessHarness(async () => clone);
    const pending = h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1');
    await flush();
    h.document.visibilityState = 'hidden';
    h.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(clone.prompt.mock.calls[0][1].signal.aborted, false);
    assert.equal(clone.destroy.mock.calls.length, 0);
    resolve('Finished while hidden');
    assert.equal(await pending, 'Finished while hidden');
    assert.equal(clone.destroy.mock.calls.length, 1);
    assert.equal(h.model.create.mock.calls.length, 1);
    assert.equal(h.model.availability.mock.calls.length, 1);
});

test.each([false, true])('pagehide persisted=%s destroys the job; pageshow cannot resume its session', async persisted => {
    const clone = streamedClone(['x'.repeat(4096), 'Unread']);
    const h = await statelessHarness(async () => clone);
    let reached;
    const callback = new Promise(resolve => reached = resolve);
    const sink = { invokeMethodAsync: () => { reached(); return new Promise(() => {}); } };
    const pending = h.controller.promptMessages([{ role: 'user', content: 'Hi' }], '1', null, sink);
    const rejected = assert.rejects(pending);
    await callback;
    h.lifecycle.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
    await rejected;
    h.lifecycle.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
    await assert.rejects(h.controller.promptMessages([{ role: 'user', content: 'Resume' }], '2'), /Initialize/);
    assert.equal(clone.destroy.mock.calls.length, 1);
    assert.equal(clone.cancel.mock.calls.length, 1);
    assert.equal(h.seed.destroy.mock.calls.length, 1);
    assert.equal(h.model.create.mock.calls.length, 1);
});
