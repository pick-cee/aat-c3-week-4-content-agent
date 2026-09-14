/**
 * The demo account.
 *
 * ONE account, deliberately. DESIGN.md §4: "The approver may be the author.
 * Week 3 separated them because a proposal goes to a paying client and a wrong
 * number is a commercial liability. Here the risk is reputational and the team
 * is small; forcing a second person to approve every LinkedIn post would make
 * the tool slower than writing the post by hand."
 *
 * So the content manager researches, reviews AND approves. The approval gate
 * is still real and still enforced server-side — it is a gate between the
 * machine and publishing, not between two people.
 *
 * Kept out of `seed.ts` because that module imports `server-only`, and the
 * landing page renders a client component from this data. A server-only module
 * in that graph breaks the client boundary.
 */
export interface DemoAccount {
  email: string;
  password: string;
  fullName: string;
  role: "manager" | "reviewer" | "admin";
}

export const DEMO_ACCOUNT: DemoAccount = {
  email: "maya@koyatalent.demo",
  password: "koya-content-demo",
  fullName: "Maya Adeyemi",
  // Reviewer: creates requests and approves content for publishing (§4).
  role: "reviewer",
};
