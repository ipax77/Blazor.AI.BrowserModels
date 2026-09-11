// Files and preview URLs are owned exclusively by this browser-side controller.
const maxFiles = 4;
const maxBytes = 10 * 1024 * 1024;
const types = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type Attachments = ReturnType<typeof createAttachments>;

export function createAttachments(root: HTMLElement, supported: boolean, onDispose: () => void) {
    const picker = root.querySelector<HTMLInputElement>('[data-image-picker]')!;
    const fields = root.querySelector<HTMLFieldSetElement>('[data-image-controls]')!;
    const previews = root.querySelector<HTMLElement>('[data-image-previews]')!;
    const status = root.querySelector<HTMLElement>('[data-image-status]')!;
    const error = root.querySelector<HTMLElement>('[data-image-error]')!;
    const entries: { file: File; url: string; node: HTMLElement }[] = [];
    let disabled = true;
    let busy = false;
    let disposed = false;
    const locked = () => disposed || disabled || busy || !supported;
    function update() {
        fields.disabled = locked();
        status.textContent = supported
            ? `${entries.length} of ${maxFiles} images attached. PNG, JPEG or WebP; up to 10 MiB each. Original resolution.`
            : 'Image attachments are unsupported in this session. Text chat is available.';
    }
    function add(files: Iterable<File>) {
        if (locked()) return;
        const errors: string[] = [];
        for (const file of files) {
            if (!types.has(file.type)) { errors.push(`${file.name}: choose a PNG, JPEG or WebP image.`); continue; }
            if (!file.size || file.size > maxBytes) { errors.push(`${file.name}: choose a nonempty image no larger than 10 MiB.`); continue; }
            if (entries.length === maxFiles) { errors.push('You can attach up to four images. Remove an image to add another.'); break; }
            const url = URL.createObjectURL(file);
            const node = document.createElement('div');
            node.className = 'image-attachment';
            const image = document.createElement('img');
            image.src = url;
            image.alt = file.name;
            image.decoding = 'async';
            const name = document.createElement('span');
            name.textContent = file.name;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', `Remove ${file.name}`);
            const entry = { file, url, node };
            remove.addEventListener('click', () => {
                if (locked()) return;
                entries.splice(entries.indexOf(entry), 1);
                URL.revokeObjectURL(url);
                node.remove();
                error.textContent = '';
                update();
                picker.focus();
            });
            node.append(image, name, remove);
            previews.append(node);
            entries.push(entry);
        }
        error.textContent = errors.join(' ');
        update();
    }
    function change() {
        add(Array.from(picker.files ?? []));
        picker.value = '';
    }
    function paste(event: ClipboardEvent) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length) return;
        // Mixed clipboard text retains the browser's normal text insertion behavior.
        if (!event.clipboardData?.getData('text/plain')) event.preventDefault();
        add(files);
    }
    function dragover(event: DragEvent) {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    }
    function drop(event: DragEvent) {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        add(Array.from(event.dataTransfer.files));
    }
    function clear() {
        for (const entry of entries) URL.revokeObjectURL(entry.url);
        entries.length = 0;
        previews.replaceChildren();
        picker.value = '';
        error.textContent = '';
        update();
    }
    function dispose() {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        picker.removeEventListener('change', change);
        root.removeEventListener('paste', paste);
        root.removeEventListener('dragover', dragover);
        root.removeEventListener('drop', drop);
        globalThis.removeEventListener('pagehide', dispose);
        clear();
        onDispose();
    }
    const observer = new MutationObserver(() => { if (!root.isConnected) dispose(); });
    observer.observe(document.body, { childList: true, subtree: true });
    picker.addEventListener('change', change);
    root.addEventListener('paste', paste);
    root.addEventListener('dragover', dragover);
    root.addEventListener('drop', drop);
    globalThis.addEventListener('pagehide', dispose);
    update();
    return {
        snapshot() {
            if (disposed) throw new Error('The attachments have been disposed.');
            return entries.map(entry => entry.file);
        },
        clear,
        setDisabled(value: boolean) { disabled = value; update(); },
        setBusy(value: boolean) { busy = value; update(); },
        dispose
    };
}
