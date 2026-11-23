//! Experimental event projection shared by the native and browser adapters.

mod fields;
mod projection;

#[cfg(all(feature = "native-addon", not(target_arch = "wasm32")))]
mod native;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use projection::Validator;

pub const MAX_INPUT_BYTES: usize = 128 * 1024;
const MAX_PROFILE_BYTES: usize = 64 * 1024;
const MAX_REQUESTS: usize = 32;
const MAX_OUTPUT_BYTES: usize = 2 * MAX_INPUT_BYTES;
