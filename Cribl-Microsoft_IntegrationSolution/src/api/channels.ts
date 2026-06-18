// Channel/path conversion -- the one place that knows how an IPC channel name maps to a web
// API route. Channels are colon-separated ('auth:status'); web routes are slash-separated
// ('auth/status'). This rule was previously duplicated in api-client.ts (call) and
// api-router.ts (middleware); both now import from here.
//
// This module is renderer-safe (no electron import) so the web client can use it.

/** 'auth:cribl-connect' -> 'auth/cribl-connect' (for fetch URLs). */
export function channelToPath(channel: string): string {
  return channel.replace(/:/g, '/');
}

/** 'auth/cribl-connect' -> 'auth:cribl-connect' (for routing an incoming request to a handler). */
export function pathToChannel(path: string): string {
  return path.replace(/\//g, ':');
}
