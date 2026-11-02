// Shapes of what the Flask API returns (see docs/api.md).
export type Role = "admin" | "manager" | "annotator" | "inspector" | "acceptor" | "viewer";

export interface Me {
  username: string; name: string; role: Role; role_label: string; active: boolean;
  permissions: string[]; created: string; updated: string;
  /** still the default password from the administrator: must choose their own first */
  must_change: boolean; last_login?: string | null; last_seen?: string | null;
}

export interface Word { text: string; start: number; end: number; sp?: boolean }

/** A segment of the cut editor; in a task, a dialogue segment ("part") of a package. */
export interface Seg {
  id: number; start: number; end: number;
  text: string; norm: string; normEdited: boolean; role: string;
  words: Word[] | null; wordsText: string | null;
  state: "pending" | "running" | "done" | "error"; error: string; deleted: boolean;
  [k: string]: any;
}

export interface ReviewRecord { status?: string; stage?: string; by: string; at: string; note: string }

/** A crop of an audio = a package of a task. */
export interface Crop {
  id?: number; start: number; end: number; text?: string; norm?: string; role?: string; state?: string;
  deleted?: boolean; completed?: boolean; annotator?: string; updated?: string;
  parts?: Seg[]; speakers?: Record<string, { age?: string; gender?: string; native?: string }>;
  info?: Record<string, any>;
  inspection?: ReviewRecord | null; acceptance?: ReviewRecord | null; returned?: ReviewRecord | null;
  history?: any[]; resubmit?: string;
  [k: string]: any;
}

export interface AudioSummary {
  id: string; name: string; duration: number; created: string; chunk_seconds: number | null; task_id: string | null;
  count: number; done: number; todo: number; updated: string; stages?: Record<string, number>;
  segments?: Crop[];
}

export interface Members { annotator: string[]; inspector: string[]; acceptor: string[] }
export interface TaskAccess { view: boolean; edit: boolean; inspect: boolean; accept: boolean; manage: boolean }
export interface LastPush { repo: string; split: string; url: string; at: string; pr: boolean }

export interface TaskSummary {
  id: string; name: string; created: string; created_by: string; updated: string;
  members: Members; audio_count: number; duration: number; count: number; done: number; todo: number;
  stages: Record<string, number>; access: TaskAccess | null; last_push?: LastPush | null;
}
export interface Task extends TaskSummary { audios: (AudioSummary & { segments: Crop[] })[] }

export interface Job { kind: string; done: number; total: number; message: string; running: boolean; error: string | null; result: any }

export interface DatasetAccess { view: boolean; review: boolean; bulk_accept: boolean; manage: boolean }
export interface ClipItem {
  idx: number; part: number; file: string; duration: number; source_file?: string | null;
  original_text: string; text: string; norm: string | null; extra: Record<string, any>;
  audio: { speech_start?: number; speech_end?: number; [k: string]: any };
  trim: [number, number] | null; asr_text: string | null; cer: number | null; flags: string[];
  category: "pass" | "review" | "bad" | "unchecked"; status: "todo" | "accepted" | "rejected";
  reason: string; reviewer: string; updated: string;
}
export interface DatasetSummary {
  id: string; name: string; repo: string; config: string; split: string; created: string; updated: string;
  text_column: string; audio_column: string; failed?: number; members?: string[];
  count: number; duration: number; checked: number; fixed: number;
  status_counts: Record<"todo" | "accepted" | "rejected", number>;
  category_counts: Record<"pass" | "review" | "bad" | "unchecked", number>;
  batch: { start: number; end: number | null; name: string; prefix: string } | null;
  job: Job | null; access: DatasetAccess | null; last_push?: LastPush | null;
}
export interface Dataset extends DatasetSummary {
  items: ClipItem[]; cer_pass: number; sibling_push: LastPush | null;
  flag_info: Record<string, { severity: string; text: string }>;
}

export interface DirectoryUser { username: string; name: string; role: Role }
