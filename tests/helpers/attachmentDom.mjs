import { vi } from 'vitest';

class Element extends EventTarget {
    children = [];
    isConnected = true;
    textContent = '';
    value = '';
    attributes = {};
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren() { for (const node of this.children) node.parent = null; this.children = []; }
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focused = true; }
}

export function attachmentDom() {
    const root = new Element();
    const picker = new Element();
    const fields = new Element();
    const previews = new Element();
    const status = new Element();
    const error = new Element();
    root.querySelector = selector => ({ '[data-image-picker]': picker, '[data-image-controls]': fields,
        '[data-image-previews]': previews, '[data-image-status]': status, '[data-image-error]': error })[selector];
    vi.stubGlobal('document', { body: {}, createElement: () => new Element() });
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation((_, index) => `blob:${++id}`);
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    return { root, picker, fields, previews, status, error, created, revoked };
}
let id = 0;

export function file(name = 'image.png', type = 'image/png', size = 12) {
    const result = new File(['image'], name, { type });
    Object.defineProperty(result, 'size', { value: size });
    return result;
}

export function choose(dom, files) {
    dom.picker.files = files;
    dom.picker.dispatchEvent(new Event('change'));
}

export function transfer(dom, kind, files, text = '') {
    const event = new Event(kind, { cancelable: true });
    const data = { files, types: files.length ? ['Files'] : ['text/plain'], getData: () => text };
    Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data });
    dom.root.dispatchEvent(event);
    return event;
}
