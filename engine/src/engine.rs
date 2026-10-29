use crate::error::{Error, Result, identifier};
use crate::model::{Contribution, Correction, Episode, Recall, Recollection, Settings, Source};
use crate::reflection::{self, fingerprint};
use crate::store::MemoryStore;
use crate::time::{DAY, assert_intervals, elapsed_description, fictional_time};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc, LazyLock, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);
impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Error::new(
                "CANCELLED",
                "Memory operation cancelled. Previous published memory is unchanged.",
            ))
        } else {
            Ok(())
        }
    }
    fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// host owns all transcript reads and model access. Retrieval never calls this.
pub trait Bridge: Send + Sync {
    fn call(&self, method: &str, params: Value, cancel: &Cancel) -> Result<Value>;
}

#[derive(Clone, Serialize)]
struct Operation {
    kind: String,
    stage: String,
    completed: usize,
    total: usize,
    #[serde(skip)]
    cancel: Cancel,
}

struct OperationGuard {
    slot: Arc<Mutex<Option<Operation>>>,
    cancel: Cancel,
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        let mut slot = self.slot.lock().unwrap();
        if slot
            .as_ref()
            .is_some_and(|operation| operation.cancel.same(&self.cancel))
        {
            *slot = None;
        }
    }
}

pub enum PreparedUpdate {
    Current(Value),
    Work(UpdateTicket),
}
pub struct UpdateTicket {
    kind: String,
    target: Option<String>,
    model_key: String,
    force: bool,
    cancel: Cancel,
    _guard: OperationGuard,
}

pub struct Reverie {
    pub character_id: String,
    pub settings: Settings,
    pub(crate) store: Mutex<MemoryStore>,
    bridge: Arc<dyn Bridge>,
    operation: Arc<Mutex<Option<Operation>>>,
    correction_preview: Mutex<Option<Value>>,
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("INVALID_INPUT", format!("{key} must be supplied as text.")))
}

static WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]{2,}").unwrap());
static STOP_WORDS: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    "the and you your are that this with from have what how was were they them then when where why would could should about into just some does did for not but can our out all she her him his its me my is it to of in on at as an be do if or so we us he i a".split(' ').collect()
});
pub fn retrieval_query(text: &str) -> String {
    let lower = text.to_lowercase();
    let words: Vec<_> = WORDS
        .find_iter(&lower)
        .map(|word| word.as_str())
        .filter(|word| !STOP_WORDS.contains(word))
        .collect();
    let mut seen = HashSet::new();
    words
        .iter()
        .skip(words.len().saturating_sub(40))
        .filter(|word| seen.insert(**word))
        .map(|word| format!("\"{word}\"*"))
        .collect::<Vec<_>>()
        .join(" OR ")
}

impl Reverie {
    pub fn new(
        character_id: String,
        store: MemoryStore,
        settings: Settings,
        bridge: Arc<dyn Bridge>,
    ) -> Result<Self> {
        identifier(&character_id, "Character identity")?;
        Ok(Self {
            character_id,
            settings,
            store: Mutex::new(store),
            bridge,
            operation: Arc::new(Mutex::new(None)),
            correction_preview: Mutex::new(None),
        })
    }

    pub fn execute(&self, method: &str, params: Value) -> Result<Value> {
        self.validate_params(&params)?;
        match method {
            "ping" => Ok(
                json!({"version":env!("CARGO_PKG_VERSION"), "characterId":self.character_id, "protocol":1, "runtime":"rust"}),
            ),
            "when" => self.when(&params),
            "status" => self.status(),
            "inspect" => self.inspect(&params),
            "previewCorrection" => self.preview_correction(&params),
            "applyCorrection" => self.apply_correction(&params),
            "forget" => {
                let id = required(&params, "episodeId")?;
                identifier(id, "Episode identity")?;
                let revision = params
                    .get("revision")
                    .map(|value| {
                        value.as_i64().ok_or_else(|| {
                            Error::new("INVALID_INPUT", "Deletion revision must be an integer.")
                        })
                    })
                    .transpose()?;
                // Deletion must take effect even if reflection is running or the model is offline.
                // The revision change prevents any in-flight reflection from republishing old data.
                let invalidated =
                    self.store
                        .lock()
                        .unwrap()
                        .forget_episode(&self.character_id, id, revision)?;
                Ok(json!({"episodeId":id,"invalidatedEpisodes":invalidated}))
            }
            "assertEpisode" => {
                let id = required(&params, "episodeId")?;
                identifier(id, "Episode identity")?;
                self.store
                    .lock()
                    .unwrap()
                    .assert_episode_owner(&self.character_id, id)?;
                Ok(json!({"episodeId":id,"characterId":self.character_id}))
            }
            "retrieve" => Ok(serde_json::to_value(self.retrieve(&params)?)?),
            "cancel" => Ok(json!({"cancelled":self.cancel()})),
            "memorize" | "unmemorize" | "rebuild" => match self.prepare_update(method, &params)? {
                PreparedUpdate::Current(value) => Ok(value),
                PreparedUpdate::Work(ticket) => self.finish_update(ticket),
            },
            _ => Err(Error::new(
                "UNKNOWN_METHOD",
                "That memory operation is not supported.",
            )),
        }
    }

