// CLI shell (Phase 0). Proves cli -> @soc/core wiring; real commands land in Phases 1 and 5.
// This is one of the two thin frontends over the same core (the GUI is the other).
import { toDirectDcrName } from '@soc/core';

function main(): void {
  console.log('SOC Optimization Toolkit CLI (Phase 0 shell)');
  console.log('  destination: Microsoft Sentinel  |  pipe: Cribl Stream');
  // Demonstrate a pure core call end to end:
  const example = toDirectDcrName('CommonSecurityLog', 'dcr', 'eastus');
  console.log(`  example Direct DCR name for CommonSecurityLog: ${example}`);
  console.log(
    'Real commands (dcr deploy, onboard, discover) arrive with the Phase 1 walking skeleton.',
  );
}

main();
