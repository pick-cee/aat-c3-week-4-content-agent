"use client";

import { chooseImage } from "@/app/actions/approvals";
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
  const readOnly = locked;
  if (images.length === 0) {
    return (
      <p className="small muted">
        No openly licensed images were found for this article. That is fine, an image is
        optional, and one with no licence on record is never attached.
      </p>
    );
  }

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
          {!readOnly && (
            <button
              className="btn btn-sm mt-1"
              disabled={pending}
              onClick={() =>
                action.run(() => chooseImage(requestId, image.chosen ? null : image.id))
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
