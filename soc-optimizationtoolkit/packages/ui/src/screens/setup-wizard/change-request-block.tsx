/**
 * ChangeRequestBlock - the "generate a change request" affordance promoted
 * from the cloud shell's Diagnostics panels, for operators who must ASK
 * another team to perform a setup step (create the app registration, assign
 * roles, or create resources) rather than doing it themselves. The ticket
 * body and the Mermaid architecture diagram embedded in it come entirely from
 * @soc/core via the `generate` closure; this component only handles
 * rendering, clipboard copy, and download (through the ArtifactSink port, so
 * it works identically in both shells). The generated text is shown in a
 * monospace <pre>; the embedded diagram is a fenced mermaid block whose
 * source is plain text, so it pastes safely anywhere and renders wherever
 * Markdown+Mermaid is supported.
 */

import { useState } from "react";
import { usePorts } from "../../ports-context";

export interface ChangeRequestBlockProps {
  title: string;
  description: string;
  /** Downloaded filename. */
  filename: string;
  generate: () => string;
}

export function ChangeRequestBlock({
  title,
  description,
  filename,
  generate,
}: ChangeRequestBlockProps) {
  const { ports } = usePorts();
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState("");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("Copied to clipboard.");
    } catch (err) {
      setFeedback(`Copy failed: ${String(err)}`);
    }
  };

  // Download the ticket as plain text so it can be attached or pasted into a
  // ticketing system without the terminal multi-line paste prompt.
  const download = async () => {
    try {
      await ports.artifacts.save(filename, "text/plain", text);
      setFeedback(`Download dispatched (${filename}).`);
    } catch (err) {
      setFeedback(`Download failed: ${String(err)}`);
    }
  };

  return (
    <div className="change-request">
      <span className="field-label">{title}</span>
      <p className="panel-desc">{description}</p>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => {
            setText(generate());
            setFeedback("");
          }}
        >
          Generate change request
        </button>
        {text !== "" && (
          <>
            <button className="run-button" onClick={() => void copy()}>
              Copy
            </button>
            <button className="run-button" onClick={() => void download()}>
              Download {filename}
            </button>
          </>
        )}
      </div>
      {text !== "" && <pre className="result">{text}</pre>}
      {feedback !== "" && <p className="panel-desc">{feedback}</p>}
    </div>
  );
}
