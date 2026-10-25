/** Types for the two exports of design-probe.js the tests use. */
export interface Failure {
  width: number;
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
