//! Portable, character-scoped memory. Hosts retain and freeze canonical source;
//! SQLite row IDs and search indexes are rebuilt rather than transported.
use crate::{
    engine::{Cancel, Reverie},
    error::{Error, Result, identifier},
    model::{Contribution, Correction, Episode, Memory, Source, SourceMessage},
    reflection::{self, fingerprint},
    time::{assert_intervals, fictional_time},
};
use rusqlite::{TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const FORMAT: &str = "reverie-memory";
pub const VERSION: u32 = 1;
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_EPISODES: usize = 10_000;
/// Independent decoded limits, shared by compact and explicit dependencies.
pub const MAX_DEPENDENCIES: usize = 4_000_000;
pub const MAX_DEPENDENCY_BYTES: usize = 128 * 1024 * 1024;

#[derive(Default)]
struct DependencyBudget {
    entries: usize,
    bytes: usize,
}
impl DependencyBudget {
    fn include(&mut self, entries: usize, bytes: usize) -> Result<()> {
        self.entries = self.entries.saturating_add(entries);
        self.bytes = self.bytes.saturating_add(bytes);
        if self.entries > MAX_DEPENDENCIES || self.bytes > MAX_DEPENDENCY_BYTES {
            return Err(Error::new(
                "ARCHIVE_TOO_LARGE",
                "Memory archive exceeds the decoded dependency limit (4,000,000 IDs or 128 MiB of UTF-8 identity text).",
            ));
        }
        Ok(())
    }
}
fn dependency_prefix(value: &Value, preceding: usize) -> Result<usize> {
    value
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("prefix"))
        .and_then(Value::as_u64)
        .filter(|count| *count <= preceding as u64)
        .map(|count| count as usize)
        .ok_or_else(|| invalid("A dependency prefix must reference only preceding contributions."))
}
/// Inspect the complete encoded collection before cloning even the first
/// expanded ID. Prefix byte totals refer to the original IDs, not their count
/// alone; explicit lists consume the same cumulative budget.
fn check_encoded_dependencies(values: &[Value], cancel: &Cancel) -> Result<()> {
    check_episode_limit(values.len())?;
    let mut budget = DependencyBudget::default();
    let mut prefix_bytes = Vec::with_capacity(values.len() + 1);
    prefix_bytes.push(0usize);
    for (index, value) in values.iter().enumerate() {
        cancel.check()?;
        let dependencies = &value["dependencies"];
        if dependencies.is_object() {
            let count = dependency_prefix(dependencies, index)?;
            budget.include(count, prefix_bytes[count])?;
        } else {
            let dependencies = dependencies
                .as_array()
                .ok_or_else(|| invalid("Archived dependencies must be an ID array or prefix."))?;
            let mut bytes = 0usize;
            for id in dependencies {
                bytes = bytes.saturating_add(
                    id.as_str()
                        .ok_or_else(|| invalid("Archived dependency identities must be strings."))?
                        .len(),
                );
            }
            budget.include(dependencies.len(), bytes)?;
        }
        let id = value["episodeId"]
            .as_str()
            .ok_or_else(|| invalid("An archived contribution must identify its episode."))?;
        prefix_bytes.push(prefix_bytes[index].saturating_add(id.len()));
    }
    Ok(())
}
fn check_decoded_dependencies(items: &[Contribution], cancel: &Cancel) -> Result<()> {
    let mut budget = DependencyBudget::default();
    for item in items {
        cancel.check()?;
        budget.include(
            item.dependencies.len(),
            item.dependencies
                .iter()
                .fold(0usize, |bytes, id| bytes.saturating_add(id.len())),
        )?;
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryArchive {
    pub format: String,
    pub version: u32,
    pub character_id: String,
    pub episodes: Vec<Episode>,
    #[serde(with = "dependency_encoding")]
    pub contributions: Vec<Contribution>,
    pub corrections: Vec<Correction>,
    /// Current source fingerprints, including null for deleted source. These
    /// are separate from published fingerprints so stale memory stays stale.
    pub sources: BTreeMap<String, Option<String>>,
    pub checksum: String,
}

// The native contribution keeps its original dependency IDs and state hash.
// On the wire, the usual complete preceding history is a constant-size prefix
// count. Sparse/legacy histories retain an explicit ID list in its exact order.
mod dependency_encoding {
    use super::*;
    use serde::{Deserializer, Serializer, de::Error as _, ser::Error as _};

    pub fn serialize<S: Serializer>(
        items: &[Contribution],
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut sequence = serializer.serialize_seq(Some(items.len()))?;
        for (index, item) in items.iter().enumerate() {
            let mut value = serde_json::to_value(item).map_err(S::Error::custom)?;
            if item.dependencies.len() <= index
                && item
                    .dependencies
                    .iter()
                    .zip(items)
                    .all(|(id, prior)| *id == prior.episode_id)
            {
                value["dependencies"] = json!({"prefix":item.dependencies.len()});
            }
            sequence.serialize_element(&value)?;
        }
        sequence.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Vec<Contribution>, D::Error> {
        let values = Vec::<Value>::deserialize(deserializer)?;
        check_encoded_dependencies(&values, &Cancel::default()).map_err(D::Error::custom)?;
        let mut items: Vec<Contribution> = Vec::with_capacity(values.len());
        for mut value in values {
            let prefix = if value["dependencies"].is_object() {
                let count = dependency_prefix(&value["dependencies"], items.len())
                    .map_err(D::Error::custom)?;
                value["dependencies"] = json!([]);
                Some(count)
            } else {
                None
            };
            let mut item: Contribution = serde_json::from_value(value).map_err(D::Error::custom)?;
            if let Some(count) = prefix {
                // Expand straight into the native strings. An intermediate
                // Value::String array would retain a second expanded copy.
                item.dependencies = items[..count]
                    .iter()
                    .map(|c| c.episode_id.clone())
                    .collect();
            }
            items.push(item);
        }
        Ok(items)
    }
}

fn invalid(message: &str) -> Error {
    Error::new("INVALID_ARCHIVE", message)
}
fn check_episode_limit(count: usize) -> Result<()> {
    if count > MAX_EPISODES {
        Err(Error::new(
            "ARCHIVE_TOO_LARGE",
            "Memory archive exceeds the 10,000-episode limit.",
        ))
    } else {
        Ok(())
    }
}
fn digest(archive: &MemoryArchive) -> Result<String> {
    let mut value = serde_json::to_value(archive)?;
    value.as_object_mut().unwrap().remove("checksum");
    fingerprint(&value)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn validate_memories(memories: &[Memory], source: Option<&Source>) -> Result<()> {
    // Reflection accepts short model aliases. Archived references are already
    // canonical: validate them without interpreting an actual ID such as m1
    // as a new alias (or depending on HashSet iteration order).
    let mut references = BTreeMap::new();
    for id in memories.iter().flat_map(|m| &m.source_message_ids) {
        identifier(id, "Source message identity")?;
        if source.is_some_and(|s| !s.messages.iter().any(|m| m.id == *id)) {
            return Err(invalid(
                "A recollection cites a message outside its played source.",
            ));
        }
        let next = references.len();
        references
            .entry(id.clone())
            .or_insert_with(|| format!("archive-source-{next}"));
    }
    let messages = references
        .values()
        .map(|id| SourceMessage {
            id: id.clone(),
            role: "user".into(),
            text: String::new(),
        })
        .collect();
    let synthetic = Source {
        messages,
        foundation: String::new(),
        hash: String::new(),
        recall_history: vec![],
        recall_hash: String::new(),
    };
    let mut normalized = memories.to_vec();
    for memory in &mut normalized {
        memory.source_message_ids = memory
            .source_message_ids
            .iter()
            .map(|id| references[id].clone())
            .collect();
    }
    let (parsed, _) = reflection::parse(
        json!({"memories":normalized,"impressions":[]}),
        &synthetic,
        &[],
    )
    .map_err(|e| invalid(&e.message))?;
    if parsed != normalized {
        return Err(invalid(
            "Archived recollections must use canonical text and source identities.",
        ));
    }
    Ok(())
}

/// Decode and validate all logical records before a host reviews an import.
pub fn decode(value: &Value) -> Result<MemoryArchive> {
    decode_cancellable(value, &Cancel::default())
}
fn decode_cancellable(value: &Value, cancel: &Cancel) -> Result<MemoryArchive> {
    cancel.check()?;
    if serde_json::to_vec(value)?.len() > MAX_BYTES {
        return Err(Error::new(
            "ARCHIVE_TOO_LARGE",
            "Memory archive exceeds the 64 MiB encoded-size limit.",
        ));
    }
    if let Some(episodes) = value.get("episodes").and_then(Value::as_array) {
        check_episode_limit(episodes.len())?;
    }
    if let Some(contributions) = value.get("contributions").and_then(Value::as_array) {
        check_encoded_dependencies(contributions, cancel)?;
    }
    cancel.check()?;
    let archive: MemoryArchive =
        serde_json::from_value(value.clone()).map_err(|e| invalid(&e.to_string()))?;
    validate_archive(&archive, cancel)?;
    Ok(archive)
}
fn validate_archive(archive: &MemoryArchive, cancel: &Cancel) -> Result<()> {
    cancel.check()?;
    check_decoded_dependencies(&archive.contributions, cancel)?;
    if archive.format != FORMAT || archive.version != VERSION {
        return Err(Error::new(
            "UNSUPPORTED_ARCHIVE",
            "Unsupported memory archive format or version.",
        ));
    }
    identifier(&archive.character_id, "Character identity")?;
    if archive.checksum != digest(&archive)? {
        return Err(invalid(
            "Memory archive checksum does not match its contents.",
        ));
    }
    check_episode_limit(archive.episodes.len())?;
    if archive.contributions.len() > archive.episodes.len()
        || archive.corrections.len() > archive.episodes.len()
    {
        return Err(invalid("Memory archive record limits exceeded."));
    }
    assert_intervals(&archive.episodes).map_err(|e| invalid(&e.message))?;
    let mut ids = HashSet::new();
    for episode in &archive.episodes {
        cancel.check()?;
        identifier(&episode.id, "Episode identity")?;
        identifier(&episode.label, "Episode label")?;
        if !ids.insert(episode.id.as_str())
            || episode.time_offset.unsigned_abs() > 17_280_000_000_000_000
        {
            return Err(invalid("Duplicate episode or invalid time offset."));
        }
        for time in [episode.start, episode.now] {
            fictional_time(&json!(time))?;
        }
        if episode.source_hash.as_ref().is_some_and(|v| !hash(v))
            || episode
                .input_hash
                .as_ref()
                .is_some_and(|v| !v.is_empty() && !hash(v))
        {
            return Err(invalid("Invalid episode fingerprints."));
        }
    }
    let episodes: HashMap<_, _> = archive
        .episodes
        .iter()
        .map(|e| (e.id.as_str(), e))
        .collect();
    let contributions: HashMap<_, _> = archive
        .contributions
        .iter()
        .map(|c| (c.episode_id.as_str(), c))
        .collect();
    if archive.sources.len() != ids.len()
        || archive
            .sources
            .iter()
            .any(|(id, h)| !ids.contains(id.as_str()) || h.as_ref().is_some_and(|h| !hash(h)))
    {
        return Err(invalid(
            "Archive source fingerprints must cover exactly its episodes.",
        ));
    }
    let mut published = HashSet::new();
    for (index, item) in archive.contributions.iter().enumerate() {
        cancel.check()?;
        if let Some(model) = &item.model_key {
            identifier(model, "Model provenance")?;
        }
        let episode = episodes
            .get(item.episode_id.as_str())
            .ok_or_else(|| invalid("A contribution has no episode."))?;
        if index > 0
            && (
                archive.contributions[index - 1].start,
                &archive.contributions[index - 1].episode_id,
            ) >= (item.start, &item.episode_id)
        {
            return Err(invalid(
                "Archived contributions must be in chronological order.",
            ));
        }
        if !published.insert(item.episode_id.as_str())
            || !episode.included
            || item.end < item.start
            || !hash(&item.source_hash)
            || (!item.input_hash.is_empty() && !hash(&item.input_hash))
            || item.reuse_hash.as_ref().is_some_and(|h| !hash(h))
            || episode.source_hash.as_ref() != Some(&item.source_hash)
            || episode.published_end != Some(item.end)
            || episode.input_hash.as_ref() != Some(&item.input_hash)
        {
            return Err(invalid("Inconsistent published contribution metadata."));
        }
        fictional_time(&json!(item.start))?;
        fictional_time(&json!(item.end))?;
        let mut state = serde_json::to_value(item)?;
        for key in ["stateHash", "reuseHash", "modelKey"] {
            state.as_object_mut().unwrap().remove(key);
        }
        if item.state_hash != fingerprint(&state)? {
            return Err(invalid("A contribution state fingerprint is invalid."));
        }
        let mut deps = HashSet::new();
        for id in &item.dependencies {
            if !deps.insert(id)
                || !contributions
                    .get(id.as_str())
                    .is_some_and(|p| p.start < item.start)
            {
                return Err(invalid(
                    "A contribution dependency is missing or not earlier in the story.",
                ));
            }
        }
        validate_memories(&item.memories, None)?;
        let mut referenced = BTreeMap::new();
        let mut normalized = item.impressions.clone();
        for impression in &mut normalized {
            for id in &mut impression.source_episode_ids {
                if *id != item.episode_id && !deps.contains(id) {
                    return Err(invalid(
                        "An impression cites an episode outside its memory history.",
                    ));
                }
                let next = referenced.len();
                *id = referenced
                    .entry(id.clone())
                    .or_insert_with(|| format!("archive-episode-{next}"))
                    .clone();
            }
        }
        let allowed = referenced.into_values().collect::<Vec<_>>();
        let source = Source {
            messages: vec![],
            foundation: String::new(),
            hash: String::new(),
            recall_history: vec![],
            recall_hash: String::new(),
        };
        let (_, impressions) = reflection::parse(
            json!({"memories":[],"impressions":normalized}),
            &source,
            &allowed,
        )
        .map_err(|e| invalid(&e.message))?;
        if impressions != normalized {
            return Err(invalid(
                "Archived impressions must use canonical text and episode identities.",
            ));
        }
    }
    let mut pins = HashSet::new();
    for pin in &archive.corrections {
        cancel.check()?;
        if !ids.contains(pin.episode_id.as_str())
            || !pins.insert(&pin.episode_id)
            || !hash(&pin.source_hash)
            || !hash(&pin.prefix_hash)
        {
            return Err(invalid("Invalid correction identity or fingerprints."));
        }
        validate_memories(&pin.memories, None)?;
    }
    Ok(())
}

fn snapshot(engine: &Reverie) -> Result<(MemoryArchive, i64)> {
    let store = engine.store.lock().unwrap();
    let _snapshot = store.db.unchecked_transaction()?;
    let mut corrections = store.corrections(&engine.character_id)?;
    corrections.sort_by(|a, b| a.episode_id.cmp(&b.episode_id));
    Ok((
        MemoryArchive {
            format: FORMAT.into(),
            version: VERSION,
            character_id: engine.character_id.clone(),
            episodes: store.episodes(&engine.character_id)?,
            contributions: store.contributions(&engine.character_id)?,
            corrections,
            sources: BTreeMap::new(),
            checksum: String::new(),
        },
        store.revision(&engine.character_id)?,
    ))
}
fn read_sources(
    engine: &Reverie,
    archive: &MemoryArchive,
    cancel: &Cancel,
) -> Result<BTreeMap<String, Option<String>>> {
    let mut result = BTreeMap::new();
    for episode in &archive.episodes {
        let source = engine.read_source(&episode.id, cancel)?;
        if let Some(source) = &source {
            for item in archive
                .contributions
                .iter()
                .filter(|c| c.episode_id == episode.id && c.source_hash == source.hash)
            {
                validate_memories(&item.memories, Some(source))?;
            }
            for pin in archive
                .corrections
                .iter()
                .filter(|c| c.episode_id == episode.id && c.source_hash == source.hash)
            {
                validate_memories(&pin.memories, Some(source))?;
            }
        }
        result.insert(episode.id.clone(), source.map(|s| s.hash));
    }
    Ok(result)
}
pub(crate) fn export(engine: &Reverie, cancel: &Cancel) -> Result<Value> {
    let (mut archive, revision) = snapshot(engine)?;
    check_episode_limit(archive.episodes.len())?;
    check_decoded_dependencies(&archive.contributions, cancel)?;
    archive.sources = read_sources(engine, &archive, cancel)?;
    archive.checksum = digest(&archive)?;
    validate_archive(&archive, cancel)?;
    if serde_json::to_vec(&archive)?.len() > MAX_BYTES {
        return Err(Error::new(
            "ARCHIVE_TOO_LARGE",
            "Memory archive exceeds the 64 MiB encoded-size limit.",
        ));
    }
    if read_sources(engine, &archive, cancel)? != archive.sources {
        return Err(Error::new(
            "STALE_SOURCE",
            "Source changed during export. Retry the export.",
        ));
    }
    let _barrier = engine.operation.lock().unwrap();
    cancel.check()?;
    if engine
        .store
        .lock()
        .unwrap()
        .revision(&engine.character_id)?
        != revision
    {
        return Err(Error::new(
            "STALE_OPERATION",
            "Memory changed during export. Retry the export.",
        ));
    }
    Ok(json!({"archive":archive,"revision":revision}))
}
fn incoming(engine: &Reverie, params: &Value, cancel: &Cancel) -> Result<MemoryArchive> {
    let archive = decode_cancellable(
        params
            .get("archive")
            .ok_or_else(|| invalid("Supply a memory archive."))?,
        cancel,
    )?;
    if archive.character_id != engine.character_id {
        return Err(Error::new(
            "CHARACTER_MISMATCH",
            "The archive belongs to another character.",
        ));
    }
    Ok(archive)
}
fn target(engine: &Reverie, archive: &MemoryArchive) -> Result<(i64, bool)> {
    let (mut current, revision) = snapshot(engine)?;
    current.sources = archive.sources.clone();
    if digest(&current)? == archive.checksum {
        return Ok((revision, true));
    }
    if !current.episodes.is_empty() {
        return Err(Error::new(
            "IMPORT_CONFLICT",
            "Import requires an empty character. Existing story memory is never replaced.",
        ));
    }
    let store = engine.store.lock().unwrap();
    for episode in &archive.episodes {
        store.assert_episode_owner(&engine.character_id, &episode.id)?;
    }
    Ok((revision, false))
}
pub(crate) fn preview(engine: &Reverie, params: &Value, cancel: &Cancel) -> Result<Value> {
    let archive = incoming(engine, params, cancel)?;
    let (revision, current) = target(engine, &archive)?;
    let contributions: HashMap<_, _> = archive
        .contributions
        .iter()
        .map(|c| (c.episode_id.as_str(), c))
        .collect();
    let mut ordered = archive.episodes.iter().collect::<Vec<_>>();
    ordered.sort_by(|a, b| a.start.cmp(&b.start).then(a.id.cmp(&b.id)));
    let mut stale_prefix = false;
    let mut pending = Vec::new();
    for e in ordered {
        cancel.check()?;
        if e.included {
            stale_prefix |= contributions.get(e.id.as_str()).is_none_or(|c| {
                c.start != e.start
                    || c.end != e.now
                    || c.label != e.label
                    || archive.sources.get(&e.id).and_then(Option::as_ref) != Some(&c.source_hash)
            });
            if stale_prefix {
                pending.push(&e.id);
            }
        }
    }
    Ok(
        json!({"status":if current {"current"} else {"ready"},"revision":revision,"archiveHash":archive.checksum,"episodes":archive.episodes.len(),"contributions":archive.contributions.len(),"memories":archive.contributions.iter().map(|c|c.memories.len()).sum::<usize>(),"corrections":archive.corrections.len(),"pendingEpisodes":pending,"modelCalls":0}),
    )
}
pub(crate) fn import(engine: &Reverie, params: &Value, cancel: &Cancel) -> Result<Value> {
    let archive = incoming(engine, params, cancel)?;
    let expected = params
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            Error::new(
                "INVALID_INPUT",
                "Supply the destination revision from previewImport.",
            )
        })?;
    if params.get("archiveHash").and_then(Value::as_str) != Some(&archive.checksum) {
        return Err(invalid("Supply the archiveHash from previewImport."));
    }
    let (revision, current) = target(engine, &archive)?;
    cancel.check()?;
    if current {
        return Ok(json!({"status":"current","revision":revision,"archiveHash":archive.checksum}));
    }
    if revision != expected {
        return Err(Error::new(
            "STALE_OPERATION",
            "Destination changed after preview. Preview the import again.",
        ));
    }
    for _ in 0..2 {
        if read_sources(engine, &archive, cancel)? != archive.sources {
            return Err(Error::new(
                "STALE_SOURCE",
                "The host source does not match the archived source. Restore its transcript and branch selection before importing memory.",
            ));
        }
    }
    // Cancellation and publication use the same barrier as reflection.
    let mut slot = engine.operation.lock().unwrap();
    cancel.check()?;
    let mut store = engine.store.lock().unwrap();
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT OR IGNORE INTO characters(id) VALUES(?)",
        [&engine.character_id],
    )?;
    let actual: i64 = tx.query_row(
        "SELECT revision FROM characters WHERE id=?",
        [&engine.character_id],
        |r| r.get(0),
    )?;
    if actual != revision {
        return Err(Error::new(
            "STALE_OPERATION",
            "Destination changed during import. Preview again.",
        ));
    }
    let occupied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM episodes WHERE character_id=?)",
        [&engine.character_id],
        |r| r.get(0),
    )?;
    if occupied {
        return Err(Error::new(
            "IMPORT_CONFLICT",
            "The destination is no longer empty.",
        ));
    }
    for e in &archive.episodes {
        let other: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM episodes WHERE id=? AND character_id<>?)",
            params![e.id, engine.character_id],
            |r| r.get(0),
        )?;
        if other {
            return Err(Error::new(
                "EPISODE_CHARACTER_MISMATCH",
                "An imported episode belongs to another character.",
            ));
        }
        tx.execute("INSERT INTO episodes(character_id,id,label,start,now,time_offset,included,source_hash,input_hash,published_end) VALUES(?,?,?,?,?,?,?,?,?,?)", params![engine.character_id,e.id,e.label,e.start,e.now,e.time_offset,e.included,e.source_hash,e.input_hash,e.published_end])?;
    }
    for c in &archive.contributions {
        tx.execute("INSERT INTO contributions(character_id,episode_id,start,end,input_hash,state_hash,data) VALUES(?,?,?,?,?,?,?)", params![engine.character_id,c.episode_id,c.start,c.end,c.input_hash,c.state_hash,serde_json::to_string(c)?])?;
        for m in &c.memories {
            tx.execute("INSERT INTO memories(character_id,episode_id,available_at,gist,detail,feeling,cues,salience,confidence,source_ids) VALUES(?,?,?,?,?,?,?,?,?,?)", params![engine.character_id,c.episode_id,c.end,m.gist,m.detail,m.feeling,m.cues.join(" "),m.salience,m.confidence,serde_json::to_string(&m.source_message_ids)?])?;
        }
    }
    for c in &archive.corrections {
        tx.execute(
            "INSERT INTO corrections(character_id,episode_id,data) VALUES(?,?,?)",
            params![engine.character_id, c.episode_id, serde_json::to_string(c)?],
        )?;
    }
    tx.execute(
        "UPDATE characters SET revision=revision+1 WHERE id=?",
        [&engine.character_id],
    )?;
    cancel.check()?;
    tx.commit()?;
    *slot = None;
    Ok(
        json!({"status":"imported","revision":revision+1,"archiveHash":archive.checksum,"episodes":archive.episodes.len(),"contributions":archive.contributions.len()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        engine::{Bridge, PreparedUpdate},
        model::Settings,
        store::MemoryStore,
    };
    use std::sync::Arc;
    struct Fixture;
    impl Bridge for Fixture {
        fn call(&self, method: &str, _params: Value, cancel: &Cancel) -> Result<Value> {
            cancel.check()?;
            match method {
                "source.read" => Ok(
                    json!({"foundation":"Mara","messages":[{"id":"played","role":"user","text":"A coat at the lighthouse."}]}),
                ),
                "model.reflect" => Ok(
                    json!({"memories":[{"gist":"I felt welcome.","detail":"A warm coat.","feeling":"Safe.","cues":["coat"],"salience":0.8,"confidence":0.9,"sourceMessageIds":["played"]}],"impressions":[]}),
                ),
                _ => panic!("Unexpected callback"),
            }
        }
    }
    fn engine() -> Reverie {
        Reverie::new(
            "mara".into(),
            MemoryStore::open(std::path::Path::new(":memory:")).unwrap(),
            Settings::default(),
            Arc::new(Fixture),
        )
        .unwrap()
    }
    fn archive() -> Value {
        let original = engine();
        original
            .execute(
                "when",
                json!({"episodeId":"meeting","position":"2000-01-01"}),
            )
            .unwrap();
        original
            .execute("memorize", json!({"episodeId":"meeting"}))
            .unwrap();
        original.execute("exportMemory", json!({})).unwrap()["archive"].clone()
    }
    fn params(engine: &Reverie, archive: &Value) -> Value {
        let preview = engine
            .execute("previewImport", json!({"archive":archive}))
            .unwrap();
        json!({"archive":archive,"revision":preview["revision"],"archiveHash":preview["archiveHash"]})
    }
    #[test]
    fn rust_api_rolls_back_an_injected_publication_failure_and_safely_retries() {
        let archive = archive();
        let target = engine();
        let request = params(&target, &archive);
        target.store.lock().unwrap().db.execute_batch("CREATE TRIGGER stop_restore BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'injected failure'); END").unwrap();
        assert_eq!(
            target
                .execute("importMemory", request.clone())
                .unwrap_err()
                .code,
            "STORAGE_FAILURE"
        );
        assert_eq!(
            target.store.lock().unwrap().episodes("mara").unwrap().len(),
            0
        );
        assert_eq!(target.store.lock().unwrap().revision("mara").unwrap(), 0);
        target
            .store
            .lock()
            .unwrap()
            .db
            .execute_batch("DROP TRIGGER stop_restore")
            .unwrap();
        assert_eq!(
            target.execute("importMemory", request.clone()).unwrap()["status"],
            "imported"
        );
        assert_eq!(
            target.execute("importMemory", request).unwrap()["status"],
            "current"
        );
        assert_eq!(
            target.execute("exportMemory", json!({})).unwrap()["archive"],
            archive
        );
    }
    #[test]
    fn queued_rust_import_cancels_before_any_mutation() {
        let archive = archive();
        let target = engine();
        let request = params(&target, &archive);
        let PreparedUpdate::Work(ticket) = target.prepare_update("importMemory", &request).unwrap()
        else {
            panic!("Expected work")
        };
        assert_eq!(
            target.execute("cancel", json!({})).unwrap()["cancelled"],
            true
        );
        assert_eq!(target.finish_update(ticket).unwrap_err().code, "CANCELLED");
        assert!(
            target
                .store
                .lock()
                .unwrap()
                .episodes("mara")
                .unwrap()
                .is_empty()
        );
        target.execute("importMemory", request).unwrap();
    }
    #[test]
    fn dependency_prefixes_preserve_exact_ids_hashes_and_sparse_histories() {
        let mut archive: MemoryArchive = serde_json::from_value(archive()).unwrap();
        let mut second = archive.contributions[0].clone();
        second.episode_id = "second".into();
        second.start += crate::time::DAY;
        second.end = second.start;
        second.dependencies = vec!["meeting".into()];
        let mut third = second.clone();
        third.episode_id = "third".into();
        third.start += crate::time::DAY;
        third.end = third.start;
        third.dependencies = vec!["second".into()];
        archive.contributions.extend([second, third]);
        let encoded = serde_json::to_value(&archive).unwrap();
        assert_eq!(
            encoded["contributions"][0]["dependencies"],
            json!({"prefix":0})
        );
        assert_eq!(
            encoded["contributions"][1]["dependencies"],
            json!({"prefix":1})
        );
        assert_eq!(
            encoded["contributions"][2]["dependencies"],
            json!(["second"])
        );
        let decoded: MemoryArchive = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.contributions, archive.contributions);
        let mut malformed = serde_json::to_value(&archive).unwrap();
        malformed["contributions"][0]["dependencies"] = json!({"prefix":1});
        assert_eq!(decode(&malformed).err().unwrap().code, "INVALID_ARCHIVE");
        malformed["contributions"][0]["dependencies"] = json!({"prefix":0,"extra":true});
        assert_eq!(decode(&malformed).err().unwrap().code, "INVALID_ARCHIVE");
    }

    #[test]
    fn archive_capacity_errors_are_distinct_from_corruption() {
        let oversized = json!({"payload":"x".repeat(MAX_BYTES)});
        assert_eq!(decode(&oversized).err().unwrap().code, "ARCHIVE_TOO_LARGE");
        drop(oversized);
        let too_many_episodes = json!({"episodes":vec![Value::Null;10_001]});
        assert_eq!(
            decode(&too_many_episodes).err().unwrap().code,
            "ARCHIVE_TOO_LARGE"
        );
    }

    #[test]
    fn compact_dependency_bombs_are_rejected_before_expansion_or_checksum_validation() {
        let seed = archive();
        for (count, width) in [(10_000, 8), (10_000, 64), (3_000, 512)] {
            let mut crafted = seed.clone();
            crafted["checksum"] = json!("deliberately invalid");
            crafted["contributions"] = json!(
                (0..count)
                    .map(|index| {
                        let mut item = seed["contributions"][0].clone();
                        item["episodeId"] = json!(format!("{index:05}{}", "x".repeat(width - 5)));
                        item["dependencies"] = json!({"prefix":index});
                        item
                    })
                    .collect::<Vec<_>>()
            );
            assert!(serde_json::to_vec(&crafted).unwrap().len() < MAX_BYTES);
            assert_eq!(decode(&crafted).err().unwrap().code, "ARCHIVE_TOO_LARGE");
            // The public serde entry point also preflights the complete array.
            let error = serde_json::from_value::<MemoryArchive>(crafted)
                .err()
                .unwrap();
            assert!(error.to_string().contains("ARCHIVE_TOO_LARGE"));
        }
    }

    #[test]
    fn dependency_budget_counts_explicit_lists_and_actual_utf8_prefix_bytes_together() {
        let id = "界".repeat(170); // 170 UTF-16 units, but 510 UTF-8 bytes.
        let values: Vec<_> = (0..1_100)
            .map(|index| {
                json!({"episodeId":format!("{index:04}{id}"),"dependencies":if index%2==0 {
                json!({"prefix":index})
            } else { json!([id]) }})
            })
            .collect();
        assert_eq!(
            check_encoded_dependencies(&values, &Cancel::default())
                .unwrap_err()
                .code,
            "ARCHIVE_TOO_LARGE"
        );
        // Compact prefixes consume 134,003,712 bytes. The explicit list fills
        // the remaining 214,016 bytes exactly; one more ID must reject it.
        let mut mixed: Vec<_> = (0..724).map(|index| {
            json!({"episodeId":format!("{index:0512}"),"dependencies":{"prefix":index}})
        }).collect();
        mixed.push(json!({"episodeId":"last","dependencies":vec!["x".repeat(512);418]}));
        check_encoded_dependencies(&mixed, &Cancel::default()).unwrap();
        mixed.last_mut().unwrap()["dependencies"]
            .as_array_mut()
            .unwrap()
            .push(json!("x".repeat(512)));
        assert_eq!(
            check_encoded_dependencies(&mixed, &Cancel::default())
                .unwrap_err()
                .code,
            "ARCHIVE_TOO_LARGE"
        );
        // Inclusive limits and arithmetic overflow must not bypass either cap.
        let mut budget = DependencyBudget::default();
        budget
            .include(MAX_DEPENDENCIES, MAX_DEPENDENCY_BYTES)
            .unwrap();
        assert_eq!(budget.include(1, 0).unwrap_err().code, "ARCHIVE_TOO_LARGE");
        let mut budget = DependencyBudget::default();
        budget.include(0, MAX_DEPENDENCY_BYTES).unwrap();
        assert_eq!(budget.include(0, 1).unwrap_err().code, "ARCHIVE_TOO_LARGE");
        assert_eq!(
            DependencyBudget::default()
                .include(usize::MAX, usize::MAX)
                .unwrap_err()
                .code,
            "ARCHIVE_TOO_LARGE"
        );
    }

    #[test]
    fn canonical_message_ids_that_resemble_model_aliases_are_not_remapped() {
        let memory = Memory {
            gist: "Welcome.".into(),
            detail: String::new(),
            feeling: String::new(),
            cues: vec![],
            salience: 0.5,
            confidence: 0.5,
            source_message_ids: vec!["m2".into(), "m1".into()],
        };
        let source = Source {
            messages: vec![
                SourceMessage {
                    id: "m2".into(),
                    role: "user".into(),
                    text: "One".into(),
                },
                SourceMessage {
                    id: "m1".into(),
                    role: "assistant".into(),
                    text: "Two".into(),
                },
            ],
            foundation: String::new(),
            hash: String::new(),
            recall_history: vec![],
            recall_hash: String::new(),
        };
        validate_memories(&[memory.clone()], None).unwrap();
        validate_memories(&[memory], Some(&source)).unwrap();
    }
    #[test]
    fn checksummed_but_forged_references_and_overlapping_episodes_are_rejected() {
        let mut archive: MemoryArchive = serde_json::from_value(archive()).unwrap();
        archive.contributions[0].memories[0].source_message_ids = vec!["not-played".into()];
        let mut state = serde_json::to_value(&archive.contributions[0]).unwrap();
        for key in ["stateHash", "reuseHash", "modelKey"] {
            state.as_object_mut().unwrap().remove(key);
        }
        archive.contributions[0].state_hash = fingerprint(&state).unwrap();
        archive.checksum = digest(&archive).unwrap();
        let archive = serde_json::to_value(archive).unwrap();
        let target = engine();
        assert_eq!(
            target
                .execute("importMemory", params(&target, &archive))
                .unwrap_err()
                .code,
            "INVALID_ARCHIVE"
        );
        assert_eq!(target.store.lock().unwrap().count("mara").unwrap(), 0);
        let mut archive: MemoryArchive = serde_json::from_value(super::tests::archive()).unwrap();
        let mut duplicate = archive.episodes[0].clone();
        duplicate.id = "overlap".into();
        archive.episodes.push(duplicate);
        archive.sources.insert("overlap".into(), None);
        archive.checksum = digest(&archive).unwrap();
        assert_eq!(
            decode(&serde_json::to_value(archive).unwrap())
                .err()
                .unwrap()
                .code,
            "INVALID_ARCHIVE"
        );
    }
}
