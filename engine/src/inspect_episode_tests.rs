use crate::engine::{Bridge, Cancel, Reverie};
use crate::error::Result;
use crate::model::Settings;
use crate::reflection;
use crate::store::MemoryStore;
use rusqlite::params;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};

struct SourceBridge {
    source: Value,
    calls: Mutex<Vec<Value>>,
}

impl Bridge for SourceBridge {
    fn call(&self, method: &str, params: Value, _: &Cancel) -> Result<Value> {
        assert_eq!(method, "source.read");
        assert_eq!(params, json!({"characterId":"mara","episodeId":"target"}));
        self.calls.lock().unwrap().push(params);
        Ok(self.source.clone())
    }
}

fn fixture(source: Value, memories: Value) -> (Reverie, Arc<SourceBridge>) {
    let store = MemoryStore::open(Path::new(":memory:")).unwrap();
    let hash = reflection::observe(source.clone()).unwrap().unwrap().hash;
    store.db.execute_batch("INSERT INTO characters VALUES('mara',7),('other',3);
        INSERT INTO episodes(character_id,id,label,start,now,included) VALUES
        ('mara','target','Meeting',100,200,1),('mara','unreadable','Other',300,400,1),
        ('mara','invalidated','Invalidated',500,600,1),('other','foreign','Foreign',100,200,1);
        INSERT INTO contributions VALUES('mara','unreadable',300,400,'','','INVALID_JSON');
        INSERT INTO corrections VALUES('mara','target','INVALID_JSON');").unwrap();
    store.db.execute("INSERT INTO contributions VALUES('mara','target',100,200,'','',?)",
        [json!({"sourceHash":hash,"label":"Meeting","memories":memories,
            "impressions":[{"text":"PRIVATE_IMPRESSION"}]}).to_string()]).unwrap();
    store.db.execute("UPDATE episodes SET source_hash=?,input_hash='',published_end=200 WHERE character_id='mara' AND id='target'", params![hash]).unwrap();
    let bridge = Arc::new(SourceBridge { source, calls: Mutex::new(Vec::new()) });
    let engine = Reverie::new("mara".into(), store, Settings::default(), bridge.clone()).unwrap();
    (engine, bridge)
}

fn source() -> Value {
    json!({"messages":[{"id":"u1","role":"user","text":"PRIVATE_SOURCE"}],"foundation":"Synthetic Mara"})
}

#[test]
fn direct_episode_inspection_projects_saved_fields_without_broad_reads_or_writes() {
    let (engine, bridge) = fixture(source(), json!([{
        "gist":"Saved gist","detail":"Saved detail","feeling":"Hopeful","confidence":0.8,
        "sourceMessageIds":["PRIVATE_ID"],"cues":["PRIVATE_CUE"],"salience":0.9
    }]));
    let before = engine.store.lock().unwrap().db.total_changes();
    let result = engine.inspect_episode(&json!({"episodeId":"target"})).unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), json!({
        "characterId":"mara","episodeId":"target","revision":7,"state":"published",
        "memories":[{"gist":"Saved gist","detail":"Saved detail","feeling":"Hopeful","confidence":0.8}]
    }));
    assert_eq!(bridge.calls.lock().unwrap().len(), 1);
    assert_eq!(engine.store.lock().unwrap().db.total_changes(), before);
}

#[test]
fn direct_episode_inspection_validates_scope_and_preserves_empty_publication() {
    let (engine, bridge) = fixture(source(), json!([]));
    for (id, state) in [("unknown", "not-memorized"), ("invalidated", "invalidated")] {
        assert_eq!(engine.execute("inspectEpisode", json!({"episodeId":id})).unwrap(),
            json!({"characterId":"mara","episodeId":id,"revision":7,"state":state,"memories":[]}));
    }
    assert_eq!(engine.inspect_episode(&json!({})).unwrap_err().code, "INVALID_INPUT");
    assert_eq!(engine.inspect_episode(&json!({"episodeId":"target","characterId":"other"})).unwrap_err().code, "CHARACTER_MISMATCH");
    assert_eq!(engine.inspect_episode(&json!({"episodeId":"foreign"})).unwrap_err().code, "EPISODE_CHARACTER_MISMATCH");
    assert!(bridge.calls.lock().unwrap().is_empty());
    assert_eq!(engine.execute("inspectEpisode", json!({"episodeId":"target"})).unwrap()["state"], "published");
    assert_eq!(bridge.calls.lock().unwrap().len(), 1);
}
