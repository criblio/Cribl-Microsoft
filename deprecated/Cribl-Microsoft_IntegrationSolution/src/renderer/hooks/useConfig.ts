import { useState, useEffect, useCallback } from 'react';

interface UseConfigReturn {
  data: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  save: (data: Record<string, unknown>) => Promise<void>;
}

export function useConfig(configPath: string): UseConfigReturn {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!window.api) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.api.config.read(configPath);
      setData(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [configPath]);

  const save = useCallback(async (newData: Record<string, unknown>) => {
    if (!window.api) return;
    try {
      await window.api.config.write(configPath, newData);
      setData(newData);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    }
  }, [configPath]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload, save };
}
