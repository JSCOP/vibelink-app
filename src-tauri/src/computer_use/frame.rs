use super::types::{HostRequest, HostResponseBody, ProviderError, COMPUTER_USE_PROTOCOL_VERSION};
use rand::RngCore;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fmt,
    io::{self, Read, Write},
};
use uuid::Uuid;

pub const MAX_COMPUTER_FRAME_LEN: usize = 4 * 1024 * 1024;
const BOOT_TOKEN_LEN: usize = 32;

#[derive(Clone, Copy, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct BootToken([u8; BOOT_TOKEN_LEN]);

impl BootToken {
    pub fn generate() -> Self {
        let mut bytes = [0_u8; BOOT_TOKEN_LEN];
        rand::thread_rng().fill_bytes(&mut bytes);
        Self(bytes)
    }

    pub const fn from_bytes(bytes: [u8; BOOT_TOKEN_LEN]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; BOOT_TOKEN_LEN] {
        &self.0
    }

    pub fn constant_time_eq(&self, other: &Self) -> bool {
        self.0
            .iter()
            .zip(other.0.iter())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
    }

    pub fn to_hex(self) -> String {
        let mut output = String::with_capacity(BOOT_TOKEN_LEN * 2);
        for byte in self.0 {
            use fmt::Write as _;
            let _ = write!(output, "{byte:02x}");
        }
        output
    }

    pub fn from_hex(value: &str) -> Result<Self, FrameError> {
        if value.len() != BOOT_TOKEN_LEN * 2 {
            return Err(FrameError::InvalidBootTokenEncoding);
        }
        let mut bytes = [0_u8; BOOT_TOKEN_LEN];
        for (index, byte) in bytes.iter_mut().enumerate() {
            let offset = index * 2;
            *byte = u8::from_str_radix(&value[offset..offset + 2], 16)
                .map_err(|_| FrameError::InvalidBootTokenEncoding)?;
        }
        Ok(Self(bytes))
    }
}

impl fmt::Debug for BootToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BootToken([redacted])")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub protocol_version: u16,
    pub request_id: Uuid,
    pub operation_id: Uuid,
    pub boot_token: BootToken,
    pub request: HostRequest,
}

impl RequestEnvelope {
    pub fn new(boot_token: BootToken, operation_id: Uuid, request: HostRequest) -> Self {
        Self {
            protocol_version: COMPUTER_USE_PROTOCOL_VERSION,
            request_id: Uuid::new_v4(),
            operation_id,
            boot_token,
            request,
        }
    }

    pub fn authenticate(&self, expected: &BootToken) -> Result<(), FrameError> {
        if self.protocol_version != COMPUTER_USE_PROTOCOL_VERSION {
            return Err(FrameError::UnsupportedProtocol {
                actual: self.protocol_version,
            });
        }
        if !self.boot_token.constant_time_eq(expected) {
            return Err(FrameError::Unauthorized);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub protocol_version: u16,
    pub request_id: Uuid,
    pub operation_id: Uuid,
    pub result: Result<HostResponseBody, ProviderError>,
}

impl ResponseEnvelope {
    pub fn success(request: &RequestEnvelope, body: HostResponseBody) -> Self {
        Self {
            protocol_version: COMPUTER_USE_PROTOCOL_VERSION,
            request_id: request.request_id,
            operation_id: request.operation_id,
            result: Ok(body),
        }
    }

    pub fn failure(request: &RequestEnvelope, error: ProviderError) -> Self {
        Self {
            protocol_version: COMPUTER_USE_PROTOCOL_VERSION,
            request_id: request.request_id,
            operation_id: request.operation_id,
            result: Err(error),
        }
    }
}

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    Encode(rmp_serde::encode::Error),
    Decode(rmp_serde::decode::Error),
    EmptyFrame,
    FrameTooLarge { len: u32, max: usize },
    Unauthorized,
    UnsupportedProtocol { actual: u16 },
    InvalidBootTokenEncoding,
}

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "frame io error: {error}"),
            Self::Encode(error) => write!(formatter, "frame encode error: {error}"),
            Self::Decode(error) => write!(formatter, "frame decode error: {error}"),
            Self::EmptyFrame => formatter.write_str("empty frame"),
            Self::FrameTooLarge { len, max } => {
                write!(formatter, "frame too large: {len} bytes (maximum {max})")
            }
            Self::Unauthorized => formatter.write_str("invalid computer-use boot token"),
            Self::UnsupportedProtocol { actual } => {
                write!(
                    formatter,
                    "unsupported computer-use protocol version {actual}"
                )
            }
            Self::InvalidBootTokenEncoding => formatter.write_str("invalid boot token encoding"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rmp_serde::encode::Error> for FrameError {
    fn from(error: rmp_serde::encode::Error) -> Self {
        Self::Encode(error)
    }
}

impl From<rmp_serde::decode::Error> for FrameError {
    fn from(error: rmp_serde::decode::Error) -> Self {
        Self::Decode(error)
    }
}

pub fn write_frame<W, T>(writer: &mut W, message: &T) -> Result<(), FrameError>
where
    W: Write,
    T: Serialize + ?Sized,
{
    write_frame_with_limit(writer, message, MAX_COMPUTER_FRAME_LEN)
}

pub fn write_frame_with_limit<W, T>(
    writer: &mut W,
    message: &T,
    max_len: usize,
) -> Result<(), FrameError>
where
    W: Write,
    T: Serialize + ?Sized,
{
    let payload = rmp_serde::to_vec_named(message)?;
    if payload.is_empty() {
        return Err(FrameError::EmptyFrame);
    }
    if payload.len() > max_len || payload.len() > u32::MAX as usize {
        return Err(FrameError::FrameTooLarge {
            len: payload.len().min(u32::MAX as usize) as u32,
            max: max_len,
        });
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

pub fn read_frame<R, T>(reader: &mut R) -> Result<T, FrameError>
where
    R: Read,
    T: DeserializeOwned,
{
    read_frame_with_limit(reader, MAX_COMPUTER_FRAME_LEN)
}

pub fn read_frame_with_limit<R, T>(reader: &mut R, max_len: usize) -> Result<T, FrameError>
where
    R: Read,
    T: DeserializeOwned,
{
    let mut len_bytes = [0_u8; 4];
    reader.read_exact(&mut len_bytes)?;
    let len = u32::from_be_bytes(len_bytes);
    if len == 0 {
        return Err(FrameError::EmptyFrame);
    }
    if len as usize > max_len {
        return Err(FrameError::FrameTooLarge { len, max: max_len });
    }

    const READ_CHUNK_LEN: usize = 64 * 1024;
    let len = len as usize;
    let mut payload = Vec::with_capacity(len.min(READ_CHUNK_LEN));
    let mut remaining = len;
    while remaining > 0 {
        let chunk_len = remaining.min(READ_CHUNK_LEN);
        let start = payload.len();
        payload.resize(start + chunk_len, 0);
        reader.read_exact(&mut payload[start..])?;
        remaining -= chunk_len;
    }
    Ok(rmp_serde::from_slice(&payload)?)
}

pub fn read_authenticated_request<R>(
    reader: &mut R,
    expected_token: &BootToken,
) -> Result<RequestEnvelope, FrameError>
where
    R: Read,
{
    let request: RequestEnvelope = read_frame(reader)?;
    request.authenticate(expected_token)?;
    Ok(request)
}