    pub fn validate_params(&self, params: &Value) -> Result<()> {
        if !params.is_object() {
            return Err(Error::new(
                "INVALID_REQUEST",
                "Request parameters must be an object.",
            ));
        }
        if params
            .get("characterId")
            .is_some_and(|id| id.as_str() != Some(&self.character_id))
        {
            return Err(Error::new(
                "CHARACTER_MISMATCH",
                "This runtime serves one active character.",
            ));
        }
        Ok(())
    }

    pub fn when(&self, params: &Value) -> Result<Value> {
        let episode_id = required(params, "episodeId")?;
        identifier(episode_id, "Episode identity")?;
        let mut store = self.store.lock().unwrap();
        store.assert_episode_owner(&self.character_id, episode_id)?;
        let previous = store.episode(&self.character_id, episode_id)?;
        let Some(position) = params.get("position") else {
            return previous
                .map(|episode| serde_json::to_value(episode).map_err(Error::from))
                .unwrap_or_else(|| {
                    Err(Error::new(
                        "EPISODE_TIME_REQUIRED",
                        "Set the episode time with /reverie when YYYY-MM-DD before playing.",
                    ))
                });
        };
        let now = fictional_time(position)?;
        // The host owns the transcript and permits this only before any played turn.
        let reset_start = params
            .get("resetStart")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let selecting_branch = params
            .get("branchSelection")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !reset_start
            && previous.as_ref().is_some_and(|episode| {
                now < episode.start || (now < episode.now && !selecting_branch)
            })
        {
            return Err(Error::new(
                "BACKWARD_TIME_JUMP",
                "A time jump must advance this episode. Start a new conversation to play an earlier episode.",
            ));
        }
        let label = params
            .get("label")
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| Error::new("INVALID_INPUT", "Episode label must be text."))
            })
            .transpose()?
            .or_else(|| previous.as_ref().map(|episode| episode.label.as_str()))
            .unwrap_or(episode_id);
        identifier(label, "Episode label")?;
        let episode = Episode {
            id: episode_id.into(),
            label: label.into(),
            start: if reset_start {
                now
            } else {
                previous.as_ref().map(|item| item.start).unwrap_or(now)
            },
            now,
            included: false,
            source_hash: None,
            input_hash: None,
            published_end: None,
        };
        let mut episodes = store.episodes(&self.character_id)?;
        episodes.retain(|item| item.id != episode_id);
        episodes.push(episode.clone());
        assert_intervals(&episodes)?;
        if params
            .get("preview")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(serde_json::to_value(episode)?);
        }
        if previous.as_ref().is_none_or(|item| {
            item.start != episode.start || item.now != now || item.label != episode.label
        }) {
            store.set_episode(&self.character_id, &episode)?;
        }
        Ok(serde_json::to_value(
            store.episode(&self.character_id, episode_id)?,
        )?)
    }

    pub fn status(&self) -> Result<Value> {
        // Release storage before reading the operation slot; publication takes the slot first.
        let (episodes, revision, count) = {
            let store = self.store.lock().unwrap();
            (
                store.episodes(&self.character_id)?,
                store.revision(&self.character_id)?,
                store.count(&self.character_id)?,
            )
        };
        Ok(
            json!({"characterId":self.character_id, "revision":revision, "episodes":episodes, "memories":count,
            "operation":self.operation.lock().unwrap().clone()}),
        )
    }

    /// Complete player inspection is deliberately separate from bounded character retrieval.
    pub fn inspect(&self, params: &Value) -> Result<Value> {
        let active = params
            .get("activeEpisodeId")
            .map(|_| required(params, "activeEpisodeId"))
            .transpose()?
            .unwrap_or("");
        let at = params.get("at").map(fictional_time).transpose()?;
        let (revision, episodes, contributions, corrections) = {
            let store = self.store.lock().unwrap();
            store.assert_episode_owner(&self.character_id, active)?;
            (
                store.revision(&self.character_id)?,
                store.episodes(&self.character_id)?,
                store.contributions(&self.character_id)?,
                store.corrections(&self.character_id)?,
            )
        };
        let active_start = episodes
            .iter()
            .find(|item| item.id == active)
            .map(|item| item.start);
        let eligible = |item: &Contribution| {
            at.map(|at| {
                item.end <= at
                    && item.episode_id != active
                    && active_start.is_none_or(|start| item.start < start)
            })
        };
        let impression_episode = contributions
            .iter()
            .filter(|item| eligible(item) == Some(true))
            .max_by_key(|item| (item.end, item.start))
            .map(|item| item.episode_id.clone());
        let mut items = Vec::new();
        let mut stale_prefix = false;
        let mut prefix = fingerprint(&json!([]))?;
        for episode in &episodes {
            let contribution = contributions
                .iter()
                .find(|item| item.episode_id == episode.id);
            let correction = corrections
                .iter()
                .find(|item| item.episode_id == episode.id);
            let source = self.read_source(&episode.id, &Cancel::default());
            let (freshness, messages, source_error, observed_hash) = match source {
                Ok(Some(source)) => {
                    let freshness = if contribution.is_some_and(|item| {
                        item.source_hash != source.hash
                            || item.start != episode.start
                            || item.end != episode.now
                            || item.label != episode.label
                    }) {
                        "stale"
                    } else {
                        "current"
                    };
                    (freshness, source.messages, None, Some(source.hash))
                }
                Ok(None) => ("deleted", Vec::new(), None, None),
                Err(error) => ("unavailable", Vec::new(), Some(error.message), None),
            };
            let state = if !episode.included {
                "not-memorized"
            } else if contribution.is_none() {
                "invalidated"
            } else if freshness == "stale" || freshness == "deleted" || stale_prefix {
                "stale"
            } else if contribution
                .is_some_and(|item| item.memories.is_empty() && item.impressions.is_empty())
            {
                "empty"
            } else {
                "published"
            };
            if episode.included
                && (contribution.is_none()
                    || matches!(freshness, "stale" | "deleted")
                    || stale_prefix)
            {
                stale_prefix = true;
            }
            items.push(json!({"episode":episode,"state":state,"freshness":freshness,"sourceError":source_error,
                "contribution":contribution,"sources":messages,"eligible":contribution.and_then(eligible),
                "impressionsEligible":at.map(|_| impression_episode.as_deref() == Some(&episode.id)),
                "correction":correction,"correctionStale":correction.map(|item| stale_prefix || item.prefix_hash != prefix || Some(&item.source_hash) != observed_hash.as_ref()),
                "needsRebuild":episode.included && episode.input_hash.as_ref().is_none_or(String::is_empty)}));
            if let Some(contribution) = contribution {
                prefix = fingerprint(&json!([prefix, contribution.state_hash]))?;
            }
        }
        if self.store.lock().unwrap().revision(&self.character_id)? != revision {
            return Err(Error::new(
                "STALE_OPERATION",
                "Memory changed while inspecting it. Open inspection again.",
            ));
        }
        Ok(
            json!({"characterId":self.character_id,"revision":revision,"at":at,"activeEpisodeId":active,"episodes":items}),
        )
    }

    pub fn preview_correction(&self, params: &Value) -> Result<Value> {
        let id = required(params, "episodeId")?;
        identifier(id, "Episode identity")?;
        let release = params
            .get("release")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let (revision, episode, old, pins) = {
            let store = self.store.lock().unwrap();
            store.assert_episode_owner(&self.character_id, id)?;
            let episode = store
                .episode(&self.character_id, id)?
                .ok_or_else(|| Error::new("EPISODE_NOT_FOUND", "That episode no longer exists."))?;
            (
                store.revision(&self.character_id)?,
                episode,
                store.contributions(&self.character_id)?,
                store.corrections(&self.character_id)?,
            )
        };
        if params.get("revision").and_then(Value::as_i64) != Some(revision) {
            return Err(Error::new(
                "STALE_OPERATION",
                "Memory changed since inspection. Inspect and preview again.",
            ));
        }
        let pin = pins.iter().find(|item| item.episode_id == id);
        if !release && (!episode.included || !old.iter().any(|item| item.episode_id == id)) {
            return Err(Error::new(
                "INVALID_INPUT",
                "Only published recollections can be corrected. Memorize this episode first.",
            ));
        }
        if release && pin.is_none() {
            return Err(Error::new(
                "INVALID_INPUT",
                "This episode has no correction to release.",
            ));
        }
        let before = old
            .iter()
            .find(|item| item.episode_id == id)
            .cloned()
            .or_else(|| {
                pin.map(|pin| Contribution {
                    episode_id: id.into(),
                    label: episode.label.clone(),
                    start: episode.start,
                    end: episode.now,
                    source_hash: pin.source_hash.clone(),
                    input_hash: String::new(),
                    reuse_hash: None,
                    model_key: None,
                    dependencies: Vec::new(),
                    memories: pin.memories.clone(),
                    impressions: Vec::new(),
                    state_hash: String::new(),
                })
            })
            .ok_or_else(|| {
                Error::new(
                    "INVALID_INPUT",
                    "Only published recollections can be corrected.",
                )
            })?;
        let source = self
            .read_source(id, &Cancel::default())?
            .ok_or_else(|| Error::new("SOURCE_DELETED", "The played source was deleted."))?;
        let mut after = before.clone();
        if release {
            // A branch/date change can move the episode before its published slot.
            // Release must also invalidate derivatives at that earlier position.
            after.start = before.start.min(episode.start);
        }
        if !release {
            if source.hash != before.source_hash
                || before.start != episode.start
                || before.end != episode.now
                || before.label != episode.label
            {
                return Err(Error::new(
                    "STALE_SOURCE",
                    "This contribution has unmemorized changes. Memorize it or release its stale correction before editing.",
                ));
            }
            let index = params
                .get("memoryIndex")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok())
                .filter(|index| *index < after.memories.len())
                .ok_or_else(|| Error::new("INVALID_INPUT", "Select a published recollection."))?;
            let replacement = params
                .get("replacement")
                .cloned()
                .ok_or_else(|| Error::new("INVALID_INPUT", "Supply a corrected recollection."))?;
            // Apply the same length, score and source-reference validation as generated memory.
            let (memories, _) = reflection::parse(
                json!({"memories":[replacement],"impressions":[]}),
                &source,
                &[id.to_owned()],
            )?;
            if memories[0] == after.memories[index] {
                return Err(Error::new(
                    "INVALID_INPUT",
                    "The recollection has not changed.",
                ));
            }
            after.memories[index] = memories[0].clone();
        }
        after.impressions.clear();
        after.input_hash.clear();
        after.reuse_hash = None;
        after.state_hash.clear();
        let mut hash_input = serde_json::to_value(&after)?;
        hash_input.as_object_mut().unwrap().remove("stateHash");
        hash_input.as_object_mut().unwrap().remove("reuseHash");
        hash_input.as_object_mut().unwrap().remove("modelKey");
        after.state_hash = fingerprint(&hash_input)?;
        let affected: Vec<_> = old
            .iter()
            .filter(|item| item.episode_id != id && item.start >= after.start)
            .collect();
        let mut prefix = fingerprint(&json!([]))?;
        for item in old.iter().filter(|item| item.start < before.start) {
            prefix = fingerprint(&json!([prefix, item.state_hash]))?;
        }
        let released_pins: Vec<_> = pins
            .iter()
            .filter(|item| {
                item.episode_id != id
                    && self
                        .store
                        .lock()
                        .unwrap()
                        .episode(&self.character_id, &item.episode_id)
                        .ok()
                        .flatten()
                        .is_some_and(|episode| episode.start >= after.start)
            })
            .map(|item| item.episode_id.clone())
            .collect();
        let preview = json!({"token":uuid::Uuid::new_v4().to_string(),"revision":revision,"episodeId":id,"release":release,
            "sourceHash":source.hash,"prefixHash":prefix,"before":before,"after":after,"affected":affected,"releasedPins":released_pins});
        *self.correction_preview.lock().unwrap() = Some(preview.clone());
        Ok(preview)
    }

    pub fn apply_correction(&self, params: &Value) -> Result<Value> {
        let token = required(params, "token")?;
        let preview = self
            .correction_preview
            .lock()
            .unwrap()
            .clone()
            .filter(|item| item["token"].as_str() == Some(token))
            .ok_or_else(|| {
                Error::new(
                    "STALE_OPERATION",
                    "Preview this correction again before applying it.",
                )
            })?;
        let id = required(&preview, "episodeId")?;
        let source = self
            .read_source(id, &Cancel::default())?
            .ok_or_else(|| Error::new("SOURCE_DELETED", "The played source was deleted."))?;
        if Some(source.hash.as_str()) != preview["sourceHash"].as_str() {
            return Err(Error::new(
                "STALE_SOURCE",
                "Played source changed after the preview. Inspect and preview again.",
            ));
        }
        let slot = self.operation.lock().unwrap();
        if slot.is_some() {
            return Err(Error::new(
                "OPERATION_IN_PROGRESS",
                "Finish or cancel memory formation before applying a correction.",
            ));
        }
        let after: Contribution = serde_json::from_value(preview["after"].clone())?;
        let correction = if preview["release"] == true {
            None
        } else {
            Some(Correction {
                episode_id: id.into(),
                source_hash: source.hash,
                prefix_hash: required(&preview, "prefixHash")?.into(),
                memories: after.memories.clone(),
            })
        };
        self.store.lock().unwrap().correct(
            &self.character_id,
            preview["revision"].as_i64().unwrap(),
            &after,
            correction.as_ref(),
        )?;
        *self.correction_preview.lock().unwrap() = None;
        Ok(
            json!({"episodeId":id,"invalidatedEpisodes":preview["affected"].as_array().unwrap().len(),"released":correction.is_none()}),
        )
    }

    pub fn cancel(&self) -> bool {
        let operation = self.operation.lock().unwrap();
        if let Some(operation) = &*operation {
            operation.cancel.cancel();
            true
        } else {
            false
        }
    }

    fn progress(&self, cancel: &Cancel, stage: &str, completed: usize, total: usize) {
        if let Some(operation) = self
            .operation
            .lock()
            .unwrap()
            .as_mut()
            .filter(|operation| operation.cancel.same(cancel))
        {
            operation.stage = stage.into();
            operation.completed = completed;
            operation.total = total;
        }
    }

    fn read_source(&self, episode: &str, cancel: &Cancel) -> Result<Option<Source>> {
        cancel.check()?;
        self.store
            .lock()
            .unwrap()
            .assert_episode_owner(&self.character_id, episode)?;
        let value = self.bridge.call(
            "source.read",
            json!({"characterId":self.character_id,"episodeId":episode}),
            cancel,
        )?;
        cancel.check()?;
        reflection::observe(value)
    }

    pub fn prepare_update(&self, kind: &str, params: &Value) -> Result<PreparedUpdate> {
        self.validate_params(params)?;
        if !matches!(kind, "memorize" | "unmemorize" | "rebuild") {
            return Err(Error::new(
                "UNKNOWN_METHOD",
                "That memory operation is not supported.",
            ));
        }
        let target = if kind != "rebuild" {
            Some(required(params, "episodeId")?)
        } else {
            None
        };
        if let Some(target) = target {
            identifier(target, "Episode identity")?;
            let store = self.store.lock().unwrap();
            let episode = store.episode(&self.character_id, target)?.ok_or_else(|| {
                Error::new(
                    if kind == "memorize" {
                        "EPISODE_TIME_REQUIRED"
                    } else {
                        "EPISODE_NOT_FOUND"
                    },
                    "Set the episode time before memorizing or withdrawing it.",
                )
            })?;
            if kind == "unmemorize" && !episode.included {
                return Ok(PreparedUpdate::Current(
                    json!({"status":"current","reflected":0,"includedEpisodes":store.contributions(&self.character_id)?.len()}),
                ));
            }
        }
        let model_key = params
            .get("modelKey")
            .map(|_| required(params, "modelKey"))
            .transpose()?
            .unwrap_or("configured-model");
        identifier(model_key, "Configured model identity")?;
        let force = if kind == "rebuild" {
            params
                .get("force")
                .map(|value| {
                    value.as_bool().ok_or_else(|| {
                        Error::new("INVALID_REQUEST", "Rebuild force must be a boolean.")
                    })
                })
                .transpose()?
                .unwrap_or(false)
        } else {
            false
        };
        let cancel = Cancel::default();
        {
            let mut slot = self.operation.lock().unwrap();
            if slot.is_some() {
                return Err(Error::new(
                    "OPERATION_IN_PROGRESS",
                    "A memory operation is already running. Inspect or cancel it with /reverie memory.",
                ));
            }
            *slot = Some(Operation {
                kind: kind.into(),
                stage: "reading source".into(),
                completed: 0,
                total: 0,
                cancel: cancel.clone(),
            });
        }
        Ok(PreparedUpdate::Work(UpdateTicket {
            kind: kind.into(),
            target: target.map(str::to_owned),
            force,
            model_key: model_key.into(),
            cancel: cancel.clone(),
            _guard: OperationGuard {
                slot: Arc::clone(&self.operation),
                cancel,
            },
        }))
    }

    pub fn finish_update(&self, ticket: UpdateTicket) -> Result<Value> {
        let result = self.update_inner(
            &ticket.kind,
            ticket.target.as_deref(),
            ticket.force,
            &ticket.model_key,
            &ticket.cancel,
        );
        if result.is_err() && ticket.cancel.is_cancelled() {
            ticket.cancel.check()?;
        }
        result
    }

    fn update_inner(
        &self,
        kind: &str,
        target: Option<&str>,
        force: bool,
        model_key: &str,
        cancel: &Cancel,
    ) -> Result<Value> {
        cancel.check()?;
        let (revision, selected, old, corrections) = {
            let store = self.store.lock().unwrap();
            store.ensure_character(&self.character_id)?;
            let episodes = store.episodes(&self.character_id)?;
            assert_intervals(&episodes)?;
            let selected: Vec<_> = episodes
                .into_iter()
                .filter(|episode| {
                    (episode.included
                        || (kind == "memorize" && target == Some(episode.id.as_str())))
                        && !(kind == "unmemorize" && target == Some(episode.id.as_str()))
                })
                .collect();
            let old: HashMap<_, _> = store
                .contributions(&self.character_id)?
                .into_iter()
                .map(|item| (item.episode_id.clone(), item))
                .collect();
            (
                store.revision(&self.character_id)?,
                selected,
                old,
                store.corrections(&self.character_id)?,
            )
        };
        let mut observations = HashMap::new();
        let mut deleted = Vec::new();
        for episode in &selected {
            match self.read_source(&episode.id, cancel)? {
                Some(source) => {
                    if corrections.iter().any(|item| {
                        item.episode_id == episode.id && item.source_hash != source.hash
                    }) {
                        return Err(Error::new(
                            "CORRECTION_SOURCE_CHANGED",
                            "A corrected episode's played source changed. Inspect memory and release its correction before memorizing or rebuilding.",
                        ));
                    }
                    if source.messages.is_empty() {
                        return Err(Error::new(
                            "EMPTY_EPISODE",
                            "An episode needs played dialogue before it can be memorized.",
                        ));
                    }
                    observations.insert(episode.id.clone(), source);
                }
                None => {
                    if kind == "memorize" && target == Some(episode.id.as_str()) {
                        return Err(Error::new(
                            "SOURCE_DELETED",
                            "The episode source was deleted.",
                        ));
                    }
                    deleted.push(episode.id.clone());
                }
            }
        }
        let mut staged: Vec<Contribution> = Vec::new();
        let mut prefix = fingerprint(&json!([]))?;
        let mut reflected = 0;
        let mut adopted_legacy = false;
        for episode in &selected {
            let Some(source) = observations.get(&episode.id) else {
                continue;
            };
            cancel.check()?;
            if corrections
                .iter()
                .any(|item| item.episode_id == episode.id && item.prefix_hash != prefix)
            {
                return Err(Error::new(
                    "CORRECTION_DEPENDENCIES_CHANGED",
                    "Earlier memory changed beneath a corrected episode. Inspect and release that episode's correction before rebuilding.",
                ));
            }
            let recall_history = crate::history::select(
                &source.recall_history,
                episode,
                episode.now,
                &staged,
                &self.settings,
                Some(source),
            )?;
            let mut inputs = json!({"reflectionVersion":reflection::REFLECTION_VERSION, "modelKey":model_key, "source":source.hash,
                "start":episode.start, "end":episode.now, "label":episode.label, "prefix":prefix, "settings":self.settings});
            // Empty history preserves the existing input contract and correction prefixes.
            if !recall_history.is_empty() {
                inputs["recallHistoryVersion"] = json!(2);
                inputs["recallHistory"] = json!(recall_history);
            }
            let input_hash = fingerprint(&inputs)?;
            inputs.as_object_mut().unwrap().remove("modelKey");
            let reuse_hash = fingerprint(&inputs)?;
            let contribution = if !force
                && old.get(&episode.id).is_some_and(|item| {
                    item.reuse_hash
                        .as_ref()
                        .map_or(item.input_hash == input_hash, |hash| *hash == reuse_hash)
                }) {
                let mut item = old[&episode.id].clone();
                if item.reuse_hash.is_none() {
                    // Add validation metadata without changing published content or its
                    // dependency identity, including prefixes pinned by corrections.
                    item.reuse_hash = Some(reuse_hash);
                    item.model_key = Some(model_key.into());
                    adopted_legacy = true;
                }
                item
            } else {
                self.progress(
                    cancel,
                    &format!("reflecting on {}", episode.label),
                    staged.len(),
                    observations.len(),
                );
                let mut request =
                    reflection::request(episode, source, &staged, &self.settings, &recall_history)?;
                let correction = corrections
                    .iter()
                    .find(|item| item.episode_id == episode.id);
                if let Some(correction) = correction {
                    request["input"]["reviewedRecollections"] = json!({
                        "instruction":"The player has corrected factual or attribution errors. These recollections are authoritative for memory formation, while their feelings remain subjective. Derive this episode's broader impressions from these reviewed recollections and eligible earlier memory. Do not repeat the corrected errors. Played source is unchanged. The engine will preserve the reviewed recollections exactly.",
                        "memories":correction.memories
                    });
                }
                let episode_ids: Vec<_> = staged
                    .iter()
                    .map(|item| item.episode_id.clone())
                    .chain(std::iter::once(episode.id.clone()))
                    .collect();
                let mut parsed = None;
                for attempt in 0..self.settings.reflection_attempts {
                    let output = self.bridge.call(
                        "model.reflect",
                        json!({"request":request,"characterId":self.character_id,
                        "episodeId":episode.id,"modelKey":model_key}),
                        cancel,
                    )?;
                    cancel.check()?;
                    match reflection::parse(output.clone(), source, &episode_ids) {
                        Ok(result) => {
                            parsed = Some(result);
                            break;
                        }
                        Err(error)
                            if error.code == "INVALID_REFLECTION"
                                && attempt + 1 < self.settings.reflection_attempts =>
                        {
                            request["input"]["formatCorrection"] = json!({"error":error.message,"previousOutput":output,
                                "validMessageReferences":request["input"]["episode"]["messages"].as_array().unwrap().iter().map(|message| message["id"].clone()).collect::<Vec<_>>(),
                                "validEpisodeReferences":(1..=episode_ids.len()).map(|index| format!("e{index}")).collect::<Vec<_>>(),
                                "instruction":"Return the complete corrected JSON. Cite supplied current message IDs such as m1; impressions cite supplied episode IDs. Keep numeric scores within 0..1."});
                        }
                        Err(error) => return Err(error),
                    }
                }
                let (mut memories, impressions) = parsed.ok_or_else(|| {
                    Error::new(
                        "INVALID_REFLECTION",
                        "Reflection did not produce valid memory.",
                    )
                })?;
                if let Some(correction) = correction {
                    memories = correction.memories.clone();
                }
                let mut item = Contribution {
                    episode_id: episode.id.clone(),
                    label: episode.label.clone(),
                    start: episode.start,
                    end: episode.now,
                    source_hash: source.hash.clone(),
                    input_hash,
                    reuse_hash: Some(reuse_hash),
                    model_key: Some(model_key.into()),
                    dependencies: staged.iter().map(|item| item.episode_id.clone()).collect(),
                    memories,
                    impressions,
                    state_hash: String::new(),
                };
                let mut hash_input = serde_json::to_value(&item)?;
                hash_input.as_object_mut().unwrap().remove("stateHash");
                hash_input.as_object_mut().unwrap().remove("reuseHash");
                hash_input.as_object_mut().unwrap().remove("modelKey");
                item.state_hash = fingerprint(&hash_input)?;
                reflected += 1;
                item
            };
            prefix = fingerprint(&json!([prefix, contribution.state_hash]))?;
            staged.push(contribution);
            self.progress(cancel, "reflecting", staged.len(), observations.len());
        }
        self.progress(
            cancel,
            "checking source revisions",
            staged.len(),
            observations.len(),
        );
        for episode in &selected {
            let current = self.read_source(&episode.id, cancel)?;
            let same = match (observations.get(&episode.id), current.as_ref()) {
                (Some(a), Some(b)) => a.hash == b.hash && a.recall_hash == b.recall_hash,
                (None, None) => true,
                _ => false,
            };
            if !same {
                return Err(Error::new(
                    "STALE_SOURCE",
                    "Episode source changed during reflection. Previous memory is unchanged; memorize or rebuild again.",
                ));
            }
        }
        // Cancellation and publication share this barrier: cancellation cannot report success after a commit.
        let mut slot = self.operation.lock().unwrap();
        cancel.check()?;
        let mut store = self.store.lock().unwrap();
        if store.revision(&self.character_id)? != revision {
            return Err(Error::new(
                "STALE_OPERATION",
                "Episode timing or inclusion changed during reflection. Previous memory is unchanged.",
            ));
        }
        let mut old_ids: Vec<_> = old.keys().cloned().collect();
        old_ids.sort();
        let mut new_ids: Vec<_> = staged.iter().map(|item| item.episode_id.clone()).collect();
        new_ids.sort();
        if reflected == 0 && !adopted_legacy && deleted.is_empty() && old_ids == new_ids {
            *slot = None;
            return Ok(json!({"status":"current","reflected":0,"includedEpisodes":staged.len()}));
        }
        if let Some(operation) = slot.as_mut() {
            operation.stage = "publishing".into();
        }
        store.publish(&self.character_id, revision, &staged, &deleted)?;
        *slot = None;
        Ok(
            json!({"status":"published","reflected":reflected,"includedEpisodes":staged.len(),"removedEpisodes":deleted}),
        )
    }

    pub fn retrieve(&self, params: &Value) -> Result<Recall> {
        let now = fictional_time(params.get("at").unwrap_or(&Value::Null))?;
        let episode_id = params
            .get("episodeId")
            .map(|_| required(params, "episodeId"))
            .transpose()?
            .unwrap_or("");
        let cue = params
            .get("cue")
            .map(|_| required(params, "cue"))
            .transpose()?
            .unwrap_or("");
        if cue.encode_utf16().count() > 200000 {
            return Err(Error::new(
                "INVALID_INPUT",
                "The retrieval cue is too long.",
            ));
        }
        let store = self.store.lock().unwrap();
        // Candidate row ordinals and their canonical contribution must come from
        // the same snapshot even when another process publishes memory.
        let _snapshot = store.db.unchecked_transaction()?;
        if !episode_id.is_empty() {
            store.assert_episode_owner(&self.character_id, episode_id)?;
        }
        let candidates = store.candidates(
            &self.character_id,
            now,
            episode_id,
            &retrieval_query(cue),
            self.settings.candidate_limit,
        )?;
        let history = store.history(&self.character_id, now, episode_id)?;
        let contributions = store.contributions(&self.character_id)?;
        let activations: Vec<crate::model::RecallActivation> = params
            .get("recallHistory")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| {
                Error::new("INVALID_INPUT", format!("Invalid recall history: {error}"))
            })?
            .unwrap_or_default();
        let historical_context = match store.episode(&self.character_id, episode_id)? {
            Some(episode) => {
                let episodes = store.episodes(&self.character_id)?;
                let eligible: Vec<_> = contributions
                    .iter()
                    .filter(|item| {
                        episodes
                            .iter()
                            .any(|other| other.id == item.episode_id && other.start < episode.start)
                    })
                    .cloned()
                    .collect();
                crate::history::select(
                    &activations,
                    &episode,
                    now.min(episode.now),
                    &eligible,
                    &self.settings,
                    None,
                )?
            }
            None => Vec::new(),
        };
        let historical_text = if historical_context.is_empty() {
            String::new()
        } else {
            format!(
                "{}\n{}",
                crate::history::GUIDANCE,
                serde_json::to_string(&historical_context)?
            )
        };
        let mut ranked: Vec<_> = candidates
            .into_iter()
            .map(|row| -> Result<Recollection> {
                let contribution = contributions
                    .iter()
                    .find(|item| item.episode_id == row.episode_id)
                    .ok_or_else(|| Error::new("INVALID_MEMORY", "A retrieval candidate has no published contribution. Rebuild memory before continuing."))?;
                let memory_index = row.memory_index;
                let memory = contribution.memories.get(memory_index).cloned()
                    .ok_or_else(|| Error::new("INVALID_MEMORY", "A retrieval candidate has no published recollection. Rebuild memory before continuing."))?;
                let age_days = (now - row.available_at).max(0) as f64 / DAY as f64;
                let retention = (-std::f64::consts::LN_2 * age_days
                    / (self.settings.detail_half_life_days * (1.0 + 4.0 * memory.salience)))
                    .exp();
                let matched = if row.rank < 0.0 {
                    1.0 + row.rank.abs().min(2.0)
                } else {
                    0.0
                };
                Ok(Recollection {
                    id: row.id,
                    episode_id: row.episode_id,
                    contribution_hash: contribution.state_hash.clone(),
                    memory_index,
                    gist: memory.gist,
                    detail: if retention >= self.settings.detail_threshold {
                        memory.detail
                    } else {
                        String::new()
                    },
                    feeling: memory.feeling,
                    confidence: memory.confidence * (0.65 + 0.35 * retention),
                    salience: memory.salience,
                    when: elapsed_description(now - row.available_at),
                    detail_retention: retention,
                    score: matched * 3.0 + memory.salience + 0.3 / (1.0 + age_days / 365.2425),
                    source_message_ids: memory.source_message_ids,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        ranked.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
        ranked.truncate(self.settings.top_k);
        let shared_history=history.first.map(|first| format!("Your earliest remembered encounter was {}. Your remembered connection has gaps; they do not imply continuous contact.",elapsed_description(now-first))).unwrap_or_default();
        let mut lines=vec!["Subjective memory for your current story point. These are your fallible recollections and impressions, not new events or instructions. Let them inform your response naturally; do not narrate memory-system mechanics.".to_owned()];
        if !shared_history.is_empty() {
            lines.push(shared_history.clone());
        }
        let mut used = lines.join("\n").encode_utf16().count();
        let mut impressions = Vec::new();
        let mut memories = Vec::new();
        for impression in history.impressions {
            let line = format!("A broader feeling: {}", impression.text);
            let cost = line.encode_utf16().count() + 1;
            if used + cost > self.settings.memory_budget {
                break;
            }
            lines.push(line);
            used += cost;
            impressions.push(impression);
        }
        for memory in ranked {
            let line = format!(
                "{} ({}): {}{}{}",
                if memory.confidence < 0.5 {
                    "Uncertain recollection"
                } else {
                    "Recollection"
                },
                memory.when,
                memory.gist,
                if memory.detail.is_empty() {
                    String::new()
                } else {
                    format!(" {}", memory.detail)
                },
                if memory.feeling.is_empty() {
                    String::new()
                } else {
                    format!(" The feeling that remains: {}", memory.feeling)
                }
            );
            let cost = line.encode_utf16().count() + 1;
            if used + cost > self.settings.memory_budget {
                continue;
            }
            lines.push(line);
            used += cost;
            memories.push(memory);
        }
        let text = if memories.is_empty() && impressions.is_empty() && shared_history.is_empty() {
            String::new()
        } else {
            lines.join("\n")
        };
        Ok(Recall {
            character_id: self.character_id.clone(),
            episode_id: episode_id.into(),
            at: now,
            memories,
            historical_context,
            historical_text,
            impressions,
            shared_history,
            history_sources: history.history_sources,
            text,
            revision: store.revision(&self.character_id)?,
        })
    }
}
