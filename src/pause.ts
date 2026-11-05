/** Keep upstream controls, but route their intent through the room authority. */
export function bindSharedPause(
  watch: { paused: boolean; controls: { paused: { peek(): boolean; set(value: boolean): void } } },
  command: (paused: boolean) => void,
) {
  Object.defineProperty(watch, 'paused', {
    configurable: true,
    get: () => watch.controls.paused.peek(),
    set: (paused: boolean) => command(paused),
  });
  return (paused: boolean) => watch.controls.paused.set(paused);
}
