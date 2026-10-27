use crate::engine::{Bridge, Cancel, PreparedUpdate, Reverie};
use crate::error::{Error, Result};
use crate::model::Settings;
use crate::store::MemoryStore;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, BufWriter, Write};
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

struct Wire {
    output: Mutex<BufWriter<io::Stdout>>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Result<Value>>>>,
    closed: AtomicBool,
}

impl Wire {
    fn send(&self, value: Value) -> Result<()> {
        let mut output = self.output.lock().unwrap();
        serde_json::to_writer(&mut *output, &value)?;
        output.write_all(b"\n")?;
        output.flush()?;
        Ok(())
    }
    fn response(&self, id: Value, result: Result<Value>) {
        let value = match result {
            Ok(value) => json!({"id":id,"result":value}),
            Err(error) => json!({"id":id,"error":error}),
        };
        let _ = self.send(value);
    }
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(Error::new(
                "HOST_DISCONNECTED",
                "The host disconnected.",
            )));
        }
    }
}

impl Bridge for Wire {
    fn call(&self, method: &str, params: Value, cancel: &Cancel) -> Result<Value> {
        cancel.check()?;
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().unwrap();
            if self.closed.load(Ordering::Acquire) {
                return Err(Error::new("HOST_DISCONNECTED", "The host disconnected."));
            }
            pending.insert(id.clone(), sender);
        }
        let result = (|| {
            self.send(json!({"callId":id,"method":method,"params":params}))?;
            let deadline = Instant::now() + Duration::from_secs(180);
            loop {
                if let Err(error) = cancel.check() {
                    let _ = self.send(json!({"cancelCall":id}));
                    return Err(error);
                }
                if Instant::now() >= deadline {
                    let _ = self.send(json!({"cancelCall":id}));
                    return Err(Error::new(
                        "CALLBACK_TIMEOUT",
                        "The host did not finish a source read or reflection in time. Previous memory is unchanged.",
                    ));
                }
                match receiver.recv_timeout(Duration::from_millis(20)) {
                    Ok(result) => {
                        cancel.check()?;
                        return result;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err(Error::new("HOST_DISCONNECTED", "The host disconnected."));
                    }
                }
            }
        })();
        self.pending.lock().unwrap().remove(&id);
        result
    }
}

/// The reader remains available for cancellation/status while reflection waits for host callbacks.
pub fn serve(character_id: String, database: &Path, settings: Settings) -> Result<()> {
    let wire = Arc::new(Wire {
        output: Mutex::new(BufWriter::new(io::stdout())),
        pending: Mutex::new(HashMap::new()),
        closed: AtomicBool::new(false),
    });
    let bridge: Arc<dyn Bridge> = wire.clone();
    let engine = Arc::new(Reverie::new(
        character_id,
        MemoryStore::open(database)?,
        settings,
        bridge,
    )?);
    let mut workers = Vec::new();
    let mut input_error = None;
    for line in io::stdin().lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                input_error = Some(Error::from(error));
                break;
            }
        };
        let message: Value = match serde_json::from_str::<Value>(&line) {
            Ok(value) if value.is_object() => value,
            _ => {
                wire.response(
                    Value::Null,
                    Err(Error::new(
                        "INVALID_REQUEST",
                        "Requests must be JSON objects.",
                    )),
                );
                continue;
            }
        };
        if let Some(id) = message.get("callId").and_then(Value::as_str) {
            if let Some(sender) = wire.pending.lock().unwrap().remove(id) {
                let result = if let Some(error) = message.get("error") {
                    Err(Error::new(
                        error
                            .get("code")
                            .and_then(Value::as_str)
                            .unwrap_or("HOST_CALLBACK_FAILED"),
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("The host operation failed."),
                    ))
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = sender.send(result);
            }
            continue;
        }
        if message.get("cancelCall").is_some() {
            continue;
        }
        let id = message
            .get("id")
            .filter(|id| id.is_number() || id.is_string())
            .cloned();
        let method = message.get("method").and_then(Value::as_str);
        let (Some(id), Some(method)) = (id, method) else {
            wire.response(
                Value::Null,
                Err(Error::new(
                    "INVALID_REQUEST",
                    "Requests need an identity and method.",
                )),
            );
            continue;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        if matches!(method, "memorize" | "unmemorize" | "rebuild") {
            // Reserve synchronously, so even an immediately following cancel sees the queued operation.
            match engine.prepare_update(method, &params) {
                Ok(PreparedUpdate::Current(value)) => wire.response(id, Ok(value)),
                Err(error) => wire.response(id, Err(error)),
                Ok(PreparedUpdate::Work(ticket)) => {
                    workers.retain(|worker: &std::thread::JoinHandle<()>| !worker.is_finished());
                    let engine = Arc::clone(&engine);
                    let output = Arc::clone(&wire);
                    let error_id = id.clone();
                    let worker = std::thread::Builder::new()
                        .name("reverie-reflection".into())
                        .spawn(move || {
                            let result =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    engine.finish_update(ticket)
                                }))
                                .unwrap_or_else(|_| {
                                    Err(Error::new(
                                        "MEMORY_FAILURE",
                                        "The memory worker failed. Restart the memory connection.",
                                    ))
                                });
                            output.response(id, result);
                        });
                    match worker {
                        Ok(worker) => workers.push(worker),
                        Err(error) => wire.response(error_id, Err(Error::from(error))),
                    }
                }
            }
        } else {
            wire.response(id, engine.execute(method, params));
        }
    }
    engine.cancel();
    wire.close();
    for worker in workers {
        let _ = worker.join();
    }
    if let Some(error) = input_error {
        return Err(error);
    }
    Ok(())
}
