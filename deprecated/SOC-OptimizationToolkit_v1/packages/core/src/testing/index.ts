// In-memory fakes for the driven ports. Consumed as `@soc/core/testing` by tests and by
// the CLI/GUI in-memory demo mode (no cloud credentials needed). The real adapters live in
// packages/adapters-* and are swapped in once Azure/Cribl test credentials are available.
import type {
  SourceConnector,
  DcrDeployer,
  CriblClient,
  ProgressSink,
  ProgressEvent,
} from '../ports/index';

export class FakeSourceConnector implements SourceConnector {
  constructor(private readonly type: string = 'event-hub') {}
  describe(): { readonly type: string } {
    return { type: this.type };
  }
}

export class FakeDcrDeployer implements DcrDeployer {
  readonly deployed: string[] = [];
  async deployDirect(name: string): Promise<{ id: string }> {
    this.deployed.push(name);
    return { id: `dcr/${name}` };
  }
}

export class FakeCriblClient implements CriblClient {
  readonly destinations: string[] = [];
  async listDestinations(): Promise<readonly string[]> {
    return this.destinations;
  }
  async createSentinelDestination(args: { name: string; dcrId: string }): Promise<{ id: string }> {
    const id = `dest-${args.name}`;
    this.destinations.push(id);
    return { id };
  }
}

export class RecordingProgressSink implements ProgressSink {
  readonly events: ProgressEvent[] = [];
  report(event: ProgressEvent): void {
    this.events.push(event);
  }
}
