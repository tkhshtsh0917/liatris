//! Single-threaded WebAssembly adapter with a bounded input buffer.

use std::cell::RefCell;

use crate::{MAX_INPUT_BYTES, Validator};

struct Buffers {
    input: Box<[u8]>,
    output: Vec<u8>,
    validator: Option<Validator>,
}

thread_local! {
    static BUFFERS: RefCell<Buffers> = RefCell::new(Buffers {
        input: vec![0; MAX_INPUT_BYTES].into_boxed_slice(),
        output: Vec::new(),
        validator: None,
    });
}

/// The host writes UTF-8 into this fixed input buffer before calling configure or project.
#[unsafe(no_mangle)]
pub extern "C" fn input_offset() -> *mut u8 {
    BUFFERS.with_borrow_mut(|buffers| buffers.input.as_mut_ptr())
}

/// Output is valid until the next call to project.
#[unsafe(no_mangle)]
pub extern "C" fn output_offset() -> *const u8 {
    BUFFERS.with_borrow(|buffers| buffers.output.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn configure(length: usize) -> bool {
    BUFFERS.with_borrow_mut(|buffers| {
        buffers.validator = buffers.input.get(..length).and_then(Validator::new);
        buffers.validator.is_some()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn project(length: usize) -> usize {
    BUFFERS.with_borrow_mut(|buffers| {
        buffers.output = buffers
            .input
            .get(..length)
            .and_then(|input| buffers.validator.as_ref()?.project(input))
            .unwrap_or_default();
        buffers.output.len()
    })
}
