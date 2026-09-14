import type { Evaluation, JudgedCriterion } from "@/lib/db/types";

/**
 * The evaluation report. DESIGN.md §14.2.
 *
 * "The evaluation report leads with computed results, because those are facts,
 * and then the judged scores."
 *
 * Two distinctions have to survive to the screen:
 *   · `not_evaluated` is not a pass, and never looks like one (§5.8).
 *   · A criterion the judge could not assess is null WITH a reason, never a
 *     score and never 0 (§11.1).
 */

const CRITERION_LABELS: Record<string, string> = {
  topicRelevance: "Topic relevance",
  audienceFit: "Audience fit",
  tone: "Tone",
  clarity: "Clarity",
};

export function EvaluationReport({ evaluation }: { evaluation: Evaluation | null }) {
  if (!evaluation) {
    return <p className="small muted">This version has not been evaluated.</p>;
  }

  if (evaluation.status === "not_evaluated") {
    return (
      <div className="alert alert-warn small mb-0">
        <strong>The evaluation could not run.</strong>
        <p className="mb-0 mt-1">
          {evaluation.error ?? "No reason was recorded."} This is not a pass — an evaluation that
          did not happen can never become one, so the draft was not approved on its behalf.
        </p>
      </div>
    );
  }

  const computed = evaluation.computed;
  const judged = evaluation.judged as Record<string, JudgedCriterion> | null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between">
        <span className="strong small">Overall</span>
        <span
          className={`pill ${
            evaluation.status === "pass"
              ? "pill-ok"
              : evaluation.status === "reject"
                ? "pill-danger"
                : "pill-warn"
          }`}
        >
          {evaluation.status}
        </span>
      </div>

      {/* The judge's verdict is stored and displayed, but it does not decide.
          A model returning `pass` while a computed check fails is overruled,
          and the disagreement is logged (§11.2). */}
      {evaluation.judge_overruled && (
        <div className="alert alert-warn small mb-0">
          The reviewing model said <strong>{evaluation.judge_verdict}</strong>, but a measured
          check is failing. The measurement stands — a model does not get to overrule a fact.
        </div>
      )}

      {/* ── Computed first, because these are facts ── */}
      {computed && (
        <section>
          <h4 className="tiny strong mb-1" style={{ textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-3)" }}>
            Measured
          </h4>
          <div className="stack" style={{ gap: 7 }}>
            <CheckRow
              label="Source grounding"
              passed={computed.sourceGrounding.passed}
              detail={
                `${computed.sourceGrounding.markedSentences} of ${computed.sourceGrounding.factualSentences} factual sentences cite a source` +
                (computed.sourceGrounding.weakCount > 0
                  ? `, ${computed.sourceGrounding.weakCount} weakly`
                  : "") +
                (computed.sourceGrounding.unsupportedCount > 0
                  ? `, ${computed.sourceGrounding.unsupportedCount} unsupported`
                  : "")
              }
            />
            <CheckRow
              label="Factual consistency"
              passed={computed.factualConsistency.passed}
              detail={
                computed.factualConsistency.unsupportedCandidates === 0 &&
                computed.factualConsistency.numberDisagreements === 0
                  ? "No uncited claims and no figures that disagree with their source"
                  : [
                      computed.factualConsistency.unsupportedCandidates > 0 &&
                        `${computed.factualConsistency.unsupportedCandidates} uncited claim(s)`,
                      computed.factualConsistency.numberDisagreements > 0 &&
                        `${computed.factualConsistency.numberDisagreements} figure(s) not found in the cited excerpt`,
                    ]
                      .filter(Boolean)
                      .join("; ")
              }
            />
            <CheckRow
              label="SEO fit"
              passed={computed.seoFit.passed}
              detail={[
                computed.seoFit.keywordInTitle ? "keyword in title" : "keyword MISSING from title",
                computed.seoFit.keywordInFirst100
                  ? "in first 100 words"
                  : "NOT in first 100 words",
                `${computed.seoFit.linkCount} links`,
                computed.seoFit.linksResolve
                  ? "all resolve to a source"
                  : "a link does NOT resolve to a source",
              ].join(" · ")}
            />
            <CheckRow
              label="Completeness"
              passed={computed.completeness.passed}
              detail={`${computed.completeness.outlineSectionsPresent} of ${computed.completeness.outlineSectionsExpected} planned sections present`}
            />
            {computed.bannedPhrases.length > 0 && (
              <CheckRow
                label="Banned phrases"
                passed={false}
                detail={`Found: ${computed.bannedPhrases.join(", ")}`}
              />
            )}
          </div>
        </section>
      )}

      {/* ── Then judged ── */}
      {judged && (
        <section>
          <h4 className="tiny strong mb-1" style={{ textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-3)" }}>
            Judged
          </h4>
          <div className="stack" style={{ gap: 7 }}>
            {Object.entries(judged).map(([key, criterion]) => (
              <div key={key}>
                <div className="row-between">
                  <span className="small">{CRITERION_LABELS[key] ?? key}</span>
                  <Score criterion={criterion} />
                </div>
                <div className="tiny muted">{criterion.reason}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Flagged claims ── */}
      {(evaluation.unsupported_claims?.length ?? 0) > 0 && (
        <section>
          <h4 className="tiny strong mb-1" style={{ color: "var(--danger)" }}>
            Claims with no support
          </h4>
          <div className="stack" style={{ gap: 6 }}>
            {evaluation.unsupported_claims!.slice(0, 8).map((claim, i) => (
              <div key={i} className="tiny" style={{ color: "var(--text-2)" }}>
                &ldquo;{claim.sentence.slice(0, 160)}
                {claim.sentence.length > 160 && "…"}&rdquo;
                {claim.labels.length > 0 && (
                  <span className="dim"> — cites {claim.labels.join(", ")}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {(evaluation.weak_citations?.length ?? 0) > 0 && (
        <section>
          <h4 className="tiny strong mb-1" style={{ color: "var(--warn)" }}>
            Weakly supported claims
          </h4>
          <p className="tiny muted mb-1">
            The citation is real, but the sentence and the excerpt are only loosely related.
          </p>
          <div className="stack" style={{ gap: 6 }}>
            {evaluation.weak_citations!.slice(0, 6).map((claim, i) => (
              <div key={i} className="tiny" style={{ color: "var(--text-2)" }}>
                &ldquo;{claim.sentence.slice(0, 140)}
                {claim.sentence.length > 140 && "…"}&rdquo;
                {claim.groundingScore != null && (
                  <span className="dim"> — {(claim.groundingScore * 100).toFixed(0)}% match</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {evaluation.recommended_changes && (
        <section>
          <h4 className="tiny strong mb-1">Recommended changes</h4>
          <p className="tiny muted mb-0">{evaluation.recommended_changes}</p>
        </section>
      )}

      {evaluation.overall_note && (
        <p className="tiny muted mb-0" style={{ fontStyle: "italic" }}>
          {evaluation.overall_note}
        </p>
      )}
    </div>
  );
}

function CheckRow({
  label,
  passed,
  detail,
}: {
  label: string;
  passed: boolean;
  detail: string;
}) {
  return (
    <div>
      <div className="row-between">
        <span className="small">{label}</span>
        <span className={`pill tiny ${passed ? "pill-ok" : "pill-danger"}`}>
          {passed ? "pass" : "fail"}
        </span>
      </div>
      <div className="tiny muted">{detail}</div>
    </div>
  );
}

/**
 * A null score is a legitimate answer and is shown as one — never as 0, and
 * never as a number the judge did not give (§11.1, §17).
 */
function Score({ criterion }: { criterion: JudgedCriterion }) {
  if (criterion.score == null) {
    return (
      <span
        className="pill pill-info tiny"
        title="The judge could not assess this. That is recorded as unknown, not as a score of zero."
      >
        not assessed
      </span>
    );
  }

  const tone =
    criterion.score >= 4 ? "pill-ok" : criterion.score === 3 ? "pill-info" : "pill-danger";

  return <span className={`pill tiny ${tone}`}>{criterion.score}/5</span>;
}
