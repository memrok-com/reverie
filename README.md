# Reverie

Reverie is a standalone Rust memory engine for roleplay. It gives characters selective recollections and subjective impressions that respect the story's chronology.

A host supplies the played source and runs model-assisted reflection. Reverie stores the resulting memory in SQLite and retrieves relevant recollections locally. Hosts can launch the native executable over a JSON-lines connection. Rust hosts can also link the crate from source.

- [Build and connect a host](docs/quickstart.md)
- [Architecture and host responsibilities](docs/architecture.md)
- [Development and tests](docs/development.md)
- [Product vision](docs/product-vision.md)
- [Ubiquitous language](docs/ubiquitous-language.md)
- [Validation and limits](docs/validation.md)

## Earlier Pi integration

The [last revision with the Pi extension](https://github.com/memrok-com/reverie/tree/518cb3e911e0fb5a056d7862179c2cae5b6d7c05) retains its installation and [story export instructions](https://github.com/memrok-com/reverie/blob/518cb3e911e0fb5a056d7862179c2cae5b6d7c05/docs/story-backup.md). Existing Pi stories can still be opened and exported with that version. The standalone engine takes episode source from its host. Importing a legacy story archive is a host responsibility.

## License

Reverie's source code and documentation are licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [third_party](third_party/) for attribution.
