export type AgentRow = {
  id: string
  label: string
  type: string
  status: string
  model: string
}

export type Viewer = {
  isOpen: boolean
  index: number
  isCapped: boolean
  isFailed: boolean
  isLoading: boolean
  /** True when the list came from the session log (the whole history), false when it came from the transcript. */
  isFromLog: boolean
}

/**
 * A suffix that says why the account is unknown; drawn as `account ? (<suffix>)`. `read timed out` (1.4.0): the whole read hit its
 * 30 s ceiling; `timed out` is the status run's own timeout.
 */
export type AccountSuffix =
  | 'claude not on PATH'
  | 'timed out'
  | 'read timed out'
  | 'unreadable status'
  | 'no email reported'
  | `claude exited ${number}`

/** What the band knows of the signed-in account. `readAt`: `$.clock.now()` when that read ENDED. */
export type Account =
  | { kind: 'unread' }
  | { kind: 'unknown'; suffix: AccountSuffix | undefined; readAt: number }
  | { kind: 'signed-out'; readAt: number }
  | { kind: 'signed-in'; email: string; readAt: number }

/**
 * The login button. `attempt` counts the attempts and is never cleared (an attempt's identity); `startedAt` is set while the
 * attempt has not settled and serves only for elapsed time; `reason` is the last refusal.
 */
export type Login = { attempt?: number; startedAt?: number; reason?: string }

/** One note of the tasks list; `id` is unique in the session and never reused: the key of its row's buttons. */
export type Task = { id: number; text: string }

/**
 * The session's tasks list (one per session: `$.state`, survives a hot reload, not a new session). `nextId` is the id the
 * next note gets; `draft` what the add field draws (the refused text, the text kept when the view closes; '' after an add;
 * typing alone writes nothing, the text typed so far lives in memory); `editing` the note whose row is an edit field and
 * the text that field draws; `note` the one dim line (a refusal), cleared by the next action (typing does not clear it);
 * `isSending` while an Apply's submit has not settled, `sendingId` the note it is sending (only Apply writes either).
 */
export type Tasks = {
  isOpen: boolean
  items: Task[]
  nextId: number
  draft: string
  editing?: { id: number; draft: string }
  note?: string
  isSending: boolean
  sendingId?: number
}

/**
 * What the mod keeps of the usage answer: three "% left" numbers (0-100, whole), the server's label, the moment the 5-hour window
 * resets (1.4.0) and the moment the weekly window resets (1.5.0). NOTHING else.
 */
export type Limits = {
  fiveHour: number | null
  week: number | null
  model: { label: string; left: number } | null // the `weekly_scoped` entry named Fable; null when the answer has none
  fiveHourResetsAt: number | null // epoch ms of `five_hour.resets_at` (ISO 8601 with an offset); null when absent or not that. The text is made at draw time
  /** Epoch ms of `seven_day.resets_at`, read like `fiveHourResetsAt`. A value stored by 1.4.0 has none: read it as null (a dash). */
  weekResetsAt: number | null
}

/**
 * A question of the `last answer` list (1.9.0), read from the session's transcript file: `id` is the `uuid` of its line (what the screen
 * draws it under, so what a scroll takes), `text` the clean first line of the question, cut to 60 characters.
 */
export type AskedQuestion = { id: string; text: string }

/**
 * The list's questions (1.9.0): the newest three on the live chain of the transcript file, newest first, and `size` the file length the
 * read saw (the tick looks again only when the file is longer).
 */
export type Recent = { questions: readonly AskedQuestion[]; size: number }

/**
 * A question the person submitted that the transcript file does not hold yet (1.9.0): `text` its shown text, `from` the file's length at
 * the submit (the first question line that ends after it is this one's), `turns` the main-loop turn ends since (an entry at 2 is dropped).
 */
export type PendingQuestion = { text: string; from: number; turns: number }

