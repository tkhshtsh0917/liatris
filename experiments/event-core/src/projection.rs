//! Profile compilation and extraction of the allowed input fields.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use super::fields::{Fields, Rules, allow_keys, is_safe_integer, object, scalar_fields, string};
use super::{MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_PROFILE_BYTES, MAX_REQUESTS};

#[derive(Deserialize)]
struct Event {
    fields: Option<Rules>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Validator {
    allow_query_text: bool,
    events: BTreeMap<String, Event>,
    #[serde(default)]
    extensions: BTreeMap<String, Rules>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Request {
    Event { name: String, data: Value },
    Query { data: Value },
}

impl Validator {
    /// Loads only the projection rules from a compiled collection profile.
    pub fn new(profile: &[u8]) -> Option<Self> {
        if profile.len() > MAX_PROFILE_BYTES {
            return None;
        }
        serde_json::from_slice(profile).ok()
    }

    /// Returns one projection or null per request. None means the batch could
    /// not be represented by this JSON adapter and must use the host path.
    pub fn project(&self, input: &[u8]) -> Option<Vec<u8>> {
        if input.len() > MAX_INPUT_BYTES {
            return None;
        }
        let requests: Vec<Request> = serde_json::from_slice(input).ok()?;
        if requests.is_empty() || requests.len() > MAX_REQUESTS {
            return None;
        }
        let projected: Vec<_> = requests
            .into_iter()
            .map(|request| match request {
                Request::Event { name, data } => self.event(name, data),
                Request::Query { data } => self.query(data),
            })
            .collect();
        let output = serde_json::to_vec(&projected).ok()?;
        (output.len() <= MAX_OUTPUT_BYTES).then_some(output)
    }

    fn query(&self, data: Value) -> Option<Value> {
        if !self.allow_query_text {
            return None;
        }
        let mut data = object(data)?;
        allow_keys(&data, &["query_id", "user_query", "query_attributes"])?;
        let id = string(data.remove("query_id")?, 100, false)?;
        let text = string(data.remove("user_query")?, 1024, true)?;
        let attributes = self.extension(data.remove("query_attributes"), "query_attributes")?;
        Some(Value::Object(Fields::from_iter([
            ("query_id".into(), id),
            ("user_query".into(), text),
            ("query_attributes".into(), Value::Object(attributes)),
        ])))
    }

    fn event(&self, name: String, data: Value) -> Option<Value> {
        let event = self.events.get(&name)?;
        let mut data = object(data)?;
        allow_keys(&data, &["query_id", "event_attributes", "metadata"])?;
        let mut payload = Fields::new();
        payload.insert("action_name".into(), Value::String(name));
        if let Some(query_id) = data.remove("query_id") {
            payload.insert("query_id".into(), string(query_id, 100, false)?);
        }
        if let Some(attributes) = data.remove("event_attributes") {
            payload.insert("event_attributes".into(), self.attributes(attributes)?);
        }

        let metadata = data
            .remove("metadata")
            .map(object)
            .unwrap_or_else(|| Some(Fields::new()))?;
        let metadata = scalar_fields(metadata, event.fields.as_ref())?;
        Some(Value::Object(Fields::from_iter([
            ("payload".into(), Value::Object(payload)),
            ("metadata".into(), Value::Object(metadata)),
        ])))
    }

    fn extension(&self, value: Option<Value>, path: &str) -> Option<Fields> {
        let fields = value.map(object).unwrap_or_else(|| Some(Fields::new()))?;
        scalar_fields(fields, self.extensions.get(path))
    }

    fn attributes(&self, value: Value) -> Option<Value> {
        let mut fields = object(value)?;
        let position = self.position(fields.remove("position")?)?;
        let object = fields.remove("object");

        let mut fields = scalar_fields(fields, self.extensions.get("event_attributes"))?;
        fields.insert("position".into(), position);
        if let Some(object) = object {
            fields.insert("object".into(), self.result(object)?);
        }
        Some(Value::Object(fields))
    }

    fn position(&self, value: Value) -> Option<Value> {
        let mut fields = object(value)?;
        let ordinal = fields.remove("ordinal")?;
        let rank = ordinal.as_f64()?;
        if rank < 1.0 || !is_safe_integer(rank) {
            return None;
        }
        let mut fields = scalar_fields(fields, self.extensions.get("event_attributes.position"))?;
        fields.insert("ordinal".into(), ordinal);
        Some(Value::Object(fields))
    }

    fn result(&self, value: Value) -> Option<Value> {
        let mut fields = object(value)?;
        let id = string(fields.remove("object_id")?, 1024, false)?;
        let object_type = fields.remove("object_id_type");

        let mut fields = scalar_fields(fields, self.extensions.get("event_attributes.object"))?;
        fields.insert("object_id".into(), id);
        if let Some(object_type) = object_type {
            fields.insert("object_id_type".into(), string(object_type, 100, false)?);
        }
        Some(Value::Object(fields))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_out_of_bounds_frame_before_parsing() {
        let profile = br#"{"allowQueryText":false,"events":{}}"#;
        let validator = Validator::new(profile).expect("compiled profile");
        assert!(Validator::new(&vec![b' '; MAX_PROFILE_BYTES + 1]).is_none());
        assert!(
            validator
                .project(&vec![b' '; MAX_INPUT_BYTES + 1])
                .is_none()
        );
        assert!(validator.project(b"[]").is_none());
        assert_eq!(
            validator
                .project(br#"[{"kind":"query","data":{}}]"#)
                .as_deref(),
            Some(b"[null]".as_slice())
        );
    }
}
