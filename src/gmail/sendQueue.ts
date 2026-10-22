import { setTimeout as sleep } from "node:timers/promises";

/** Pause between consecutive sends so a batch goes out at a human-like pace. */
export const SEND_QUEUE_GAP_MS = 30_000;

export interface QueuedEmail {
  outreachId: number;
  label: string;
}

export interface SendQueueState {
  total: number;
  sent: string[];
  failed?: { label: string; error: string };
  current?: string;
  running: boolean;
  /** Emails left unsent because the queue stopped at a failure. */
  remaining: number;
  finishedAt?: string;
}

const queues = new Map<number, SendQueueState>();

export function sendQueueState(campaignId: number): SendQueueState | undefined {
  return queues.get(campaignId);
}

export function isSending(campaignId: number): boolean {
  return queues.get(campaignId)?.running === true;
}

/**
 * Sends a human-confirmed batch one email at a time, in process. `send` re-checks each email
 * (approval, recipient, content) immediately before dispatch. The queue stops at the first
 * failure so a transport problem cannot fail the whole batch; unsent emails stay READY_TO_SEND.
 */
export function startSendQueue(
  campaignId: number,
  emails: QueuedEmail[],
  send: (outreachId: number) => Promise<void>,
  gapMs = SEND_QUEUE_GAP_MS,
): Promise<SendQueueState> {
  if (isSending(campaignId)) throw new Error("A send queue is already running for this campaign");
  const state: SendQueueState = { total: emails.length, sent: [], running: true, remaining: emails.length };
  queues.set(campaignId, state);
  return (async () => {
    for (const [index, email] of emails.entries()) {
      if (index > 0) await sleep(gapMs);
      state.current = email.label;
      try {
        await send(email.outreachId);
        state.sent.push(email.label);
        state.remaining -= 1;
      } catch (error) {
        state.failed = { label: email.label, error: error instanceof Error ? error.message : String(error) };
        break;
      }
    }
    state.current = undefined;
    state.running = false;
    state.finishedAt = new Date().toISOString();
    return state;
  })();
}
