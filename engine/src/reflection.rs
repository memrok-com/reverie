use crate::error::{Error, Result, identifier};
use crate::model::{Contribution, Episode, Impression, Memory, Settings, Source, SourceMessage};
use crate::time::iso;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub const REFLECTION_VERSION: u32 = 5;
pub const SYSTEM: &str = include_str!("../resources/reflection-system.txt");

pub fn fingerprint<T: Serialize>(value: &T) -> Result<String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| Error::new("INVALID_INPUT", error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

/// Source is transient. Only its hash and validated, selected derivatives reach storage.
pub fn observe(value: Value) -> Result<Option<Source>> {
    if !value.is_object() {
        return Err(Error::new(
            "INVALID_SOURCE",
            "The source reader returned no episode observation.",
        ));
    }
    if value.get("deleted") == Some(&Value::Bool(true)) {
        return Ok(None);
    }
    let played = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            Error::new(
                "INVALID_SOURCE",
                "Episode source must contain played messages.",
            )
        })?;
    let mut seen = HashSet::new();
    let mut messages = Vec::with_capacity(played.len());
    for item in played {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::new("INVALID_SOURCE", "Source message identity is missing."))?;
        identifier(id, "Source message identity")?;
        if !seen.insert(id.to_owned()) {
            return Err(Error::new(
                "INVALID_SOURCE",
                "Source message identities must be unique.",
            ));
        }
        let role = item.get("role").and_then(Value::as_str).unwrap_or("");
        let text = item.get("text").and_then(Value::as_str);
        if !matches!(role, "user" | "assistant") || text.is_none() {
            return Err(Error::new(
                "INVALID_SOURCE",
                "Episode source may contain only played player and character text.",
            ));
        }
        messages.push(SourceMessage {
            id: id.into(),
            role: role.into(),
            text: text.unwrap().into(),
        });
    }
    let foundation = value
        .get("foundation")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    // Struct field order intentionally matches host's source fingerprint.
    #[derive(Serialize)]
    struct Input<'a> {
        messages: &'a [SourceMessage],
        foundation: &'a str,
    }
    let hash = fingerprint(&Input {
        messages: &messages,
        foundation: &foundation,
    })?;
    Ok(Some(Source {
        messages,
        foundation,
        hash,
    }))
}

fn text(value: Option<&Value>, label: &str, max: usize, optional: bool) -> Result<String> {
    let value = if optional && value.is_none_or(Value::is_null) {
        Some("")
    } else {
        value.and_then(Value::as_str)
    };
    let value =
        value.ok_or_else(|| Error::new("INVALID_REFLECTION", format!("{label} must be text.")))?;
    if (!optional && value.trim().is_empty()) || value.encode_utf16().count() > max {
        return Err(Error::new(
            "INVALID_REFLECTION",
            format!(
                "{label} must be {}text of at most {max} characters.",
                if optional { "" } else { "nonempty " }
            ),
        ));
    }
    Ok(value.trim().to_owned())
}

fn unit(value: Option<&Value>, label: &str) -> Result<f64> {
    let number = value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && (0.0..=1.0).contains(number));
    number.ok_or_else(|| {
        Error::new(
            "INVALID_REFLECTION",
            format!("{label} must be between zero and one."),
        )
    })
}

fn references(
    value: Option<&Value>,
    allowed: &HashSet<String>,
    aliases: &HashMap<String, String>,
    label: &str,
) -> Result<Vec<String>> {
    let array = value
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty() && values.len() <= 64)
        .ok_or_else(|| {
            Error::new(
                "INVALID_REFLECTION",
                format!("{label} must cite the supplied source identities."),
            )
        })?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in array {
        let id = item
            .as_str()
            .filter(|id| allowed.contains(*id))
            .ok_or_else(|| {
                Error::new(
                    "INVALID_REFLECTION",
                    format!("{label} must cite only the supplied source identities."),
                )
            })?;
        let resolved = aliases.get(id).map(String::as_str).unwrap_or(id);
        if seen.insert(resolved.to_owned()) {
            result.push(resolved.to_owned());
        }
    }
    Ok(result)
}

