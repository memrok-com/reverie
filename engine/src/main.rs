use reverie_engine::{
    error::{Error, Result},
    model::Settings,
};
use std::path::PathBuf;

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--storage-probe") {
        println!("{}", reverie_engine::storage_probe()?);
        return Ok(());
    }
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "--version") {
        println!(
            "Reverie 0.3.0 native memory engine\nConfigure and use Reverie through its Pi extension.\nAdapter connection: --stdio --character NAME --database PATH [--settings JSON]"
        );
        return Ok(());
    }
    let (mut character, mut database, mut settings, mut stdio) = (None, None, None, false);
    let mut values = args.iter();
    while let Some(arg) = values.next() {
        if arg == "--stdio" {
            stdio = true;
            continue;
        }
        let value = values
            .next()
            .ok_or_else(|| Error::new("INVALID_ARGUMENT", "An engine argument is incomplete."))?;
        match arg.as_str() {
            "--character" => character = Some(value.clone()),
            "--database" => database = Some(PathBuf::from(value)),
            "--settings" => {
                settings = Some(serde_json::from_str(value).map_err(|_| {
                    Error::new("INVALID_CONFIGURATION", "Memory settings must be JSON.")
                })?)
            }
            _ => {
                return Err(Error::new(
                    "INVALID_ARGUMENT",
                    "Unknown engine argument. Use --help.",
                ));
            }
        }
    }
    let character = character.filter(|_| stdio).ok_or_else(|| {
        Error::new(
            "INVALID_ARGUMENT",
            "The host connection requires --stdio and --character.",
        )
    })?;
    let database = database.ok_or_else(|| {
        Error::new(
            "INVALID_ARGUMENT",
            "The host adapter must supply a memory database location.",
        )
    })?;
    reverie_engine::protocol::serve(character, &database, Settings::from_value(settings)?)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Reverie: {error}");
        std::process::exit(1);
    }
}
