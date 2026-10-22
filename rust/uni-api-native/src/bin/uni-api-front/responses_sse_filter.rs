//! Responses SSE rewriting for the raw passthrough path.
//!
//! Copilot's `/responses` endpoint emits two shapes that break OpenAI
//! Responses clients: reasoning items that only carry an encrypted blob with an
//! empty `summary`, and item ids that are several-hundred-character encrypted
//! blobs instead of `fc_`/`msg_`/`rs_` identifiers. Both are corrected here,
//! frame by frame, without touching the bytes of frames that need no change.
use std::collections::{HashMap, HashSet};

use memchr::memmem;
use serde_json::Value;

use crate::responses_item_ids::ResponsesItemIdNormalizer;

/// Give up rewriting and pass an oversized, still unterminated frame through
/// verbatim instead of buffering without bound.
const MAX_PENDING_FRAME: usize = 8 << 20;

/// 丢弃 summary 为空的 reasoning item 事件。
///
/// Copilot 的 `/responses` 会返回只承载加密 blob、summary 为空的 reasoning
/// item，客户端无法使用这类 item。命中 `output_item.added` 时跳过该事件并
/// 记录 `output_index`，同 index 后续的 `output_item.done` 也一并丢弃。
#[derive(Default)]
pub(crate) struct EmptyReasoningItemFilter {
    dropped_output_indexes: HashSet<u64>,
}

impl EmptyReasoningItemFilter {
    pub(crate) fn should_drop(&mut self, event_type: &str, payload: &Value) -> bool {
        match event_type {
            "response.output_item.added" => {
                let Some(item) = payload.get("item") else {
                    return false;
                };
                if !is_empty_reasoning_item(item) {
                    return false;
                }
                let Some(output_index) = payload.get("output_index").and_then(Value::as_u64) else {
                    return false;
                };
                self.dropped_output_indexes.insert(output_index);
                true
            }
            "response.output_item.done" => payload
                .get("output_index")
                .and_then(Value::as_u64)
                .is_some_and(|index| self.dropped_output_indexes.remove(&index)),
            _ => false,
        }
    }
}

/// Drops filtered reasoning items, keeping the array order of the rest.
fn retain_answer_items(output: &mut Vec<Value>) -> bool {
    let before = output.len();
    output.retain(|item| !is_empty_reasoning_item(item));
    before != output.len()
}

fn is_empty_reasoning_item(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("reasoning")
        && item
            .get("summary")
            .is_none_or(|summary| summary.as_array().is_some_and(Vec::is_empty))
}

/// Non-streaming counterpart: drop empty reasoning items from `output` and
/// normalize the remaining item ids.
pub(crate) fn rewrite_response_payload(payload: &mut Value) -> bool {
    let mut changed = false;
    if let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) {
        changed = retain_answer_items(output);
    }
    let normalized = ResponsesItemIdNormalizer::default()
        .normalize(payload)
        .unwrap_or(false);
    changed || normalized
}

/// Incremental SSE frame rewriter.
///
/// Chunk boundaries never line up with event boundaries, so complete frames are
/// cut out of a persistent buffer and any partial tail waits for the next chunk.
pub(crate) struct SseRewriter {
    buffer: Vec<u8>,
    ids: ResponsesItemIdNormalizer,
    empty_reasoning: EmptyReasoningItemFilter,
    /// Copilot mints a fresh encrypted-blob id on every event of the same
    /// item, so the id first announced by `output_item.added` is pinned per
    /// `output_index` and reused for every later event of that item.
    output_ids: HashMap<u64, String>,
}

impl SseRewriter {
    pub(crate) fn new() -> Self {
        Self {
            buffer: Vec::new(),
            ids: ResponsesItemIdNormalizer::default(),
            empty_reasoning: EmptyReasoningItemFilter::default(),
            output_ids: HashMap::new(),
        }
    }

    /// Returns the bytes to emit for this chunk; empty when every frame was
    /// dropped or the chunk ended mid-frame.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::with_capacity(chunk.len());
        let mut consumed = 0;
        while let Some((offset, delimiter)) = find_frame_end(&self.buffer[consumed..]) {
            let end = consumed + offset + delimiter;
            rewrite_frame(
                &self.buffer[consumed..end],
                &mut out,
                &mut self.ids,
                &mut self.empty_reasoning,
                &mut self.output_ids,
            );
            consumed = end;
        }
        if consumed > 0 {
            self.buffer.drain(..consumed);
        } else if self.buffer.len() > MAX_PENDING_FRAME {
            out.append(&mut self.buffer);
        }
        out
    }

    /// Flushes the tail. A frame that never got its delimiter is emitted
    /// verbatim rather than dropped.
    pub(crate) fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.buffer.len());
        if !self.buffer.is_empty() {
            let tail = std::mem::take(&mut self.buffer);
            rewrite_frame(
                &tail,
                &mut out,
                &mut self.ids,
                &mut self.empty_reasoning,
                &mut self.output_ids,
            );
        }
        out
    }
}

