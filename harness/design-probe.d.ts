/** The design-token stylesheets, as absolute paths, in the order they layer. */
export const TOKEN_SOURCES: string[];

export interface Failure {
  width: number;
  /** The page as first rendered, or once no live panel was loading. */
  state: 'first-render' | 'settled';
  check: string;
  element: string;
  detail: string;
}

export interface Report {
  url: string;
  widths: number[];
  tokenColors: number;
  failureCount: number;
  failures: Failure[];
}

export interface Browser {
  cdp: {
    send(method: string, params?: object, sessionId?: string): Promise<unknown>;
    close(): void;
  };
  close(): Promise<void>;
}

/** Reads DevToolsActivePort; throws as readFileSync does while the file is not written yet. */
export type ReadPort = (path: string) => string;

/** Deletes the browser's temporary profile; a failure that outlasts the retries is only a warning. */
export type RemoveProfile = (path: string, options: { recursive: true; force: true }) => void;

/** `portTimeoutMs` is how long to wait for the DevTools port (45 s by default). */
export function launchBrowser(
  readPort?: ReadPort,
  portTimeoutMs?: number,
  remove?: RemoveProfile,
): Promise<Browser>;
export function probe(url: string, readPort?: ReadPort, remove?: RemoveProfile): Promise<Report>;

export const PORT_FILE_NOT_WRITTEN_YET: ReadonlySet<string>;
