/**
 * LoggingMapPanel - details on demand for the selected scope of the Azure
 * Logging Map (AZR-19, phase 1, READ-ONLY): breadcrumb, what is set here,
 * what is inherited (with its origin and what it does here), exclusions,
 * exemptions, and for each assignment its ranked ownership evidence, logging
 * class, managed identity and that identity's roles. Plus the trace control
 * and its summary.
 *
 * HONESTY RULES this panel renders (inventory-honesty):
 * - exemptions: a VERIFIED zero says "No exemptions at this scope"; a refused
 *   read says "Exemptions could not be read" plus the role - never "none";
 * - assignments: a refused read says "Assignments could not be read", never
 *   "Nothing is assigned";
 * - roles: a refused or capped read says so; "no roles" is said only for a
 *   read that answered with zero grants.
 */

import type { ReactNode } from "react";
import { isExpired, normaliseScopeId, type PolicyExemption, type RoleGrant } from "@soc/core";

import {
  ancestorIds,
  isShown,
  type LoggingMapUiState,
  type UiLoggingMap,
  type UiMapAssignment,
} from "./logging-map-state";
import {
  ASSIGNMENTS_REFUSED,
  EVIDENCE_LABEL,
  EXEMPTIONS_REFUSED,
  KIND_WORD,
  NO_ASSIGNMENTS_HERE,
  NO_EXEMPTIONS,
  ROLES_EMPTY_VERIFIED,
  ROLES_REFUSED,
  ROLES_ROLE_HINT,
  STRENGTH_LABEL,
  classSentence,
  coveragePill,
  coverageSentence,
  ownerPill,
  portalLink,
  readRoleFor,
  refusalText,
  rolesNoteText,
  traceSummaryText,
  unreadSentence,
} from "./logging-map-copy";

export interface LoggingMapPanelProps {
  readonly map: UiLoggingMap;
  readonly state: LoggingMapUiState;
  /** ISO time of the read, used only to mark expired exemptions. */
  readonly now: string;
  readonly onTrace: (assignmentKey: string | null) => void;
  readonly onSelect: (scopeId: string) => void;
}

function lastSegment(id: string): string {
  const parts = id.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? id;
}

function nameOf(entry: UiMapAssignment): string {
  return entry.assignment.displayName !== "" ? entry.assignment.displayName : entry.assignment.name;
}

function scopeName(map: UiLoggingMap, id: string): string {
  return map.tree.byId.get(id)?.displayName ?? lastSegment(id);
}

function RolesBlock({ entry }: { entry: UiMapAssignment }): ReactNode {
  const roles = entry.roles;
  if (roles === null) {
    return <p className="lm-note" data-lm-roles="note">{rolesNoteText(entry.rolesNote ?? "not-read")}</p>;
  }
  if (roles.state === "refused") {
    const capped = /cap reached/i.test(roles.refusal.text);
    return (
      <p className="lm-note lm-note-unknown" data-lm-roles="refused">
        {capped ? "Roles not read: cap reached." : `${ROLES_REFUSED} ${refusalText(roles.refusal)} ${ROLES_ROLE_HINT}`}
      </p>
    );
  }
  if (roles.rows.length === 0) {
    return <p className="lm-note" data-lm-roles="none">{ROLES_EMPTY_VERIFIED}</p>;
  }
  return (
    <>
      <ul className="lm-roles" data-lm-roles="rows">
        {roles.rows.map((g: RoleGrant, i) => (
          <li key={`${g.roleDefinitionId}|${g.scope}|${i}`} className="lm-role-row">
            <span className="lm-role-name">{g.roleName ?? "role name not read"}</span>
            <span className="lm-role-scope">{g.scope}</span>
          </li>
        ))}
      </ul>
      {entry.rolesNote === "some-not-read" && <p className="lm-note">{rolesNoteText("some-not-read")}</p>}
    </>
  );
}