pub fn parse(
    output: Value,
    source: &Source,
    episode_ids: &[String],
) -> Result<(Vec<Memory>, Vec<Impression>)> {
    let value = if let Value::String(ref raw) = output {
        let raw = raw.trim();
        let fence = "\u{60}\u{60}\u{60}";
        let cleaned = if raw.starts_with(fence) && raw.ends_with(fence) {
            let line = raw.find('\n').ok_or_else(|| {
                Error::new(
                    "INVALID_REFLECTION",
                    "Reflection did not return valid JSON.",
                )
            })?;
            let language = raw[fence.len()..line].trim();
            if !language.is_empty() && !language.eq_ignore_ascii_case("json") {
                return Err(Error::new(
                    "INVALID_REFLECTION",
                    "Reflection did not return valid JSON.",
                ));
            }
            &raw[line + 1..raw.len() - fence.len()]
        } else {
            raw
        };
        serde_json::from_str(cleaned).map_err(|_| {
            Error::new(
                "INVALID_REFLECTION",
                "Reflection did not return valid JSON. Previous memory is unchanged.",
            )
        })?
    } else {
        output
    };
    let memories = value
        .get("memories")
        .and_then(Value::as_array)
        .filter(|items| items.len() <= 12)
        .ok_or_else(|| {
            Error::new(
                "INVALID_REFLECTION",
                "Reflection needs an array of at most twelve memories.",
            )
        })?;
    let impressions = value
        .get("impressions")
        .and_then(Value::as_array)
        .filter(|items| items.len() <= 8)
        .ok_or_else(|| {
            Error::new(
                "INVALID_REFLECTION",
                "Reflection needs an array of at most eight impressions.",
            )
        })?;
    let message_aliases: HashMap<String, String> = source
        .messages
        .iter()
        .enumerate()
        .map(|(i, message)| (format!("m{}", i + 1), message.id.clone()))
        .collect();
    let allowed_messages = source
        .messages
        .iter()
        .map(|message| message.id.clone())
        .chain(message_aliases.keys().cloned())
        .collect();
    let episode_aliases: HashMap<String, String> = episode_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (format!("e{}", i + 1), id.clone()))
        .collect();
    let allowed_episodes = episode_ids
        .iter()
        .cloned()
        .chain(episode_aliases.keys().cloned())
        .collect();
    let memories = memories
        .iter()
        .map(|memory| {
            let cues = memory
                .get("cues")
                .and_then(Value::as_array)
                .filter(|items| items.len() <= 20)
                .ok_or_else(|| {
                    Error::new(
                        "INVALID_REFLECTION",
                        "Memory cues must be an array of at most twenty short phrases.",
                    )
                })?;
            Ok(Memory {
                gist: text(memory.get("gist"), "Memory gist", 800, false)?,
                detail: text(memory.get("detail"), "Memory detail", 1600, true)?,
                feeling: text(memory.get("feeling"), "Remembered feeling", 400, true)?,
                cues: cues
                    .iter()
                    .map(|cue| text(Some(cue), "Memory cue", 100, false))
                    .collect::<Result<_>>()?,
                salience: unit(memory.get("salience"), "Emotional salience")?,
                confidence: unit(memory.get("confidence"), "Subjective confidence")?,
                source_message_ids: references(
                    memory.get("sourceMessageIds"),
                    &allowed_messages,
                    &message_aliases,
                    "Memory references",
                )?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let impressions = impressions
        .iter()
        .map(|impression| {
            Ok(Impression {
                text: text(impression.get("text"), "Broader impression", 1200, false)?,
                source_episode_ids: references(
                    impression.get("sourceEpisodeIds"),
                    &allowed_episodes,
                    &episode_aliases,
                    "Impression references",
                )?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((memories, impressions))
}

pub fn request(
    episode: &Episode,
    source: &Source,
    prior: &[Contribution],
    settings: &Settings,
) -> Result<Value> {
    let episode_ids: Vec<_> = prior
        .iter()
        .map(|item| item.episode_id.as_str())
        .chain(std::iter::once(episode.id.as_str()))
        .collect();
    let aliases: HashMap<_, _> = episode_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, format!("e{}", i + 1)))
        .collect();
    let mut earlier = Vec::new();
    for contribution in prior {
        for memory in &contribution.memories {
            earlier.push((memory.salience, json!({
                "episodeId": aliases[contribution.episode_id.as_str()], "at": iso(contribution.end)?,
                "gist": memory.gist, "feeling": memory.feeling, "salience": memory.salience,
            })));
        }
    }
    earlier.sort_by(|a, b| b.0.total_cmp(&a.0));
    earlier.truncate(settings.prior_memory_limit);
    let earlier_episodes = prior
        .iter()
        .map(|item| {
            Ok(json!({
                "id": aliases[item.episode_id.as_str()], "label": item.label,
                "start": iso(item.start)?, "end": iso(item.end)?,
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let impressions = prior.last().map(|item| item.impressions.iter().map(|impression| json!({
        "text": impression.text,
        "sourceEpisodeIds": impression.source_episode_ids.iter().filter_map(|id| aliases.get(id.as_str())).collect::<Vec<_>>(),
    })).collect::<Vec<_>>()).unwrap_or_default();
    Ok(json!({ "system": SYSTEM.trim_end(), "input": {
        "characterFoundation": source.foundation,
        "sourceRoleLegend": { "player": "human player and their character", "companion": "the character whose subjective memory this is" },
        "episode": { "id": aliases[episode.id.as_str()], "label": episode.label,
            "start": iso(episode.start)?, "end": iso(episode.now)?,
            "messages": source.messages.iter().enumerate().map(|(i, message)| json!({
                "id": format!("m{}", i + 1), "role": message.role, "text": message.text,
                "speaker": if message.role == "user" { "player" } else { "companion" },
            })).collect::<Vec<_>>() },
        "eligibleEarlierEpisodes": earlier_episodes,
        "earlierRecollections": earlier.into_iter().map(|(_, value)| value).collect::<Vec<_>>(),
        "earlierImpressions": impressions,
    }, "maxTokens": settings.reflection_max_tokens }))
}
