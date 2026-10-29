
      CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS episodes (
        character_id TEXT NOT NULL REFERENCES characters(id), id TEXT NOT NULL, label TEXT NOT NULL,
        start INTEGER NOT NULL, now INTEGER NOT NULL, included INTEGER NOT NULL DEFAULT 0,
        source_hash TEXT, input_hash TEXT, published_end INTEGER,
        PRIMARY KEY(character_id, id)
      );
      CREATE INDEX IF NOT EXISTS episodes_identity ON episodes(id);
      CREATE TABLE IF NOT EXISTS contributions (
        character_id TEXT NOT NULL, episode_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
        input_hash TEXT NOT NULL, state_hash TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(character_id, episode_id),
        FOREIGN KEY(character_id,episode_id) REFERENCES episodes(character_id,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS contributions_time ON contributions(character_id,end);
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY, character_id TEXT NOT NULL, episode_id TEXT NOT NULL, available_at INTEGER NOT NULL,
        gist TEXT NOT NULL, detail TEXT NOT NULL, feeling TEXT NOT NULL, cues TEXT NOT NULL,
        salience REAL NOT NULL, confidence REAL NOT NULL, source_ids TEXT NOT NULL,
        FOREIGN KEY(character_id,episode_id) REFERENCES episodes(character_id,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS memories_time ON memories(character_id,available_at);
      CREATE INDEX IF NOT EXISTS memories_episode_order ON memories(character_id,episode_id,id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(gist,detail,feeling,cues, content='memories',content_rowid='id',tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS memories_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memory_search(rowid,gist,detail,feeling,cues) VALUES(new.id,new.gist,new.detail,new.feeling,new.cues);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memory_search(memory_search,rowid,gist,detail,feeling,cues) VALUES('delete',old.id,old.gist,old.detail,old.feeling,old.cues);
      END;
      CREATE TABLE IF NOT EXISTS corrections (
        character_id TEXT NOT NULL, episode_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(character_id,episode_id),
        FOREIGN KEY(character_id,episode_id) REFERENCES episodes(character_id,id) ON DELETE CASCADE
      );
      PRAGMA user_version=2;
