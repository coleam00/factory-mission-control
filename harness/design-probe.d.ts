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

export function launchBrowser(readPort?: ReadPort): Promise<Browser>;
export function probe(url: string, readPort?: ReadPort): Promise<Report>;

export const PORT_FILE_NOT_WRITTEN_YET: ReadonlySet<string>;
