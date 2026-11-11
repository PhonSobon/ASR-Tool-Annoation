// Home page texts (English). Brand names (Hugging Face, ASR, WAV, JSON, parquet, FFmpeg) are kept as they are.
import type { ReactNode } from "react";
import type { IconName } from "@/components/icon-sprite";

type Section = "features" | "workflow" | "team" | "roles" | "faq";
export type StationRole = "manager" | "automatic" | "annotator" | "inspector";

export interface HomeText {
  nav: Record<Section, string>; sections: string; skip: string; openMenu: string; closeMenu: string; theme: string;
  signIn: string; openWorkspace: string;
  heroTitle: ReactNode; heroText: string; howItWorks: string;
  featuresTitle: string; featuresText: string; features: { icon: IconName; title: string; text: string }[];
  workflowTitle: string; workflowText: string;
  steps: { icon: IconName; title: string; role: StationRole; who: string; text: string; points: string[]; out: string }[];
  teamTitle: string; teamText: string; teamPoints: { icon: IconName; title: string; rest: string }[];
  rolesTitle: string; rolesText: string; roles: Record<string, { label: string; summary: string }>;
  faqTitle: string; faq: [string, string][];
  finalTitle: string; finalIn: string; finalOut: string;
  footerText: string; product: string; more: string;
}

export const HOME: HomeText = {
  nav: { features: "Features", workflow: "How it works", team: "Teamwork", roles: "Roles", faq: "FAQ" },
  sections: "Sections", skip: "Skip to content", openMenu: "Open menu", closeMenu: "Close menu", theme: "Theme",
  signIn: "Sign in", openWorkspace: "Open workspace",
  heroTitle: <>Build clean Khmer speech datasets, <em>together.</em></>,
  heroText: "Load recordings, let a local Khmer ASR model draft the text, have a reviewer check every package and export training-ready data — one place for the whole team.",
  howItWorks: "See how it works",
  featuresTitle: "Everything a speech dataset needs", featuresText: "From a raw recording to a reviewed, training-ready clip.",
  features: [
    { icon: "recognize", title: "Local Khmer ASR", text: "A Khmer speech model drafts every transcript on your own GPU or CPU. No cloud service, no API key — your audio never leaves your server." },
    { icon: "scissors", title: "Waveform cut editor", text: "10 / 20 / 30 s cuts that snap to pauses; drag, merge, skip, undo, zoom." },
    { icon: "shield", title: "One review step", text: "A reviewer accepts each completed package or returns it to the annotator with a note." },
    { icon: "database", title: "Dataset cleaning", text: "Import a Hugging Face dataset; the ASR flags clips whose text does not match." },
    { icon: "inbox", title: "Push & pull work", text: "Managers push a dataset, annotators pull one — never the same task twice." },
    { icon: "download", title: "Export anywhere", text: "WAV + JSON as a ZIP, or parquet straight to the Hugging Face Hub." },
  ],
  workflowTitle: "How it works",
  workflowText: "One recording, from raw audio to a training-ready row: five steps, and the task page shows who did each one.",
  steps: [
    { icon: "upload", title: "Load and cut", role: "manager", who: "Project manager",
      text: "Bring in the speech — long recordings, a folder that already has labels, or a Hugging Face dataset — and cut it into packages.",
      points: ["Any format FFmpeg reads, converted to 16 kHz mono", "10 / 20 / 30 s cuts, boundaries snapped to pauses", "Big Hub datasets loaded in batches of rows"],
      out: "Packages of 0.5–30 s" },
    { icon: "recognize", title: "ASR draft", role: "automatic", who: "Automatic",
      text: "The local Khmer speech model writes a first transcript for every package, on your own GPU or CPU.",
      points: ["No cloud service, no API key", "Loaded data keeps its own text — no draft needed"],
      out: "Draft text" },
    { icon: "file", title: "Annotate", role: "annotator", who: "Annotator",
      text: "Pull a task, listen, fix the text and add the speaker and recording details. Autosave keeps every change.",
      points: ["Dialogue: one segment per speaker turn", "Normalized text made automatically", "Keyboard shortcuts for play, next, complete"],
      out: "Labeled package" },
    { icon: "shield", title: "Review", role: "inspector", who: "Reviewer",
      text: "A reviewer checks every completed package against the audio: accept it, fix the text, or return it with a note.",
      points: ["Returned packages go back to the same annotator, with the note", "Only accepted packages count as training data", "Who annotated and who reviewed is kept"],
      out: "Accepted package" },
    { icon: "database", title: "Export", role: "manager", who: "Project manager",
      text: "Download a ZIP of WAV + JSON or push parquet to your Hugging Face repo — many tasks into one repo.",
      points: ["Choose: accepted, completed or all", "Pull request or direct push, with a dataset card"],
      out: "Training-ready rows" },
  ],
  teamTitle: "Share the work without stepping on each other",
  teamText: "Managers push a loaded dataset to the annotators. Each annotator pulls one — first come, first served — and the dashboard shows where every task stands.",
  teamPoints: [
    { icon: "upload", title: "Push to annotators", rest: " once the data is loaded" },
    { icon: "download", title: "Pull dataset", rest: " — it disappears for the others" },
    { icon: "dashboard", title: "Dashboard", rest: ": pulled, completed, waiting for review, acceptance rate" },
    { icon: "alert", title: "Needs attention", rest: ": not pulled, idle for 3 days, returned packages" },
  ],
  rolesTitle: "Everyone sees only their own work", rolesText: "Any number of people per role — the administrator makes every account.",
  roles: {
    admin: { label: "Administrator", summary: "Adds every account, sees every user's status and the full activity log." },
    manager: { label: "Project Manager", summary: "Uploads audio, makes tasks, imports datasets, assigns people, exports." },
    annotator: { label: "Annotator", summary: "Annotates the packages and dataset clips they are assigned to." },
    inspector: { label: "Reviewer", summary: "Reviews completed packages: accept, fix the text, or return to the annotator." },
  },
  faqTitle: "Questions people ask",
  faq: [
    ["Do I need an internet connection or an API key?", "No. The speech recognition model runs on your own computer or server (GPU or CPU). Internet is only needed to download the model once and to use the Hugging Face Hub."],
    ["How do I get an account?", "There is no sign-up. Your administrator creates your account with a default password; you choose your own password the first time you sign in."],
    ["Can two annotators work on the same task?", "Not by accident. When a manager pushes a task, the first annotator who pulls it gets it and it disappears for everyone else. A manager can still assign several people on purpose."],
    ["What happens when a package is returned?", "It goes back to the annotator who did it, with the reviewer's note, and is reviewed again after it is completed."],
    ["Which data formats come out?", "A ZIP with wavs/ and metadata.json, or parquet files on the Hugging Face Hub with audio, transcription, normalized text and the speaker and recording details."],
  ],
  finalTitle: "Ready to start?", finalIn: "Your tasks are waiting in the workspace.", finalOut: "Sign in with the account your administrator gave you.",
  footerText: "A platform for building and cleaning Khmer speech datasets.", product: "Product", more: "More",
};
