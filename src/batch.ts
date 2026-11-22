import { readObject } from "./fields.ts";
import type { Envelope } from "./records.ts";

export const batchMediaType = "application/vnd.liatris.batch+json";
export const maxBatchEvents = 32;
export const maxBatchBytes = 128 * 1024;

export type ReceiptStatus = "accepted" | "rejected" | "retry";
export type BatchReceipt = { event_id: string; status: ReceiptStatus };
export type BatchDelivery = (
	records: readonly Envelope[],
	signal: AbortSignal,
) => Promise<readonly BatchReceipt[]>;

export function isReceiptStatus(value: unknown): value is ReceiptStatus {
	return value === "accepted" || value === "rejected" || value === "retry";
}

/** Requires one unambiguous status for each submitted event. */
export function readBatchReceipts(
	value: unknown,
	records: readonly Envelope[],
): BatchReceipt[] {
	if (!Array.isArray(value) || value.length !== records.length)
		throw new Error("incomplete batch receipt");
	const pending = new Set(records.map(({ event_id }) => event_id));
	return value.map((item) => {
		const { event_id, status } = readObject(item);
		if (
			typeof event_id !== "string" ||
			!pending.delete(event_id) ||
			!isReceiptStatus(status)
		) {
			throw new Error("invalid batch receipt");
		}
		return { event_id, status };
	});
}