fn find_frame_end(bytes: &[u8]) -> Option<(usize, usize)> {
    let lf = memmem::find(bytes, b"\n\n").map(|index| (index, 2));
    let crlf = memmem::find(bytes, b"\r\n\r\n").map(|index| (index, 4));
    match (lf, crlf) {
        (Some(lf), Some(crlf)) => Some(if lf.0 <= crlf.0 { lf } else { crlf }),
        (found, None) | (None, found) => found,
    }
}

fn possibly_relevant(frame: &[u8]) -> bool {
    const MARKERS: [&[u8]; 4] = [
        b"\"output_index\"",
        b"\"item_id\"",
        b"response.output_item.",
        b"response.completed",
    ];
    MARKERS
        .iter()
        .any(|marker| memmem::find(frame, marker).is_some())
}

fn relevant_payload(event_type: &str, payload: &Value) -> bool {
    payload.get("output_index").is_some()
        || payload.get("item_id").is_some()
        || event_type == "response.completed"
        || matches!(
            event_type,
            "response.output_item.added" | "response.output_item.done"
        )
}

fn rewrite_frame(
    frame: &[u8],
    out: &mut Vec<u8>,
    ids: &mut ResponsesItemIdNormalizer,
    empty_reasoning: &mut EmptyReasoningItemFilter,
    output_ids: &mut HashMap<u64, String>,
) {
    if !possibly_relevant(frame) {
        out.extend_from_slice(frame);
        return;
    }
    let Some(mut payload) = frame_payload(frame) else {
        out.extend_from_slice(frame);
        return;
    };
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(event_type) = event_type.filter(|event_type| relevant_payload(event_type, &payload))
    else {
        out.extend_from_slice(frame);
        return;
    };
    if empty_reasoning.should_drop(&event_type, &payload) {
        return;
    }
    // Best effort: a rejected mapping keeps the frame as the upstream sent it.
    let mut changed = ids.normalize(&mut payload).unwrap_or(false);
    if event_type == "response.output_item.added" {
        if let (Some(index), Some(id)) = (
            payload.get("output_index").and_then(Value::as_u64),
            payload.pointer("/item/id").and_then(Value::as_str),
        ) {
            output_ids.entry(index).or_insert_with(|| id.to_owned());
        }
    }
    changed |= bind_payload_ids(&event_type, &mut payload, output_ids);
    if event_type == "response.completed" {
        if let Some(output) = payload
            .pointer_mut("/response/output")
            .and_then(Value::as_array_mut)
        {
            changed |= retain_answer_items(output);
        }
    }
    if !changed {
        out.extend_from_slice(frame);
        return;
    }
    match serde_json::to_string(&payload) {
        Ok(data) => {
            out.extend_from_slice(format!("event: {event_type}\ndata: {data}\n\n").as_bytes());
        }
        Err(_) => out.extend_from_slice(frame),
    }
}

/// Copies the pinned id of each `output_index` onto the payload's references.
fn bind_payload_ids(
    event_type: &str,
    payload: &mut Value,
    output_ids: &HashMap<u64, String>,
) -> bool {
    let mut changed = false;
    if let Some(index) = payload.get("output_index").and_then(Value::as_u64) {
        if let Some(bound) = output_ids.get(&index).cloned() {
            changed |= replace_id(payload, "item_id", &bound);
            if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut) {
                changed |= replace_in_map(item, &bound);
            }
        }
    }
    if event_type == "response.completed" {
        if let Some(output) = payload
            .pointer_mut("/response/output")
            .and_then(Value::as_array_mut)
        {
            for (index, item) in output.iter_mut().enumerate() {
                let Some(bound) = output_ids.get(&(index as u64)) else {
                    continue;
                };
                if let Some(item) = item.as_object_mut() {
                    changed |= replace_in_map(item, bound);
                }
            }
        }
    }
    changed
}

fn replace_id(payload: &mut Value, key: &str, bound: &str) -> bool {
    if payload.get(key).and_then(Value::as_str) == Some(bound) {
        return false;
    }
    if payload.get(key).is_none() {
        return false;
    }
    payload[key] = Value::String(bound.to_owned());
    true
}

