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
