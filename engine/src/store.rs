use crate::error::{Error, Result};
use crate::model::{Contribution, Correction, Episode, Impression};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use std::{collections::HashSet, path::Path};

pub struct MemoryStore {
    pub(crate) db: Connection,
}

pub struct Candidate {
    pub id: i64,
    pub episode_id: String,
    pub memory_index: usize,
    pub available_at: i64,
    pub rank: f64,
}

pub struct History {
    pub impressions: Vec<Impression>,
    pub impression_episode_id: Option<String>,
    pub first: Option<i64>,
    pub history_sources: Vec<String>,
}

fn episode_row(row: &Row<'_>) -> rusqlite::Result<Episode> {
    Ok(Episode {
        id: row.get("id")?,
        label: row.get("label")?,
        start: row.get("start")?,
        now: row.get("now")?,
        included: row.get("included")?,
        source_hash: row.get("source_hash")?,
        input_hash: row.get("input_hash")?,
        published_end: row.get("published_end")?,
    })
}

fn candidate_row(row: &Row<'_>) -> rusqlite::Result<Candidate> {
    Ok(Candidate {
        id: row.get("id")?,
        episode_id: row.get("episode_id")?,
        memory_index: row.get::<_, i64>("memory_index")? as usize,
        available_at: row.get("available_at")?,
        rank: row.get("rank")?,
    })
}