function AssignmentCard({
  map,
  entry,
  scopeId,
  inherited,
  traced,
  onTrace,
}: {
  map: UiLoggingMap;
  entry: UiMapAssignment;
  scopeId: string;
  inherited: boolean;
  traced: boolean;
  onTrace: (key: string | null) => void;
}) {
  const a = entry.assignment;
  const owner = entry.ownership?.owner ?? null;
  const strength = entry.ownership?.strength ?? "none";
  const here = entry.coverage.byScope.get(scopeId)?.coverage ?? null;
  const gapPill = coveragePill(here);
  const cls = inherited ? "lm-acard lm-acard-inherited" : owner === "ours" ? "lm-acard lm-acard-ours" : "lm-acard lm-acard-other";
  const identity = entry.identity;
  return (
    <div className={cls} data-lm-assignment={entry.assignmentKey}>
      <div className="lm-acard-head">
        <span className={owner === "ours" ? "lm-pill lm-pill-ours" : "lm-pill lm-pill-other"}>{ownerPill(owner)}</span>
        {strength === "name-only" && <span className="lm-pill lm-pill-name">name match</span>}
        {entry.unclassified && <span className="lm-pill lm-pill-unread">unclassified</span>}
        {gapPill !== null && (
          <span className="lm-pill lm-pill-gap" data-lm-coverage-pill="">
            {gapPill}
          </span>
        )}
        <b className="lm-acard-name">{nameOf(entry)}</b>
      </div>
      {(inherited || (here !== null && here.state !== "covered" && here.state !== "not-reached")) && (
        <p className="lm-note" data-lm-coverage={here?.state ?? ""}>
          {coverageSentence(here, scopeName(map, entry.originId))}
        </p>
      )}
      <dl className="lm-dl">
        <dt>What</dt>
        <dd>{classSentence(entry.classification)}</dd>
        <dt>Set at</dt>
        <dd>{scopeName(map, entry.originId)}</dd>
        <dt>Owner</dt>
        <dd>
          {STRENGTH_LABEL[strength]}
          {(entry.ownership?.evidence.length ?? 0) > 0 && (
            <ol className="lm-evidence">
              {entry.ownership?.evidence.map((ev, i) => (
                <li key={`${ev.kind}-${i}`} data-lm-evidence={ev.kind}>
                  <span className="lm-evidence-kind">{EVIDENCE_LABEL[ev.kind]}</span>
                  {ev.detail !== "" && <span className="lm-evidence-detail">{`: ${ev.detail}`}</span>}
                </li>
              ))}
            </ol>
          )}
        </dd>
        {a.notScopes.length > 0 && (
          <>
            <dt>Excludes</dt>
            <dd>{a.notScopes.map((s) => scopeName(map, normaliseScopeId(s))).join(", ")}</dd>
          </>
        )}
        <dt>Identity</dt>
        <dd>
          {identity.type === "" || identity.type.toLowerCase() === "none" ? (
            "None"
          ) : (
            <>
              <span>{identity.type}</span>
              {identity.principalId !== null && <span className="lm-mono">{` principal ${identity.principalId}`}</span>}
              {identity.userAssigned.map((u) => (
                <span key={u.id} className="lm-identity-ua">
                  {lastSegment(u.id)}
                  {u.principalId !== null && <span className="lm-mono">{` principal ${u.principalId}`}</span>}
                </span>
              ))}
            </>
          )}
        </dd>
        <dt>Roles</dt>
        <dd>
          <RolesBlock entry={entry} />
          {entry.legacyGrantedRoles.length > 0 && (
            <p className="lm-note" data-lm-legacy-roles="">
              {`The earlier toolkit granted this identity: ${entry.legacyGrantedRoles
                .map((r) => `${r.roleName} (${r.at})`)
                .join(", ")}.`}
            </p>
          )}
        </dd>
      </dl>
      <button type="button" className="lm-btn" aria-pressed={traced} onClick={() => onTrace(traced ? null : entry.assignmentKey)}>
        {traced ? "Stop tracing" : "Trace"}
      </button>
    </div>
  );
}

