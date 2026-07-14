// Perspective's browser bootstrap references customElements before checking
// init_client(); polyfill so WASM client init works inside a Vite worker.
if (typeof globalThis.customElements === "undefined") {
  Object.defineProperty(globalThis, "customElements", {
    value: { get: () => undefined },
    writable: true,
    configurable: true,
  });
}
