"""Review of the packages (crops) of a task: annotator -> reviewer (one review step).

    annotating  -> the annotator presses Complete           -> inspecting (waiting for review)
    inspecting  -> the reviewer accepts it                  -> accepted
                   ... or returns it with a note            -> returned (the annotator fixes it, Complete again)
    skipped     (the package or every segment of it is left out)

The decisions live on the crop, next to what the annotator saves:

    acceptance {status: "accepted", by, at, note}
    returned   {stage: "review", by, at, note}
    history    [{stage, decision, by, at, note}, ...]

Before inspection and acceptance were combined into one review, a package was first passed by an inspector
(inspection {status: "passed"}) and then accepted. Such a passed package that was never accepted waits for the review
again; its inspection record and the old history entries are kept.
Only the review endpoint writes these fields; an autosave from the browser keeps the saved ones (merge_saved).
"""
PROTECTED = ("inspection", "acceptance", "returned", "history")
STAGES = ("annotating", "returned", "inspecting", "accepted", "skipped")
DECISIONS = ("accept", "return")


def is_skipped(crop):
    parts = crop.get("parts")
    return bool(crop.get("deleted") or (parts and all(p.get("deleted") for p in parts)))


def stage(crop):
    """Where the package is in the review."""
    if is_skipped(crop):
        return "skipped"
    if not crop.get("completed"):
        return "returned" if crop.get("returned") else "annotating"
    if (crop.get("acceptance") or {}).get("status") == "accepted":
        return "accepted"
    return "inspecting"


def counts(crops):
    out = dict.fromkeys(STAGES, 0)
    for c in crops:
        out[stage(c)] += 1
    return out


def decide(crop, decision, user, note, at):
    """Apply the reviewer's decision ("accept" / "return") to the crop (changed in place).
    Raises ValueError when the package is not waiting for review or the decision is unknown."""
    if decision not in DECISIONS:
        raise ValueError(f"The decision must be one of {', '.join(DECISIONS)}")
    if stage(crop) != "inspecting":
        raise ValueError(f"This package is not waiting for review (it is {stage(crop)})")
    note = (note or "").strip()
    if decision == "return" and not note:
        raise ValueError("Write what the annotator has to fix")
    record = {"by": user, "at": at, "note": note}
    if decision == "return":
        crop.update(completed=False, inspection=None, acceptance=None, returned={"stage": "review", **record})
    else:
        crop["acceptance"] = {"status": "accepted", **record}
    crop["history"] = [*(crop.get("history") or []), {"stage": "review", "decision": decision, **record}]
    return crop


def merge_saved(old, new, may_review, changed=None):
    """The crops to store when the browser autosaves `new` over the saved `old`.

    - the review fields always come from `old` (only the review endpoint changes them)
    - `changed` (indexes the browser edited) limits the save to those crops, so two people working on different
      packages of one audio do not overwrite each other
    - once a package is accepted, only reviewers / managers (may_review) can change it
    - a returned package is completed again only by a browser that saw the return (resubmit = returned.at);
      a package moved back to Todo loses its acceptance
    """
    if len(old) != len(new):  # the crops themselves changed (only in Upload & Crop): nothing to keep
        return [{k: v for k, v in n.items() if k not in PROTECTED and k != "resubmit"} for n in new]
    changed = set(range(len(new))) if changed is None else set(changed)
    out = []
    for k, (o, n) in enumerate(zip(old, new)):
        if k not in changed or (not may_review and stage(o) == "accepted"):
            out.append(o)
            continue
        resubmit = n.get("resubmit")
        n = {key: v for key, v in n.items() if key not in PROTECTED and key != "resubmit"}
        n.update({key: o[key] for key in PROTECTED if o.get(key) is not None})
        if o.get("returned") and n.get("completed"):
            if resubmit and resubmit == o["returned"].get("at"):
                n.pop("returned", None)
            else:
                n["completed"] = False   # a browser that has not seen the return yet
        if not n.get("completed"):
            n.pop("inspection", None)
            n.pop("acceptance", None)
        out.append(n)
    return out