/**
 * The owner's last question (1.5.0, no longer written since 1.9.0: only cleared at a session end), what the `last answer` list's first row scrolls to: `uuid` is the transcript message's id (known
 * before any press, so the press scrolls without waiting); `pending` is the text of a question submitted but not yet found in the
 * transcript (queued behind a running turn, or typed into a running turn), and `previous` is the uuid of the question before it: the
 * press goes there (it is the question being answered now) and the lookup never goes back past it; the lookup takes the newest row
 * with the same text newer than `previous`. null: no question seen yet. Absent in a state stored before 1.5.0: read it as null. A
 * `queued` field that a 1.5.0 candidate stored is ignored.
 *
 * 1.6.0: `text` (a settled question) and `previousText` (the text of `previous`, kept in a pending value) are the clean first line of
 * the question, cut to 60 characters: the first list row shows it. A value stored by 1.5.0 has neither: the row says `last question`.
 */
export type LastQuestion = { uuid: string; text?: string } | { pending: string; previous?: string; previousText?: string } | null

/**
 * A question before the last one (1.8.0), as the list shows it: `uuid` is the question's transcript row (what a scroll takes),
 * `text` the clean first line of the question, cut to 60 characters.
 */
export type EarlierQuestion = { uuid: string; text: string }

/**
 * A pin (1.6.0) on one of Claude's text answers: `id` is the `requestId` of the answer's block (one per block, stable while it
 * streams), what a transcript scroll takes; `text` the block's first content line, cut to 60 characters, what the list shows.
 */
export type Pin = { id: string; text: string }

/**
 * The limits line under the account row. `email`: the account the line was opened for (a line is drawn only while the signed-in
 * email is the same). `fetchedAt`: `$.clock.now()` when the last fetch ENDED (answer or failure). `isOpen` is written by a press
 * on the email (toggle) and by the line's Close button (only to false); neither changes `value` or `fetchedAt`.
 */
export type LimitsView = { isOpen: boolean; email?: string; fetchedAt?: number; value?: Limits; isFailed: boolean }

/**
 * The wake button (1.7.0): `nextAt` is the epoch ms of the next fire (`$.clock.now()`'s milliseconds), `minute` the whole minutes left to `nextAt` (floored) the 2 s tick last wrote: only its change matters,
 * it draws the label again at the moment the label's own minutes turn. null: off. Absent in a
 * state stored before 1.7.0: read it as null.
 */
export type Wake = { nextAt: number; minute: number } | null

declare module 'claude-code' {
  interface PluginState {
    'agent-models': {
      models: Record<string, string>
      rows: AgentRow[]
      viewer: Viewer
      prompts: string[]
      account: Account
      login: Login
      tasks: Tasks
      limits: LimitsView
      /** The clock minute (epoch ms / 60000, floored) of the open limits line's tick; null: the clock was refused. Only its change matters: it draws the band again as the times run down. */
      limitsMinute: number | null
      /** 1.5.0-1.8.1, no longer written or read since 1.9.0: only cleared at a session end. */
      lastQuestion: LastQuestion
      /** 1.8.0-1.8.1, no longer written or read since 1.9.0: only cleared at a session end. */
      earlierQuestions: readonly EarlierQuestion[]
      /** The list's questions (1.9.0), read from the transcript file; null: none read yet. Absent in a state stored before 1.9.0: read it as null. */
      recent: Recent | null
      /** The submitted questions the file does not hold yet (1.9.0), oldest first, at most 8. Absent in a state stored before 1.9.0: read it as []. */
      pending: readonly PendingQuestion[]
      /** The pins (1.6.0), oldest first, at most 50. Absent in a state stored before 1.6.0: read it as []. */
      pins: readonly Pin[]
      /** Whether the list under the `last answer` button is open (1.6.0). Absent in a state stored before 1.6.0: read it as false. */
      answerListOpen: boolean
      /** The wake (1.7.0): null is off. Absent in a state stored before 1.7.0: read it as null. */
      wake: Wake
    }
  }
}
