export declare const DEFAULT_FAILURE_DIR: string;

export interface RunWithFailureCaptureOptions {
  command: string;
  args: string[];
  failureDir?: string;
  now?: () => string;
}

export interface RunWithFailureCaptureResult {
  code: number;
  capturedTo: string | null;
}

export declare function runWithFailureCapture(
  options: RunWithFailureCaptureOptions,
): Promise<RunWithFailureCaptureResult>;
