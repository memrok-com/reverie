pub mod engine;
pub mod error;
pub mod model;
pub mod protocol;
pub mod reflection;
pub mod store;
pub mod time;

/// A real linked SQLite/FTS5 probe, kept small while the engine migration lands.
pub fn storage_probe() -> rusqlite::Result<String> {
    let connection = rusqlite::Connection::open_in_memory()?;
    connection.execute_batch("CREATE VIRTUAL TABLE probe USING fts5(memory); INSERT INTO probe VALUES('A cedar coat at the lighthouse');")?;
    connection.query_row(
        "SELECT memory FROM probe WHERE probe MATCH 'lighthouse'",
        [],
        |row| row.get(0),
    )
}