function ExemptionRows({ rows, now, map }: { rows: readonly PolicyExemption[]; now: string; map: UiLoggingMap }) {
  return (
    <ul className="lm-exemptions">
      {rows.map((x) => {
        const target = map.assignmentsByKey.get(normaliseScopeId(x.policyAssignmentId));
        const expired = isExpired(x.expiresOn, now);
        return (
          <li key={x.id} className="lm-exemption-row">
            <b>{x.name}</b>
            {x.category !== "" && <span className="lm-pill lm-pill-gap">{x.category}</span>}
            <span>{` for ${target !== undefined ? nameOf(target) : lastSegment(x.policyAssignmentId)}`}</span>
            <span className="lm-note">
              {x.expiresOn === null
                ? " does not expire"
                : expired
                  ? ` expired ${x.expiresOn.slice(0, 10)}, information only`
                  : ` expires ${x.expiresOn.slice(0, 10)}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function LoggingMapPanel({ map, state, now, onTrace, onSelect }: LoggingMapPanelProps) {
  const traced = state.tracedAssignment === null ? undefined : map.assignmentsByKey.get(state.tracedAssignment);
  const n = state.selectedScope === null ? undefined : map.nodesById.get(state.selectedScope);

  const trace = traced !== undefined && (
    <div className="lm-panel-trace" data-lm-trace-summary="">
      <span className="lm-eyebrow">Tracing</span>
      <h3 className="lm-panel-title">{nameOf(traced)}</h3>
      <p className="lm-note">{`Set on ${scopeName(map, traced.originId)}: ${traceSummaryText(traced.summary)}`}</p>
      <button type="button" className="lm-btn" onClick={() => onTrace(null)}>
        Stop tracing
      </button>
    </div>
  );

  if (n === undefined) {
    return (
      <aside className="lm-panel" aria-live="polite">
        {trace}
        <p className="lm-note">Select a scope to see what is assigned there.</p>
      </aside>
    );
  }

  const node = n.node;
  const crumbs = [...ancestorIds(map, node.id)].reverse();
  const assignmentsUnread = node.kind !== "placeholder" && n.assignments.kind === "empty";
  const unread = unreadSentence(node, assignmentsUnread);
  const setHere = n.setHere.map((k) => map.assignmentsByKey.get(k)).filter((e) => e !== undefined);
  const shownHere = setHere.filter((e) => isShown(e, state.showAll));
  const hiddenHere = setHere.length - shownHere.length;
  const inherited = n.inherited
    .map((ref) => map.assignmentsByKey.get(ref.assignmentKey))
    .filter((e) => e !== undefined)
    .filter((e) => isShown(e, state.showAll));
  const exclusions = n.gaps
    .filter((g) => g.coverage.state === "excluded")
    .map((g) => map.assignmentsByKey.get(g.assignmentKey))
    .filter((e) => e !== undefined);
  const isRealScope = node.kind !== "placeholder" && node.treeRole !== "unread-origin";

  return (
    <aside className="lm-panel" aria-live="polite">
      {trace}
      <div>
        <span className="lm-eyebrow">{KIND_WORD[node.kind]}</span>
        <h3 className="lm-panel-title">{node.displayName}</h3>
        <nav className="lm-crumbs" aria-label="Path">
          {crumbs.map((id) => (
            <span key={id}>
              <button type="button" className="lm-crumb" onClick={() => onSelect(id)}>
                {scopeName(map, id)}
              </button>
              {" > "}
            </span>
          ))}
          <span>{node.displayName}</span>
        </nav>
        {node.kind !== "placeholder" && <div className="lm-mono lm-scope-id">{node.id}</div>}
      </div>

      {unread !== null && (
        <div className="lm-unread-block" data-lm-unread="">
          <b>Can&apos;t be read</b>
          <p className="lm-note">{`${unread} ${readRoleFor(node.kind)}`}</p>
        </div>
      )}

      {node.kind !== "placeholder" && (
        <section className="lm-panel-section">
          <h4 className="lm-eyebrow">{`Set here (${assignmentsUnread || node.treeRole === "unread-origin" ? "unknown" : shownHere.length})`}</h4>
          {shownHere.length > 0 ? (
            <div className="lm-alist">
              {shownHere.map((e) => (
                <AssignmentCard
                  key={e.assignmentKey}
                  map={map}
                  entry={e}
                  scopeId={node.id}
                  inherited={false}
                  traced={state.tracedAssignment === e.assignmentKey}
                  onTrace={onTrace}
                />
              ))}
            </div>
          ) : assignmentsUnread ? (
            <p className="lm-note lm-note-unknown">{`${ASSIGNMENTS_REFUSED} ${readRoleFor(node.kind)}`}</p>
          ) : node.treeRole === "unread-origin" ? (
            <p className="lm-note lm-note-unknown">Only the assignments seen from scopes below are known.</p>
          ) : hiddenHere === 0 ? (
            <p className="lm-note">{NO_ASSIGNMENTS_HERE}</p>
          ) : null}
          {hiddenHere > 0 && (
            <p className="lm-note">{`${hiddenHere} other assignment${hiddenHere === 1 ? " is" : "s are"} set here but hidden by the default view. Turn on All policy to show ${hiddenHere === 1 ? "it" : "them"}.`}</p>
          )}
        </section>
      )}

      {inherited.length > 0 && (
        <section className="lm-panel-section">
          <h4 className="lm-eyebrow">{`Inherited (${inherited.length})`}</h4>
          <div className="lm-alist">
            {inherited.map((e) => (
              <AssignmentCard
                key={e.assignmentKey}
                map={map}
                entry={e}
                scopeId={node.id}
                inherited
                traced={state.tracedAssignment === e.assignmentKey}
                onTrace={onTrace}
              />
            ))}
          </div>
        </section>
      )}

      {exclusions.length > 0 && (
        <section className="lm-panel-section">
          <h4 className="lm-eyebrow">{`Excluded here (${exclusions.length})`}</h4>
          <ul className="lm-exemptions">
            {exclusions.map((e) => (
              <li key={e.assignmentKey}>{`${nameOf(e)}: excluded by notScopes, set at ${scopeName(map, e.originId)}.`}</li>
            ))}
          </ul>
        </section>
      )}

      {isRealScope && (
        <section className="lm-panel-section" data-lm-exemptions={n.exemptions.kind}>
          <h4 className="lm-eyebrow">Exemptions</h4>
          {n.exemptions.kind === "empty" ? (
            <p className="lm-note lm-note-unknown">{`${EXEMPTIONS_REFUSED} ${readRoleFor(node.kind)}`}</p>
          ) : n.exemptions.kind === "none" ? (
            <p className="lm-note">{NO_EXEMPTIONS}</p>
          ) : (
            <ExemptionRows rows={n.exemptions.rows} now={now} map={map} />
          )}
        </section>
      )}

      {isRealScope && (
        <a className="lm-portal-link" href={portalLink(node.id)} target="_blank" rel="noopener noreferrer">
          Open in the Azure portal
        </a>
      )}
    </aside>
  );
}
