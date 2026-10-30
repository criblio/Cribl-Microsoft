/**
 * The Defender XDR Streaming API step. The coverage catalog marks XDR as a
 * guided-portal item: the Event Hub can be prepared, but the stream itself is
 * configured by a person in the Defender portal and Azure exposes nothing this
 * app can read back (Validate reports it as unmeasurable). The tables come
 * from the catalog's export tiers and the tables-not-supported list.
 *
 * Pure: data and string building only.
 */

import { XDR_TABLES_NOT_SUPPORTED, coverageItem } from "../coverage-model";
import { eventHubNamespacePath } from "../eventhub-arm/eventhub-arm";
import { planNamespace } from "./eventhub-steps";
import type { HowToStep, StepValueRow } from "./steps";

/** The export tiers a sub-selection names, or the catalog's default. */
function tiersFor(subSelection: readonly string[]) {
  const sub = coverageItem("xdrStreaming")?.subSelection;
  const options = sub?.options ?? [];
  const chosen = options.filter((o) => subSelection.includes(o.key));
  if (chosen.length > 0) return chosen;
  return options.filter((o) => (sub?.defaultSelected ?? []).includes(o.key));
}

export const XDR_STEPS: readonly HowToStep[] = [
  {
    id: "xdr-streaming",
    sourceIds: ["xdrStreaming"],
    title: "Turn on the Defender XDR Streaming API to {{namespace}}",
    why: "Microsoft Defender XDR advanced hunting tables leave Microsoft 365 only through the Streaming API, which a person configures in the Defender portal. It writes to the Event Hub namespace you give it.",
    portal: [
      "Open the Microsoft Defender portal and select System, Settings, Microsoft Defender XDR, then Streaming API, then + Add.",
      "Name the stream, choose Forward events to Azure Event Hub, and enter the Event Hub resource ID shown below for the namespace {{namespace}}.",
      "Event Hub name: {{hubName}}. Always enter it: the guide prepares that one hub and its consumer group, and the Cribl source reads that hub only.",
      "Tick the tables in the tiers listed below, then Save.",
    ],
    cli: "",
    values: (v, sub): StepValueRow[] => [
      { label: "Event Hub resource ID", value: eventHubNamespacePath(planNamespace(v)) },
      { label: "Event Hub name", value: v.hubName },
      ...tiersFor(sub).map((t) => ({ label: `Tier ${t.key}`, value: t.detail })),
      { label: "Not available", value: `${XDR_TABLES_NOT_SUPPORTED.tables.join(", ")}. ${XDR_TABLES_NOT_SUPPORTED.reason}` },
    ],
    rbac: [
      "Security Administrator or Global Administrator in Microsoft Entra ID to add a stream.",
      "Contributor on the namespace {{namespace}} in {{resourceGroup}} for the person who saves it, and the Microsoft.Insights resource provider registered in {{subscriptionId}}.",
    ],
    confirmHow: "The Streaming API page lists the stream with the namespace {{namespace}}; Azure cannot be asked about it, so Validate reports it as not measurable and shows hub arrival instead.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "namespace", "hubName"],
    checkKinds: ["xdr-streaming"],
    provenance: "inferred",
    warning: "Some tables are very high volume. Check the tier notes below before ticking them, and plan to filter in Cribl.",
  },
];
