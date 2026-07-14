/**
 * useRunner - the tiny async-action state hook shared by the Setup page's
 * Azure sections (promoted verbatim from the cloud shell's Diagnostics
 * panels): a status pill plus a monospace output area. The task either
 * resolves to the output text (status ok) or throws; thrown errors are
 * reported verbatim (status failed).
 */

import { useCallback, useState } from "react";

export type RunnerStatus = "idle" | "running" | "ok" | "failed";

export function useRunner(): [
  RunnerStatus,
  string,
  (task: () => Promise<string>) => Promise<void>,
] {
  const [status, setStatus] = useState<RunnerStatus>("idle");
  const [output, setOutput] = useState("");
  const run = useCallback(async (task: () => Promise<string>) => {
    setStatus("running");
    setOutput("");
    try {
      setOutput(await task());
      setStatus("ok");
    } catch (err) {
      setOutput(String(err));
      setStatus("failed");
    }
  }, []);
  return [status, output, run];
}
