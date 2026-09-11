import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createAttachments } from '../src/Blazor.AI.BrowserModels/TypeScript/attachments.ts';
import { attachmentDom, choose, file, transfer } from './helpers/attachmentDom.mjs';

const controllers = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(supported = true) {
    const lifecycle = new EventTarget();
    let observer;
    vi.stubGlobal('addEventListener', lifecycle.addEventListener.bind(lifecycle));
    vi.stubGlobal('removeEventListener', lifecycle.removeEventListener.bind(lifecycle));
    vi.stubGlobal('MutationObserver', class {
        constructor(callback) { observer = this; this.callback = callback; }
        observe() {}
        disconnect() { this.disconnected = true; }
    });
    const dom = attachmentDom();
    const onDispose = vi.fn();
    const controller = createAttachments(dom.root, supported, onDispose);
    controllers.push(controller);
    controller.setDisabled(false);
    return { ...dom, controller, lifecycle, onDispose, removed() { dom.root.isConnected = false; observer.callback(); } };
}

test('picker retains original files, previews them, removes them, and accepts reselection', () => {
    const h = setup();
    const original = file('<image>.png');
    choose(h, [original]);
    assert.equal(h.controller.snapshot()[0], original);
    assert.equal(h.created.mock.calls[0][0], original);
    assert.equal(h.picker.value, '');
    assert.equal(h.previews.children[0].children[0].alt, original.name);
    assert.equal(h.previews.children[0].children[1].textContent, original.name);
    assert.equal(h.previews.children[0].children[2].attributes['aria-label'], `Remove ${original.name}`);
    h.previews.children[0].children[2].dispatchEvent(new Event('click'));
    assert.equal(h.revoked.mock.calls.length, 1);
    assert.equal(h.controller.snapshot().length, 0);
    assert.equal(h.picker.focused, true);
    choose(h, [original]);
    assert.equal(h.controller.snapshot()[0], original);
});

test('validation retains accepted files and rejects unsupported, empty, oversized, and excess files', () => {
    const h = setup();
    const accepted = file('limit.webp', 'image/webp', 10 * 1024 * 1024);
    choose(h, [accepted, file('bad.svg', 'image/svg+xml'), file('empty.png', 'image/png', 0), file('large.png', 'image/png', 10 * 1024 * 1024 + 1)]);
    assert.deepEqual(h.controller.snapshot(), [accepted]);
    assert.match(h.error.textContent, /bad.svg/);
    assert.match(h.error.textContent, /empty.png/);
    assert.match(h.error.textContent, /large.png/);
    choose(h, [file('a.jpg', 'image/jpeg'), file(), file(), file()]);
    assert.equal(h.controller.snapshot().length, 4);
    assert.equal(h.created.mock.calls.length, 4);
    assert.match(h.error.textContent, /up to four/);
    assert.match(h.status.textContent, /4 of 4/);
});

test('paste and drop add files in order, preserve text paste, and prevent file navigation', () => {
    const h = setup();
    const first = file('first.png');
    const second = file('second.png');
    assert.equal(transfer(h, 'paste', [], 'plain text').defaultPrevented, false);
    assert.equal(transfer(h, 'paste', [first], 'mixed text').defaultPrevented, false);
    assert.equal(transfer(h, 'dragover', [second]).defaultPrevented, true);
    assert.equal(transfer(h, 'drop', [second]).defaultPrevented, true);
    assert.equal(transfer(h, 'paste', [file()]).defaultPrevented, true);
    assert.deepEqual(h.controller.snapshot().slice(0, 2), [first, second]);
});

test('busy and disabled controls reject additions and removal; unsupported sessions stay locked', () => {
    const h = setup();
    choose(h, [file()]);
    h.controller.setBusy(true);
    assert.equal(h.fields.disabled, true);
    choose(h, [file()]);
    transfer(h, 'drop', [file()]);
    transfer(h, 'paste', [file()]);
    h.previews.children[0].children[2].dispatchEvent(new Event('click'));
    assert.equal(h.controller.snapshot().length, 1);
    h.controller.setBusy(false);
    h.controller.setDisabled(true);
    choose(h, [file()]);
    assert.equal(h.controller.snapshot().length, 1);
    h.controller.setDisabled(false);
    assert.equal(h.fields.disabled, false);
    h.controller.dispose();
    const unsupported = setup(false);
    choose(unsupported, [file()]);
    assert.equal(unsupported.controller.snapshot().length, 0);
    assert.equal(unsupported.fields.disabled, true);
    assert.match(unsupported.status.textContent, /unsupported/);
});

test.each(['clear', 'dispose', 'pagehide', 'removed'])('%s releases every URL and file reference', action => {
    const h = setup();
    choose(h, [file(), file()]);
    const urls = h.created.mock.results.map(result => result.value);
    if (action === 'pagehide') h.lifecycle.dispatchEvent(new Event('pagehide'));
    else if (action === 'removed') h.removed();
    else h.controller[action]();
    assert.deepEqual(h.revoked.mock.calls.map(args => args[0]), urls);
    assert.equal(h.previews.children.length, 0);
    if (action === 'clear') assert.deepEqual(h.controller.snapshot(), []);
    else {
        assert.throws(() => h.controller.snapshot(), /disposed/);
        choose(h, [file()]);
        assert.equal(h.previews.children.length, 0);
        assert.equal(h.onDispose.mock.calls.length, 1);
    }
    h.controller.dispose();
    assert.equal(h.revoked.mock.calls.length, 2);
});
