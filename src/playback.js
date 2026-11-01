export const playbackBlocked = (error) =>
  ["NotAllowedError", "SecurityError", "NotSupportedError"].includes(error.name);
// Call play before yielding: the trusted-click path must retain browser user activation.
export function requestPlayback(player, timeoutMs = 0) {
  const playing = player.play();
  if (!timeoutMs) return playing;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("播放启动等待超时")), timeoutMs);
  });
  return Promise.race([playing, timeout]).finally(() => clearTimeout(timer));
}
