/**
 * The deliberately broken input pack. DESIGN.md §21.1.
 *
 * "Built and run BEFORE the happy path, while there is still time to fix what
 * it finds."
 *
 * Every case here is one the spec names. The ones that need no network or
 * database run as assertions; the ones that need a live pipeline are printed
 * as a checklist with the URL or input to use, because a script that pretends
 * to have tested a fetch failure it never made is worse than no script.
 *
 * Usage: npm run broken-pack
 */

import { config } from "dotenv";
config({ quiet: true });

import {
  canonicaliseUrl,
  countXCharacters,
  isValidE164,
  normaliseE164,
  describeBytes,
  segmentSentences,
} from "../src/lib/text";
import {
  checkMarkerIntegrity,
  checkInheritedMarkers,
  runTripwire,
  segmentSentencesWithMarkers,
  type LabelledExcerpt,
} from "../src/lib/pipeline/grounding";
import { rollUpDeliveries, isAlreadyHandled } from "../src/lib/publish/rollup";
import { checkGrants } from "./verify-grants";
import {
  checkLinkedIn,
  checkNewsletter,
  checkX,
  runSeoChecks,
} from "../src/lib/pipeline/checks";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
}

function excerpt(label: string, text: string): LabelledExcerpt {
  return {
    label,
    excerptId: `id-${label}`,
    sourceId: "src-1",
    sourceLabel: "S1",
    text,
    headingPath: null,
    sourceTitle: "A page",
    sourceUrl: "https://example.com/a",
    siteName: "example.com",
    publishedAt: null,
    embedding: null,
  };
}

// ─── Grounding ──────────────────────────────────────────────────────────────

section("Grounding: citations that do not hold up");

{
  const supplied = [excerpt("E1", "Remote hiring grew through 2024.")];

  // "A draft with a citation marker for a non-existent excerpt → hard fail."
  const invented = checkMarkerIntegrity("A claim. [E1] Another. [E99]", supplied);
  check(
    "A marker for a non-existent excerpt is a hard failure",
    !invented.valid && invented.unknownLabels.includes("E99"),
  );

  // "A channel output that introduces a marker the article never had."
  const inherited = checkInheritedMarkers("Post text. [E7]", [
    {
      sentenceIndex: 0,
      sentence: "A claim",
      labels: ["E1"],
      excerptIds: [],
      sourceIds: [],
      groundingScore: 0.8,
      verdict: "grounded",
    },
  ]);
  check(
    "A channel output cannot cite what the article did not",
    !inherited.valid && inherited.unknownLabels.includes("E7"),
  );

  // The tripwire: an unmarked sentence making a checkable claim.
  const tripped = runTripwire("Adoption rose by 42% last year.", [
    "Remote hiring grew through 2024.",
  ]);
  check("An uncited statistic trips the wire", tripped.length === 1);

  const quiet = runTripwire("This is where most teams get stuck.", [
    "Remote hiring grew through 2024.",
  ]);
  check("Ordinary narrative does not trip the wire", quiet.length === 0);

  // The segmentation bug that would shift the whole claim map by one.
  const sentences = segmentSentencesWithMarkers("Adoption rose 42%. [E1] Costs fell. [E2]");
  check(
    "A trailing marker stays on the sentence it belongs to",
    sentences.length === 2 &&
      sentences[0]!.text.includes("[E1]") &&
      sentences[0]!.text.includes("42%"),
    `got ${JSON.stringify(sentences.map((s) => s.text))}`,
  );
}

// ─── Sentence segmentation ──────────────────────────────────────────────────

section("Segmentation: the decimals and abbreviations that corrupt a claim map");

check(
  "A percentage with a decimal is one sentence",
  segmentSentences("Conversions rose 2.5% last quarter. That is real.").length === 2,
);
check(
  "An abbreviation does not end a sentence",
  segmentSentences("Acme Inc. raised a round. Nobody expected it.").length === 2,
);

// ─── URL canonicalisation ───────────────────────────────────────────────────

section("Ingestion: the same article arriving twice");

check(
  "The same article at two URLs with tracking params is one source",
  canonicaliseUrl("https://www.Example.com/post/?utm_source=x&utm_medium=y") ===
    canonicaliseUrl("https://example.com/post#section-2"),
);
check(
  "A meaningful query parameter is kept",
  canonicaliseUrl("https://example.com/s?q=hiring").includes("q=hiring"),
);

