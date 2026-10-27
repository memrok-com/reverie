# Reverie for Pi

Subjective memory for an RPG companion: recollections shaped by emotion, bias and fictional time, together with a sense of shared history.

**Experimental.** Memory mechanics are tested; sustained-play quality and broader platform support remain work in progress.

Reverie 0.3.0 is a **Pi extension with a bundled native Rust memory engine**. Pi owns the conversations and model connections; Reverie adds character setup, an in-terminal personality editor, story dates, memory controls, and saved reply alternatives.

The current verified release supports **Pi 1.3.0, Windows x64 and Node 24.9–24.x**. Other platforms need a matching native build and verification; the package does not download executables during startup. npm registry publication is pending. The package name is `@memrok-com/reverie-pi`.

Start with the [quickstart](docs/quickstart.md). The local installable directory is `dist/reverie-pi`; an npm archive is produced by `npm run package`. No Rust compiler, separate server, or Docker container is needed by a user.

- [User controls](docs/user-controls.md)
- [Architecture](docs/architecture.md)
- [Development and verification](docs/development.md)
- [Validation and limitations](docs/validation.md)
- [Product vision](docs/product-vision.md)
- [Ubiquitous language](docs/ubiquitous-language.md)
- [Decisions](docs/open-decisions.md)

The earlier Node memory prototype and DSH adapter have been retired. Existing DSH user data is not modified or imported automatically: its conversation references belong to that host.

## License

Reverie's source code and documentation are licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution. Third-party components retain their own licenses; their notices are included in `third_party/` and bundled releases. Public source availability is separate from npm registry publication.
