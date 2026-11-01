// Help disclosure lifecycle and placement, shared by all info triggers.
export function bindInfoDisclosures({ ui, $, lifecycle }) {
  let openedInfo = null;
  function closeInfo() {
    if (!openedInfo) return;
    openedInfo.content.hidden = true;
    openedInfo.button.setAttribute("aria-expanded", "false");
    openedInfo = null;
  }
  lifecycle.on(ui, "click", (event) => {
    const button = event.target.closest?.("[data-info]");
    if (!button) return;
    const content = $("#" + button.dataset.info),
      shouldOpen = content.hidden;
    closeInfo();
    if (shouldOpen) {
      content.hidden = false;
      content.style.transform = "";
      const panel = $("#panel");
      if (content.getBoundingClientRect && panel.getBoundingClientRect) {
        const rect = content.getBoundingClientRect(),
          bounds = panel.getBoundingClientRect(),
          pad = 8;
        const dx =
          rect.left < bounds.left + pad
            ? bounds.left + pad - rect.left
            : rect.right > bounds.right - pad
              ? bounds.right - pad - rect.right
              : 0;
        const dy =
          rect.bottom > bounds.bottom - pad
            ? Math.max(bounds.top + pad - rect.top, bounds.bottom - pad - rect.bottom)
            : 0;
        content.style.transform = `translate(${dx}px,${dy}px)`;
      }
      button.setAttribute("aria-expanded", "true");
      openedInfo = { button, content };
    }
  });
  return {
    close: closeInfo,
    get opened() {
      return openedInfo;
    },
  };
}
