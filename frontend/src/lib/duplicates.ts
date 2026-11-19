// Duplicate audio across tasks: wording shared by the upload page and the Duplicates page.
import type { DupKind, DupMatch } from "./types";

export const DUP_KIND: Record<DupKind, string> = {
  identical: "Same recording",
  part_of: "Part of a longer recording",
  contains: "Contains another recording",
  overlap: "Shares some speech",
};

/** "Same recording as “news_01” (task Batch 3)" */
export const dupText = (d: DupMatch) =>
  `${d.kind === "part_of" ? "Part of" : d.kind === "contains" ? "Contains" : d.kind === "identical" ? "Same recording as" : `${Math.round(d.seconds)} s shared with`}` +
  ` “${d.name}”` + (d.task ? ` (task ${d.task})` : " (in Upload & Crop)");
