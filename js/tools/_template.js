// Example of the contract — not routed. Copy the shape, not the content.
import { h, card, button, busy, filePicker, notice, progress, resultCard, stem } from '../ui.js';

export async function mount(root, toolId) {
  let file = null;
  const out = h('div');
  const go = button('Do it', () => busy(go, async () => {
    out.replaceChildren();
    if (!file) return out.append(notice('Choose a file first.', 'warn'));
    const p = progress('Working…'); out.append(p.el);
    try {
      const blob = new Blob([await file.arrayBuffer()], { type: file.type });
      p.done();
      out.append(await resultCard({ title: 'Ready', blob, filename: `${stem(file.name)}_copy`, before: file.size }));
    } catch (e) { p.fail(e.message || 'Something went wrong'); }
  }), { full: true });
  root.append(
    card({ title: 'Your file' }, filePicker({ accept: '*/*', label: 'Choose a file', onFiles: f => { file = f[0]; } })),
    go, out);
}
