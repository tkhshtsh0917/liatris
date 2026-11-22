import type {
	PutRecordsCommandInput,
	PutRecordsCommandOutput,
} from "@aws-sdk/client-kinesis";
import type { Envelope } from "../src/records.ts";
import type { openEventStore } from "./event-store.ts";

type Outbox = Pick<
	ReturnType<typeof openEventStore>,
	"pending" | "markForwarded"
>;
type PutRecords = (
	input: PutRecordsCommandInput,
	signal?: AbortSignal,
) => Promise<PutRecordsCommandOutput>;

function partitionKey(record: Envelope): string {
	const attributes = record.payload.query_attributes as
		| Record<string, unknown>
		| undefined;
	const sessionId =
		record.kind === "query"
			? attributes?.session_id
			: record.payload.session_id;
	// Intake has already validated UUID session IDs.
	return typeof sessionId === "string" ? sessionId : record.event_id;
}

/** Forwards committed events and marks only the records acknowledged by Kinesis. */
export async function forwardToKinesis(
	outbox: Outbox,
	streamName: string,
	putRecords: PutRecords,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const batch = outbox.pending(100);
	if (batch.length === 0) return { sent: 0, failed: 0 };

	const response = await putRecords(
		{
			StreamName: streamName,
			Records: batch.map((record) => ({
				PartitionKey: partitionKey(record),
				Data: Buffer.from(JSON.stringify(record)),
			})),
		},
		signal,
	);

	const results = response.Records;
	if (!results || results.length !== batch.length)
		throw new Error("Kinesis returned an incomplete result");
	const acknowledged: string[] = [];
	for (const [index, result] of results.entries()) {
		if (!result.ErrorCode && result.ShardId && result.SequenceNumber)
			acknowledged.push(batch[index].event_id);
	}
	outbox.markForwarded(acknowledged);
	return {
		sent: acknowledged.length,
		failed: batch.length - acknowledged.length,
	};
}
