use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use thiserror::Error;

pub const BINARY_HEADER_BYTES: usize = 28;
pub const MAX_BINARY_PAYLOAD_BYTES: usize = 60 * 1024;
pub const MAX_SEQUENCE_DOMAINS: usize = 64;
pub const MAX_RESYNC_ADVANCE: u64 = 4096;
pub const MAX_OPERATION_REPLAY_IDS: usize = 4096;

pub const FLAG_FINAL: u16 = 1 << 0;
pub const FLAG_KEYFRAME: u16 = 1 << 1;
pub const FLAG_RESYNC: u16 = 1 << 2;
pub const FLAG_DROPPED_BEFORE: u16 = 1 << 3;
const KNOWN_FLAGS: u16 = FLAG_FINAL | FLAG_KEYFRAME | FLAG_RESYNC | FLAG_DROPPED_BEFORE;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[repr(u8)]
#[serde(rename_all = "camelCase")]
pub enum BinaryChannel {
    TerminalOutput = 1,
    TerminalSnapshot = 2,
    BrowserScreencast = 3,
    Screenshot = 4,
    File = 5,
    Attachment = 6,
    Emulator = 7,
}

impl BinaryChannel {
    pub fn latest_frame_wins(self) -> bool {
        matches!(self, Self::BrowserScreencast | Self::Emulator)
    }
}

impl TryFrom<u8> for BinaryChannel {
    type Error = anyhow::Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            1 => Ok(Self::TerminalOutput),
            2 => Ok(Self::TerminalSnapshot),
            3 => Ok(Self::BrowserScreencast),
            4 => Ok(Self::Screenshot),
            5 => Ok(Self::File),
            6 => Ok(Self::Attachment),
            7 => Ok(Self::Emulator),
            _ => bail!("unknown remote-v2 binary channel {value}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryFrame {
    pub channel: BinaryChannel,
    pub flags: u16,
    pub stream_id: u64,
    pub sequence: u64,
    pub dropped_before: u32,
    pub payload: Vec<u8>,
}

impl BinaryFrame {
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let payload_len = u32::try_from(self.payload.len()).context("binary payload length")?;
        let mut encoded = Vec::with_capacity(BINARY_HEADER_BYTES + self.payload.len());
        encoded.push(super::PROTOCOL_VERSION as u8);
        encoded.push(self.channel as u8);
        encoded.extend_from_slice(&self.flags.to_be_bytes());
        encoded.extend_from_slice(&self.stream_id.to_be_bytes());
        encoded.extend_from_slice(&self.sequence.to_be_bytes());
        encoded.extend_from_slice(&self.dropped_before.to_be_bytes());
        encoded.extend_from_slice(&payload_len.to_be_bytes());
        encoded.extend_from_slice(&self.payload);
        Ok(encoded)
    }

    pub fn decode(encoded: &[u8]) -> Result<Self> {
        if encoded.len() < BINARY_HEADER_BYTES {
            bail!("remote-v2 binary frame is truncated");
        }
        if encoded[0] != super::PROTOCOL_VERSION as u8 {
            bail!("remote-v2 binary protocol mismatch");
        }
        let channel = BinaryChannel::try_from(encoded[1])?;
        let flags = u16::from_be_bytes(encoded[2..4].try_into().expect("fixed header"));
        let stream_id = u64::from_be_bytes(encoded[4..12].try_into().expect("fixed header"));
        let sequence = u64::from_be_bytes(encoded[12..20].try_into().expect("fixed header"));
        let dropped_before = u32::from_be_bytes(encoded[20..24].try_into().expect("fixed header"));
        let payload_len =
            u32::from_be_bytes(encoded[24..28].try_into().expect("fixed header")) as usize;
        if payload_len > MAX_BINARY_PAYLOAD_BYTES
            || encoded.len() != BINARY_HEADER_BYTES + payload_len
        {
            bail!("invalid remote-v2 binary payload length");
        }
        let frame = Self {
            channel,
            flags,
            stream_id,
            sequence,
            dropped_before,
            payload: encoded[BINARY_HEADER_BYTES..].to_vec(),
        };
        frame.validate()?;
        Ok(frame)
    }

