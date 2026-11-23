//! Profile field matching and extension projection.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Map, Value};

pub type Fields = Map<String, Value>;
pub type Rules = BTreeMap<String, Rule>;

#[derive(Deserialize)]
pub struct Rule {
    #[serde(default)]
    required: bool,
    #[serde(flatten)]
    kind: Kind,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Kind {
    String {
        #[serde(rename = "maxLength")]
        max_length: usize,
    },
    Integer {
        minimum: Option<f64>,
    },
    Number {
        minimum: Option<f64>,
    },
    Boolean,
}

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub fn is_safe_integer(value: f64) -> bool {
    value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
}

fn within_utf16_limit(value: &str, limit: usize) -> bool {
    // A valid UTF-8 string never uses fewer bytes than UTF-16 code units.
    value.len() <= limit || value.encode_utf16().take(limit.saturating_add(1)).count() <= limit
}

fn matches_rule(value: &Value, rule: &Rule) -> bool {
    match &rule.kind {
        Kind::String { max_length } => value
            .as_str()
            .is_some_and(|value| within_utf16_limit(value, *max_length)),
        Kind::Integer { minimum } | Kind::Number { minimum } => value.as_f64().is_some_and(|n| {
            n.is_finite()
                && (!matches!(rule.kind, Kind::Integer { .. }) || is_safe_integer(n))
                && minimum.is_none_or(|lower| n >= lower)
        }),
        Kind::Boolean => value.is_boolean(),
    }
}

pub fn allow_keys(object: &Fields, keys: &[&str]) -> Option<()> {
    object
        .keys()
        .all(|key| keys.contains(&key.as_str()))
        .then_some(())
}

pub fn scalar_fields(input: Fields, rules: Option<&Rules>) -> Option<Fields> {
    let Some(rules) = rules else {
        return input.is_empty().then_some(input);
    };
    let allowed = input
        .iter()
        .all(|(key, value)| rules.get(key).is_some_and(|rule| matches_rule(value, rule)))
        && rules
            .iter()
            .all(|(key, rule)| !rule.required || input.contains_key(key));
    allowed.then_some(input)
}

pub fn object(value: Value) -> Option<Fields> {
    if let Value::Object(value) = value {
        Some(value)
    } else {
        None
    }
}

pub fn string(value: Value, max_length: usize, empty: bool) -> Option<Value> {
    let text = value.as_str()?;
    ((empty || !text.is_empty()) && within_utf16_limit(text, max_length)).then_some(value)
}
