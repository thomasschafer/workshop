// Types mirror the packs' routes in src/server/packs.rs.

export interface Draft {
  id: string;
  path: string;
  source: string | null;
  skills: string[];
  kind: string | null;
  added: string | null;
  text: string;
}

export interface PackShown {
  id: string;
  name: string;
  /** Whether it can be changed: the sample pack is built in. */
  editable: boolean;
  skills: { id: string; name: string }[];
  drafts: Draft[];
}
