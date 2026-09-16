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

/**
 * What the verdict means, in a sentence a person can act on.
 *
 * `pass` / `revise` / `reject` are the database's words. A reviewer wants to
 * know whether they can send it, so the headline answers that and the detail
 * says what follows.
 */
const VERDICT: Record<string, { headline: string; detail: string }> = {
  pass: {
    headline: "Ready to send",
    detail:
      "Every computed check passed and the judged scores are sound. Read it if you want to, " +
      "then approve the channels you want it on.",
  },
  revise: {
    headline: "Needs work before it goes out",
    detail:
      "Something below did not meet the bar. You can still approve it if you disagree, or " +
      "send it back with a note saying what to change.",
  },
  reject: {
    headline: "Not usable as written",
    detail:
      "This failed badly enough that editing it is likely to cost more than rewriting. The " +
      "detail below says what went wrong.",
  },
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
          {evaluation.error ?? "No reason was recorded."} This is not a pass, an evaluation that
          did not happen can never become one, so the draft was not approved on its behalf.
        </p>
      </div>
    );
  }

  // `not_evaluated` returned above, so the remaining three are all mapped.
  const verdict = VERDICT[evaluation.status] ?? VERDICT.revise!;
  const computed = evaluation.computed;
  const judged = evaluation.judged as Record<string, JudgedCriterion> | null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {/* The verdict in a sentence, before any detail.
          "revise" is the database's word for it; a reviewer wants to know
          whether they can send this and what stands in the way. The scores
          below are how they check that answer, not how they find it. */}
      <div
        className={`alert small mb-0 ${
          evaluation.status === "pass"
            ? "alert-ok"
            : evaluation.status === "reject"
              ? "alert-error"
              : "alert-warn"
        }`}
      >
        <strong>{verdict.headline}</strong>
        <p className="mb-0 mt-1">{verdict.detail}</p>
      </div>

      {/* The judge's verdict is stored and displayed, but it does not decide.
          A model returning `pass` while a computed check fails is overruled,
          and the disagreement is logged (§11.2). */}
      {evaluation.judge_overruled && (
        <div className="alert alert-warn small mb-0">
          The reviewing model said <strong>{evaluation.judge_verdict}</strong>, but a measured
          check is failing. The measurement stands, a model does not get to overrule a fact.
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
            {/* The whole sentence, never a slice. This is the evidence the
                reviewer has to judge, a claim cut off at "round three is a c…"
                cannot be checked, which defeats the point of listing it. */}
            {evaluation.unsupported_claims!.slice(0, 8).map((claim, i) => (
              <blockquote key={i} className="claim-quote">
                {claim.sentence}
                {claim.labels.length > 0 && (
                  <span className="dim">, cites {claim.labels.join(", ")}</span>
                )}
              </blockquote>
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
              <blockquote key={i} className="claim-quote">
                {claim.sentence}
                {claim.groundingScore != null && (
                  <span className="dim">, {(claim.groundingScore * 100).toFixed(0)}% match</span>
                )}
              </blockquote>
            ))}
          </div>
        </section>
      )}

      {(evaluation.recommended_changes?.length ?? 0) > 0 && (
        <section>
          <h4 className="tiny strong mb-1">Recommended changes</h4>
          {/* A numbered list, most important first. This was one dense
              paragraph of nine edits run together, which had to be unpicked
              before any of it could be acted on. */}
          <ol className="change-list">
            {evaluation.recommended_changes!.map((change, i) => (
              <li key={i}>{change}</li>
            ))}
          </ol>
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
