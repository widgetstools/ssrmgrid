/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AG_GRID_LICENSE?: string;
  /** Fallback: run Perspective on main thread instead of nested worker. */
  readonly VITE_PERSPECTIVE_ON_MAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}

declare module "*.js?url" {
  const url: string;
  export default url;
}
