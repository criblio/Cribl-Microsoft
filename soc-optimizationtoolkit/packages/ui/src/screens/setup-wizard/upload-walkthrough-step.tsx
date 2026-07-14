/**
 * UploadWalkthroughStep - the cribl-side Connect step for the CRIBL-HOSTED
 * target: the .tgz packaging + upload-to-leader walkthrough. This is GUIDANCE
 * for installing the app into a Cribl.Cloud workspace (it references the
 * existing package flow - `npm run package` - it does not rebuild packaging).
 * The Cribl connection is implicit once the app runs inside the leader, so
 * there is no credential form here.
 */

export interface UploadWalkthroughStepProps {
  /**
   * The packaged artifact name, if the shell knows it (e.g. the built .tgz).
   * Defaults to the conventional name.
   */
  artifactName?: string;
}

// The upload walkthrough steps, kept as data so the numbering is stable and the
// copy lives in one place.
const UPLOAD_STEPS: readonly string[] = [
  "Build the app bundle from the toolkit repo: run `npm run package` - it produces the distributable .tgz.",
  "Sign in to your Cribl.Cloud workspace as an admin.",
  "Open the workspace leader (Manage, then the leader for your Organization).",
  "Go to Settings, then Global Settings, then Distributed Settings, then Apps (or your workspace's App management surface).",
  "Choose Add App / Upload App and select the .tgz produced in step 1.",
  "Confirm the upload; the leader unpacks and registers the app.",
  "Open the app from the workspace nav - it runs Cribl-hosted, so the Cribl connection is already granted by the platform.",
];

export function UploadWalkthroughStep({ artifactName }: UploadWalkthroughStepProps) {
  const name = artifactName !== undefined && artifactName !== "" ? artifactName : "the packaged .tgz";
  return (
    <div className="wizard-step">
      <h2 className="wizard-step-title">Install the app into your Cribl leader</h2>
      <p className="panel-desc">
        The Cribl-hosted target runs this app inside your Cribl.Cloud workspace
        leader. Package the app once and upload {name} to the leader - the Cribl
        connection is then implicit (granted by the platform), so there is no
        token to enter here.
      </p>
      <div className="discovery-result">
        <span className="field-label">Package and upload</span>
        <ol className="setup-steps">
          {UPLOAD_STEPS.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
        <p className="field-hint">
          This walkthrough references the existing package flow; it does not
          change how the bundle is built. Once the app is running inside the
          leader you can continue - Azure is still connected separately in the
          next step.
        </p>
      </div>
    </div>
  );
}
