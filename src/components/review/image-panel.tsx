"use client";

import { useState } from "react";
import { chooseImage, findImages } from "@/app/actions/approvals";
import { useAction } from "./use-action";
import type { ImageCandidate } from "@/lib/db/types";

/**
 * The image candidates, and choosing one.
 *
 * Openly licensed and selected rather than generated, so the licence and
 * attribution travel with the image (§13). One responsibility, its own action
 * state.
 */

export function ImagePanel({
  requestId,
  images,
  locked,
}: {
  requestId: string;
  images: ImageCandidate[];
  locked: boolean;
}) {
  const action = useAction();
  const pending = action.pending;
  const [alts, setAlts] = useState<Record<string,string>>({});
  const readOnly = locked;
  if (images.length === 0) return <div className="empty"><h3>No image candidates available yet</h3><p>Licensed photos are searched automatically during article checks. If none are available, you can try again. Image search does not use AI tokens.</p>{action.error && <div className="alert alert-warn small">{action.error}</div>}{!readOnly && <button className="btn" disabled={pending} onClick={()=>action.run(()=>findImages(requestId))}>{pending ? "Searching..." : "Find images"}</button>}</div>;

  return (
    <div className="stack">
      {action.error && <div className="alert alert-error small">{action.error}</div>}
      <p className="tiny muted mb-0">
        Openly licensed, selected not generated. The licence and attribution travel with the
        image into the article and the LinkedIn post.
      </p>

      {images.map((image) => (
        <div
          key={image.id}
          className="card card-pad"
          style={{
            boxShadow: "none",
            borderColor: image.chosen ? "var(--accent)" : "var(--border)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.download_url}
            alt={image.alt_text ?? ""}
            style={{
              width: "100%",
              height: 120,
              objectFit: "cover",
              borderRadius: 6,
              marginBottom: 8,
              background: "var(--surface-2)",
            }}
          />
          <div className="tiny muted">{image.attribution_text}</div>
          <div className="tiny dim mt-1">
            {image.licence}
            {image.licence_url && (
              <>
                {" · "}
                <a href={image.licence_url} target="_blank" rel="noopener noreferrer">
                  licence
                </a>
              </>
            )}
          </div>
          {!readOnly && !image.chosen && <div className="field mt-2"><label htmlFor={"alt-" + image.id}>Describe the image for readers using a screen reader</label><input id={"alt-" + image.id} maxLength={200} value={alts[image.id] ?? image.alt_text ?? ""} placeholder="e.g. A team reviewing notes around a desk" onChange={e=>setAlts({...alts,[image.id]:e.target.value})} /></div>}
          {!readOnly && (
            <button
              className="btn btn-sm mt-1"
              disabled={pending || (!image.chosen && !(alts[image.id] ?? image.alt_text)?.trim())}
              onClick={() =>
                action.run(() => chooseImage(requestId, image.chosen ? null : image.id, alts[image.id] ?? image.alt_text ?? ""))
              }
            >
              {image.chosen ? "Remove" : "Use this one"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Sources ────────────────────────────────────────────────────────────────
