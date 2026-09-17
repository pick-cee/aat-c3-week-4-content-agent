import { describe, expect, it, vi } from "vitest";
vi.mock("./db/client",()=>({serviceClient:vi.fn(),table:(s:string)=>s}));
import { mayShowPublicArticle } from "./publication";
describe("public article visibility",()=>{
  it.each(["draft","researching","drafting","evaluating","content_review","needs_human","failed","cancelled"])("keeps %s articles private",status=>{
    expect(mayShowPublicArticle(status,null,true)).toBe(false);
  });
  it.each(["scheduled","publishing","published"])("requires approval even when %s",status=>{
    expect(mayShowPublicArticle(status,null,false)).toBe(false);
    expect(mayShowPublicArticle(status,null,true)).toBe(true);
    expect(mayShowPublicArticle(status,"2026-09-16",true)).toBe(false);
  });
});
