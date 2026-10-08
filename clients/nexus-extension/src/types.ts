/** The shapes the Nexus live lane speaks. Mirrors core/meetings/services/live/src/* — the
 *  service is the SSOT; these are the fields this UI actually reads. */

export type AgendaStatus = 'open' | 'touched' | 'covered';

export interface AgendaItem {
  id: string;
  text: string;
  status: AgendaStatus;
  /** The quote from the room that earned the current status. */
  evidence?: string;
  firstTouchedMs?: number;
  coveredMs?: number;
}

export interface Agenda {
  items: AgendaItem[];
  version: number;
}

export interface Progress {
  covered: number;
  touched: number;
  open: number;
  total: number;
}

export interface SessionSnapshot {
  session_uid: string;
  meeting_id: number;
  status: 'live' | 'ended';
  title: string;
  started_at: string;
  ended_at: string | null;
  elapsed_ms: number;
  agenda: Agenda;
  progress: Progress;
  audio: { frames: number; seconds: number; last_frame_ms_ago: number | null };
  transcript_lines: number;
  coverage: { passes: number; changes: number; failures: number };
  warnings: string[];
}

export interface StartedSession extends SessionSnapshot {
  ingest: {
    url: string;
    session_uid: string;
    subprotocol_prefix: string;
    sample_rate: number;
  };
}

export interface HistoryRow {
  meeting_id: number;
  session_uid: string;
  title: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  progress: Progress;
  agenda: Agenda;
}

export interface SavedChecklist {
  key: string;
  title: string;
  items: string[];
  lastUsedAt: string | null;
  uses: number;
  lastCovered: number;
}

/** A named agenda the user keeps for a KIND of meeting. Stored against their Nexus account, so
 *  it survives reinstalling this extension and follows them to another machine. */
export interface AgendaTemplate {
  id: string;
  name: string;
  items: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface Me {
  user_id: number;
  email: string;
  live_session: SessionSnapshot | null;
  capabilities: { identity: boolean; stt: boolean; coverage: boolean };
}

/** What the panel asks the service worker to do, and what it gets back. */
export type PanelMessage =
  | { type: 'state' }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'start'; title: string; agenda: string[] }
  | { type: 'stop' }
  | { type: 'history' }
  | { type: 'checklists' }
  | { type: 'grant-mic' };

/** The one state object the panel renders. The service worker owns it; the panel is a view. */
export interface ExtensionState {
  connected: boolean;
  email: string | null;
  /** 'idle' | 'starting' | 'live' | 'stopping' */
  phase: 'idle' | 'starting' | 'live' | 'stopping';
  session: SessionSnapshot | null;
  /** Is the microphone actually being captured, and is the socket up? */
  capture: { mic: boolean; socket: boolean; frames: number };
  micPermission: 'granted' | 'denied' | 'unknown';
  error: string | null;
  /** Non-fatal things the user should know (no coverage model configured, etc.). */
  notices: string[];
}
