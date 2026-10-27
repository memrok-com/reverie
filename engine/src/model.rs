use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub gist: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub feeling: String,
    pub cues: Vec<String>,
    pub salience: f64,
    pub confidence: f64,
    pub source_message_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Impression {
    pub text: String,
    pub source_episode_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Contribution {
    pub episode_id: String,
    pub label: String,
    pub start: i64,
    pub end: i64,
    pub source_hash: String,
    pub input_hash: String,
    pub dependencies: Vec<String>,
    pub memories: Vec<Memory>,
    pub impressions: Vec<Impression>,
    pub state_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Episode {
    pub id: String,
    pub label: String,
    pub start: i64,
    pub now: i64,
    pub included: bool,
    pub source_hash: Option<String>,
    pub input_hash: Option<String>,
    pub published_end: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SourceMessage {
    pub id: String,
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct Source {
    pub messages: Vec<SourceMessage>,
    pub foundation: String,
    pub hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub top_k: usize,
    pub candidate_limit: usize,
    pub memory_budget: usize,
    pub detail_half_life_days: f64,
    pub detail_threshold: f64,
    pub prior_memory_limit: usize,
    pub reflection_max_tokens: usize,
    pub reflection_attempts: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            top_k: 6,
            candidate_limit: 80,
            memory_budget: 6000,
            detail_half_life_days: 180.0,
            detail_threshold: 0.35,
            prior_memory_limit: 64,
            reflection_max_tokens: 4096,
            reflection_attempts: 3,
        }
    }
}

impl Settings {
    pub fn from_value(value: Option<Value>) -> Result<Self> {
        let settings: Self = value
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| {
                Error::new(
                    "INVALID_CONFIGURATION",
                    format!("Invalid memory settings: {error}"),
                )
            })?
            .unwrap_or_default();
        if settings.top_k == 0
            || settings.top_k > 32
            || settings.candidate_limit == 0
            || settings.candidate_limit > 2000
            || !(512..=50000).contains(&settings.memory_budget)
            || !settings.detail_half_life_days.is_finite()
            || settings.detail_half_life_days <= 0.0
            || !settings.detail_threshold.is_finite()
            || settings.detail_threshold <= 0.0
            || settings.detail_threshold > 1.0
            || settings.prior_memory_limit == 0
            || settings.prior_memory_limit > 1000
            || settings.reflection_max_tokens == 0
            || !(1..=3).contains(&settings.reflection_attempts)
        {
            return Err(Error::new(
                "INVALID_CONFIGURATION",
                "Memory budgets or selection limits are outside their supported ranges.",
            ));
        }
        Ok(settings)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recollection {
    pub id: i64,
    pub episode_id: String,
    pub gist: String,
    pub detail: String,
    pub feeling: String,
    pub confidence: f64,
    pub salience: f64,
    pub when: String,
    pub detail_retention: f64,
    pub score: f64,
    pub source_message_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recall {
    pub character_id: String,
    pub episode_id: String,
    pub at: i64,
    pub memories: Vec<Recollection>,
    pub impressions: Vec<Impression>,
    pub shared_history: String,
    pub history_sources: Vec<String>,
    pub text: String,
    pub revision: i64,
}
