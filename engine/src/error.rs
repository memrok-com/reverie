use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
pub struct Error {
    pub code: String,
    pub message: String,
}

impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(
            "STORAGE_FAILURE",
            format!("Memory storage could not complete the operation: {error}"),
        )
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO_FAILURE", error.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_DATA", format!("Memory data is invalid: {error}"))
    }
}

pub fn identifier(value: &str, label: &str) -> Result<String> {
    if value.is_empty() || value.encode_utf16().count() > 512 {
        return Err(Error::new(
            "INVALID_INPUT",
            format!("{label} must be nonempty text of at most 512 characters."),
        ));
    }
    Ok(value.to_owned())
}
