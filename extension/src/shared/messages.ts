/** Content script <-> service worker messages, plus backend response shapes. */

export interface Link {
  order_item_id: string;
  wearer: string | null;
  wearer_id: number | null;
  parent_order_item_id: string | null;
  note: string | null;
  orphaned: boolean;
}

export interface OrderState {
  order_id: string;
  order_ref: number | null;
  version: number;
  completed: boolean;
  aliases: string[];
  links: Link[];
  foreign_lines?: string[];
}

export type Request =
  | { type: "lookup"; orderId: string; lines: string[] }
  | { type: "write"; orderId: string; path: string; body: Record<string, unknown> }
  | { type: "complete"; orderId: string; lines: string[] }
  | { type: "health"; report: HealthReport }
  | { type: "status" }
  | { type: "retry" }
  | { type: "discard"; orderId: string }
  | { type: "openOptions" };

export interface HealthReport {
  ext_version: string;
  path: string;
  checks: Record<string, boolean>;
}

export type Outcome =
  | { kind: "ok"; data: OrderState }
  | { kind: "queued"; waiting: number }
  | { kind: "conflict"; current: OrderState }
  | { kind: "locked"; current: OrderState }
  | { kind: "signin" }
  | { kind: "offline" }
  | { kind: "error"; message: string };

export interface QueueStatus {
  signedIn: boolean;
  waiting: number;
  blocked: { orderId: string; kind: "conflict" | "locked"; current: OrderState }[];
}

/** Pushed from the service worker to tabs when the queue or sign-in changes. */
export type Push = { type: "queue"; status: QueueStatus };