fn replace_in_map(item: &mut serde_json::Map<String, Value>, bound: &str) -> bool {
    if item.get("id").and_then(Value::as_str) == Some(bound) {
        return false;
    }
    if item.get("id").is_none() {
        return false;
    }
    item.insert("id".into(), Value::String(bound.to_owned()));
    true
}

fn frame_payload(frame: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(frame).ok()?;
    let mut data = String::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(value) = line.strip_prefix("data:") else {
            continue;
        };
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(value.strip_prefix(' ').unwrap_or(value));
    }
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&data).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BLOB: &str = "Fg6HoXWnpgBBpR6wr2wJSDyY3ecmHzauXjRZXRDH+iZFH2pwVaaHULdNKuR6RpxK+nOZC4LhbnRFAc8pJpErpJJE5YvtavhcUToDvp7of4gNT6FtmJOWzhGaHgrCFYHFYvWGyXWjptCrjkrMGOQa1EVpcfdXBVt7LYb91IndZn1YJdUtgAnsAeECDXuB8sVgSw";

    fn frame(payload: Value) -> String {
        format!(
            "event: {}\ndata: {payload}\n\n",
            payload["type"].as_str().unwrap()
        )
    }

    #[test]
    fn drops_empty_summary_reasoning_item_and_keeps_informative_ones() {
        let mut filter = EmptyReasoningItemFilter::default();
        let empty = json!({
            "type":"response.output_item.added","output_index":0,
            "item":{"type":"reasoning","id":"rs_blob","summary":[],"encrypted_content":"x"}
        });
        assert!(filter.should_drop("response.output_item.added", &empty));
        assert!(filter.should_drop(
            "response.output_item.done",
            &json!({"type":"response.output_item.done","output_index":0})
        ));
        let informative = json!({
            "type":"response.output_item.added","output_index":1,
            "item":{"type":"reasoning","id":"rs_blob","summary":[{"type":"summary_text","text":"ok"}]}
        });
        assert!(!filter.should_drop("response.output_item.added", &informative));
        let message = json!({
            "type":"response.output_item.added","output_index":2,
            "item":{"type":"message","id":"msg_1","content":[]}
        });
        assert!(!filter.should_drop("response.output_item.added", &message));
    }

    #[test]
    fn drops_empty_reasoning_frames_and_pins_one_id_per_output_index() {
        // Copilot mints a fresh encrypted-blob id on every event of the same
        // item, so ids can only be matched through `output_index`.
        let mut rewriter = SseRewriter::new();
        let wire = [
            frame(json!({
                "type":"response.output_item.added","output_index":0,
                "item":{"type":"reasoning","id":format!("{BLOB}r1"),"summary":[],"encrypted_content":BLOB}
            })),
            frame(json!({"type":"response.output_item.done","output_index":0,
                "item":{"type":"reasoning","id":format!("{BLOB}r2"),"summary":[]}})),
            frame(json!({
                "type":"response.output_item.added","output_index":1,
                "item":{"type":"message","id":format!("{BLOB}m1"),"content":[]}
            })),
            frame(json!({"type":"response.content_part.added","output_index":1,
                "item_id":format!("{BLOB}m0"),"part":{"type":"output_text","text":""}})),
            frame(json!({"type":"response.output_text.delta","output_index":1,
                "item_id":format!("{BLOB}m2"),"delta":"hi"})),
            frame(json!({"type":"response.output_item.done","output_index":1,
                "item":{"type":"message","id":format!("{BLOB}m3"),"content":[]}})),
            frame(json!({
                "type":"response.output_item.added","output_index":2,
                "item":{"type":"function_call","id":format!("{BLOB}c1"),"name":"shell","arguments":""}
            })),
            frame(json!({"type":"response.function_call_arguments.delta","output_index":2,
                "item_id":format!("{BLOB}c2"),"delta":"cmd"})),
            frame(json!({"type":"response.function_call_arguments.done","output_index":2,
                "item_id":format!("{BLOB}c3"),"arguments":"{\"cmd\":\"echo hi\"}"})),
            frame(json!({"type":"response.output_item.done","output_index":2,
                "item":{"type":"function_call","id":format!("{BLOB}c4"),"name":"shell","arguments":"{}"}})),
            frame(json!({"type":"response.completed","response":{"output":[
                {"type":"reasoning","id":format!("{BLOB}r3")},
                {"type":"message","id":format!("{BLOB}m4")},
                {"type":"function_call","id":format!("{BLOB}c5"),"name":"shell","arguments":"{}"}
            ]}})),
        ]
        .concat();
        let out = rewriter.push(wire.as_bytes());
        assert_eq!(rewriter.finish(), Vec::<u8>::new());
        let out = String::from_utf8(out).unwrap();
        assert!(!out.contains(BLOB), "blob id leaked: {out}");

        let payloads = out
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .collect::<Vec<_>>();
        assert!(
            !payloads.iter().any(|payload| payload["type"]
                .as_str()
                .is_some_and(|event| event.starts_with("response.output_item"))
                && payload["item"]["type"] == "reasoning"),
            "empty reasoning frame leaked: {out}"
        );

        let msg_id = payloads
            .iter()
            .find(|payload| {
                payload["type"] == "response.output_item.added"
                    && payload["item"]["type"] == "message"
            })
            .unwrap()["item"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let call_id = payloads
            .iter()
            .find(|payload| {
                payload["type"] == "response.output_item.added"
                    && payload["item"]["type"] == "function_call"
            })
            .unwrap()["item"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(msg_id.starts_with("msg_") && msg_id.len() <= 64, "{msg_id}");
        assert!(
            call_id.starts_with("fc_") && call_id.len() <= 64,
            "{call_id}"
        );

        // Every reference to an item agrees with the id announced by `added`.
        for payload in &payloads {
            match payload["type"].as_str().unwrap() {
                "response.output_item.added" => {}
                "response.output_item.done" => {
                    let expected = if payload["output_index"] == 1 {
                        &msg_id
                    } else {
                        &call_id
                    };
                    assert_eq!(payload["item"]["id"], expected.as_str());
                }
                "response.content_part.added" | "response.output_text.delta" => {
                    assert_eq!(payload["item_id"], msg_id.as_str());
                }
                "response.function_call_arguments.delta"
                | "response.function_call_arguments.done" => {
                    assert_eq!(payload["item_id"], call_id.as_str());
                }
                "response.completed" => {
                    // The filtered reasoning item is gone from the final output
                    // too; the remaining items keep their pinned ids.
                    let output = payload["response"]["output"].as_array().unwrap();
                    assert_eq!(output.len(), 2);
                    assert_eq!(output[0]["id"], msg_id.as_str());
                    assert_eq!(output[1]["id"], call_id.as_str());
                }
                other => panic!("unexpected event {other}"),
            }
        }
    }

    #[test]
    fn reassembles_frames_split_at_arbitrary_chunk_boundaries() {
        let wire = format!(
            "{}{}{}",
            frame(json!({"type":"response.output_item.added","output_index":0,
                "item":{"type":"message","id":"item_m1"}})),
            frame(json!({"type":"response.output_text.delta","item_id":"item_m1","delta":"hello"})),
            frame(
                json!({"type":"response.output_text.delta","item_id":"item_m1","delta":" world"})
            )
        );
        let mut rewriter = SseRewriter::new();
        let mut out = Vec::new();
        for byte in wire.as_bytes() {
            out.extend_from_slice(&rewriter.push(&[*byte]));
        }
        out.extend_from_slice(&rewriter.finish());
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("\"id\":\"msg_m1\""));
        assert_eq!(out.matches("\"item_id\":\"msg_m1\"").count(), 2);
        assert!(out.contains("\"delta\":\"hello\"") && out.contains("\"delta\":\" world\""));
    }

    #[test]
    fn oversized_unterminated_frame_is_passed_through_instead_of_buffered() {
        let mut rewriter = SseRewriter::new();
        let mut out = Vec::new();
        for _ in 0..9 {
            out.extend_from_slice(&rewriter.push(&vec![b'a'; 1 << 20]));
        }
        assert_eq!(out.len(), 9 << 20);
        assert!(rewriter.buffer.is_empty());
        assert_eq!(rewriter.finish(), Vec::<u8>::new());
    }

    #[test]
    fn flushes_an_unterminated_tail_verbatim() {
        let mut rewriter = SseRewriter::new();
        let tail = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.";
        assert!(rewriter.push(tail.as_bytes()).is_empty());
        assert_eq!(rewriter.finish(), tail.as_bytes());
    }

    #[test]
    fn non_streaming_payload_drops_empty_reasoning_and_normalizes_ids() {
        let mut payload = json!({"output":[
            {"type":"reasoning","id":BLOB,"summary":[],"encrypted_content":BLOB},
            {"type":"message","id":"item_m1","content":[]}
        ]});
        assert!(rewrite_response_payload(&mut payload));
        assert_eq!(payload["output"].as_array().unwrap().len(), 1);
        assert_eq!(payload["output"][0]["id"], "msg_m1");
    }
}