// ─── Channel formatting ─────────────────────────────────────────────────────

section("Channel formatting: the rules that break a post");

{
  // "An X post that goes over 280 only once the link is counted."
  const body = `${"x".repeat(262)}\n\nhttps://koya.example/a/post`;
  const result = checkX({
    body,
    hashtags: ["#hiring"],
    coreIdea: "An idea",
    includesLink: true,
  });
  const limit = result.checks.find((c) => c.name.includes("280"))!;
  check("An X post over 280 only via its link is caught", !limit.passed, limit.detail);

  // The inverse: a long URL must not wrongly reject a valid post.
  const longUrl = `${"y".repeat(200)}\n\nhttps://example.com/${"z".repeat(120)}`;
  check(
    "A long URL does not wrongly reject a valid X post",
    countXCharacters(longUrl) <= 280,
    `weighed ${countXCharacters(longUrl)}`,
  );

  // "A 3,000-character LinkedIn post."
  const linkedin = checkLinkedIn({
    body: "x".repeat(3_001),
    cta: "Read it",
    pas: null,
    emojiAllowance: 3,
  });
  check("A 3000-character LinkedIn post fails its check", !linkedin.passed);

  // Newsletter word band, with the ACTUAL count named for the retry.
  const newsletter = checkNewsletter({
    subject: "Short",
    body: "Too short to be a newsletter.",
    cta: "Read it",
  });
  const words = newsletter.checks.find((c) => c.name.includes("250"))!;
  check(
    "A short newsletter fails and the retry is told the real count",
    !words.passed && /is \d+ words/.test(words.detail),
    words.detail,
  );
}

// ─── SEO ────────────────────────────────────────────────────────────────────

section("SEO: the checks that send a draft back");

{
  const article = [
    "# Remote Hiring in Nigeria",
    "",
    "Remote hiring in Nigeria changed twice over.",
    "",
    "## Where teams get stuck",
    "",
    "Onboarding. See [the study](https://a.example/x).",
    "",
    "## What to do",
    "",
    "Write a brief. More in [the follow-up](https://b.example/y).",
  ].join("\n");

  const base = {
    title: "Remote Hiring in Nigeria",
    metaDescription: "A guide.",
    bodyMd: article,
    primaryKeyword: "remote hiring",
    secondaryKeywords: [],
    outline: [
      { heading: "Where teams get stuck", intent: "" },
      { heading: "What to do", intent: "" },
    ],
    allowedUrls: ["https://a.example/x", "https://b.example/y"],
  };

  check("A well-formed article passes", runSeoChecks(base).passed);

  // "A link that does not resolve to a selected source" — which means the
  // server-side substitution failed, not a style problem.
  const invented = runSeoChecks({
    ...base,
    bodyMd: article.replace("https://b.example/y", "https://invented.example/z"),
  });
  check("A link to an unselected source fails", !invented.linksResolve);

  // "A missing outline section is a Completeness failure, not a shorter article."
  const incomplete = runSeoChecks({
    ...base,
    outline: [...base.outline, { heading: "A section never written", intent: "" }],
  });
  check(
    "A missing outline section is a completeness failure",
    incomplete.missingSections.length === 1,
  );
}

// ─── Recipients ─────────────────────────────────────────────────────────────

section("Recipients: numbers validated at import, not at send time");

check("A valid E.164 number is accepted", isValidE164("+2348012345678"));
check("A number without a plus is rejected", !isValidE164("2348012345678"));
check(
  "Common formatting is normalised",
  normaliseE164("+234 801 234 5678") === "+2348012345678",
);
check("An unparseable number returns null, not a guess", normaliseE164("not a phone") === null);

// ─── Fan-out roll-up ────────────────────────────────────────────────────────

section("Broadcasts: a status must not claim to know more than it does");

