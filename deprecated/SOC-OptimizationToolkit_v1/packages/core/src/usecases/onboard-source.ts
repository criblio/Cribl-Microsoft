// OnboardSource — the walking-skeleton usecase (docs/adr/0010 + roadmap Phase 1).
// Orchestrates one source end to end: configure the source, deploy the Sentinel DCR,
// wire the Cribl destination. Pure orchestration: depends only on ports, never on adapters.
import { toDirectDcrName } from '../domain/dcr-name';
import type {
  SourceConnector,
  DcrDeployer,
  CriblClient,
  ProgressSink,
  OnboardInput,
  OnboardResult,
} from '../ports/index';

export interface OnboardSourceDeps {
  readonly source: SourceConnector;
  readonly dcr: DcrDeployer;
  readonly cribl: CriblClient;
  readonly progress: ProgressSink;
}

export class OnboardSource {
  constructor(private readonly deps: OnboardSourceDeps) {}

  async run(input: OnboardInput): Promise<OnboardResult> {
    const { source, dcr, cribl, progress } = this.deps;

    const sourceType = source.describe().type;
    progress.report({ phase: 'source', message: `source connector: ${sourceType}` });

    const dcrName = toDirectDcrName(input.sourceTable, input.dcrPrefix ?? 'dcr', input.location);
    progress.report({ phase: 'dcr', message: `deploying Direct DCR ${dcrName}` });
    const deployed = await dcr.deployDirect(dcrName);

    progress.report({ phase: 'cribl', message: `creating Cribl destination for ${dcrName}` });
    const destination = await cribl.createSentinelDestination({
      name: dcrName,
      dcrId: deployed.id,
    });

    progress.report({ phase: 'done', message: `onboarded ${input.sourceTable} -> Sentinel` });
    return {
      sourceType,
      dcrName,
      dcrId: deployed.id,
      criblDestinationId: destination.id,
    };
  }
}
