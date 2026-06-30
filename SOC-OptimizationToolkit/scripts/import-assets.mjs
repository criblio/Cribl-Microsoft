// Copy the language-agnostic data assets from the original trees into packages/core/assets/.
// Idempotent: re-run to refresh from the source of truth. See packages/core/assets/README.md.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const toolkit = resolve(here, '..'); // SOC-OptimizationToolkit/
const repoRoot = resolve(toolkit, '..'); // repo root
const assets = join(toolkit, 'packages', 'core', 'assets');

const armSrcBase = join(
  repoRoot,
  'Azure',
  'CustomDeploymentTemplates',
  'DCR-Templates',
  'SentinelNativeTables',
);
const armVariants = ['DataCollectionRules(DCE)', 'DataCollectionRules(NoDCE)'];

const packSources = [
  join(repoRoot, 'packs', 'cloudflare-sentinel_0-5-8.crbl'),
  join(repoRoot, 'Azure', 'dev', 'Azure_vNet_FlowLogs', 'AzureFlowLogs.crbl'),
];

async function importArmTemplates() {
  for (const variant of armVariants) {
    const src = join(armSrcBase, variant);
    if (!existsSync(src)) {
      console.warn(`skip (missing): ${src}`);
      continue;
    }
    const dest = join(assets, 'arm-templates', variant);
    await mkdir(dest, { recursive: true });
    await cp(src, dest, { recursive: true });
    const count = (await readdir(dest)).filter((f) => f.endsWith('.json')).length;
    console.log(`arm-templates/${variant}: ${count} templates`);
  }
}

async function importPacks() {
  const dest = join(assets, 'cribl-packs');
  await mkdir(dest, { recursive: true });
  for (const src of packSources) {
    if (!existsSync(src)) {
      console.warn(`skip (missing): ${src}`);
      continue;
    }
    await cp(src, join(dest, basename(src)));
    console.log(`cribl-packs/${basename(src)}`);
  }
}

await importArmTemplates();
await importPacks();
console.log('Done. Assets in packages/core/assets/.');