impl MemoryStore {
    pub fn open(path: &Path) -> Result<Self> {
        if path != Path::new(":memory:")
            && let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;",
        )?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 2 {
            return Err(Error::new(
                "UNSUPPORTED_DATABASE",
                "This memory database needs a newer version of Reverie.",
            ));
        }
        db.execute_batch(include_str!("../resources/schema.sql"))?;
        db.set_prepared_statement_cache_capacity(32);
        Ok(Self { db })
    }

    pub fn ensure_character(&self, id: &str) -> Result<()> {
        self.db
            .prepare_cached("INSERT OR IGNORE INTO characters(id) VALUES(?)")?
            .execute([id])?;
        Ok(())
    }

    pub fn assert_episode_owner(&self, character: &str, episode: &str) -> Result<()> {
        let other: bool = self
            .db
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM episodes WHERE id=? AND character_id<>?)")?
            .query_row(params![episode, character], |row| row.get(0))?;
        if other {
            return Err(Error::new(
                "EPISODE_CHARACTER_MISMATCH",
                "This conversation belongs to another character's memory. Select its original character in Reverie settings, or start a new conversation.",
            ));
        }
        Ok(())
    }

    pub fn revision(&self, id: &str) -> Result<i64> {
        Ok(self
            .db
            .prepare_cached("SELECT revision FROM characters WHERE id=?")?
            .query_row([id], |row| row.get(0))
            .optional()?
            .unwrap_or(0))
    }

    pub fn count(&self, id: &str) -> Result<i64> {
        Ok(self
            .db
            .prepare_cached("SELECT COUNT(*) FROM memories WHERE character_id=?")?
            .query_row([id], |row| row.get(0))?)
    }

    pub fn episodes(&self, id: &str) -> Result<Vec<Episode>> {
        Ok(self.db.prepare_cached("SELECT id,label,start,now,included,source_hash,input_hash,published_end FROM episodes WHERE character_id=? ORDER BY start,id")?
            .query_map([id], episode_row)?.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn episode(&self, character: &str, episode: &str) -> Result<Option<Episode>> {
        Ok(self.db.prepare_cached("SELECT id,label,start,now,included,source_hash,input_hash,published_end FROM episodes WHERE character_id=? AND id=?")?
            .query_row(params![character, episode], episode_row).optional()?)
    }

    pub fn set_episode(&mut self, character: &str, episode: &Episode) -> Result<()> {
        self.ensure_character(character)?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let other: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM episodes WHERE id=? AND character_id<>?)",
            params![episode.id, character],
            |row| row.get(0),
        )?;
        if other {
            return Err(Error::new(
                "EPISODE_CHARACTER_MISMATCH",
                "This conversation belongs to another character's memory. Select its original character in Reverie settings, or start a new conversation.",
            ));
        }
        tx.execute("INSERT INTO episodes(character_id,id,label,start,now) VALUES(?,?,?,?,?) ON CONFLICT(character_id,id) DO UPDATE SET label=excluded.label,start=excluded.start,now=excluded.now",
            params![character, episode.id, episode.label, episode.start, episode.now])?;
        tx.execute(
            "UPDATE characters SET revision=revision+1 WHERE id=?",
            [character],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn contributions(&self, character: &str) -> Result<Vec<Contribution>> {
        let texts = self
            .db
            .prepare_cached(
                "SELECT data FROM contributions WHERE character_id=? ORDER BY start,episode_id",
            )?
            .query_map([character], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        texts
            .iter()
            .map(|text| Ok(serde_json::from_str(text)?))
            .collect()
    }

    pub fn corrections(&self, character: &str) -> Result<Vec<Correction>> {
        let texts = self
            .db
            .prepare_cached("SELECT data FROM corrections WHERE character_id=?")?
            .query_map([character], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        texts
            .iter()
            .map(|text| Ok(serde_json::from_str(text)?))
            .collect()
    }

    /// Replace one reviewed contribution and invalidate all dependent derivatives atomically.
    pub fn correct(
        &mut self,
        character: &str,
        revision: i64,
        target: &Contribution,
        correction: Option<&Correction>,
    ) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: i64 = tx.query_row(
            "SELECT revision FROM characters WHERE id=?",
            [character],
            |row| row.get(0),
        )?;
        if revision != current {
            return Err(Error::new(
                "STALE_OPERATION",
                "Memory changed after the preview. Inspect and preview again.",
            ));
        }
        tx.execute("DELETE FROM memories WHERE character_id=? AND episode_id IN (SELECT id FROM episodes WHERE character_id=? AND start>=?)", params![character, character, target.start])?;
        tx.execute(
            "DELETE FROM contributions WHERE character_id=? AND start>=?",
            params![character, target.start],
        )?;
        tx.execute("UPDATE episodes SET source_hash=NULL,input_hash=NULL,published_end=NULL WHERE character_id=? AND start>=?", params![character, target.start])?;
        // A later pin was reviewed against the old prefix, so it cannot survive this edit.
        tx.execute("DELETE FROM corrections WHERE character_id=? AND episode_id IN (SELECT id FROM episodes WHERE character_id=? AND start>?)", params![character, character, target.start])?;
        if let Some(correction) = correction {
            tx.execute("INSERT INTO corrections(character_id,episode_id,data) VALUES(?,?,?) ON CONFLICT(character_id,episode_id) DO UPDATE SET data=excluded.data",
                params![character, target.episode_id, serde_json::to_string(correction)?])?;
            tx.execute("INSERT INTO contributions(character_id,episode_id,start,end,input_hash,state_hash,data) VALUES(?,?,?,?,?,?,?)",
                params![character,target.episode_id,target.start,target.end,target.input_hash,target.state_hash,serde_json::to_string(target)?])?;
            tx.execute("UPDATE episodes SET source_hash=?,input_hash='',published_end=? WHERE character_id=? AND id=?", params![target.source_hash,target.end,character,target.episode_id])?;
            for memory in &target.memories {
                tx.execute("INSERT INTO memories(character_id,episode_id,available_at,gist,detail,feeling,cues,salience,confidence,source_ids) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    params![character,target.episode_id,target.end,memory.gist,memory.detail,memory.feeling,memory.cues.join(" "),memory.salience,memory.confidence,serde_json::to_string(&memory.source_message_ids)?])?;
            }
        } else {
            tx.execute(
                "DELETE FROM corrections WHERE character_id=? AND episode_id=?",
                params![character, target.episode_id],
            )?;
        }
        tx.execute(
            "UPDATE characters SET revision=revision+1 WHERE id=?",
            [character],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Remove source and every later derivative that could have learned from it.
    /// Inclusion choices for surviving episodes remain available for an explicit rebuild.
    pub fn forget_episode(
        &mut self,
        character: &str,
        episode: &str,
        revision: Option<i64>,
    ) -> Result<usize> {
        self.assert_episode_owner(character, episode)?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = tx
            .query_row(
                "SELECT revision FROM characters WHERE id=?",
                [character],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        if revision.is_some_and(|revision| revision != current) {
            return Err(Error::new(
                "STALE_OPERATION",
                "Memory changed while preparing deletion. Retry source reconciliation.",
            ));
        }
        let start: Option<i64> = tx
            .query_row(
                "SELECT start FROM episodes WHERE character_id=? AND id=?",
                params![character, episode],
                |row| row.get(0),
            )
            .optional()?;
        let Some(start) = start else {
            return Ok(0);
        };
        let published_start: Option<i64> = tx
            .query_row(
                "SELECT start FROM contributions WHERE character_id=? AND episode_id=?",
                params![character, episode],
                |row| row.get(0),
            )
            .optional()?;
        let mut invalidated = 0;
        // Unmemorized source was never part of a later reflection prefix.
        if let Some(published_start) = published_start {
            let cutoff = start.min(published_start);
            // Use the published chronology for every derivative. Current episode
            // dates can drift from the snapshot that dependent memory learned from.
            let affected: Vec<String> = tx
                .prepare("SELECT episode_id FROM contributions WHERE character_id=? AND start>=?")?
                .query_map(params![character, cutoff], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            invalidated = affected.len();
            for id in affected {
                tx.execute(
                    "DELETE FROM memories WHERE character_id=? AND episode_id=?",
                    params![character, id],
                )?;
                tx.execute(
                    "DELETE FROM contributions WHERE character_id=? AND episode_id=?",
                    params![character, id],
                )?;
                tx.execute(
                    "DELETE FROM corrections WHERE character_id=? AND episode_id=?",
                    params![character, id],
                )?;
                tx.execute("UPDATE episodes SET source_hash=NULL,input_hash=NULL,published_end=NULL WHERE character_id=? AND id=?", params![character, id])?;
            }
            // Withdrawn/invalidated pins have no contribution row to select above.
            tx.execute("DELETE FROM corrections WHERE character_id=? AND episode_id IN (SELECT id FROM episodes WHERE character_id=? AND start>=? AND id NOT IN (SELECT episode_id FROM contributions WHERE character_id=?))", params![character, character, cutoff, character])?;
        }
        tx.execute(
            "DELETE FROM episodes WHERE character_id=? AND id=?",
            params![character, episode],
        )?;
        tx.execute(
            "UPDATE characters SET revision=revision+1 WHERE id=?",
            [character],
        )?;
        tx.commit()?;
        Ok(invalidated)
    }

    pub fn publish(
        &mut self,
        character: &str,
        revision: i64,
        contributions: &[Contribution],
        deleted_ids: &[String],
    ) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: i64 = tx.query_row(
            "SELECT revision FROM characters WHERE id=?",
            [character],
            |row| row.get(0),
        )?;
        if current != revision {
            return Err(Error::new(
                "STALE_OPERATION",
                "The character or episode changed during reflection. Previous memory is unchanged; try again.",
            ));
        }
        tx.execute("DELETE FROM memories WHERE character_id=?", [character])?;
        tx.execute(
            "DELETE FROM contributions WHERE character_id=?",
            [character],
        )?;
        tx.execute(
            "UPDATE episodes SET included=0 WHERE character_id=?",
            [character],
        )?;
        for id in deleted_ids {
            tx.execute(
                "DELETE FROM episodes WHERE character_id=? AND id=?",
                params![character, id],
            )?;
        }
        {
            let mut update_episode = tx.prepare("UPDATE episodes SET included=1,source_hash=?,input_hash=?,published_end=? WHERE character_id=? AND id=?")?;
            let mut insert_contribution = tx.prepare("INSERT INTO contributions(character_id,episode_id,start,end,input_hash,state_hash,data) VALUES(?,?,?,?,?,?,?)")?;
            let mut insert_memory = tx.prepare("INSERT INTO memories(character_id,episode_id,available_at,gist,detail,feeling,cues,salience,confidence,source_ids) VALUES(?,?,?,?,?,?,?,?,?,?)")?;
            for item in contributions {
                update_episode.execute(params![
                    item.source_hash,
                    item.input_hash,
                    item.end,
                    character,
                    item.episode_id
                ])?;
                insert_contribution.execute(params![
                    character,
                    item.episode_id,
                    item.start,
                    item.end,
                    item.input_hash,
                    item.state_hash,
                    serde_json::to_string(item)?
                ])?;
                for memory in &item.memories {
                    insert_memory.execute(params![
                        character,
                        item.episode_id,
                        item.end,
                        memory.gist,
                        memory.detail,
                        memory.feeling,
                        memory.cues.join(" "),
                        memory.salience,
                        memory.confidence,
                        serde_json::to_string(&memory.source_message_ids)?
                    ])?;
                }
            }
        }
        tx.execute(
            "UPDATE characters SET revision=revision+1 WHERE id=?",
            [character],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn candidates(
        &self,
        character: &str,
        now: i64,
        active: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<Candidate>> {
        // An active earlier episode must not see an adjacent episode at their shared timestamp.
        let active_start = self
            .episode(character, active)?
            .map(|episode| episode.start);
        let mut rows = Vec::new();
        if !query.is_empty() {
            // Publication inserts each episode's complete memory vector in order.
            // Its row ordinal survives restarts and backup without float matching.
            rows = self.db.prepare_cached("SELECT m.*,memory_search.rank AS rank,
                (SELECT COUNT(*) FROM memories earlier WHERE earlier.character_id=m.character_id AND earlier.episode_id=m.episode_id AND earlier.id<m.id) AS memory_index FROM memory_search
                CROSS JOIN memories m ON m.id=memory_search.rowid WHERE memory_search MATCH ?1
                AND m.character_id=?2 AND m.available_at<=?3 AND m.episode_id<>?4
                AND (?5 IS NULL OR EXISTS(SELECT 1 FROM episodes e WHERE e.character_id=m.character_id AND e.id=m.episode_id AND e.start<?5))
                ORDER BY memory_search.rank LIMIT ?6")?
                .query_map(params![query, character, now, active, active_start, limit as i64], candidate_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
        }
        let fallback = self.db.prepare_cached("SELECT m.*,0 AS rank,
            (SELECT COUNT(*) FROM memories earlier WHERE earlier.character_id=m.character_id AND earlier.episode_id=m.episode_id AND earlier.id<m.id) AS memory_index FROM memories m WHERE m.character_id=?1 AND m.available_at<=?2 AND m.episode_id<>?3
            AND (?4 IS NULL OR EXISTS(SELECT 1 FROM episodes e WHERE e.character_id=m.character_id AND e.id=m.episode_id AND e.start<?4))
            ORDER BY salience DESC,available_at DESC LIMIT ?5")?
            .query_map(params![character, now, active, active_start, limit.min(12) as i64], candidate_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.extend(fallback);
        let mut seen = HashSet::new();
        rows.retain(|row| seen.insert(row.id));
        Ok(rows)
    }

    pub fn history(&self, character: &str, now: i64, active: &str) -> Result<History> {
        let active_start = self
            .episode(character, active)?
            .map(|episode| episode.start);
        let snapshot: Option<String> = self.db.prepare_cached("SELECT c.data FROM contributions c WHERE c.character_id=?1 AND c.end<=?2 AND c.episode_id<>?3
            AND (?4 IS NULL OR EXISTS(SELECT 1 FROM episodes e WHERE e.character_id=c.character_id AND e.id=c.episode_id AND e.start<?4))
            ORDER BY c.end DESC,c.start DESC LIMIT 1")?
            .query_row(params![character, now, active, active_start], |row| row.get(0)).optional()?;
        let first: Option<(i64, String)> = self.db.prepare_cached("SELECT c.start,c.episode_id FROM contributions c WHERE c.character_id=?1 AND c.end<=?2 AND c.episode_id<>?3
            AND (?4 IS NULL OR EXISTS(SELECT 1 FROM episodes e WHERE e.character_id=c.character_id AND e.id=c.episode_id AND e.start<?4))
            ORDER BY c.start,c.episode_id LIMIT 1")?
            .query_row(params![character, now, active, active_start], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        let snapshot = snapshot
            .map(|text| serde_json::from_str::<Contribution>(&text))
            .transpose()?;
        // Impression citations identify supporting events, which need not include
        // the episode that authored this complete snapshot.
        let impression_episode_id = snapshot.as_ref().map(|item| item.episode_id.clone());
        let impressions = snapshot.map(|item| item.impressions).unwrap_or_default();
        Ok(History {
            impressions,
            impression_episode_id,
            first: first.as_ref().map(|(start, _)| *start),
            history_sources: first.map(|(_, id)| vec![id]).unwrap_or_default(),
        })
    }
}
