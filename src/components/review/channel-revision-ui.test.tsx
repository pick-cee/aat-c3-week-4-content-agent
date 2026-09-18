import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/app/actions/approvals", () => ({ approveChannel: vi.fn(), approveChannels: vi.fn(), rejectChannel: vi.fn(), requestChannelRevision: vi.fn() }));
vi.mock("./use-action", () => ({ useAction: () => ({ pending: false, error: null, run: vi.fn() }) }));
vi.mock("../post-dialog", () => ({ PostDialog: () => null }));
import { ChannelsPanel } from "./channels-panel";
import type { ChannelOutput } from "@/lib/db/types";
const output = { id: "saved", channel: "newsletter", status: "approved", body: "Newsletter", hashtags: [], char_count: 10 } as unknown as ChannelOutput;
it("offers revision of approved copy even when ordinary approval controls are closed", () => {
  const html = renderToStaticMarkup(<ChannelsPanel requestId="request" outputs={[output]} holdInQueue publishTarget={null} canApprove locked canRevise />);
  expect(html).toContain("Revise Newsletter");
  expect(html).toContain("Approved");
});
it("does not offer channel revision without reviewer permission", () => {
  const html = renderToStaticMarkup(<ChannelsPanel requestId="request" outputs={[output]} holdInQueue publishTarget={null} canApprove={false} locked canRevise />);
  expect(html).not.toContain("Revise Newsletter");
});
