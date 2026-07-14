import { useState, useCallback } from 'react';
import { appendTerminalOutput, clearTerminal } from '../components/Terminal';

interface UsePowerShellReturn {
  isRunning: boolean;
  processId: string | null;
  execute: (script: string, args: string[]) => Promise<void>;
  cancel: () => Promise<void>;
}

export function usePowerShell(): UsePowerShellReturn {
  const [isRunning, setIsRunning] = useState(false);
  const [processId, setProcessId] = useState<string | null>(null);

  const execute = useCallback(async (script: string, args: string[]) => {
    if (!window.api) return;

    setIsRunning(true);
    clearTerminal();

    appendTerminalOutput({
      id: 'system',
      stream: 'system',
      text: `> Executing: ${script} ${args.join(' ')}\n`,
      timestamp: Date.now(),
    });

    try {
      const result = await window.api.powershell.execute(script, args);
      setProcessId(result.id);

      // Wait for process to complete by listening for exit event
      await new Promise<void>((resolve) => {
        const removeExit = window.api.powershell.onExit((event) => {
          if (event.id === result.id) {
            removeExit();
            setIsRunning(false);
            setProcessId(null);
            resolve();
          }
        });
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      appendTerminalOutput({
        id: 'system',
        stream: 'stderr',
        text: `Execution error: ${message}\n`,
        timestamp: Date.now(),
      });
      setIsRunning(false);
      setProcessId(null);
    }
  }, []);

  const cancel = useCallback(async () => {
    if (!window.api || !processId) return;
    try {
      await window.api.powershell.cancel(processId);
      appendTerminalOutput({
        id: 'system',
        stream: 'system',
        text: '-- Process cancelled by user --\n',
        timestamp: Date.now(),
      });
    } catch {
      // Process may have already exited
    }
    setIsRunning(false);
    setProcessId(null);
  }, [processId]);

  return { isRunning, processId, execute, cancel };
}
