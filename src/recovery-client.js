// Retransmit only until the controller confirms receipt of the exact request.
export function createRecoveryClient({ send, onReceipt, now = () => Date.now() }) {
  let pending = null;
  function transmit() {
    pending.sentAt = now();
    send("recovery-request", { reason: pending.reason, requestId: pending.id });
  }
  function request(reason) {
    if (pending) return;
    pending = { id: crypto.randomUUID(), reason, confirmed: false };
    transmit();
  }
  function tick() {
    if (pending && !pending.confirmed && now() - pending.sentAt >= 10000) transmit();
  }
  function acknowledge(message) {
    if (
      !pending ||
      message.requestId !== pending.id ||
      !["queued", "running", "blocked"].includes(message.status)
    )
      return;
    if (pending.confirmed) return;
    pending.confirmed = true;
    onReceipt(message);
  }
  return {
    request,
    tick,
    acknowledge,
    clear() {
      pending = null;
    },
  };
}
