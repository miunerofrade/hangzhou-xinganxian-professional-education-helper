// Schedule both tracks together so their handoff does not depend on JS callbacks.
export function createMenuMotion({ panel, launcher, reducedMotion }) {
  let menuAnimation = null,
    ballAnimation = null,
    generation = 0;
  const enterEase = "cubic-bezier(.16,1,.3,1)";
  const exitEase = "cubic-bezier(.4,0,1,1)";
  const translate = (x) => `translate3d(${x}px,0,0)`;
  function opacity(element, fallback) {
    const value = Number.parseFloat(getComputedStyle(element).opacity);
    return Number.isFinite(value) ? value : fallback;
  }
  function transition(open) {
    const ticket = ++generation;
    const menuCurrent = menuAnimation && panel.getBoundingClientRect?.();
    const ballCurrent = ballAnimation && launcher.getBoundingClientRect?.();
    const ballOpacity = opacity(launcher, open ? 1 : 0);
    menuAnimation?.cancel();
    ballAnimation?.cancel();
    menuAnimation = null;
    ballAnimation = null;
    if (reducedMotion() || typeof panel.animate !== "function") {
      panel.hidden = !open;
      launcher.style.opacity = open ? "0" : "";
      launcher.style.pointerEvents = open ? "none" : "";
      panel.style.willChange = "";
      launcher.style.willChange = "";
      return;
    }
    panel.hidden = false;
    const menu = panel.getBoundingClientRect?.();
    const ball = launcher.getBoundingClientRect?.();
    const left = ball ? ball.left + ball.width / 2 < window.innerWidth / 2 : false;
    // Include the shadow in the offscreen distance, avoiding a clipped shadow at rest.
    const menuOutside = menu
      ? left
        ? -(menu.right + 80)
        : window.innerWidth - menu.left + 80
      : left
        ? -window.innerWidth
        : window.innerWidth;
    const ballOutside = ball
      ? left
        ? -(ball.right + 24)
        : window.innerWidth - ball.left + 24
      : 80;
    const menuStart = menuCurrent && menu ? menuCurrent.left - menu.left : open ? menuOutside : 0;
    const ballStart = ballCurrent && ball ? ballCurrent.left - ball.left : open ? 0 : ballOutside;
    const hasBallMotion = typeof launcher.animate === "function";
    panel.style.willChange = "transform";
    launcher.style.opacity = open ? "0" : "";
    launcher.style.pointerEvents = open ? "none" : "";
    const activeMenu = panel.animate(
      [{ transform: translate(menuStart) }, { transform: translate(open ? 0 : menuOutside) }],
      {
        duration: open ? 380 : 300,
        delay: open && hasBallMotion && !menuCurrent ? 100 : 0,
        easing: open ? enterEase : exitEase,
        fill: "both",
      },
    );
    menuAnimation = activeMenu;
    activeMenu.finished
      .then(() => {
        if (ticket !== generation) return;
        if (!open) panel.hidden = true;
        // Set the resting state before removing the filled animation.
        panel.style.willChange = "";
        menuAnimation = null;
        activeMenu.cancel();
      })
      .catch(() => {});
    if (!hasBallMotion) return;
    launcher.style.willChange = "transform, opacity";
    const activeBall = launcher.animate(
      [
        {
          transform: translate(ballStart),
          opacity: ballCurrent ? ballOpacity : open ? 1 : 0,
        },
        { transform: translate(open ? ballOutside : 0), opacity: open ? 0 : 1 },
      ],
      {
        duration: open ? 160 : 260,
        delay: open ? 0 : 220,
        easing: open ? exitEase : enterEase,
        fill: "both",
      },
    );
    ballAnimation = activeBall;
    activeBall.finished
      .then(() => {
        if (ticket !== generation) return;
        launcher.style.opacity = open ? "0" : "";
        launcher.style.willChange = "";
        ballAnimation = null;
        activeBall.cancel();
      })
      .catch(() => {});
  }
  return { transition };
}
