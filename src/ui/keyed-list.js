// Retain DOM identity and scroll position; only insert, move or remove changed keys.
export function createKeyedList({ container, key, create, update }) {
  const entries = new Map();
  function render(items) {
    const live = new Set(items.map(key));
    for (const [id, entry] of entries) {
      if (!live.has(id)) {
        entry.element.remove();
        entries.delete(id);
      }
    }
    items.forEach((item, index) => {
      const id = key(item);
      let entry = entries.get(id);
      if (!entry) {
        entry = create(item);
        entries.set(id, entry);
      }
      update(entry, item, index);
      const next = container.children[index] || null;
      if (next !== entry.element) container.insertBefore(entry.element, next);
    });
  }
  return { render };
}
