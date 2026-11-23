import { createRecordReaders } from "/experiment/projection.js";
import { wasmFactory } from "/experiment/wasm-adapter.js";
import * as reference from "/records-reference.js";

const source = await fetch("/event-core.wasm");
if (!source.ok) throw new Error("could not load the experimental WASM");
const module = await WebAssembly.compile(await source.arrayBuffer());
export const { readEvent, readQuery } = createRecordReaders(
	reference,
	wasmFactory(module),
);
export const { maxRecordBytes } = reference;