{
  const tally = (over: Partial<{ sent: number; failed: number; uncertain: number; skipped: number }> = {}) => ({
    sent: 0, failed: 0, uncertain: 0, skipped: 0, ...over,
  });

  // "The same broadcast retried after a partial failure → nobody receives it
  // twice." A timed-out delivery used to be recorded as `failed`, so the retry
  // re-sent it.
  check(
    "A delivery with an unknown outcome is not re-sent",
    isAlreadyHandled("uncertain") && !isAlreadyHandled("failed"),
    "uncertain must be skipped on retry; failed is safe to re-send",
  );

  const mixed = rollUpDeliveries(tally({ sent: 37, failed: 2, uncertain: 1 }), false);
  check(
    "A mix of sent, failed and unknown reports all three",
    mixed.message.includes("37 of 40 delivered") &&
      mixed.message.includes("2 failed") &&
      mixed.message.includes("1 unknown"),
    mixed.message,
  );
  check(
    "An unknown delivery is not counted as a failure",
    !/3 failed/.test(mixed.message),
    mixed.message,
  );

  const unknownOnly = rollUpDeliveries(tally({ sent: 39, uncertain: 1 }), false);
  check(
    "A broadcast with an unaccounted-for send never reads as published",
    unknownOnly.status !== "published" && unknownOnly.status !== "published_dry_run",
    `got ${unknownOnly.status}`,
  );

  check(
    "A skipped recipient is counted, not silently dropped",
    rollUpDeliveries(tally({ sent: 37, skipped: 3 }), false).message.includes(
      "3 skipped for consent",
    ),
  );

  check(
    "A DEMO_MODE send is a dry run, never a real publish",
    rollUpDeliveries(tally({ sent: 3 }), true).status === "published_dry_run",
  );
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

section("Diagnostics: printing the bytes when something behaves impossibly");

check("A non-breaking space is made visible", describeBytes("a b") === "a[NBSP]b");
check("A zero-width space is made visible", describeBytes("a​b") === "a[U+200B]b");
check("A newline is made visible", describeBytes("a\nb") === "a\\nb");

// ─── Function grants ────────────────────────────────────────────────────────

async function checkFunctionGrants() {
  section("Security: who can execute the pipeline's functions");

  /**
   * Runs the standing grant check as part of the pack, so an over-granted
   * function shows up in the evidence table rather than only in a script
   * somebody has to remember to run.
   *
   * Skipped rather than failed without a database URL: the pack must stay
   * runnable offline, and a missing connection string is not a security
   * finding.
   */
  if (!process.env.SUPABASE_DB_URL) {
    console.log("  skip  no SUPABASE_DB_URL, so grants could not be checked");
  } else {
    // Run in-process rather than shelling out: spawning npx fails on Windows
    // with EINVAL, and a check that cannot run on the machine doing the
    // testing is not a check.
    try {
      const { problems, functionCount } = await checkGrants();
      check(
        "No function is executable by public, anon or an unexpected role",
        problems.length === 0,
        problems.length > 0
          ? `${problems.length} of ${functionCount}: ${problems[0]}`
          : "",
      );
    } catch (err) {
      check(
        "No function is executable by public, anon or an unexpected role",
        false,
        `the check could not run: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ─── What needs a live run ──────────────────────────────────────────────────

section("Cases that need a live pipeline");

console.log(`
These cannot be asserted offline. Run them through the app and record what
happened — DESIGN.md §21.2: screenshots captured while testing, not
reconstructed afterwards.

  Research
    · A 404 URL                 https://example.com/definitely-not-a-real-page-404
      → fetch_failed, and the request continues on the remaining sources
    · A hard paywall            https://www.ft.com/ (any article)
      → paywalled, visible at gate one, excluded from drafting
    · A PDF                     https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf
      → unsupported_type or parsed — either way, not a crash
    · A nav shell, no article   https://example.com
      → empty, and DISTINCT from fetch_failed
    · An off-domain redirect    https://bit.ly/3xxxxxx
      → redirected_offsite, kept and flagged
    · A niche idea with no coverage
      → no_sources_found → needs_human, NOT an ungrounded article

  Approval and publishing
    · POST /api/runner for an unapproved item, or insert a publish_queue row
      by hand → refused by the NOT NULL approved_by constraint
    · Fire /api/cron/release twice at once → exactly one send
    · Submit the intake form twice quickly → one request (submit_token)
    · Kill the process mid-step → the lease expires and the next runner
      resumes from stored state
    · Set a budget below the drafting estimate → budget_exceeded BEFORE the
      call, with the work so far intact
    · Open a handoff confirmation link twice → the second shows the recorded
      URL and creates no second record
`);

/**
 * The grant check needs a database, so the summary waits for it. Everything
 * above is synchronous and has already printed.
 */
checkFunctionGrants()
  .catch((err) => {
    check(
      "No function is executable by public, anon or an unexpected role",
      false,
      `the check could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
  })
  .finally(() => {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.log("\nSomething the spec says must be caught is not being caught.");
      process.exit(1);
    }
  });
