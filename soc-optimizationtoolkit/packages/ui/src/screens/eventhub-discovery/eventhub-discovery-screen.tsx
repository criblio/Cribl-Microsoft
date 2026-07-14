/**
 * EventHubDiscoveryScreen - in-app Event Hub discovery (roadmap Phase 4,
 * EVH-03/04/07/08 + LOG-16). One Resource Graph query inventories every
 * namespace, one bounded ARM GET per namespace lists its hubs, a second
 * Resource Graph query discovers the CONFIGURED senders (diagnostic settings
 * targeting Event Hubs), and an opt-in activity check (one metrics GET per
 * hub, capped) feeds the pure unknown-sender inference - which hubs are worth
 * onboarding and where visibility gaps are. Selected hubs generate Cribl
 * Stream source configs (the verbatim legacy template) plus the
 * connection-strings reference - downloaded through the ArtifactSink.
 *
 * All request/parse/generate logic is the pure @soc/core eventhub-discovery
 * module + the discoverEventHubs usecase; this component only renders and
 * drives IO through the ports (ZERO direct fetch here).
 */

import { useCallback, useMemo, useState } from "react";
import {
  EH_ACTIVITY_LOOKBACK_DAYS,
  EH_DEFAULT_CONSUMER_GROUP,
  analyzeHubFindings,
  buildConnectionStringsReference,
  buildEventHubSourceConfig,
  checkEventHubActivity,
  deriveEhStatistics,
  discoverEventHubSenders,
  discoverEventHubs,
  enumerateEventHubDetails,
  inferSendersFromEnumeration,
  sendersForHub,
} from "@soc/core";
import type {
  DiagnosticSettingSender,
  EventHubDiscoveryResult,
  EventHubInfo,
  HubActivity,
  HubEnumeration,
  HubFindings,
} from "@soc/core";
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
  // EVH-04: configured senders (one extra Resource Graph query, best-effort).
  const [senders, setSenders] = useState<DiagnosticSettingSender[] | null>(null);
  const [senderNote, setSenderNote] = useState("");
  // EVH-07: opt-in per-hub activity (one metrics call per hub, capped).
  const [activityByHub, setActivityByHub] = useState<Map<string, HubActivity> | null>(null);
  const [activityWarnings, setActivityWarnings] = useState<string[]>([]);
  const [checkingActivity, setCheckingActivity] = useState(false);
  // EVH-06: opt-in consumer-group + auth-rule enumeration (2 calls per hub).
  const [enumerationByHub, setEnumerationByHub] = useState<Map<string, HubEnumeration> | null>(null);
  const [enumWarnings, setEnumWarnings] = useState<string[]>([]);
  const [enumerating, setEnumerating] = useState(false);

  const runDiscovery = useCallback(async () => {
    if (discovering || config.subscriptionId === "") {
      return;
    }
    setDiscovering(true);
    setDiscoverError("");
    setSaveNotice("");
    setGenerated("");
    setSelected(new Set());
    setActivityByHub(null);
    setActivityWarnings([]);
    setEnumerationByHub(null);
    setEnumWarnings([]);
    try {
      const found = await discoverEventHubs(
        ports.azure,
        { subscriptionId: config.subscriptionId },
        ports.logger,
      );
      setResult(found);
      // Sender discovery is an ENRICHMENT: one more Resource Graph query,
      // best-effort - a failure degrades to a note, never hides the inventory.
      try {
        setSenders(
          await discoverEventHubSenders(
            ports.azure,
            { subscriptionId: config.subscriptionId },
            ports.logger,
          ),
        );
        setSenderNote("");
      } catch (senderErr) {
        setSenders(null);
        setSenderNote(
          `Configured-sender discovery unavailable: ${senderErr instanceof Error ? senderErr.message : String(senderErr)}`,
        );
      }
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

  // EVH-07: opt-in activity check. The timespan is minted HERE (the impure
  // component layer; core never reads a clock): the last N days, ISO/ISO.
  const runActivityCheck = useCallback(async () => {
    if (checkingActivity || hubs.length === 0) {
      return;
    }
    setCheckingActivity(true);
    setActivityWarnings([]);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - EH_ACTIVITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const checked = await checkEventHubActivity(
        ports.azure,
        hubs,
        `${start.toISOString()}/${end.toISOString()}`,
        ports.logger,
      );
      setActivityByHub(checked.activityByHub);
      setActivityWarnings(checked.warnings);
    } catch (err) {
      setActivityWarnings([err instanceof Error ? err.message : String(err)]);
    } finally {
      setCheckingActivity(false);
    }
  }, [checkingActivity, hubs, ports.azure, ports.logger]);

  // EVH-06: opt-in enumeration - two ARM calls per hub, capped in the usecase.
  const runEnumeration = useCallback(async () => {
    if (enumerating || hubs.length === 0) {
      return;
    }
    setEnumerating(true);
    setEnumWarnings([]);
    try {
      const result = await enumerateEventHubDetails(ports.azure, hubs, ports.logger);
      setEnumerationByHub(result.enumerationByHub);
      setEnumWarnings(result.warnings);
    } catch (err) {
      setEnumWarnings([err instanceof Error ? err.message : String(err)]);
    } finally {
      setEnumerating(false);
    }
  }, [enumerating, hubs, ports.azure, ports.logger]);

  // Configured-sender counts and EVH-08 findings per hub (pure projections).
  const senderCountByHub = useMemo(() => {
    const map = new Map<string, number>();
    if (senders !== null) {
      for (const hub of hubs) {
        map.set(hubKey(hub), sendersForHub(senders, hub.namespace, hub.name).length);
      }
    }
    return map;
  }, [senders, hubs]);

  const findingsByHub = useMemo(() => {
    const map = new Map<string, HubFindings>();
    if (activityByHub !== null) {
      for (const hub of hubs) {
        const key = hubKey(hub);
        map.set(
          key,
          analyzeHubFindings(senderCountByHub.get(key) ?? 0, activityByHub.get(key)),
        );
      }
    }
    return map;
  }, [activityByHub, hubs, senderCountByHub]);

  const stats = useMemo(
    () =>
      activityByHub !== null
        ? deriveEhStatistics(activityByHub, findingsByHub)
        : null,
    [activityByHub, findingsByHub],
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

              <div className="panel-controls">
                <button
                  className="run-button"
                  onClick={() => void runActivityCheck()}
                  disabled={checkingActivity}
                >
                  {checkingActivity
                    ? "Checking activity..."
                    : activityByHub === null
                      ? `Check activity (last ${EH_ACTIVITY_LOOKBACK_DAYS} days)`
                      : "Re-check activity"}
                </button>
                <span className="field-hint">
                  One metrics call per hub - flags which hubs actually receive
                  data and which active hubs have no configured sources
                  (visibility gaps worth onboarding).
                </span>
                <button
                  className="run-button"
                  onClick={() => void runEnumeration()}
                  disabled={enumerating}
                >
                  {enumerating
                    ? "Enumerating..."
                    : enumerationByHub === null
                      ? "Enumerate consumer groups + access rules"
                      : "Re-enumerate"}
                </button>
                <span className="field-hint">
                  Two calls per hub - consumer-group names (they seed the
                  source config) and Send-capable access rules hint at existing
                  consumers/senders.
                </span>
              </div>
              {stats !== null && (
                <p className="field-hint">
                  {stats.activeEventHubs} active, {stats.inactiveEventHubs}{" "}
                  inactive, {stats.eventHubsWithUnknownSenders} with unknown
                  senders.
                </p>
              )}
              {senderNote !== "" && (
                <p className="field-hint eh-warning">{senderNote}</p>
              )}
              {activityWarnings.map((warning) => (
                <p className="field-hint eh-warning" key={warning}>
                  {warning}
                </p>
              ))}
              {enumWarnings.map((warning) => (
                <p className="field-hint eh-warning" key={warning}>
                  {warning}
                </p>
              ))}

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
                      const activity = activityByHub?.get(key);
                      const findings = findingsByHub.get(key);
                      return (
                        <div key={key}>
                          <label className="integrate-check">
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
                              {senders !== null
                                ? ` - ${senderCountByHub.get(key) ?? 0} configured source${(senderCountByHub.get(key) ?? 0) === 1 ? "" : "s"}`
                                : ""}
                              {activity !== undefined && (
                                <span
                                  className={
                                    activity.isActive
                                      ? "eh-activity eh-activity-active"
                                      : "eh-activity eh-activity-idle"
                                  }
                                >
                                  {activity.error !== undefined
                                    ? `metrics unavailable (${activity.error})`
                                    : activity.isActive
                                      ? `ACTIVE - ${Math.round(activity.incomingMessages).toLocaleString()} msgs/${EH_ACTIVITY_LOOKBACK_DAYS}d`
                                      : "inactive"}
                                </span>
                              )}
                            </span>
                          </label>
                          {findings !== undefined &&
                            findings.notes.map((note) => (
                              <p
                                className={
                                  findings.hasUnknownSenders
                                    ? "field-hint eh-finding eh-warning"
                                    : "field-hint eh-finding"
                                }
                                key={note}
                              >
                                {note}
                              </p>
                            ))}
                          {(() => {
                            const enumeration = enumerationByHub?.get(key);
                            if (enumeration === undefined) {
                              return null;
                            }
                            const inferred = inferSendersFromEnumeration(enumeration);
                            return (
                              <>
                                <p className="field-hint eh-finding">
                                  Consumer groups:{" "}
                                  {enumeration.consumerGroups.length > 0
                                    ? enumeration.consumerGroups.join(", ")
                                    : "(none)"}
                                </p>
                                {inferred.map((hint) => (
                                  <p
                                    className="field-hint eh-finding"
                                    key={`${hint.inferredFrom}:${hint.name}`}
                                  >
                                    Hint ({hint.inferredFrom}): {hint.name}
                                    {hint.rights !== undefined
                                      ? ` [${hint.rights.join(", ")}]`
                                      : ""}{" "}
                                    - {hint.note}.
                                  </p>
                                ))}
                              </>
                            );
                          })()}
                        </div>
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
