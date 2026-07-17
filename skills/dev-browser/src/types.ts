// API request/response types - shared between client and server

export type BrowserMode = "dev" | "stealth" | "user";

export interface ServeOptions {
  port?: number;
  headless?: boolean;
  cdpPort?: number;
  /** Directory to store persistent browser profiles (cookies, localStorage, etc.) */
  profileDir?: string;
  /** Browser mode: dev (default), stealth (anti-fingerprinting), user (connect to main browser) */
  browserMode?: BrowserMode;
  /** CDP port for user mode - where user's Chrome is listening */
  userCdpPort?: number;
}

export interface GetPageRequest {
  name: string;
  /**
   * Owning project (= tmux session name, which is also the page-name prefix).
   * Sent by the client from PROJECT_PREFIX so the server can enforce a
   * per-project tab cap. The server cannot derive this from `name`: prefixes
   * themselves contain hyphens (e.g. "my-project-main" splits to "my"), so
   * splitting on "-" guesses wrong. Optional — an unknown owner is left uncapped
   * rather than mis-capped against someone else's tabs.
   */
  project?: string;
}

export interface GetPageResponse {
  wsEndpoint: string;
  name: string;
  targetId: string; // CDP target ID for reliable page matching
}

export interface ListPagesResponse {
  pages: string[];
}

export interface ServerInfoResponse {
  wsEndpoint: string;
}
