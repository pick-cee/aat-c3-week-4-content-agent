"use client";
import { Icon } from "./icon";
import { stripInternalMarkup } from "./article-view";

export function ArticleExport({ title, body, sources }: { title: string; body: string; sources: { title: string | null; url: string }[] }) {
  function download() {
    const content = stripInternalMarkup(body) + (sources.length ? "\n\n## Sources\n\n" + sources.map(s=>`- [${s.title ?? s.url}](${s.url})`).join("\n") : "");
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href=url; anchor.download=(title.toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,80) || "article") + ".md"; anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <button className="btn btn-sm" onClick={download}><Icon name="download" size={15} />Export article</button>;
}
