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
use std::collections::{BTreeMap, HashSet};

pub const FORMAT: &str = "reverie-memory";
pub const VERSION: u32 = 1;
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryArchive {
    pub format: String,
    pub version: u32,
    pub character_id: String,
    pub episodes: Vec<Episode>,
    pub contributions: Vec<Contribution>,
    pub corrections: Vec<Correction>,
    /// Current source fingerprints, including null for deleted source. These
    /// are separate from published fingerprints so stale memory stays stale.
    pub sources: BTreeMap<String, Option<String>>,
    pub checksum: String,
}

fn invalid(message: &str) -> Error {
    Error::new("INVALID_ARCHIVE", message)
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
    if serde_json::to_vec(value)?.len() > MAX_BYTES {
        return Err(invalid("Memory archive exceeds 64 MiB."));
    }
    let archive: MemoryArchive =
        serde_json::from_value(value.clone()).map_err(|e| invalid(&e.to_string()))?;
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
    if archive.episodes.len() > 10_000
        || archive.contributions.len() > archive.episodes.len()
        || archive.corrections.len() > archive.episodes.len()
    {
        return Err(invalid("Memory archive record limits exceeded."));
    }
    assert_intervals(&archive.episodes).map_err(|e| invalid(&e.message))?;
    let mut ids = HashSet::new();
    for episode in &archive.episodes {
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
    for item in &archive.contributions {
        if let Some(model) = &item.model_key {
            identifier(model, "Model provenance")?;
        }
        let episode = archive
            .episodes
            .iter()
            .find(|e| e.id == item.episode_id)
            .ok_or_else(|| invalid("A contribution has no episode."))?;
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
                || !archive
                    .contributions
                    .iter()
                    .any(|p| p.episode_id == *id && p.start < item.start)
            {
                return Err(invalid(
                    "A contribution dependency is missing or not earlier in the story.",
                ));
            }
        }
        validate_memories(&item.memories, None)?;
        let allowed = item
            .dependencies
            .iter()
            .cloned()
            .chain(std::iter::once(item.episode_id.clone()))
            .collect::<Vec<_>>();
        let mut normalized = item.impressions.clone();
        for impression in &mut normalized {
            for id in &mut impression.source_episode_ids {
                let index = allowed
                    .iter()
                    .position(|candidate| candidate == id)
                    .ok_or_else(|| {
                        invalid("An impression cites an episode outside its memory history.")
                    })?;
                *id = format!("archive-episode-{index}");
            }
        }
        let allowed = (0..allowed.len())
            .map(|i| format!("archive-episode-{i}"))
            .collect::<Vec<_>>();
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
        if !ids.contains(pin.episode_id.as_str())
            || !pins.insert(&pin.episode_id)
            || !hash(&pin.source_hash)
            || !hash(&pin.prefix_hash)
        {
            return Err(invalid("Invalid correction identity or fingerprints."));
        }
        validate_memories(&pin.memories, None)?;
    }
    Ok(archive)
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
    archive.sources = read_sources(engine, &archive, cancel)?;
    archive.checksum = digest(&archive)?;
    decode(&serde_json::to_value(&archive)?)?;
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
fn incoming(engine: &Reverie, params: &Value) -> Result<MemoryArchive> {
    let archive = decode(
        params
            .get("archive")
            .ok_or_else(|| invalid("Supply a memory archive."))?,
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
pub(crate) fn preview(engine: &Reverie, params: &Value) -> Result<Value> {
    let archive = incoming(engine, params)?;
    let (revision, current) = target(engine, &archive)?;
    let pending = archive
        .episodes
        .iter()
        .filter(|e| {
            e.included
                && !archive.contributions.iter().any(|c| {
                    c.episode_id == e.id
                        && c.start == e.start
                        && c.end == e.now
                        && c.label == e.label
                        && archive.sources.get(&e.id).and_then(Option::as_ref)
                            == Some(&c.source_hash)
                })
        })
        .map(|e| &e.id)
        .collect::<Vec<_>>();
    Ok(
        json!({"status":if current {"current"} else {"ready"},"revision":revision,"archiveHash":archive.checksum,"episodes":archive.episodes.len(),"contributions":archive.contributions.len(),"memories":archive.contributions.iter().map(|c|c.memories.len()).sum::<usize>(),"corrections":archive.corrections.len(),"pendingEpisodes":pending,"modelCalls":0}),
    )
}
pub(crate) fn import(engine: &Reverie, params: &Value, cancel: &Cancel) -> Result<Value> {
    let archive = incoming(engine, params)?;
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
