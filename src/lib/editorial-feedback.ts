/** Ignore empty template values from model responses, including older saved reviews. */
export function editorialFeedback(value: string | null | undefined): string | null {
  const text = value?.trim();
  return !text || /^(?:placeholder|todo|tbd|n\/?a|null|undefined)[.!]?$/i.test(text) ? null : text;
}
