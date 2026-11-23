import type { Profile } from "../../../src/profile.ts";

type Exports = {
	memory: WebAssembly.Memory;
	input_offset(): number;
	output_offset(): number;
	configure(length: number): number;
	project(length: number): number;
};

const maxBytes = 128 * 1024;

export function wasmFactory(module: WebAssembly.Module) {
	return (profile: Profile) => {
		const { exports } = new WebAssembly.Instance(module);
		const wasm = exports as unknown as Exports;
		const encoder = new TextEncoder();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const input = wasm.input_offset();

		function transfer(text: string) {
			const view = new Uint8Array(wasm.memory.buffer, input, maxBytes);
			const { read, written } = encoder.encodeInto(text, view);
			return read === text.length ? written : undefined;
		}

		const profileSize = transfer(JSON.stringify(profile));
		if (profileSize === undefined || !wasm.configure(profileSize)) return;
		return (text: string) => {
			const inputSize = transfer(text);
			if (inputSize === undefined) return;
			const outputSize = wasm.project(inputSize);
			if (outputSize === 0) return;
			const output = new Uint8Array(
				wasm.memory.buffer,
				wasm.output_offset(),
				outputSize,
			);
			return decoder.decode(output);
		};
	};
}