    fn validate(&self) -> Result<()> {
        if self.stream_id == 0 || self.sequence == 0 {
            bail!("remote-v2 binary stream and sequence must be non-zero");
        }
        if self.flags & !KNOWN_FLAGS != 0 {
            bail!("remote-v2 binary frame contains unknown flags");
        }
        if self.payload.len() > MAX_BINARY_PAYLOAD_BYTES {
            bail!("remote-v2 binary payload exceeds the encrypted frame limit");
        }
        if self.dropped_before > 0 {
            if !self.channel.latest_frame_wins() || self.flags & FLAG_DROPPED_BEFORE == 0 {
                bail!("drop accounting is only valid for latest-frame channels");
            }
        } else if self.flags & FLAG_DROPPED_BEFORE != 0 {
            bail!("drop flag requires a non-zero dropped count");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct StreamKey {
    channel: BinaryChannel,
    stream_id: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EnqueueOutcome {
    Queued,
    Replaced { dropped: u32 },
}

pub struct BinaryStreamQueue {
    max_frames_per_stream: usize,
    max_bytes_per_stream: usize,
    queues: HashMap<StreamKey, VecDeque<BinaryFrame>>,
    queued_bytes: HashMap<StreamKey, usize>,
}

impl BinaryStreamQueue {
    pub fn new(max_frames_per_stream: usize, max_bytes_per_stream: usize) -> Result<Self> {
        if max_frames_per_stream == 0 || max_bytes_per_stream == 0 {
            bail!("remote-v2 stream queue bounds must be non-zero");
        }
        Ok(Self {
            max_frames_per_stream,
            max_bytes_per_stream,
            queues: HashMap::new(),
            queued_bytes: HashMap::new(),
        })
    }

    pub fn enqueue(&mut self, mut frame: BinaryFrame) -> Result<EnqueueOutcome> {
        frame.validate()?;
        let key = StreamKey {
            channel: frame.channel,
            stream_id: frame.stream_id,
        };
        let queue = self.queues.entry(key).or_default();
        let bytes = self.queued_bytes.entry(key).or_default();
        if frame.channel.latest_frame_wins() {
            let dropped = queue.drain(..).fold(0_u32, |total, queued| {
                total.saturating_add(1 + queued.dropped_before)
            });
            *bytes = 0;
            if frame.payload.len() > self.max_bytes_per_stream {
                bail!("remote-v2 latest frame exceeds stream byte bound");
            }
            if dropped > 0 {
                frame.dropped_before = frame.dropped_before.saturating_add(dropped);
                frame.flags |= FLAG_DROPPED_BEFORE;
            }
            *bytes = frame.payload.len();
            queue.push_back(frame);
            return Ok(if dropped == 0 {
                EnqueueOutcome::Queued
            } else {
                EnqueueOutcome::Replaced { dropped }
            });
        }
        if queue.len() >= self.max_frames_per_stream
            || bytes.saturating_add(frame.payload.len()) > self.max_bytes_per_stream
        {
            bail!("remote-v2 lossless stream backpressure");
        }
        *bytes += frame.payload.len();
        queue.push_back(frame);
        Ok(EnqueueOutcome::Queued)
    }

    pub fn pop(&mut self, channel: BinaryChannel, stream_id: u64) -> Option<BinaryFrame> {
        let key = StreamKey { channel, stream_id };
        let frame = self.queues.get_mut(&key)?.pop_front()?;
        if let Some(bytes) = self.queued_bytes.get_mut(&key) {
            *bytes = bytes.saturating_sub(frame.payload.len());
        }
        Some(frame)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalBackpressureReason {
    PerStream,
    Connection,
    ResyncRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalRecordDecision {
    Recorded,
    Backpressured { reason: TerminalBackpressureReason },
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TerminalFlowError {
    #[error("remote-v2 terminal stream id must be non-zero")]
    InvalidStreamId,
    #[error("remote-v2 terminal flow stream limit {max_streams} exceeded")]
    StreamLimitExceeded { max_streams: usize },
    #[error(
        "remote-v2 terminal sequence {received} is not above highest sent sequence {highest_sent} for stream {stream_id}"
    )]
    SequenceNotIncreasing {
        stream_id: u64,
        highest_sent: u64,
        received: u64,
    },
    #[error(
        "remote-v2 terminal ack {received} is ahead of highest sent sequence {highest_sent} for stream {stream_id}"
    )]
    AckAhead {
        stream_id: u64,
        highest_sent: u64,
        received: u64,
    },
    #[error(
        "remote-v2 terminal ack {received} is behind last acknowledged sequence {last_acknowledged} for stream {stream_id}"
    )]
    AckBehind {
        stream_id: u64,
        last_acknowledged: u64,
        received: u64,
    },
}

#[derive(Default)]
struct TerminalAckStream {
    sent: VecDeque<(u64, usize)>,
    last_acknowledged_sequence: u64,
    highest_sent_sequence: u64,
    unacked_bytes: usize,
    requires_resync: bool,
}

pub struct TerminalAckWindow {
    max_unacked_bytes_per_stream: usize,
    max_unacked_bytes_per_connection: usize,
    connection_unacked_bytes: usize,
    streams: HashMap<u64, TerminalAckStream>,
}

impl TerminalAckWindow {
    pub fn new(
        max_unacked_bytes_per_stream: usize,
        max_unacked_bytes_per_connection: usize,
    ) -> Result<Self> {
        if max_unacked_bytes_per_stream == 0 || max_unacked_bytes_per_connection == 0 {
            bail!("remote-v2 terminal flow bounds must be non-zero");
        }
        Ok(Self {
            max_unacked_bytes_per_stream,
            max_unacked_bytes_per_connection,
            connection_unacked_bytes: 0,
            streams: HashMap::new(),
        })
    }

    pub fn record_sent(
        &mut self,
        stream_id: u64,
        sequence: u64,
        bytes: usize,
    ) -> std::result::Result<TerminalRecordDecision, TerminalFlowError> {
        if stream_id == 0 {
            return Err(TerminalFlowError::InvalidStreamId);
        }
        let highest_sent = self
            .streams
            .get(&stream_id)
            .map_or(0, |stream| stream.highest_sent_sequence);
        if sequence == 0 || sequence <= highest_sent {
            return Err(TerminalFlowError::SequenceNotIncreasing {
                stream_id,
                highest_sent,
                received: sequence,
            });
        }

        let max_unacked_bytes_per_stream = self.max_unacked_bytes_per_stream;
        let max_unacked_bytes_per_connection = self.max_unacked_bytes_per_connection;
        let connection_unacked_bytes = self.connection_unacked_bytes;
        let stream = self.ensure_stream(stream_id)?;
        if stream.requires_resync && bytes > 0 {
            return Ok(TerminalRecordDecision::Backpressured {
                reason: TerminalBackpressureReason::ResyncRequired,
            });
        }

        let reason = if bytes > max_unacked_bytes_per_stream.saturating_sub(stream.unacked_bytes) {
            Some(TerminalBackpressureReason::PerStream)
        } else if bytes > max_unacked_bytes_per_connection.saturating_sub(connection_unacked_bytes)
        {
            Some(TerminalBackpressureReason::Connection)
        } else {
            None
        };
        if let Some(reason) = reason {
            stream.requires_resync = true;
            return Ok(TerminalRecordDecision::Backpressured { reason });
        }

        stream.highest_sent_sequence = sequence;
        stream.unacked_bytes += bytes;
        if bytes > 0 {
            stream.sent.push_back((sequence, bytes));
        }
        self.connection_unacked_bytes += bytes;
        Ok(TerminalRecordDecision::Recorded)
    }

    pub fn ack(
        &mut self,
        stream_id: u64,
        sequence: u64,
    ) -> std::result::Result<usize, TerminalFlowError> {
        if stream_id == 0 {
            return Err(TerminalFlowError::InvalidStreamId);
        }
        let (highest_sent, last_acknowledged) = self
            .streams
            .get(&stream_id)
            .map(|stream| {
                (
                    stream.highest_sent_sequence,
                    stream.last_acknowledged_sequence,
                )
            })
            .unwrap_or((0, 0));
        if sequence > highest_sent {
            return Err(TerminalFlowError::AckAhead {
                stream_id,
                highest_sent,
                received: sequence,
            });
        }
        if sequence < last_acknowledged {
            return Err(TerminalFlowError::AckBehind {
                stream_id,
                last_acknowledged,
                received: sequence,
            });
        }
        if sequence == last_acknowledged {
            return Ok(0);
        }

        let stream = self
            .streams
            .get_mut(&stream_id)
            .expect("a positive valid terminal ack has sent history");
        let mut released = 0;
        while stream
            .sent
            .front()
            .is_some_and(|(sent_sequence, _)| *sent_sequence <= sequence)
        {
            let (_, bytes) = stream.sent.pop_front().expect("front was present");
            released += bytes;
        }
        stream.last_acknowledged_sequence = sequence;
        stream.unacked_bytes -= released;
        self.connection_unacked_bytes -= released;
        Ok(released)
    }

    pub fn mark_gap(&mut self, stream_id: u64) -> std::result::Result<usize, TerminalFlowError> {
        let stream = self.ensure_stream(stream_id)?;
        let released = stream.unacked_bytes;
        stream.sent.clear();
        stream.unacked_bytes = 0;
        stream.requires_resync = true;
        self.connection_unacked_bytes -= released;
        Ok(released)
    }

    pub fn remove_stream(
        &mut self,
        stream_id: u64,
    ) -> std::result::Result<usize, TerminalFlowError> {
        if stream_id == 0 {
            return Err(TerminalFlowError::InvalidStreamId);
        }
        let Some(stream) = self.streams.remove(&stream_id) else {
            return Ok(0);
        };
        self.connection_unacked_bytes -= stream.unacked_bytes;
        Ok(stream.unacked_bytes)
    }

    pub fn complete_resync(&mut self, stream_id: u64) -> bool {
        let Some(stream) = self.streams.get_mut(&stream_id) else {
            return false;
        };
        let was_required = stream.requires_resync;
        stream.requires_resync = false;
        was_required
    }

    pub fn requires_resync(&self, stream_id: u64) -> bool {
        self.streams
            .get(&stream_id)
            .is_some_and(|stream| stream.requires_resync)
    }

    pub fn stream_unacked_bytes(&self, stream_id: u64) -> usize {
        self.streams
            .get(&stream_id)
            .map_or(0, |stream| stream.unacked_bytes)
    }

    pub fn connection_unacked_bytes(&self) -> usize {
        self.connection_unacked_bytes
    }

    pub fn last_acknowledged_sequence(&self, stream_id: u64) -> u64 {
        self.streams
            .get(&stream_id)
            .map_or(0, |stream| stream.last_acknowledged_sequence)
    }

    pub fn highest_sent_sequence(&self, stream_id: u64) -> u64 {
        self.streams
            .get(&stream_id)
            .map_or(0, |stream| stream.highest_sent_sequence)
    }

    pub fn tracked_streams(&self) -> usize {
        self.streams.len()
    }

    fn ensure_stream(
        &mut self,
        stream_id: u64,
    ) -> std::result::Result<&mut TerminalAckStream, TerminalFlowError> {
        if stream_id == 0 {
            return Err(TerminalFlowError::InvalidStreamId);
        }
        if !self.streams.contains_key(&stream_id) {
            if self.streams.len() >= MAX_SEQUENCE_DOMAINS {
                return Err(TerminalFlowError::StreamLimitExceeded {
                    max_streams: MAX_SEQUENCE_DOMAINS,
                });
            }
            self.streams.insert(stream_id, TerminalAckStream::default());
        }
        Ok(self
            .streams
            .get_mut(&stream_id)
            .expect("terminal stream was inserted"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SequenceError {
    Replay { expected: u64, received: u64 },
    Gap { expected: u64, received: u64 },
    InvalidDomain,
}

#[derive(Default)]
pub struct DomainSequenceValidator {
    expected: HashMap<String, u64>,
}

impl DomainSequenceValidator {
    pub fn validate(
        &mut self,
        domain: &str,
        sequence: u64,
    ) -> std::result::Result<(), SequenceError> {
        if !self.accepts_domain(domain) {
            return Err(SequenceError::InvalidDomain);
        }
        let expected = self.expected.entry(domain.to_string()).or_insert(1);
        if sequence < *expected {
            return Err(SequenceError::Replay {
                expected: *expected,
                received: sequence,
            });
        }
        if sequence > *expected {
            return Err(SequenceError::Gap {
                expected: *expected,
                received: sequence,
            });
        }
        *expected = expected.saturating_add(1);
        Ok(())
    }

    pub fn resync(&mut self, domain: &str, next_sequence: u64) -> Result<()> {
        if !self.accepts_domain(domain) {
            bail!("invalid remote-v2 sequence domain");
        }
        let current = *self.expected.get(domain).unwrap_or(&1);
        if next_sequence < current || next_sequence.saturating_sub(current) > MAX_RESYNC_ADVANCE {
            bail!("remote-v2 resync is outside the allowed replay window");
        }
        self.expected.insert(domain.to_string(), next_sequence);
        Ok(())
    }

    fn accepts_domain(&self, domain: &str) -> bool {
        !domain.is_empty()
            && domain.len() <= 64
            && domain
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
            && (self.expected.contains_key(domain) || self.expected.len() < MAX_SEQUENCE_DOMAINS)
    }

    pub fn expected(&self, domain: &str) -> u64 {
        *self.expected.get(domain).unwrap_or(&1)
    }
}

pub struct OperationReplayWindow {
    capacity: usize,
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl OperationReplayWindow {
    pub fn new(capacity: usize) -> Result<Self> {
        if capacity == 0 || capacity > MAX_OPERATION_REPLAY_IDS {
            bail!("invalid remote-v2 operation replay bound");
        }
        Ok(Self {
            capacity,
            order: VecDeque::new(),
            ids: HashSet::new(),
        })
    }

    pub fn record(&mut self, operation_id: &str) -> bool {
        if self.ids.contains(operation_id) {
            return false;
        }
        self.ids.insert(operation_id.to_string());
        self.order.push_back(operation_id.to_string());
        while self.order.len() > self.capacity {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayError {
    Gap { oldest_available: u64 },
}

pub struct ReplayBuffer<T> {
    max_items: usize,
    max_bytes: usize,
    bytes: usize,
    items: VecDeque<(u64, usize, T)>,
}

impl<T: Clone> ReplayBuffer<T> {
    pub fn new(max_items: usize, max_bytes: usize) -> Result<Self> {
        if max_items == 0 || max_bytes == 0 {
            bail!("remote-v2 replay bounds must be non-zero");
        }
        Ok(Self {
            max_items,
            max_bytes,
            bytes: 0,
            items: VecDeque::new(),
        })
    }

    pub fn push(&mut self, sequence: u64, bytes: usize, item: T) -> Result<()> {
        if bytes > self.max_bytes {
            bail!("remote-v2 replay item exceeds byte bound");
        }
        if self
            .items
            .back()
            .is_some_and(|(last, _, _)| sequence <= *last)
        {
            bail!("remote-v2 replay sequence must increase");
        }
        self.items.push_back((sequence, bytes, item));
        self.bytes += bytes;
        while self.items.len() > self.max_items || self.bytes > self.max_bytes {
            if let Some((_, removed, _)) = self.items.pop_front() {
                self.bytes = self.bytes.saturating_sub(removed);
            }
        }
        Ok(())
    }

    pub fn replay_after(
        &self,
        acknowledged: u64,
    ) -> std::result::Result<Vec<(u64, T)>, ReplayError> {
        if let Some((oldest, _, _)) = self.items.front() {
            if acknowledged.saturating_add(1) < *oldest {
                return Err(ReplayError::Gap {
                    oldest_available: *oldest,
                });
            }
        }
        Ok(self
            .items
            .iter()
            .filter(|(sequence, _, _)| *sequence > acknowledged)
            .map(|(sequence, _, item)| (*sequence, item.clone()))
            .collect())
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpaqueNotificationMetadata {
    pub notification_id: String,
    pub global_sequence: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

impl OpaqueNotificationMetadata {
    pub fn validate(&self) -> Result<()> {
        if self.notification_id.is_empty() || self.global_sequence == 0 || self.kind.is_empty() {
            bail!("invalid remote-v2 notification metadata");
        }
        validate_opaque_value(&self.metadata, 0)
    }
}

fn validate_opaque_value(value: &Value, depth: usize) -> Result<()> {
    if depth > 4 {
        bail!("remote-v2 notification metadata is too deeply nested");
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(value) if value.len() <= 128 => Ok(()),
        Value::String(_) => bail!("remote-v2 notification metadata string is too large"),
        Value::Array(values) if values.len() <= 16 => {
            for value in values {
                validate_opaque_value(value, depth + 1)?;
            }
            Ok(())
        }
        Value::Array(_) => bail!("remote-v2 notification metadata array is too large"),
        Value::Object(values) if values.len() <= 16 => {
            for (key, value) in values {
                let normalized = key.to_ascii_lowercase();
                if [
                    "prompt", "result", "text", "content", "terminal", "token", "secret", "path",
                ]
                .iter()
                .any(|forbidden| normalized.contains(forbidden))
                {
                    bail!("remote-v2 notification metadata contains content-bearing field");
                }
                validate_opaque_value(value, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(_) => bail!("remote-v2 notification metadata object is too large"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(channel: BinaryChannel, sequence: u64, payload: &[u8]) -> BinaryFrame {
        BinaryFrame {
            channel,
            flags: 0,
            stream_id: 7,
            sequence,
            dropped_before: 0,
            payload: payload.to_vec(),
        }
    }

    #[test]
    fn binary_channels_round_trip_with_declared_header() {
        for channel in [
            BinaryChannel::TerminalOutput,
            BinaryChannel::TerminalSnapshot,
            BinaryChannel::BrowserScreencast,
            BinaryChannel::Screenshot,
            BinaryChannel::File,
            BinaryChannel::Attachment,
            BinaryChannel::Emulator,
        ] {
            let original = frame(channel, 3, b"payload");
            assert_eq!(
                BinaryFrame::decode(&original.encode().unwrap()).unwrap(),
                original
            );
        }
    }

    #[test]
    fn latest_frame_replacement_reports_drops_but_lossless_backpressures() {
        let mut queue = BinaryStreamQueue::new(1, 1024).unwrap();
        queue
            .enqueue(frame(BinaryChannel::BrowserScreencast, 1, b"one"))
            .unwrap();
        assert_eq!(
            queue
                .enqueue(frame(BinaryChannel::BrowserScreencast, 2, b"two"))
                .unwrap(),
            EnqueueOutcome::Replaced { dropped: 1 }
        );
        let latest = queue.pop(BinaryChannel::BrowserScreencast, 7).unwrap();
        assert_eq!(latest.sequence, 2);
        assert_eq!(latest.dropped_before, 1);
        assert_ne!(latest.flags & FLAG_DROPPED_BEFORE, 0);

        queue
            .enqueue(frame(BinaryChannel::TerminalOutput, 1, b"one"))
            .unwrap();
        assert!(queue
            .enqueue(frame(BinaryChannel::TerminalOutput, 2, b"two"))
            .is_err());
        assert_eq!(
            queue.pop(BinaryChannel::TerminalOutput, 7).unwrap().payload,
            b"one"
        );
    }

    #[test]
    fn terminal_ack_window_rejects_zero_bounds_and_enforces_stream_ceiling() {
        assert!(TerminalAckWindow::new(0, 1).is_err());
        assert!(TerminalAckWindow::new(1, 0).is_err());

        let mut window = TerminalAckWindow::new(1, MAX_SEQUENCE_DOMAINS).unwrap();
        for stream_id in 1..=MAX_SEQUENCE_DOMAINS as u64 {
            assert_eq!(
                window.record_sent(stream_id, 1, 0).unwrap(),
                TerminalRecordDecision::Recorded
            );
        }
        assert_eq!(window.tracked_streams(), MAX_SEQUENCE_DOMAINS);
        assert_eq!(
            window.record_sent(MAX_SEQUENCE_DOMAINS as u64 + 1, 1, 0),
            Err(TerminalFlowError::StreamLimitExceeded {
                max_streams: MAX_SEQUENCE_DOMAINS
            })
        );
    }

    #[test]
    fn terminal_ack_window_applies_per_stream_ceiling_without_growing_accounting() {
        let mut window = TerminalAckWindow::new(5, 20).unwrap();
        assert_eq!(
            window.record_sent(1, 1, 3).unwrap(),
            TerminalRecordDecision::Recorded
        );
        assert_eq!(
            window.record_sent(1, 2, 2).unwrap(),
            TerminalRecordDecision::Recorded
        );
        assert_eq!(
            window.record_sent(1, 3, 1).unwrap(),
            TerminalRecordDecision::Backpressured {
                reason: TerminalBackpressureReason::PerStream
            }
        );
        assert!(window.requires_resync(1));
        assert_eq!(window.stream_unacked_bytes(1), 5);
        assert_eq!(window.connection_unacked_bytes(), 5);
        assert_eq!(window.highest_sent_sequence(1), 2);
        assert_eq!(
            window.record_sent(1, 4, 0).unwrap(),
            TerminalRecordDecision::Recorded
        );
        assert_eq!(window.highest_sent_sequence(1), 4);
        assert_eq!(window.ack(1, 4).unwrap(), 5);
        assert_eq!(window.last_acknowledged_sequence(1), 4);
        assert!(window.requires_resync(1));
        assert!(window.complete_resync(1));
        assert_eq!(
            window.record_sent(1, 5, 5).unwrap(),
            TerminalRecordDecision::Recorded
        );
        assert_eq!(window.highest_sent_sequence(1), 5);
        assert_eq!(window.last_acknowledged_sequence(1), 4);
    }

    #[test]
    fn terminal_ack_window_applies_connection_ceiling_to_only_attempted_stream() {
        let mut window = TerminalAckWindow::new(8, 8).unwrap();
        window.record_sent(1, 1, 4).unwrap();
        window.record_sent(2, 1, 4).unwrap();
        assert_eq!(
            window.record_sent(3, 1, 1).unwrap(),
            TerminalRecordDecision::Backpressured {
                reason: TerminalBackpressureReason::Connection
            }
        );
        assert_eq!(window.connection_unacked_bytes(), 8);
        assert_eq!(window.stream_unacked_bytes(3), 0);
        assert!(!window.requires_resync(1));
        assert!(!window.requires_resync(2));
        assert!(window.requires_resync(3));
    }

    #[test]
    fn terminal_ack_window_removal_releases_bytes_and_frees_stream_capacity() {
        let mut window = TerminalAckWindow::new(8, 64).unwrap();
        window.record_sent(1, 1, 7).unwrap();
        for stream_id in 2..=MAX_SEQUENCE_DOMAINS as u64 {
            window.record_sent(stream_id, 1, 0).unwrap();
        }
        assert_eq!(window.tracked_streams(), MAX_SEQUENCE_DOMAINS);
        assert_eq!(window.connection_unacked_bytes(), 7);
        assert_eq!(window.remove_stream(1).unwrap(), 7);
        assert_eq!(window.connection_unacked_bytes(), 0);
        assert_eq!(window.tracked_streams(), MAX_SEQUENCE_DOMAINS - 1);
        assert_eq!(window.remove_stream(1).unwrap(), 0);
        assert_eq!(
            window
                .record_sent(MAX_SEQUENCE_DOMAINS as u64 + 1, 1, 0)
                .unwrap(),
            TerminalRecordDecision::Recorded
        );
        assert_eq!(window.tracked_streams(), MAX_SEQUENCE_DOMAINS);
        assert_eq!(
            window.remove_stream(0),
            Err(TerminalFlowError::InvalidStreamId)
        );
    }

    #[test]
    fn terminal_ack_window_releases_bytes_through_ack_and_rejects_invalid_acks() {
        let mut window = TerminalAckWindow::new(20, 20).unwrap();
        window.record_sent(1, 1, 3).unwrap();
        window.record_sent(1, 3, 4).unwrap();
        window.record_sent(1, 5, 2).unwrap();

        assert_eq!(window.ack(1, 3).unwrap(), 7);
        assert_eq!(window.stream_unacked_bytes(1), 2);
        assert_eq!(window.connection_unacked_bytes(), 2);
        assert_eq!(window.last_acknowledged_sequence(1), 3);
        assert_eq!(window.ack(1, 3).unwrap(), 0);
        assert_eq!(
            window.ack(1, 6),
            Err(TerminalFlowError::AckAhead {
                stream_id: 1,
                highest_sent: 5,
                received: 6
            })
        );
        assert_eq!(
            window.ack(1, 2),
            Err(TerminalFlowError::AckBehind {
                stream_id: 1,
                last_acknowledged: 3,
                received: 2
            })
        );
        assert_eq!(window.ack(1, 5).unwrap(), 2);
        assert_eq!(window.connection_unacked_bytes(), 0);
    }

    #[test]
    fn terminal_ack_window_gap_is_isolated_and_resync_preserves_sequence_history() {
        let mut window = TerminalAckWindow::new(6, 12).unwrap();
        window.record_sent(1, 2, 4).unwrap();
        window.record_sent(2, 1, 5).unwrap();
        assert_eq!(window.mark_gap(1).unwrap(), 4);
        assert!(window.requires_resync(1));
        assert!(!window.requires_resync(2));
        assert_eq!(window.stream_unacked_bytes(1), 0);
        assert_eq!(window.stream_unacked_bytes(2), 5);
        assert_eq!(window.connection_unacked_bytes(), 5);

        assert!(window.complete_resync(1));
        assert!(!window.requires_resync(1));
        assert_eq!(window.highest_sent_sequence(1), 2);
        assert_eq!(window.last_acknowledged_sequence(1), 0);
        assert_eq!(
            window.record_sent(1, 2, 1),
            Err(TerminalFlowError::SequenceNotIncreasing {
                stream_id: 1,
                highest_sent: 2,
                received: 2
            })
        );
        assert_eq!(
            window.record_sent(1, 3, 6).unwrap(),
            TerminalRecordDecision::Recorded
        );
        assert_eq!(window.ack(1, 3).unwrap(), 6);
        assert_eq!(window.last_acknowledged_sequence(1), 3);
        assert_eq!(window.connection_unacked_bytes(), 5);
    }

    #[test]
    fn domain_sequences_reject_duplicate_and_gap_until_explicit_resync() {
        let mut sequences = DomainSequenceValidator::default();
        sequences.validate("terminal", 1).unwrap();
        assert_eq!(
            sequences.validate("terminal", 1),
            Err(SequenceError::Replay {
                expected: 2,
                received: 1
            })
        );
        assert_eq!(
            sequences.validate("terminal", 4),
            Err(SequenceError::Gap {
                expected: 2,
                received: 4
            })
        );
        sequences.resync("terminal", 4).unwrap();
        sequences.validate("terminal", 4).unwrap();
        assert_eq!(sequences.expected("terminal"), 5);
    }

    #[test]
    fn domain_resync_rejects_invalid_and_over_limit_domains() {
        let mut sequences = DomainSequenceValidator::default();
        assert!(sequences.resync("", 1).is_err());
        assert!(sequences.resync("terminal/output", 1).is_err());
        assert!(sequences.resync(&"x".repeat(65), 1).is_err());

        for index in 0..MAX_SEQUENCE_DOMAINS {
            sequences.resync(&format!("domain-{index}"), 1).unwrap();
        }
        assert!(sequences.resync("domain-0", 2).is_ok());
        assert!(sequences.resync("one-too-many", 1).is_err());
        assert_eq!(sequences.expected("one-too-many"), 1);
    }

    #[test]
    fn operation_and_reconnect_replay_windows_are_bounded() {
        let mut operations = OperationReplayWindow::new(2).unwrap();
        assert!(operations.record("one"));
        assert!(!operations.record("one"));
        assert!(operations.record("two"));
        assert!(operations.record("three"));
        assert_eq!(operations.len(), 2);
        assert!(operations.record("one"));

        let mut replay = ReplayBuffer::new(2, 8).unwrap();
        replay.push(1, 4, "one").unwrap();
        replay.push(2, 4, "two").unwrap();
        replay.push(3, 4, "three").unwrap();
        assert_eq!(replay.len(), 2);
        assert_eq!(
            replay.replay_after(0),
            Err(ReplayError::Gap {
                oldest_available: 2
            })
        );
        assert_eq!(
            replay.replay_after(1).unwrap(),
            vec![(2, "two"), (3, "three")]
        );
    }

    #[test]
    fn notification_metadata_rejects_plaintext_content_fields() {
        let safe = OpaqueNotificationMetadata {
            notification_id: "n1".into(),
            global_sequence: 1,
            kind: "automation.completed".into(),
            entity_id: Some("run-1".into()),
            metadata: json!({"status": "completed"}),
        };
        safe.validate().unwrap();
        let unsafe_metadata = OpaqueNotificationMetadata {
            metadata: json!({"resultText": "secret output"}),
            ..safe
        };
        assert!(unsafe_metadata.validate().is_err());
    }
}
