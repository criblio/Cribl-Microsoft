/**
 * EventHubDiscoveryScreen - in-app Event Hub discovery (roadmap Phase 4,
 * EVH-03 + LOG-16). One Resource Graph query inventories every namespace in
 * the active subscription, one bounded ARM GET per namespace lists its hubs,
 * and the user selects hubs to generate Cribl Stream Event Hub source configs
 * (the verbatim legacy template: Kafka format, SASL PLAIN, text-secret
 * reference per namespace) plus the connection-strings reference - downloaded
 * through the ArtifactSink.
 *
 * All request/parse/generate logic is the pure @soc/core eventhub-discovery
 * module + the discoverEventHubs usecase; this component only renders and
 * drives IO through the ports (ZERO direct fetch here).
 */

import { useCallback, useMemo, useState } from "react";
import {
  EH_DEFAULT_CONSUMER_GROUP,
  buildConnectionStringsReference,
  buildEventHubSourceConfig,
  discoverEventHubs,
} from "@soc/core";
import type { EventHubDiscoveryResult, EventHubInfo } from "@soc/core";
import { usePorts } from "../../ports-context";

/** The stable selection key for one hub. */
function hubKey(hub: EventHubInfo): string {
  return `${hub.namespace}/${hub.name}`;
}

export function EventHubDiscoveryScreen() {
  const { ports, config } = usePorts();

  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [result, setResult] = useState<EventHubDiscoveryResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupId, setGroupId] = useState(EH_DEFAULT_CONSUMER_GROUP);
  const [generated, setGenerated] = useState<string>("");
  const [saveNotice, setSaveNotice] = useState("");

  const runDiscovery = useCallback(async () => {
    if (discovering || config.subscriptionId === "") {
      return;
    }
    setDiscovering(true);
    setDiscoverError("");
    setSaveNotice("");
    setGenerated("");
    setSelected(new Set());
    try {
      const found = await discoverEventHubs(
        ports.azure,
        { subscriptionId: config.subscriptionId },
        ports.logger,
      );
      setResult(found);
    } catch (err) {
      setResult(null);
      setDiscoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  }, [discovering, config.subscriptionId, ports.azure, ports.logger]);

  const toggleHub = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const hubs = useMemo(() => result?.hubs ?? [], [result]);
  const allSelected = hubs.length > 0 && selected.size === hubs.length;
  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(hubs.map(hubKey)));
  }, [allSelected, hubs]);

  const selectedHubs = useMemo(
    () => hubs.filter((hub) => selected.has(hubKey(hub))),
    [hubs, selected],
  );

  // Generate the source configs + secrets reference for the selection. Pure
  // projection; nothing is deployed.
  const generate = useCallback(() => {
    const group = groupId.trim() === "" ? EH_DEFAULT_CONSUMER_GROUP : groupId.trim();
    const sources = selectedHubs.map((hub) =>
      buildEventHubSourceConfig(hub.namespace, hub.name, group),
    );
    const bundle = {
      sources,
      connectionStrings: buildConnectionStringsReference(
        selectedHubs.map((hub) => hub.namespace),
      ),
    };
    setGenerated(JSON.stringify(bundle, null, 2));
    setSaveNotice("");
  }, [selectedHubs, groupId]);

  const download = useCallback(async () => {
    if (generated === "") {
      return;
    }
    setSaveNotice("");
    try {
      await ports.artifacts.save(
        "cribl-eventhub-sources.json",
        "application/json",
        generated,
      );
      setSaveNotice("Saved cribl-eventhub-sources.json through the artifact sink.");
    } catch (err) {
      setSaveNotice(
        `Could not save: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [generated, ports.artifacts]);

  // Group hubs per namespace for display.
  const byNamespace = useMemo(() => {
    const map = new Map<string, EventHubInfo[]>();
    for (const hub of hubs) {
      const list = map.get(hub.namespace);
      if (list === undefined) {
        map.set(hub.namespace, [hub]);
      } else {
        list.push(hub);
      }
    }
    return map;
  }, [hubs]);

  return (
    <div className="panel">
      <h2 className="panel-title">Event Hub Discovery</h2>
      <p className="panel-desc">
        Inventories every Event Hub namespace in the active subscription with
        one Resource Graph query (Reader role required), lists the hubs inside
        each, and generates Cribl Stream Event Hub source configurations for
        the hubs you select. Generation is local: nothing is deployed, and the
        connection strings stay in Azure - the configs reference a Cribl text
        secret per namespace that you create in the worker group.
      </p>

      <div className="panel-controls">
        <button
          className="next-action-button"
          onClick={() => void runDiscovery()}
          disabled={discovering || config.subscriptionId === ""}
        >
          {discovering
            ? "Discovering..."
            : result === null
              ? "Discover Event Hubs"
              : "Re-discover"}
        </button>
        {config.subscriptionId === "" && (
          <span className="field-hint">
            Commit an Azure target scope first (Azure Targeting) so discovery
            knows the subscription.
          </span>
        )}
      </div>

      {discoverError !== "" && <pre className="result">{discoverError}</pre>}

      {result !== null && (
        <>
          <p className="field-hint">
            {result.namespaces.length} namespace
            {result.namespaces.length === 1 ? "" : "s"}, {hubs.length} event hub
            {hubs.length === 1 ? "" : "s"} discovered.
          </p>
          {result.warnings.map((warning) => (
            <p className="field-hint eh-warning" key={warning}>
              {warning}
            </p>
          ))}

          {hubs.length > 0 && (
            <>
              <label className="integrate-check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                />
                <span className="integrate-check-text">
                  Select all {hubs.length} hubs
                </span>
              </label>

              {[...byNamespace.entries()].map(([namespace, nsHubs]) => {
                const ns = result.namespaces.find((n) => n.name === namespace);
                return (
                  <div className="discovery-result" key={namespace}>
                    <span className="field-label">
                      {namespace}
                      {ns !== undefined
                        ? ` (${ns.skuName}, ${ns.location}, ${ns.resourceGroup})`
                        : ""}
                    </span>
                    {nsHubs.map((hub) => {
                      const key = hubKey(hub);
                      return (
                        <label className="integrate-check" key={key}>
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggleHub(key)}
                          />
                          <span className="integrate-check-text">
                            {hub.name}
                            {hub.partitionCount !== null
                              ? ` - ${hub.partitionCount} partition${hub.partitionCount === 1 ? "" : "s"}`
                              : ""}
                            {hub.messageRetentionInDays !== null
                              ? `, ${hub.messageRetentionInDays}d retention`
                              : ""}
                            {hub.status !== "" ? `, ${hub.status}` : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}

              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Consumer group</span>
                  <input
                    type="text"
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="field-hint">
                    Used by every generated source. Create a dedicated consumer
                    group per worker group to avoid partition contention;
                    {" "}{EH_DEFAULT_CONSUMER_GROUP} works for testing.
                  </span>
                </label>
              </div>

              <div className="panel-controls">
                <button
                  className="run-button"
                  onClick={generate}
                  disabled={selectedHubs.length === 0}
                >
                  Generate Cribl source configs ({selectedHubs.length} selected)
                </button>
                {generated !== "" && (
                  <button className="run-button" onClick={() => void download()}>
                    Download JSON
                  </button>
                )}
              </div>
              {saveNotice !== "" && <span className="field-hint">{saveNotice}</span>}
              {generated !== "" && (
                <>
                  <p className="field-hint">
                    Import each source into the worker group (or paste into a
                    pack), then create the per-namespace text secrets listed
                    under connectionStrings - the config references them; the
                    key itself never leaves Azure until you paste it there.
                  </p>
                  <pre className="result eh-generated">{generated}</pre>
                </>
              )}
            </>
          )}
          {hubs.length === 0 && result.namespaces.length === 0 && (
            <p className="field-hint">
              No Event Hub namespaces found in this subscription.
            </p>
          )}
        </>
      )}
    </div>
  );
}
