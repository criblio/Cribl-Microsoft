// CLI shell (Phase 1). One of the two thin frontends over the same core usecase (the GUI is
// the other). `onboard` drives OnboardSource end to end against in-memory fakes — no cloud
// credentials needed. Real adapters + a live smoke deploy land once Azure/Cribl test creds exist.
import { OnboardSource, toDirectDcrName, type ProgressSink, type ProgressEvent } from '@soc/core';
import { FakeSourceConnector, FakeDcrDeployer, FakeCriblClient } from '@soc/core/testing';

const stdoutSink: ProgressSink = {
  report: (e: ProgressEvent) => console.log(`  [${e.phase}] ${e.message}`),
};

function banner(): void {
  console.log('SOC Optimization Toolkit CLI (Phase 1 walking skeleton)');
  console.log('  destination: Microsoft Sentinel  |  pipe: Cribl Stream');
  const example = toDirectDcrName('CommonSecurityLog', 'dcr', 'eastus');
  console.log(`  example Direct DCR name for CommonSecurityLog: ${example}`);
  console.log('  commands: onboard');
}

async function onboard(): Promise<void> {
  console.log('onboard (in-memory demo): source -> Cribl -> Sentinel');
  const result = await new OnboardSource({
    source: new FakeSourceConnector('event-hub'),
    dcr: new FakeDcrDeployer(),
    cribl: new FakeCriblClient(),
    progress: stdoutSink,
  }).run({ sourceTable: 'CommonSecurityLog', location: 'eastus' });
  console.log('result:', JSON.stringify(result));
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'onboard') {
    await onboard();
  } else {
    banner();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
