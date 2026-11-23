import * as reference from "../../../src/records.ts";
import { nativeFactory } from "./native-adapter.ts";
import { createRecordReaders } from "./projection.ts";

export { maxRecordBytes } from "../../../src/records.ts";

export const { readEvent, readQuery } = createRecordReaders(
	reference,
	nativeFactory,
);
